import { createHash } from "node:crypto";
import sql from "mssql";
import type { CatalogOperationalLink } from "./catalogOperationalLinksSqlRepository";
import type { CatalogInventoryProofScope } from "./catalogScheduleInventory";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { runSqlTransaction } from "./sqlTransaction";

type Source = Readonly<{ sourceId: string; role: "erp-customers" | "sag-admin";
  bindingVersion: string; profileVersion: string }>;
type Evidence = CatalogOperationalLink["evidence"];
type Link = Readonly<{ linkId: string; evidence: Evidence }>;
type Approval = Readonly<{ populationId: string; portalEnvironment: CatalogEnvironment;
  sourceCount: number; linkCount: number; digest: Buffer; approvedAt: Date; validUntil: Date }>;
type Observations = Readonly<{
  approvals: readonly Approval[];
  sources: readonly (Source & { certified: boolean })[];
  edges: readonly (Link & { sourceId: string })[];
}>;

const incomplete = { id: "catalog-population-unverified", complete: false } as const;
export type CatalogSchedulePopulationCoverage = typeof incomplete |
  Readonly<{ id: string; complete: true; validUntil: Date }>;
const uuid = (id: unknown): id is string => typeof id === "string" && id.length === 36 &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
const version = (id: unknown): id is string => typeof id === "string" && id.length === 16 && /^[0-9a-f]{16}$/.test(id);
const environment = (id: unknown): id is CatalogEnvironment => id === "qa" || id === "production";
const instant = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.valueOf());
const validSource = (s: Source) => s && uuid(s.sourceId) && version(s.bindingVersion) && version(s.profileVersion) &&
  (s.role === "erp-customers" || s.role === "sag-admin");
const validRevision = (revision: unknown): revision is string => typeof revision === "string" &&
  /^[1-9][0-9]{0,18}$/.test(revision) && BigInt(revision) <= 9223372036854775807n;
const unavailable = (): never => { throw new Error("catalog_schedule_population_unavailable"); };
export const catalogPopulationRevisionPrefix = "catalog-population-v1:";

/**
 * Portable v1 manifest format: SHA-256 of UTF-8 JSON
 * [domain separator, environment, source tuples sorted by UUID, link UUIDs sorted].
 * Canonical source tuples are [sourceId, role, bindingRowVersion, profileRowVersion].
 * Operational link UUIDs are immutable; all roles/versions are portal metadata,
 * not customer documents, connection information, hostnames, or secret references.
 */
export function catalogSchedulePopulationDigest(portalEnvironment: CatalogEnvironment, sources: readonly Source[],
  linkIds: readonly string[]): Buffer {
  if (!environment(portalEnvironment) || !Array.isArray(sources) || sources.length < 2 || sources.length > 50 ||
    sources.some(s => !validSource(s)) || sources.filter(s => s.role === "sag-admin").length !== 1 ||
    new Set(sources.map(s => s.sourceId)).size !== sources.length ||
    !Array.isArray(linkIds) || linkIds.length < 1 || linkIds.length > 5000 || linkIds.some(id => !uuid(id)) ||
    new Set(linkIds).size !== linkIds.length) throw new Error("catalog_population_invalid");
  const ordered = [...sources].sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0)
    .map(s => [s.sourceId, s.role, s.bindingVersion, s.profileVersion]);
  return createHash("sha256").update(JSON.stringify(
    ["portal-sag:catalog-schedule-population:v1", portalEnvironment, ordered, [...linkIds].sort()]), "utf8").digest();
}

function verifiedMatches(left: Evidence, right: Evidence, source: Source, checked: number): boolean {
  if (!left || !right || left.state !== right.state) return false;
  if (left.state === "unverifiable") return true;
  if (left.state !== "verified" || right.state !== "verified") return false;
  return left.sourceId === source.sourceId && right.sourceId === source.sourceId &&
    left.bindingVersion === source.bindingVersion && right.bindingVersion === source.bindingVersion &&
    left.profileVersion === source.profileVersion && right.profileVersion === source.profileVersion &&
    validRevision(left.revisionId) && left.revisionId === right.revisionId &&
    typeof left.verifiedUntil === "string" && Date.parse(left.verifiedUntil) > checked &&
    left.verifiedUntil === right.verifiedUntil;
}

/** A roster can include known-held edges, but can never certify an unknown or truncated population. */
export function assessCatalogSchedulePopulation(input: Observations & Readonly<{
  portalEnvironment: CatalogEnvironment; checkedAt: Date; now: Date; plannedLinks: readonly Link[];
}>): CatalogSchedulePopulationCoverage {
  const { approvals, sources, edges, plannedLinks, portalEnvironment, checkedAt, now } = input;
  if (!environment(portalEnvironment) || !instant(checkedAt) || !instant(now) || approvals.length !== 1 ||
    edges.length < 1 || edges.length > 5000 || edges.length !== plannedLinks.length ||
    sources.length < 2 || sources.length > 50) return incomplete;
  const a = approvals[0];
  const checked = Math.max(checkedAt.valueOf(), now.valueOf());
  if (!a || !uuid(a.populationId) || a.portalEnvironment !== portalEnvironment ||
    a.sourceCount !== sources.length || a.linkCount !== edges.length || !Buffer.isBuffer(a.digest) || a.digest.length !== 32 ||
    !instant(a.approvedAt) || !instant(a.validUntil) || a.approvedAt > now || a.validUntil.valueOf() <= checked ||
    a.validUntil.valueOf() > a.approvedAt.valueOf() + 30 * 24 * 60 * 60_000) return incomplete;
  if (sources.some(s => !validSource(s) || s.certified !== true)) return incomplete;
  const sourceById = new Map(sources.map(s => [s.sourceId, s]));
  const planned = new Map(plannedLinks.map(l => [l.linkId, l.evidence]));
  if (planned.size !== plannedLinks.length) return incomplete;
  const ids = new Set<string>();
  for (const edge of edges) {
    if (!uuid(edge.linkId) || ids.has(edge.linkId)) return incomplete;
    ids.add(edge.linkId);
    const source = sourceById.get(edge.sourceId);
    const observed = planned.get(edge.linkId);
    if (!source || source.role !== "erp-customers" || !observed ||
        !verifiedMatches(observed, edge.evidence, source, checked)) return incomplete;
  }
  try {
    if (!a.digest.equals(catalogSchedulePopulationDigest(portalEnvironment, sources, [...ids]))) return incomplete;
  } catch { return incomplete; }
  return { id: `${catalogPopulationRevisionPrefix}${a.populationId}`, complete: true, validUntil: a.validUntil };
}

const currentApproval = `
FROM scheduling.catalog_schedule_population_approvals a WITH (HOLDLOCK)
JOIN security.users u WITH (HOLDLOCK) ON u.user_key=a.approved_by AND u.active=1
JOIN security.user_roles ur WITH (HOLDLOCK) ON ur.user_key=u.user_key AND ur.role_id=N'super_admin'
JOIN security.roles rr WITH (HOLDLOCK) ON rr.role_id=ur.role_id AND rr.active=1 AND rr.system_role=1 AND rr.protected_role=1
WHERE a.portal_environment=@portalEnvironment AND DATALENGTH(a.portal_environment)=DATALENGTH(@portalEnvironment)
  AND a.retired_at IS NULL AND a.approved_at<=@now AND a.valid_until>@now`;

export const readCatalogSchedulePopulationSql = `
SET NOCOUNT ON;
DECLARE @now datetime2(3)=SYSUTCDATETIME();
SELECT TOP (2) LOWER(CONVERT(char(36),a.population_id)) AS populationId,a.portal_environment AS portalEnvironment,
  a.source_count AS sourceCount,a.link_count AS linkCount,a.population_sha256 AS digest,
  a.approved_at AS approvedAt,a.valid_until AS validUntil
${currentApproval};

SELECT TOP (51) LOWER(CONVERT(char(36),b.source_id)) AS sourceId,b.source_role AS role,
  LOWER(CONVERT(char(16),b.row_version,2)) AS bindingVersion, LOWER(CONVERT(char(16),p.row_version,2)) AS profileVersion,
  CONVERT(bit,CASE WHEN p.active=1 AND p.status='active' AND p.encrypt_connection=1 AND p.password_configured=1
    AND b.validated_at<=@now AND b.validated_profile_version=p.row_version
    AND ((b.source_role='erp-customers' AND b.contract_version='erp_v1') OR
      (b.source_role='sag-admin' AND b.contract_version='sag_admin_v1')) THEN 1 ELSE 0 END) AS certified
FROM settings.catalog_source_bindings b WITH (HOLDLOCK)
JOIN settings.external_database_connections p WITH (HOLDLOCK) ON p.external_database_connection_key=b.external_database_connection_key
WHERE b.portal_environment=@portalEnvironment COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(b.portal_environment)=DATALENGTH(@portalEnvironment) AND b.source_state='active'
ORDER BY b.catalog_source_key;

SELECT TOP (5001) LOWER(CONVERT(char(36),l.link_id)) AS linkId,
  LOWER(CONVERT(char(36),b.source_id)) AS sourceId,
  e.evidence_state AS state,
  CASE WHEN e.evidence_state='verified' THEN CONVERT(varchar(20),e.revision_key) END AS revisionId,
  CASE WHEN e.evidence_state='verified' THEN LOWER(CONVERT(char(16),e.binding_version,2)) END AS bindingVersion,
  CASE WHEN e.evidence_state='verified' THEN LOWER(CONVERT(char(16),e.profile_version,2)) END AS profileVersion,
  CASE WHEN e.evidence_state='verified' THEN e.verified_until END AS verifiedUntil
FROM core.catalog_operational_links l WITH (HOLDLOCK)
JOIN core.catalog_operational_owners o WITH (HOLDLOCK) ON o.owner_key=l.owner_key
JOIN settings.catalog_source_bindings b WITH (HOLDLOCK) ON b.catalog_source_key=l.catalog_source_key
LEFT JOIN core.catalog_operational_link_evidence e WITH (HOLDLOCK) ON e.link_key=l.link_key
WHERE l.portal_environment=@portalEnvironment AND DATALENGTH(l.portal_environment)=DATALENGTH(@portalEnvironment)
  AND l.retired_at IS NULL AND o.retired_at IS NULL
ORDER BY l.link_key;
`;

/** Locks the approval through registration. This is not a fence for mutations of the full population. */
export async function lockSqlCatalogSchedulePopulationApproval(transaction: sql.Transaction, portalEnvironment: CatalogEnvironment,
  revisionId: string): Promise<Date | null> {
  const populationId = revisionId.startsWith(catalogPopulationRevisionPrefix) ?
    revisionId.slice(catalogPopulationRevisionPrefix.length) : null;
  if (!uuid(populationId) || !environment(portalEnvironment)) return null;
  try {
    const { recordset } = await new sql.Request(transaction)
      .input("portalEnvironment", sql.VarChar(10), portalEnvironment)
      .input("populationId", sql.UniqueIdentifier, populationId)
      .query<{ validUntil: Date }>(`DECLARE @now datetime2(3)=SYSUTCDATETIME();
        SELECT a.valid_until AS validUntil ${currentApproval} AND a.population_id=@populationId
          AND a.valid_until>SYSUTCDATETIME();`);
    const validUntil = recordset.length === 1 ? recordset[0].validUntil : null;
    return instant(validUntil) ? validUntil : null;
  } catch { return unavailable(); }
}

/** Internal only; validates one fresh SQL view of all expected open links under SERIALIZABLE. */
export async function readSqlCatalogSchedulePopulationCoverage(
  scope: CatalogInventoryProofScope,
): Promise<CatalogSchedulePopulationCoverage> {
  if (!validScope(scope)) return incomplete;
  try {
    const result = await runSqlTransaction(transaction => readSqlCatalogSchedulePopulationCoverageInTransaction(transaction, scope));
    return result.complete && result.validUntil.valueOf() <= Date.now() ? incomplete : result;
  } catch { return unavailable(); }
}

function validScope(scope: CatalogInventoryProofScope): boolean {
  return !!scope && environment(scope.portalEnvironment) && instant(scope.checkedAt) &&
    Array.isArray(scope.links) && scope.links.length >= 1 && scope.links.length <= 5000;
}

/** Retain every source/edge/approval read lock in the caller's SERIALIZABLE transaction. */
export async function readSqlCatalogSchedulePopulationCoverageInTransaction(
  transaction: sql.Transaction, scope: CatalogInventoryProofScope,
): Promise<CatalogSchedulePopulationCoverage> {
  if (!validScope(scope)) return incomplete;
  try {
      const { recordsets } = await new sql.Request(transaction)
        .input("portalEnvironment", sql.VarChar(10), scope.portalEnvironment)
        .query(readCatalogSchedulePopulationSql);
      if (!Array.isArray(recordsets) || recordsets.length !== 3 || !recordsets.every(Array.isArray)) return unavailable();
      const [approvals, sources, links] = recordsets as unknown as [Approval[], Observations["sources"],
        Array<Record<string, unknown>>];
      if (approvals.length !== 1 || sources.length < 2 || sources.length > 50 || links.length > 5000) return incomplete;
      const edges: Observations["edges"] = links.map(({ linkId, sourceId, state, revisionId, bindingVersion,
        profileVersion, verifiedUntil }) => {
        if (!uuid(linkId) || !uuid(sourceId)) return unavailable();
        if (state === "unverifiable" && [revisionId, bindingVersion, profileVersion, verifiedUntil].every(value => value === null)) {
          return { linkId, sourceId, evidence: { state } };
        }
        if (state !== "verified" || !validRevision(revisionId) || !version(bindingVersion) ||
            !version(profileVersion) || !instant(verifiedUntil)) return unavailable();
        return { linkId, sourceId, evidence: { state, sourceId, revisionId, bindingVersion, profileVersion,
          verifiedUntil: verifiedUntil.toISOString() } };
      });
      return assessCatalogSchedulePopulation({ ...scope, plannedLinks: scope.links, now: new Date(),
        approvals, sources, edges });
  } catch { return unavailable(); }
}
