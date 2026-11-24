import sql from "mssql";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { catalogSchedulePopulationDigest } from "./catalogSchedulePopulationCoverage";

type SourceHead = Readonly<{ sourceId: string; role: "erp-customers" | "sag-admin"; revisionId: string;
  bindingVersion: string; profileVersion: string; recordedAt: Date; observedAt: Date; sealedAt: Date; validUntil: Date }>;
type SourceWindow = Readonly<{ heads: readonly SourceHead[]; linkIds: readonly string[]; validUntil: Date }>;
type SourceWindowRequest = Readonly<{ environment: CatalogEnvironment; asOf: Date; matchKeyVersion: number }>;
type Approval = { sourceCount: number; linkCount: number; digest: Buffer; validUntil: Date };
const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const binary8 = /^[a-f0-9]{16}$/;
const isTime = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.valueOf());

// Choose the latest event BEFORE checking success. A failed attempt before the
// cutoff invalidates that source; a later attempt cannot overwrite the history.
export const catalogScheduleActivationSourceSql = `
  SET NOCOUNT ON;
  SELECT TOP (51) LOWER(CONVERT(char(36),b.source_id)) AS sourceId,b.source_role AS role,
    CONVERT(varchar(20),r.revision_key) AS revisionId,LOWER(CONVERT(char(16),r.binding_version,2)) AS bindingVersion,
    LOWER(CONVERT(char(16),r.profile_version,2)) AS profileVersion,h.recorded_at AS recordedAt,
    r.observed_at AS observedAt,r.sealed_at AS sealedAt,r.verified_until AS validUntil
  FROM settings.catalog_source_bindings b WITH (HOLDLOCK)
  JOIN settings.external_database_connections p WITH (HOLDLOCK)
    ON p.external_database_connection_key=b.external_database_connection_key
    AND p.active=1 AND p.status='active' AND p.encrypt_connection=1 AND p.password_configured=1
    AND b.validated_profile_version=p.row_version
  JOIN settings.catalog_match_key_registry k WITH (HOLDLOCK)
    ON k.portal_environment=b.portal_environment COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(k.portal_environment)=DATALENGTH(b.portal_environment)
    AND k.match_key_version=@matchKeyVersion AND k.enrolled_at<=@asOf
  CROSS APPLY (
    SELECT TOP (1) e.revision_key,e.attempt_ordinal,e.attempt_status,e.attempted_at,e.recorded_at
    FROM settings.catalog_source_head_events e WITH (HOLDLOCK)
    WHERE e.catalog_source_key=b.catalog_source_key AND e.recorded_at<=@asOf
    ORDER BY e.head_event_key DESC
  ) h
  JOIN core.catalog_customer_source_revisions r WITH (HOLDLOCK)
    ON r.catalog_source_key=b.catalog_source_key AND r.revision_key=h.revision_key
    AND r.attempt_ordinal=h.attempt_ordinal AND r.source_role=b.source_role
    AND r.binding_version=b.row_version AND r.profile_version=p.row_version AND r.match_key_version=k.match_key_version
  WHERE b.portal_environment=@environment AND DATALENGTH(b.portal_environment)=DATALENGTH(@environment)
    AND b.source_state='active' AND b.validated_at<=@asOf AND @asOf<=SYSUTCDATETIME()
    AND h.attempt_status='succeeded' AND h.attempted_at<=@asOf
    AND r.observed_at<=@asOf AND r.sealed_at<=@asOf AND r.verified_until>@asOf
    AND ((b.source_role='erp-customers' AND b.contract_version='erp_v1') OR
      (b.source_role='sag-admin' AND r.has_sag_inventory_evidence=1 AND (
        b.contract_version='sag_admin_v1' OR (b.contract_version='sag_admin_v2' AND r.expected_sag_company_rows IS NOT NULL
          AND (SELECT COUNT_BIG(*) FROM core.catalog_sag_customer_directory_rows d WITH (HOLDLOCK)
            WHERE d.revision_key=r.revision_key)=r.expected_rows
          AND (SELECT COUNT_BIG(*) FROM core.catalog_sag_company_revision_rows c WITH (HOLDLOCK)
            WHERE c.revision_key=r.revision_key)=r.expected_sag_company_rows))))
  ORDER BY b.catalog_source_key;

  -- Enumerate bindings independently of head/profile validity. An uncertified
  -- active source must not disappear from completeness merely because it has no links.
  SELECT TOP (51) LOWER(CONVERT(char(36),b.source_id)) AS sourceId,b.source_role AS role
  FROM settings.catalog_source_bindings b WITH (HOLDLOCK)
  WHERE b.portal_environment=@environment AND DATALENGTH(b.portal_environment)=DATALENGTH(@environment)
    AND b.source_state='active'
  ORDER BY b.catalog_source_key;

  SELECT TOP (2) a.source_count AS sourceCount,a.link_count AS linkCount,a.population_sha256 AS digest,a.valid_until AS validUntil
  FROM scheduling.catalog_schedule_population_approvals a WITH (HOLDLOCK)
  JOIN security.users u WITH (HOLDLOCK) ON u.user_key=a.approved_by AND u.active=1
  JOIN security.user_roles ur WITH (HOLDLOCK) ON ur.user_key=u.user_key AND ur.role_id=N'super_admin'
  JOIN security.roles sr WITH (HOLDLOCK) ON sr.role_id=ur.role_id AND sr.active=1 AND sr.system_role=1 AND sr.protected_role=1
  WHERE a.portal_environment=@environment AND DATALENGTH(a.portal_environment)=DATALENGTH(@environment)
    AND a.approved_at<=@asOf AND a.valid_until>@asOf AND (a.retired_at IS NULL OR a.retired_at>@asOf);

  SELECT TOP (5001) LOWER(CONVERT(char(36),l.link_id)) AS linkId,LOWER(CONVERT(char(36),b.source_id)) AS sourceId
  FROM core.catalog_operational_links l WITH (HOLDLOCK)
  JOIN core.catalog_operational_owners o WITH (HOLDLOCK) ON o.owner_key=l.owner_key
    AND o.portal_environment=l.portal_environment AND o.client_key=l.client_key
  JOIN settings.catalog_source_bindings b WITH (HOLDLOCK) ON b.catalog_source_key=l.catalog_source_key
  WHERE l.portal_environment=@environment AND DATALENGTH(l.portal_environment)=DATALENGTH(@environment)
    AND l.registered_at<=@asOf AND (l.retired_at IS NULL OR l.retired_at>@asOf)
    AND o.registered_at<=@asOf AND (o.retired_at IS NULL OR o.retired_at>@asOf)
  ORDER BY l.link_key;`;

/** Historical source versions only. Other gates still prove population, scope, license and physical target. */
export async function readCatalogScheduleActivationSourceWindowInTransaction(transaction: sql.Transaction,
  scope: SourceWindowRequest): Promise<SourceWindow | null> {
  const { environment, asOf, matchKeyVersion } = scope;
  if (!isTime(asOf) || (environment !== "qa" && environment !== "production") ||
      !Number.isInteger(matchKeyVersion) || matchKeyVersion < 1 || matchKeyVersion > 32767) throw new Error("catalog_activation_source_scope_invalid");
  const { recordsets } = await transaction.request().input("environment", sql.VarChar(10), environment)
    .input("asOf", sql.DateTime2(3), asOf).input("matchKeyVersion", sql.SmallInt, matchKeyVersion)
    .query(catalogScheduleActivationSourceSql);
  if (!Array.isArray(recordsets) || recordsets.length !== 4 || !recordsets.every(Array.isArray)) return null;
  const [heads, bindings, approvals, links] = recordsets as unknown as [SourceHead[], Pick<SourceHead, "sourceId" | "role">[],
    Approval[], { linkId: string; sourceId: string }[]];
  const approval = approvals[0];
  if (approvals.length !== 1 || !approval || !Buffer.isBuffer(approval.digest) || approval.digest.length !== 32 ||
      !isTime(approval.validUntil) || approval.validUntil <= asOf || heads.length < 2 || heads.length > 50 ||
      heads.length !== approval.sourceCount || heads.length !== bindings.length || links.length !== approval.linkCount ||
      links.length < 1 || links.length > 5000 ||
      heads.some(row => !guid.test(row.sourceId) || (row.role !== "sag-admin" && row.role !== "erp-customers") ||
        !/^[1-9][0-9]{0,18}$/.test(row.revisionId) || !binary8.test(row.bindingVersion) || !binary8.test(row.profileVersion) ||
        ![row.recordedAt, row.observedAt, row.sealedAt].every(value => isTime(value) && value <= asOf) ||
        !isTime(row.validUntil) || row.validUntil <= asOf)) return null;
  const remaining = new Map(bindings.map(binding => [binding.sourceId, binding.role]));
  if (remaining.size !== bindings.length || heads.some(head => remaining.get(head.sourceId) !== head.role || !remaining.delete(head.sourceId))) return null;
  const availableErp = new Set(heads.filter(row => row.role === "erp-customers").map(row => row.sourceId));
  if (links.some(link => !availableErp.has(link.sourceId))) return null;
  const linkIds = links.map(({ linkId }) => linkId);
  try {
    if (!approval.digest.equals(catalogSchedulePopulationDigest(environment, heads, linkIds))) return null;
  } catch { return null; }
  return { heads, linkIds, validUntil: new Date(Math.min(approval.validUntil.getTime(), ...heads.map(row => row.validUntil.getTime()))) };
}
