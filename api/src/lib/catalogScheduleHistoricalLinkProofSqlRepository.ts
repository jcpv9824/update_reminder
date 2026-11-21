import sql from "mssql";
import { deriveCatalogSagCompanyLocationToken } from "./catalogSagCompanyLocationProof";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";

type Kind = "domain" | "database";
type TargetEnvironment = "production" | "test" | "demo";
type SourceHead = Readonly<{ sourceId: string; role: "erp-customers" | "sag-admin"; revisionId: string }>;
type LinkPin = Readonly<{ linkId: string; kind: Kind; targetId: string }>;
type HistoricalRequestLink = LinkPin | Readonly<{ linkId: string; kind: null; targetId: null }>;
export type CatalogScheduleHistoricalLinkScope = Readonly<{
  environment: CatalogEnvironment;
  asOf: Date;
  heads: readonly SourceHead[];
  /** targetId is the exact physical UUID on the frozen selection, not a logical target ID. */
  links: readonly LinkPin[];
  /** Read only the module IDs already approved at the historical cutoff. */
  includeLicenses?: boolean;
  /** Optional server-owned capability, never taken from the client. */
  scheduleKey?: string;
  matchKeyVersion?: number;
  matchKey?: Buffer;
}>;
export type CatalogScheduleHistoricalLinkProof = Readonly<{
  linkId: string;
  state: "eligible" | "absent" | "unverifiable";
  kind: Kind;
  environment: TargetEnvironment;
  clientId: string; clientName: string; domainId: string; domainName: string;
  /** Stable local logical domain or database source ID. */
  targetId: string; targetName: string; verifiedTargetId: string | null;
  /** Null is unknown; an empty array is a verified empty module set. */
  historicalModuleIds?: readonly string[] | null;
}>;

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const identifier = (value: unknown): value is string => typeof value === "string" && value.length === 36 && uuid.test(value);
const knownKind = (value: unknown): value is Kind => value === "domain" || value === "database";
const knownEnv = (value: unknown): value is TargetEnvironment => value === "production" || value === "test" || value === "demo";
const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= limit && value === value.trim() && !/\p{C}/u.test(value);
const time = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.valueOf());
const optionalTime = (value: unknown): value is Date | null => value === null || time(value);
const beforeOrAt = (value: unknown, boundary: Date) => time(value) && value <= boundary;
const futureOrNull = (value: unknown, boundary: Date) => value === null || (time(value) && value > boundary);
const sqlBigint = (value: unknown): value is string => typeof value === "string" &&
  /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const companyId = (value: unknown): value is number => integer(value, -2147483648, 2147483647);
const maxCompanyClaims = 8;
const compareLocationProc = "settings.verify_catalog_historical_schedule_company_locations";
type HistoricalV2Config = Readonly<{ scheduleKey: string; matchKeyVersion: number; matchKey: Buffer }>;
type HistoricalV2Claim = Readonly<{
  linkId: string; physicalTargetId: string; physicalLinkId: string; profileVersion: string;
  sagSourceId: string; sagRevisionId: string; sagCustomerRecordId: number; companyRecordId: number; locationTokenHex: string;
}>;
function safeDomainLabel(value: unknown): value is string {
  if (!text(value, 253) || /[^A-Za-z0-9.-]/.test(value)) return false;
  const labels = value.split(".");
  return labels.length > 1 && /[A-Za-z]/.test(labels[labels.length - 1]) &&
    labels.every(label => label.length > 0 && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-"));
}

/**
 * Only exact requested 042 pins and validated 050 revisions. Read under the
 * caller's transaction/locks. Do not query the live external databases or
 * read profile credentials. For V2 the private projection includes the exact
 * 036-pinned profile's location only. 055 denies direct reads of the sealed
 * token and seal to runtime; the protected historical RPC performs equality.
 */
export const catalogScheduleHistoricalLinkProofSql = `
SET NOCOUNT ON;
DECLARE @historicalHeads table(catalog_source_key bigint NOT NULL PRIMARY KEY,
  revision_key bigint NOT NULL UNIQUE,source_role varchar(15) NOT NULL,contract_version varchar(20) NOT NULL,
  match_key_version smallint NOT NULL,source_id uniqueidentifier NOT NULL);

INSERT @historicalHeads
SELECT b.catalog_source_key,r.revision_key,b.source_role,b.contract_version,r.match_key_version,b.source_id
FROM OPENJSON(@heads) WITH (sourceId uniqueidentifier,role varchar(15),revisionId varchar(19)) req
JOIN settings.catalog_source_bindings b WITH (HOLDLOCK) ON b.source_id=req.sourceId
  AND b.portal_environment=@environment COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(b.portal_environment)=DATALENGTH(@environment)
  AND b.source_role COLLATE Latin1_General_100_BIN2=req.role COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(b.source_role)=DATALENGTH(req.role) AND b.source_state='active'
  AND b.validated_at<=@asOf AND b.updated_at<=@asOf
JOIN settings.external_database_connections p WITH (HOLDLOCK) ON p.external_database_connection_key=b.external_database_connection_key
  AND p.active=1 AND p.status='active' AND p.encrypt_connection=1 AND p.password_configured=1 AND p.updated_at<=@asOf
  AND b.validated_profile_version=p.row_version
CROSS APPLY (
  SELECT TOP (1) e.revision_key,e.attempt_ordinal,e.attempt_status,e.attempted_at
  FROM settings.catalog_source_head_events e WITH (HOLDLOCK)
  WHERE e.catalog_source_key=b.catalog_source_key AND e.recorded_at<=@asOf
  ORDER BY e.head_event_key DESC
) h
JOIN core.catalog_customer_source_revisions r WITH (HOLDLOCK)
  ON r.revision_key=TRY_CONVERT(bigint,req.revisionId) AND r.revision_key=h.revision_key
  AND r.catalog_source_key=b.catalog_source_key AND r.source_role=b.source_role AND r.attempt_ordinal=h.attempt_ordinal
  AND r.binding_version=b.row_version AND r.profile_version=p.row_version
WHERE h.attempt_status='succeeded' AND h.attempted_at<=@asOf AND @asOf<=SYSUTCDATETIME()
  AND r.observed_at<=@asOf AND r.sealed_at<=@asOf AND r.verified_until>@asOf
  AND ((b.source_role='erp-customers' AND b.contract_version COLLATE Latin1_General_100_BIN2='erp_v1')
    OR (b.source_role='sag-admin' AND r.has_sag_inventory_evidence=1
      AND (b.contract_version COLLATE Latin1_General_100_BIN2='sag_admin_v1'
        OR (b.contract_version COLLATE Latin1_General_100_BIN2='sag_admin_v2' AND r.expected_sag_company_rows IS NOT NULL))));
DECLARE @sagContract varchar(20)=NULL;
IF (SELECT COUNT(*) FROM @historicalHeads WHERE source_role='sag-admin')=1
  AND (SELECT COUNT(*) FROM @historicalHeads)=(SELECT COUNT(*) FROM OPENJSON(@heads))
  SELECT @sagContract=contract_version FROM @historicalHeads WHERE source_role='sag-admin';
DECLARE @v2LocationReaderReady bit=0;
IF @requestV2=1 AND @sagContract='sag_admin_v2'
  AND COALESCE(HAS_PERMS_BY_NAME(N'settings.verify_catalog_historical_schedule_company_locations',N'OBJECT',N'EXECUTE'),0)=1
  SET @v2LocationReaderReady=1;

SELECT LOWER(CONVERT(char(36),l.link_id)) AS linkId,l.target_kind AS kind,l.link_environment AS environment,
  c.source_id AS clientId,c.name AS clientName,d.source_id AS domainId,safeDomain.label AS domainName,
  CASE WHEN l.target_kind='domain' THEN d.source_id ELSE db.source_id END AS targetId,
  CASE WHEN l.target_kind='domain' THEN safeDomain.label ELSE db.company_name END AS targetName,
  l.registered_at AS linkRegisteredAt,o.registered_at AS ownerRegisteredAt,
  l.retired_at AS linkRetiredAt,o.retired_at AS ownerRetiredAt,
  CASE WHEN erp.proved=1 THEN 1 ELSE 0 END AS erpProved,@sagContract AS sagContract,
  sag.proofCount AS sagDomainProofCount,
  historicalModules.value AS historicalModules,
  physical.proofCount AS physicalCount,
  CASE WHEN physical.targetId=LOWER(CONVERT(char(36),pin.targetId))
    OR (@discoverPopulation=1 AND pin.targetId IS NULL AND pin.kind IS NULL)
    THEN physical.targetId END AS physicalId,
  physical.createdAt AS physicalCreatedAt,
  physical.registeredAt AS physicalRegisteredAt,physical.verifiedAt AS physicalVerifiedAt,
  physical.validUntil AS physicalValidUntil,physical.retiredAt AS physicalRetiredAt,
  v2.includePins AS v2LocationReaderReady,
  CASE WHEN v2.includePins=1 THEN physical.linkId END AS physicalLinkId,
  CASE WHEN v2.includePins=1 THEN LOWER(CONVERT(char(16),ap.row_version,2)) END AS v2ProfileVersion,
  CASE WHEN v2.includePins=1 THEN sag.sourceId END AS v2SagSourceId,
  CASE WHEN v2.includePins=1 THEN CONVERT(varchar(20),sag.revisionId) END AS v2SagRevisionId,
  CASE WHEN v2.includePins=1 THEN sag.customerRecordId END AS v2SagCustomerRecordId,
  CASE WHEN v2.includePins=1 THEN sag.matchKeyVersion END AS v2MatchKeyVersion,
  CASE WHEN v2.includePins=1 THEN ap.server_host_port END AS v2ServerHostPort,
  CASE WHEN v2.includePins=1 THEN ap.initial_catalog END AS v2InitialCatalog,
  CASE WHEN v2.includePins=1 THEN (
    SELECT TOP (9) company.company_record_id AS companyRecordId
    FROM core.catalog_sag_company_revision_rows company WITH (HOLDLOCK)
    WHERE company.revision_key=sag.revisionId AND company.customer_record_id=sag.customerRecordId
      AND company.is_available=1
    ORDER BY company.company_record_id FOR JSON PATH
  ) END AS v2CompanyIds
FROM OPENJSON(@links) WITH (linkId uniqueidentifier,kind varchar(8),targetId uniqueidentifier) pin
JOIN core.catalog_operational_links l WITH (HOLDLOCK) ON l.link_id=pin.linkId
  AND (l.target_kind=pin.kind COLLATE Latin1_General_100_BIN2
    OR (@discoverPopulation=1 AND pin.targetId IS NULL AND pin.kind IS NULL))
  AND l.portal_environment=@environment COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(l.portal_environment)=DATALENGTH(@environment)
JOIN core.catalog_operational_owners o WITH (HOLDLOCK) ON o.owner_key=l.owner_key AND o.client_key=l.client_key
  AND o.portal_environment=l.portal_environment
JOIN core.clients c WITH (HOLDLOCK) ON c.client_key=l.client_key AND c.created_at<=@asOf AND c.updated_at<=@asOf
JOIN core.domains d WITH (HOLDLOCK) ON d.domain_key=l.domain_key AND d.client_key=l.client_key
  AND d.created_at<=@asOf AND d.updated_at<=@asOf
LEFT JOIN core.databases db WITH (HOLDLOCK) ON db.database_key=l.database_key AND db.domain_key=l.domain_key
  AND db.client_key=l.client_key AND db.created_at<=@asOf AND db.updated_at<=@asOf
LEFT JOIN core.database_access_profiles ap WITH (HOLDLOCK) ON ap.access_profile_key=db.access_profile_key
  AND ap.active=1 AND ap.created_at<=@asOf AND ap.updated_at<=@asOf
-- Historical operational names can be legacy URLs. Only project a plain
-- safe DNS label; reject paths, credentials, query/fragment, ports and IPs.
CROSS APPLY (VALUES(CASE WHEN LEFT(LOWER(d.domain_name_normalized),8)=N'https://'
  THEN SUBSTRING(d.domain_name_normalized,9,500) END)) domainInput(value)
CROSS APPLY (VALUES(CASE WHEN RIGHT(domainInput.value,1)=N'/'
  THEN LEFT(domainInput.value,CASE WHEN LEN(domainInput.value)>0 THEN LEN(domainInput.value)-1 ELSE 0 END)
  ELSE domainInput.value END)) safeDomain(label)
OUTER APPLY (
  SELECT 1 AS proved,rr.issuer,rr.document_type,rr.document_number_token,h.match_key_version
  FROM @historicalHeads h
  JOIN core.catalog_customer_source_revisions r WITH (HOLDLOCK) ON r.revision_key=h.revision_key
  JOIN core.catalog_operational_link_approvals a WITH (HOLDLOCK) ON a.link_key=l.link_key
    AND a.binding_version=r.binding_version AND a.profile_version=r.profile_version AND a.revision_key<=r.revision_key
    AND a.approved_at BETWEEN l.registered_at AND @asOf
  JOIN core.catalog_customer_revision_rows rr WITH (HOLDLOCK) ON rr.revision_key=r.revision_key
    AND rr.source_record_id=l.source_record_id AND rr.catalog_customer_key=o.catalog_customer_key
    AND rr.source_role='erp-customers' AND rr.active_code='S'
  WHERE h.catalog_source_key=l.catalog_source_key AND h.source_role='erp-customers'
    AND rr.issuer IS NOT NULL AND rr.document_type IS NOT NULL AND rr.document_number_token IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM core.catalog_customer_revision_rows competing WITH (HOLDLOCK)
      WHERE competing.revision_key=r.revision_key AND competing.source_record_id<>rr.source_record_id
      AND ((competing.catalog_customer_key=o.catalog_customer_key
        AND (competing.issuer IS NULL OR competing.document_type IS NULL OR competing.document_number_token IS NULL
          OR competing.issuer<>rr.issuer OR competing.document_type<>rr.document_type
          OR DATALENGTH(competing.document_type)<>DATALENGTH(rr.document_type) OR competing.document_number_token<>rr.document_number_token))
        OR (competing.catalog_customer_key<>o.catalog_customer_key AND competing.issuer=rr.issuer
          AND competing.document_type=rr.document_type AND DATALENGTH(competing.document_type)=DATALENGTH(rr.document_type)
          AND competing.document_number_token=rr.document_number_token)))
) erp
OUTER APPLY (
  -- A fresh historical SAG head alone proves nothing about the selected owner.
  -- Match the exact recorded document identity, canonical route and environment.
  SELECT COUNT(*) AS proofCount,MIN(LOWER(CONVERT(char(36),sh.source_id))) AS sourceId,
    MIN(sh.revision_key) AS revisionId,MIN(ownerRecord.source_record_id) AS customerRecordId,
    MIN(sh.match_key_version) AS matchKeyVersion, MIN(domainRecord.license_codes) AS licenseCodes
  FROM @historicalHeads sh
  JOIN core.catalog_customer_revision_rows ownerRecord WITH (HOLDLOCK)
    ON ownerRecord.revision_key=sh.revision_key AND ownerRecord.source_role='sag-admin'
    AND ownerRecord.issuer=erp.issuer AND ownerRecord.document_type=erp.document_type
    AND DATALENGTH(ownerRecord.document_type)=DATALENGTH(erp.document_type)
    AND ownerRecord.document_number_token=erp.document_number_token
  JOIN core.catalog_sag_revision_evidence domainRecord WITH (HOLDLOCK)
    ON domainRecord.revision_key=ownerRecord.revision_key AND domainRecord.source_record_id=ownerRecord.source_record_id
    AND domainRecord.domain_candidate COLLATE Latin1_General_100_BIN2=LOWER(safeDomain.label) COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(domainRecord.domain_candidate)=LEN(safeDomain.label)
    AND domainRecord.environment_kind=l.link_environment
    AND DATALENGTH(domainRecord.environment_kind)=DATALENGTH(l.link_environment)
  WHERE sh.source_role='sag-admin' AND sh.match_key_version=erp.match_key_version AND erp.proved=1
    AND NOT EXISTS(SELECT 1 FROM core.catalog_customer_revision_rows unresolved WITH (HOLDLOCK)
      WHERE unresolved.revision_key=sh.revision_key AND unresolved.issuer IS NULL
        AND unresolved.document_number_token=erp.document_number_token)
) sag
OUTER APPLY (
  SELECT COALESCE((
    SELECT DISTINCT m.source_id AS id
    FROM settings.catalog_sag_license_module_approvals a WITH (HOLDLOCK)
    JOIN licensing.license_modules m WITH (HOLDLOCK) ON m.module_key=a.module_key
    WHERE a.catalog_source_key=r.catalog_source_key AND a.binding_version=r.binding_version
      AND a.profile_version=r.profile_version AND a.approved_at<=@asOf
      AND m.status='active' AND m.deleted_at IS NULL AND m.created_at<=@asOf AND m.updated_at<=@asOf
      AND CHARINDEX(a.sag_code,sag.licenseCodes COLLATE Latin1_General_100_BIN2)>0
    ORDER BY m.source_id FOR JSON PATH
  ),N'[]') AS value
  FROM core.catalog_customer_source_revisions r WITH (HOLDLOCK)
  WHERE @includeLicenses=1 AND @sagContract IS NOT NULL AND sag.proofCount=1
    AND r.revision_key=sag.revisionId
    AND sag.licenseCodes IS NOT NULL AND DATALENGTH(sag.licenseCodes)<=25
    AND sag.licenseCodes COLLATE Latin1_General_100_BIN2 NOT LIKE '%[^A-SU-Z]%'
    AND DATALENGTH(sag.licenseCodes)=LEN(sag.licenseCodes)
    AND NOT EXISTS(
      SELECT 1 FROM core.catalog_customer_revision_rows ownerRow WITH (HOLDLOCK)
      LEFT JOIN core.catalog_sag_revision_evidence detail WITH (HOLDLOCK)
        ON detail.revision_key=ownerRow.revision_key AND detail.source_record_id=ownerRow.source_record_id
      WHERE ownerRow.revision_key=sag.revisionId AND ownerRow.issuer=erp.issuer
        AND ownerRow.document_type=erp.document_type AND DATALENGTH(ownerRow.document_type)=DATALENGTH(erp.document_type)
        AND ownerRow.document_number_token=erp.document_number_token
        AND (detail.environment_kind IS NULL OR detail.environment_kind='unknown'
          OR (detail.environment_kind=l.link_environment AND detail.domain_candidate IS NULL))
    )
    -- A missing or late mapping, including a changed module, is not non-membership.
    -- The unique mapping key and this count also reject repeated raw codes.
    AND DATALENGTH(sag.licenseCodes)=(
      SELECT COUNT(*) FROM settings.catalog_sag_license_module_approvals a WITH (HOLDLOCK)
      JOIN licensing.license_modules m WITH (HOLDLOCK) ON m.module_key=a.module_key
      WHERE a.catalog_source_key=r.catalog_source_key AND a.binding_version=r.binding_version
        AND a.profile_version=r.profile_version AND a.approved_at<=@asOf
        AND m.status='active' AND m.deleted_at IS NULL AND m.created_at<=@asOf AND m.updated_at<=@asOf
        AND CHARINDEX(a.sag_code,sag.licenseCodes COLLATE Latin1_General_100_BIN2)>0
    )
) historicalModules
OUTER APPLY (
  -- Count every applicable physical witness, not just the requested UUID;
  -- a competing proof for the same relation must not be hidden.
  SELECT COUNT(*) AS proofCount,
    MIN(LOWER(CONVERT(char(36),t.target_id))) AS targetId,
    MIN(LOWER(CONVERT(char(36),pt.link_id))) AS linkId,
    MIN(t.created_at) AS createdAt,MIN(pt.registered_at) AS registeredAt,MIN(pt.verified_at) AS verifiedAt,
    MIN(pt.valid_until) AS validUntil,MIN(pt.retired_at) AS retiredAt
  FROM core.catalog_physical_target_links pt WITH (HOLDLOCK)
  JOIN core.catalog_physical_targets t WITH (HOLDLOCK) ON t.physical_target_key=pt.physical_target_key
    AND t.portal_environment=l.portal_environment AND t.target_kind=l.target_kind AND t.created_at<=@asOf
  WHERE pt.portal_environment=l.portal_environment AND pt.target_kind=l.target_kind
    AND pt.client_key=l.client_key AND pt.domain_key=l.domain_key
    AND pt.registered_at<=@asOf AND pt.verified_at<=@asOf AND pt.valid_until>@asOf
    AND (pt.retired_at IS NULL OR pt.retired_at>@asOf)
    AND c.status='active' AND d.status='active'
    AND (c.deleted_at IS NULL OR c.deleted_at>@asOf) AND (d.deleted_at IS NULL OR d.deleted_at>@asOf)
    AND ((l.target_kind='domain' AND pt.database_key IS NULL
      AND d.environment_id COLLATE Latin1_General_100_BIN2=l.link_environment
      AND DATALENGTH(d.environment_id)=DATALENGTH(l.link_environment)
      AND pt.domain_route_fingerprint=HASHBYTES('SHA2_256',CONVERT(varbinary(max),N'portal-sag:web-route:v1|')
        + CONVERT(binary(4),DATALENGTH(d.domain_name_normalized)) + CONVERT(varbinary(max),d.domain_name_normalized)
        + CASE WHEN d.publishable_domain IS NULL THEN CONVERT(varbinary(max),0x00)
          ELSE CONVERT(varbinary(max),0x01) + CONVERT(binary(4),DATALENGTH(d.publishable_domain))
            + CONVERT(varbinary(max),d.publishable_domain) END))
      OR (l.target_kind='database' AND pt.database_key=l.database_key AND db.status='active'
        AND (db.deleted_at IS NULL OR db.deleted_at>@asOf)
        AND db.environment_id COLLATE Latin1_General_100_BIN2=l.link_environment
        AND DATALENGTH(db.environment_id)=DATALENGTH(l.link_environment)
        AND pt.access_profile_key=ap.access_profile_key AND pt.access_profile_version=ap.row_version))
) physical
CROSS APPLY (VALUES(CASE WHEN @v2LocationReaderReady=1 AND l.target_kind='database'
  AND sag.proofCount=1 AND physical.proofCount=1 AND (physical.targetId=LOWER(CONVERT(char(36),pin.targetId))
    OR (@discoverPopulation=1 AND pin.targetId IS NULL AND pin.kind IS NULL))
  AND l.registered_at<=@asOf AND o.registered_at<=@asOf
  AND (l.retired_at IS NULL OR l.retired_at>@asOf) AND (o.retired_at IS NULL OR o.retired_at>@asOf)
  THEN 1 ELSE 0 END)) v2(includePins)
WHERE @asOf<=SYSUTCDATETIME() AND (l.target_kind='domain' OR db.database_key IS NOT NULL)
  AND LEN(safeDomain.label) BETWEEN 3 AND 253 AND DATALENGTH(safeDomain.label)=2*LEN(safeDomain.label)
  AND CHARINDEX(N'.',safeDomain.label)>0 AND safeDomain.label NOT LIKE N'%..%'
  AND LEFT(safeDomain.label,1)<>N'.' AND RIGHT(safeDomain.label,1)<>N'.'
  AND REPLACE(safeDomain.label,N'-',N'') COLLATE Latin1_General_100_BIN2 NOT LIKE N'%[^A-Za-z0-9.]%'
  AND REVERSE(LEFT(REVERSE(safeDomain.label),CHARINDEX(N'.',REVERSE(safeDomain.label)+N'.')-1))
    COLLATE Latin1_General_100_BIN2 LIKE N'%[A-Za-z]%'
  AND NOT EXISTS(SELECT 1 FROM STRING_SPLIT(safeDomain.label,N'.') part
    WHERE LEN(part.value) NOT BETWEEN 1 AND 63 OR LEFT(part.value,1)=N'-' OR RIGHT(part.value,1)=N'-')
ORDER BY l.link_key;
`.trim();

function matchEvidence(row: Record<string, unknown>, pin: HistoricalRequestLink, asOf: Date, sourceWindowPresent: boolean):
  { proof: CatalogScheduleHistoricalLinkProof; candidateV2: boolean } | null {
  const { linkId, kind, environment, clientId, clientName, domainId, domainName, targetId, targetName,
    linkRegisteredAt, ownerRegisteredAt, linkRetiredAt, ownerRetiredAt, erpProved, sagContract, sagDomainProofCount,
    physicalCount, physicalId, physicalCreatedAt, physicalRegisteredAt, physicalVerifiedAt, physicalValidUntil, physicalRetiredAt } = row;
  if (pin.linkId !== linkId || !knownKind(kind) || (pin.kind !== null && kind !== pin.kind) ||
      !knownEnv(environment) || !text(clientId, 150) ||
      !text(domainId, 150) || !text(targetId, 150) || !text(clientName, 512) || !safeDomainLabel(domainName) ||
      !text(targetName, 512) || (kind === "domain" && (targetId !== domainId || targetName !== domainName)) ||
      !time(linkRegisteredAt) || !time(ownerRegisteredAt) || !optionalTime(linkRetiredAt) || !optionalTime(ownerRetiredAt) ||
      (linkRetiredAt !== null && linkRetiredAt < linkRegisteredAt) || (ownerRetiredAt !== null && ownerRetiredAt < ownerRegisteredAt)) return null;
  let state: CatalogScheduleHistoricalLinkProof["state"] = "unverifiable";
  let candidateV2 = false;
  if (linkRegisteredAt <= asOf && ownerRegisteredAt <= asOf) {
    if (beforeOrAt(linkRetiredAt, asOf) || beforeOrAt(ownerRetiredAt, asOf)) state = "absent";
    else if (sourceWindowPresent && erpProved === 1 && sagDomainProofCount === 1 &&
        (sagContract === "sag_admin_v1" || sagContract === "sag_admin_v2") &&
        physicalCount === 1 && identifier(physicalId) && (pin.targetId === null || physicalId === pin.targetId) &&
        beforeOrAt(physicalCreatedAt, asOf) &&
        beforeOrAt(physicalRegisteredAt, asOf) && beforeOrAt(physicalVerifiedAt, asOf) &&
        time(physicalValidUntil) && physicalValidUntil > asOf && futureOrNull(physicalRetiredAt, asOf)) {
      candidateV2 = kind === "database" && sagContract === "sag_admin_v2";
      if (!candidateV2) state = "eligible";
    }
  }
  return { candidateV2, proof: { linkId: pin.linkId, state, kind, environment, clientId, clientName, domainId, domainName,
    targetId, targetName, verifiedTargetId: state === "eligible" && identifier(physicalId) ? physicalId : null } };
}

function v2Claims(row: Record<string, unknown>, pin: LinkPin, scope: Pick<CatalogScheduleHistoricalLinkScope, "environment" | "heads">,
  config: HistoricalV2Config): readonly HistoricalV2Claim[] {
  const { physicalLinkId, v2LocationReaderReady, v2ProfileVersion: profileVersion,
    v2SagSourceId: sagSourceId, v2SagRevisionId: sagRevisionId, v2SagCustomerRecordId: sagCustomerRecordId,
    v2MatchKeyVersion, v2ServerHostPort, v2InitialCatalog, v2CompanyIds } = row;
  if (v2LocationReaderReady !== 1 || !identifier(physicalLinkId) || typeof profileVersion !== "string" ||
      !/^[0-9a-f]{16}$/.test(profileVersion) || !identifier(sagSourceId) || !sqlBigint(sagRevisionId) ||
      !companyId(sagCustomerRecordId) || v2MatchKeyVersion !== config.matchKeyVersion ||
      !scope.heads.some(head => head.role === "sag-admin" && head.sourceId === sagSourceId && head.revisionId === sagRevisionId) ||
      typeof v2ServerHostPort !== "string" || v2ServerHostPort.length > 259 ||
      typeof v2CompanyIds !== "string" || v2CompanyIds.length > 512) return [];
  const address = /^([A-Za-z0-9.-]{3,253}),([0-9]{1,5})(?![\s\S])/.exec(v2ServerHostPort);
  if (!address) return [];
  let companyRows: unknown;
  try { companyRows = JSON.parse(v2CompanyIds); } catch { return []; }
  if (!Array.isArray(companyRows) || !companyRows.length || companyRows.length > maxCompanyClaims) return [];
  const seen = new Set<number>();
  const claims: HistoricalV2Claim[] = [];
  for (const company of companyRows) {
    if (!company || typeof company !== "object" || Object.keys(company).length !== 1 ||
        !companyId(company.companyRecordId) || seen.has(company.companyRecordId)) return [];
    const companyRecordId = company.companyRecordId;
    seen.add(companyRecordId);
    const locationTokenHex = deriveCatalogSagCompanyLocationToken({
      environment: scope.environment, sourceId: sagSourceId, companyRecordId, matchKeyVersion: config.matchKeyVersion,
    }, config.matchKey, {
      status: "candidate", host: address[1].toLowerCase(), port: Number(address[2]), databaseName: v2InitialCatalog,
    });
    if (!locationTokenHex) return [];
    claims.push({ linkId: pin.linkId, physicalTargetId: pin.targetId, physicalLinkId, profileVersion,
      sagSourceId, sagRevisionId, sagCustomerRecordId, companyRecordId, locationTokenHex });
  }
  return claims;
}

async function verifyV2Locations(transaction: sql.Transaction, scope: Pick<CatalogScheduleHistoricalLinkScope, "environment" | "asOf">,
  config: HistoricalV2Config, claims: readonly HistoricalV2Claim[]): Promise<ReadonlySet<string>> {
  const claimedLinks = new Set(claims.map(claim => claim.linkId));
  try {
    // Sealed tokens never leave the database. SQL correlates exact historical
    // pins and compares fixed-length bytes, returning only the match count.
    const { recordset } = await transaction.request().input("environment", sql.VarChar(10), scope.environment)
      .input("scheduleKey", sql.VarChar(20), config.scheduleKey).input("asOf", sql.DateTime2(3), scope.asOf)
      .input("matchKeyVersion", sql.SmallInt, config.matchKeyVersion)
      .input("claims", sql.NVarChar(sql.MAX), JSON.stringify(claims)).execute(compareLocationProc);
    if (!Array.isArray(recordset) || recordset.length > claimedLinks.size) return new Set();
    const verified = new Set<string>();
    const returned = new Set<string>();
    for (const row of recordset) {
      if (!row || !claimedLinks.has(row.linkId) || returned.has(row.linkId) || !integer(row.matchCount, 0, 100000)) return new Set();
      returned.add(row.linkId);
      if (row.matchCount === 1) verified.add(row.linkId);
    }
    return verified;
  } catch { return new Set(); }
}

function parseHistoricalModuleIds(value: unknown): readonly string[] | null {
  if (typeof value !== "string" || value.length > 26000) return null;
  try {
    const rows: unknown = JSON.parse(value);
    if (!Array.isArray(rows) || rows.length > 25) return null;
    const ids = new Set<string>();
    for (const row of rows) {
      if (!row || typeof row !== "object" || Object.keys(row).length !== 1 || !text(row.id, 150) || ids.has(row.id)) return null;
      ids.add(row.id);
    }
    return [...ids];
  } catch { return null; }
}

export async function readCatalogScheduleHistoricalLinkProofInTransaction(
  transaction: sql.Transaction, scope: CatalogScheduleHistoricalLinkScope,
): Promise<readonly CatalogScheduleHistoricalLinkProof[] | null> {
  return readHistorical(transaction, scope, scope.links, false);
}

/** Only use IDs from the cutoff certificate or exact historical retirements in the same transaction. */
export async function readCatalogScheduleHistoricalPopulationInTransaction(transaction: sql.Transaction,
  scope: Omit<CatalogScheduleHistoricalLinkScope, "links">,
  certifiedIds: readonly string[],
): Promise<readonly CatalogScheduleHistoricalLinkProof[] | null> {
  if (!Array.isArray(certifiedIds) || certifiedIds.length > 5000) return null;
  return readHistorical(transaction, scope,
    certifiedIds.map(linkId => ({ linkId, kind: null, targetId: null })), true);
}

async function readHistorical(transaction: sql.Transaction, scope: Omit<CatalogScheduleHistoricalLinkScope, "links">,
  links: readonly HistoricalRequestLink[], discoverPopulation: boolean,
): Promise<readonly CatalogScheduleHistoricalLinkProof[] | null> {
  if ((scope.environment !== "qa" && scope.environment !== "production") || !time(scope.asOf) ||
      !Array.isArray(scope.heads) || scope.heads.length > 50 || !Array.isArray(links) || links.length > 5000) return null;
  const sources = new Set<string>();
  const revisions = new Set<string>();
  let sagCount = 0;
  for (const head of scope.heads) {
    if (!head || !identifier(head.sourceId) || sources.has(head.sourceId) || !sqlBigint(head.revisionId) ||
        revisions.has(head.revisionId) || (head.role !== "erp-customers" && head.role !== "sag-admin") ||
        (head.role === "sag-admin" && ++sagCount > 1)) return null;
    sources.add(head.sourceId);
    revisions.add(head.revisionId);
  }
  const pins = new Map<string, HistoricalRequestLink>();
  for (const pin of links) {
    if (!pin || !identifier(pin.linkId) || pins.has(pin.linkId) || (discoverPopulation
      ? pin.targetId !== null || pin.kind !== null : !identifier(pin.targetId) || !knownKind(pin.kind))) return null;
    pins.set(pin.linkId, pin.kind === null ? { linkId: pin.linkId, kind: null, targetId: null }
      : { linkId: pin.linkId, kind: pin.kind, targetId: pin.targetId });
  }
  if (!pins.size) return [];
  const v2Config = sqlBigint(scope.scheduleKey) && integer(scope.matchKeyVersion, 1, 32767) &&
    Buffer.isBuffer(scope.matchKey) && scope.matchKey.length === 32
    ? { scheduleKey: scope.scheduleKey, matchKeyVersion: scope.matchKeyVersion, matchKey: scope.matchKey } : null;
  try {
    const { recordset } = await transaction.request().input("environment", sql.VarChar(10), scope.environment)
      .input("asOf", sql.DateTime2(3), scope.asOf)
      .input("requestV2", sql.Bit, v2Config !== null)
      .input("discoverPopulation", sql.Bit, discoverPopulation)
      .input("includeLicenses", sql.Bit, scope.includeLicenses === true)
      .input("heads", sql.NVarChar(sql.MAX), JSON.stringify(scope.heads.map(({ sourceId, role, revisionId }) => ({ sourceId, role, revisionId }))))
      .input("links", sql.NVarChar(sql.MAX), JSON.stringify([...pins.values()])).query(catalogScheduleHistoricalLinkProofSql);
    if (!Array.isArray(recordset) || recordset.length !== pins.size) return null;
    const result: CatalogScheduleHistoricalLinkProof[] = [];
    const claims: HistoricalV2Claim[] = [];
    const candidates = new Map<string, string>();
    const modulesByLink = new Map<string, { ids: readonly string[] | null; verifiedSource: boolean }>();
    for (const row of recordset) {
      const pin = row && pins.get(row.linkId);
      if (!pin) return null;
      const evidence = matchEvidence(row, pin, scope.asOf, sagCount === 1 && sources.size > 1);
      if (!evidence) return null;
      result.push(evidence.proof);
      if (scope.includeLicenses === true) modulesByLink.set(pin.linkId, {
        ids: parseHistoricalModuleIds(row.historicalModules),
        verifiedSource: discoverPopulation && sagCount === 1 && sources.size > 1 && evidence.proof.state !== "absent" &&
          beforeOrAt(row.linkRegisteredAt, scope.asOf) && beforeOrAt(row.ownerRegisteredAt, scope.asOf) &&
          row.erpProved === 1 && row.sagDomainProofCount === 1 &&
          (row.sagContract === "sag_admin_v1" || row.sagContract === "sag_admin_v2"),
      });
      const physicalPin: LinkPin | null = pin.kind !== null ? pin
        : identifier(row.physicalId) ? { linkId: pin.linkId, kind: evidence.proof.kind, targetId: row.physicalId } : null;
      if (v2Config && evidence.candidateV2 && physicalPin) {
        const localClaims = v2Claims(row, physicalPin, scope, v2Config);
        if (localClaims.length) {
          claims.push(...localClaims);
          candidates.set(pin.linkId, physicalPin.targetId);
        }
      }
      pins.delete(pin.linkId);
    }
    const verified = v2Config && claims.length ? await verifyV2Locations(transaction, scope, v2Config, claims) : new Set<string>();
    return result.map(proof => {
      const physicalTarget = candidates.get(proof.linkId);
      const finalProof: CatalogScheduleHistoricalLinkProof = physicalTarget && verified.has(proof.linkId)
        ? { ...proof, state: "eligible", verifiedTargetId: physicalTarget }
        : proof;
      const moduleWitness = modulesByLink.get(proof.linkId);
      return scope.includeLicenses === true
        ? { ...finalProof, historicalModuleIds: finalProof.state === "eligible" || moduleWitness?.verifiedSource
          ? moduleWitness?.ids ?? null : null }
        : finalProof;
    });
  } catch { return null; }
}
