import sql from "mssql";

export type CatalogExecutionLicenseProofInput = Readonly<{
  executionId: string | number;
  portalEnvironment: "qa" | "production";
  matchKeyVersion: number;
  attachments: readonly { linkId: string; scheduleId: string; moduleIds: readonly string[] }[];
  /** Only separately certified, previously unbound 042 aliases used for provenance. */
  proofOnlyLinks?: readonly string[];
}>;

// Internal values only. This batch returns one deadline or no row; document
// comparison tokens never leave SQL. The caller owns the SERIALIZABLE transaction.
const licenseProofSql = `
SET NOCOUNT ON;
DECLARE @now datetime2(3)=SYSUTCDATETIME();
IF NOT EXISTS (SELECT 1 FROM settings.catalog_match_key_registry WITH (HOLDLOCK)
  WHERE portal_environment=@portalEnvironment COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(portal_environment)=DATALENGTH(@portalEnvironment)
    AND match_key_version=@matchKeyVersion AND enrolled_at<=@now) RETURN;

DECLARE @requested TABLE (ordinal int PRIMARY KEY,link_id nvarchar(260) COLLATE Latin1_General_100_BIN2,
  schedule_id nvarchar(150) COLLATE Latin1_General_100_BIN2,modules nvarchar(max),proof_only bit NOT NULL);
INSERT @requested SELECT CONVERT(int,j.[key]),p.linkId,p.scheduleId,p.moduleIds,COALESCE(p.proofOnly,0)
FROM OPENJSON(@attachments) j CROSS APPLY OPENJSON(j.[value]) WITH
  (linkId nvarchar(260),scheduleId nvarchar(150),moduleIds nvarchar(max) AS JSON,proofOnly bit) p;

DECLARE @sag TABLE (source_key bigint PRIMARY KEY,revision_key bigint,binding_version binary(8),
  profile_version binary(8),valid_until datetime2(3));
-- Lock even an unusable active SAG binding: ambiguity is not permission to choose another.
IF (SELECT COUNT_BIG(*) FROM settings.catalog_source_bindings WITH (HOLDLOCK)
  WHERE source_role='sag-admin' AND source_state='active'
    AND portal_environment=@portalEnvironment COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(portal_environment)=DATALENGTH(@portalEnvironment))<>1 RETURN;
INSERT @sag
SELECT b.catalog_source_key,r.revision_key,b.row_version,p.row_version,r.verified_until
FROM settings.catalog_source_bindings b WITH (HOLDLOCK)
JOIN settings.external_database_connections p WITH (HOLDLOCK)
  ON p.external_database_connection_key=b.external_database_connection_key
JOIN settings.catalog_customer_revision_heads h WITH (HOLDLOCK) ON h.catalog_source_key=b.catalog_source_key
JOIN core.catalog_customer_source_revisions r WITH (HOLDLOCK)
  ON r.revision_key=h.revision_key AND r.catalog_source_key=b.catalog_source_key AND r.source_role=b.source_role
WHERE b.portal_environment=@portalEnvironment COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(b.portal_environment)=DATALENGTH(@portalEnvironment)
  AND b.source_role='sag-admin' AND b.source_state='active' AND b.contract_version='sag_admin_v1'
  AND b.validated_at<=@now AND b.validated_profile_version=p.row_version
  AND p.active=1 AND p.status='active' AND p.encrypt_connection=1 AND p.password_configured=1
  AND h.attempt_status='succeeded' AND h.attempted_at<=@now
  AND r.binding_version=b.row_version AND r.profile_version=p.row_version AND r.match_key_version=@matchKeyVersion
  AND r.sealed_at<=@now AND r.observed_at<=@now AND r.verified_until>@now AND r.has_sag_inventory_evidence=1;
IF (SELECT COUNT_BIG(*) FROM @sag)<>1 RETURN;

DECLARE @eligible TABLE (ordinal int PRIMARY KEY,schedule_key bigint,match_mode varchar(10),
  hostname nvarchar(253) COLLATE Latin1_General_100_BIN2,environment_id varchar(20) COLLATE Latin1_General_100_BIN2,
  erp_revision bigint,erp_until datetime2(3),parent_until datetime2(3),issuer char(2) COLLATE Latin1_General_100_BIN2,
  document_type varchar(32) COLLATE Latin1_General_100_BIN2,document_token binary(32));
INSERT @eligible
SELECT q.ordinal,s.schedule_key,ls.license_match_mode,host.hostname,l.link_environment,r.revision_key,r.verified_until,parent.valid_until,
  erp.issuer,erp.document_type,erp.document_number_token
FROM @requested q
JOIN workflow.catalog_task_executions e WITH (HOLDLOCK)
  ON e.catalog_execution_key=@executionId AND e.retired_at IS NULL AND e.cutoff_at>@now
CROSS APPLY (
  SELECT stored.link_id COLLATE Latin1_General_100_BIN2 AS link_id,
    stored.execution_kind COLLATE Latin1_General_100_BIN2 AS execution_kind,stored.client_key,stored.domain_key,stored.database_key,
    stored.catalog_source_key,stored.catalog_record_id COLLATE Latin1_General_100_BIN2 AS catalog_record_id,
    stored.link_environment COLLATE Latin1_General_100_BIN2 AS link_environment
  FROM workflow.catalog_task_execution_links stored WITH (HOLDLOCK)
  WHERE q.proof_only=0 AND stored.catalog_execution_key=e.catalog_execution_key AND stored.execution_kind=e.execution_kind
    AND stored.link_id=q.link_id AND DATALENGTH(stored.link_id)=DATALENGTH(q.link_id)
    AND stored.link_state='active' AND stored.retired_at IS NULL AND stored.catalog_source_key IS NOT NULL
  UNION ALL
  SELECT q.link_id COLLATE Latin1_General_100_BIN2,e.execution_kind COLLATE Latin1_General_100_BIN2,
    external_link.client_key,external_link.domain_key,external_link.database_key,
    external_link.catalog_source_key,CONVERT(nvarchar(11),external_link.source_record_id) COLLATE Latin1_General_100_BIN2,
    external_link.link_environment COLLATE Latin1_General_100_BIN2
  FROM core.catalog_operational_link_evidence external_link WITH (HOLDLOCK)
  WHERE q.proof_only=1 AND DATALENGTH(q.link_id)=72
    AND q.link_id=LOWER(CONVERT(nvarchar(36),external_link.link_id)) COLLATE Latin1_General_100_BIN2
    AND external_link.portal_environment=@portalEnvironment COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(external_link.portal_environment)=DATALENGTH(@portalEnvironment)
    AND external_link.target_kind=e.execution_kind COLLATE Latin1_General_100_BIN2
    AND external_link.retired_at IS NULL AND external_link.owner_retired_at IS NULL AND external_link.evidence_state='verified'
    -- Never let receipt mode stand in for a hidden/retired execution link.
    AND NOT EXISTS(SELECT 1 FROM workflow.catalog_task_execution_links prior WITH (HOLDLOCK)
      WHERE prior.catalog_execution_key=e.catalog_execution_key AND prior.link_id=q.link_id)
) l
JOIN core.clients c WITH (HOLDLOCK) ON c.client_key=l.client_key AND c.status='active'
JOIN core.domains d WITH (HOLDLOCK) ON d.domain_key=l.domain_key AND d.client_key=l.client_key AND d.status='active'
LEFT JOIN core.databases db WITH (HOLDLOCK) ON db.database_key=l.database_key
  AND db.domain_key=l.domain_key AND db.client_key=l.client_key AND db.status='active'
JOIN scheduling.update_schedules s WITH (HOLDLOCK)
  ON s.source_id COLLATE Latin1_General_100_BIN2=q.schedule_id
  AND DATALENGTH(s.source_id)=DATALENGTH(q.schedule_id)
  AND s.active=1 AND s.deleted_at IS NULL AND s.selection_mode='licensing'
JOIN scheduling.licensing_scope ls WITH (HOLDLOCK) ON ls.schedule_key=s.schedule_key
JOIN core.catalog_operational_link_evidence bridge WITH (HOLDLOCK)
  ON bridge.link_id=TRY_CONVERT(uniqueidentifier,l.link_id) AND DATALENGTH(l.link_id)=72
  AND bridge.portal_environment=@portalEnvironment COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(bridge.portal_environment)=DATALENGTH(@portalEnvironment)
  AND bridge.client_key=l.client_key AND bridge.domain_key=l.domain_key
  AND bridge.target_kind=l.execution_kind COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(bridge.target_kind)=DATALENGTH(l.execution_kind)
  AND ((l.execution_kind='domain' AND bridge.database_key IS NULL AND l.database_key IS NULL)
    OR (l.execution_kind='database' AND bridge.database_key=l.database_key AND db.database_key IS NOT NULL))
  AND bridge.link_environment=l.link_environment COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(bridge.link_environment)=DATALENGTH(l.link_environment)
  AND bridge.catalog_source_key=l.catalog_source_key AND bridge.source_record_id=TRY_CONVERT(int,l.catalog_record_id)
  AND CONVERT(nvarchar(11),bridge.source_record_id) COLLATE Latin1_General_100_BIN2=l.catalog_record_id
  AND DATALENGTH(CONVERT(nvarchar(11),bridge.source_record_id))=DATALENGTH(l.catalog_record_id)
  AND bridge.retired_at IS NULL AND bridge.owner_retired_at IS NULL AND bridge.evidence_state='verified'
JOIN settings.catalog_source_bindings b WITH (HOLDLOCK) ON b.catalog_source_key=l.catalog_source_key
JOIN settings.external_database_connections p WITH (HOLDLOCK)
  ON p.external_database_connection_key=b.external_database_connection_key
JOIN settings.catalog_customer_revision_heads h WITH (HOLDLOCK) ON h.catalog_source_key=b.catalog_source_key
JOIN core.catalog_customer_source_revisions r WITH (HOLDLOCK)
  ON r.revision_key=bridge.revision_key AND r.revision_key=h.revision_key AND r.catalog_source_key=b.catalog_source_key
  AND r.source_role='erp-customers' AND r.binding_version=b.row_version AND r.profile_version=p.row_version
  AND r.match_key_version=@matchKeyVersion AND r.sealed_at<=@now AND r.observed_at<=@now AND r.verified_until>@now
JOIN core.catalog_customer_revision_rows erp WITH (HOLDLOCK)
  ON erp.revision_key=r.revision_key AND erp.source_record_id=bridge.source_record_id
  AND erp.catalog_customer_key=bridge.catalog_customer_key AND erp.active_code='S'
CROSS APPLY (VALUES (SUBSTRING(d.domain_name,9,500))) raw(authority)
CROSS APPLY (VALUES (LOWER(CASE WHEN RIGHT(raw.authority,1)=N'/'
  THEN LEFT(raw.authority,LEN(raw.authority)-1) ELSE raw.authority END))) host(hostname)
OUTER APPLY (
  SELECT MIN(parent_bridge.verified_until) AS valid_until
  FROM core.catalog_operational_link_evidence parent_bridge WITH (HOLDLOCK)
  JOIN core.catalog_customer_source_revisions parent_revision WITH (HOLDLOCK)
    ON parent_revision.revision_key=parent_bridge.revision_key
    AND parent_revision.observed_at<=@now AND parent_revision.match_key_version=@matchKeyVersion
  WHERE l.execution_kind='database' AND parent_bridge.portal_environment=@portalEnvironment COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(parent_bridge.portal_environment)=DATALENGTH(@portalEnvironment)
    AND parent_bridge.client_key=l.client_key AND parent_bridge.domain_key=l.domain_key
    AND parent_bridge.database_key IS NULL AND parent_bridge.target_kind='domain'
    AND parent_bridge.link_environment=d.environment_id COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(parent_bridge.link_environment)=DATALENGTH(d.environment_id)
    AND (ls.environment_id IS NULL OR parent_bridge.link_environment=ls.environment_id COLLATE Latin1_General_100_BIN2)
    AND parent_bridge.retired_at IS NULL AND parent_bridge.owner_retired_at IS NULL
    AND parent_bridge.evidence_state='verified' AND parent_bridge.verified_until>@now
) parent
WHERE b.portal_environment=@portalEnvironment COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(b.portal_environment)=DATALENGTH(@portalEnvironment)
  AND b.source_role='erp-customers' AND b.source_state='active' AND b.contract_version='erp_v1'
  AND b.validated_at<=@now AND b.validated_profile_version=p.row_version
  AND p.active=1 AND p.status='active' AND p.encrypt_connection=1 AND p.password_configured=1
  AND h.attempt_status='succeeded' AND h.attempted_at<=@now
  AND bridge.binding_version=b.row_version AND bridge.profile_version=p.row_version
  AND erp.issuer IS NOT NULL AND erp.document_type IS NOT NULL AND erp.document_number_token IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM core.catalog_customer_revision_rows other_erp WITH (HOLDLOCK)
    WHERE other_erp.revision_key=r.revision_key AND other_erp.source_record_id<>erp.source_record_id
      AND (other_erp.catalog_customer_key=erp.catalog_customer_key OR (other_erp.issuer=erp.issuer
        AND other_erp.document_type=erp.document_type AND other_erp.document_number_token=erp.document_number_token)))
  AND LEFT(d.domain_name,8) COLLATE Latin1_General_100_BIN2=N'https://'
  AND DATALENGTH(d.domain_name)=2*LEN(d.domain_name)
  AND LEN(host.hostname) BETWEEN 3 AND 253
  AND REPLACE(host.hostname,N'-',N'') COLLATE Latin1_General_100_BIN2 NOT LIKE N'%[^a-z0-9.]%'
  AND host.hostname LIKE N'%.%' AND host.hostname NOT LIKE N'%..%'
  AND CASE WHEN CHARINDEX(N'.',REVERSE(host.hostname))>0
    THEN RIGHT(host.hostname,CHARINDEX(N'.',REVERSE(host.hostname))-1) ELSE N'' END COLLATE Latin1_General_100_BIN2 LIKE N'%[a-z]%'
  AND NOT EXISTS (SELECT 1 FROM STRING_SPLIT(host.hostname,N'.') label
    WHERE LEN(label.[value]) NOT BETWEEN 1 AND 63 OR LEFT(label.[value],1)=N'-' OR RIGHT(label.[value],1)=N'-')
  AND LEFT(host.hostname,1)<>N'.' AND RIGHT(host.hostname,1)<>N'.'
  AND ((l.execution_kind='domain' AND d.environment_id COLLATE Latin1_General_100_BIN2=l.link_environment
      AND DATALENGTH(d.environment_id)=DATALENGTH(l.link_environment))
    OR (l.execution_kind='database' AND db.environment_id COLLATE Latin1_General_100_BIN2=l.link_environment
      AND DATALENGTH(db.environment_id)=DATALENGTH(l.link_environment)))
  AND ls.license_match_mode IN ('any','all')
  AND (l.execution_kind='domain' OR parent.valid_until IS NOT NULL)
  AND (ls.environment_id IS NULL OR (ls.environment_id COLLATE Latin1_General_100_BIN2=l.link_environment
    AND DATALENGTH(ls.environment_id)=DATALENGTH(l.link_environment)
    AND ls.environment_id COLLATE Latin1_General_100_BIN2=d.environment_id COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(ls.environment_id)=DATALENGTH(d.environment_id)))
  AND (ls.target_types='domains_and_databases' OR (l.execution_kind='domain' AND ls.target_types='domains_only')
    OR (l.execution_kind='database' AND ls.target_types='databases_only'))
  AND NOT EXISTS (SELECT 1 FROM scheduling.scope_groups WITH (HOLDLOCK) WHERE schedule_key=s.schedule_key)
  AND NOT EXISTS (SELECT 1 FROM scheduling.licensing_excluded_domains WITH (HOLDLOCK)
    WHERE schedule_key=s.schedule_key AND domain_key=l.domain_key AND l.execution_kind='domain')
  AND NOT EXISTS (SELECT 1 FROM scheduling.licensing_excluded_databases WITH (HOLDLOCK)
    WHERE schedule_key=s.schedule_key AND database_key=l.database_key AND l.execution_kind='database');
IF (SELECT COUNT_BIG(*) FROM @eligible)<>(SELECT COUNT_BIG(*) FROM @requested) RETURN;

DECLARE @claims TABLE (ordinal int,source_record_id int,domain_candidate varchar(253) COLLATE Latin1_General_100_BIN2,
  environment_kind varchar(10) COLLATE Latin1_General_100_BIN2,license_codes varchar(25) COLLATE Latin1_General_100_BIN2,
  PRIMARY KEY(ordinal,source_record_id));
-- Unknown issuer with the same comparison token cannot establish a customer join.
IF EXISTS (SELECT 1 FROM @eligible a CROSS JOIN @sag sag
  JOIN core.catalog_customer_revision_rows r WITH (HOLDLOCK) ON r.revision_key=sag.revision_key
  WHERE r.document_number_token=a.document_token AND r.issuer IS NULL) RETURN;
INSERT @claims
SELECT a.ordinal,r.source_record_id,detail.domain_candidate,detail.environment_kind,detail.license_codes
FROM @eligible a CROSS JOIN @sag sag
JOIN core.catalog_customer_revision_rows r WITH (HOLDLOCK) ON r.revision_key=sag.revision_key
  AND r.issuer=a.issuer AND r.document_type=a.document_type AND r.document_number_token=a.document_token
LEFT JOIN core.catalog_sag_revision_evidence detail WITH (HOLDLOCK)
  ON detail.revision_key=r.revision_key AND detail.source_record_id=r.source_record_id;
IF EXISTS (SELECT 1 FROM @claims c JOIN @eligible a ON a.ordinal=c.ordinal
  WHERE c.environment_kind IS NULL OR c.environment_kind='unknown'
    OR (c.environment_kind=a.environment_id AND c.domain_candidate IS NULL)
    OR (c.environment_kind=a.environment_id AND CONVERT(nvarchar(253),c.domain_candidate)=a.hostname
      AND c.license_codes IS NULL)) RETURN;
IF EXISTS (SELECT 1 FROM @claims GROUP BY ordinal HAVING COUNT_BIG(*)>128) RETURN;
IF EXISTS (SELECT 1 FROM @claims GROUP BY ordinal,domain_candidate,environment_kind HAVING COUNT_BIG(*)>1) RETURN;
IF EXISTS (SELECT 1 FROM @eligible a WHERE (SELECT COUNT_BIG(*) FROM @claims c
  WHERE c.ordinal=a.ordinal AND CONVERT(nvarchar(253),c.domain_candidate)=a.hostname
    AND DATALENGTH(CONVERT(nvarchar(253),c.domain_candidate))=DATALENGTH(a.hostname)
    AND c.environment_kind=a.environment_id AND DATALENGTH(c.environment_kind)=DATALENGTH(a.environment_id))<>1) RETURN;

DECLARE @numbers TABLE(n int PRIMARY KEY);
INSERT @numbers VALUES(1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12),(13),(14),(15),(16),(17),(18),(19),(20),(21),(22),(23),(24),(25);
DECLARE @codes TABLE(ordinal int,code varchar(1) COLLATE Latin1_General_100_BIN2);
INSERT @codes SELECT a.ordinal,SUBSTRING(c.license_codes,n.n,1)
FROM @eligible a JOIN @claims c ON c.ordinal=a.ordinal AND CONVERT(nvarchar(253),c.domain_candidate)=a.hostname
  AND c.environment_kind=a.environment_id
JOIN @numbers n ON n.n<=DATALENGTH(c.license_codes);
IF EXISTS (SELECT 1 FROM @codes WHERE code NOT LIKE '[A-SU-Z]') RETURN;
IF EXISTS (SELECT 1 FROM @codes GROUP BY ordinal,code HAVING COUNT_BIG(*)>1) RETURN;

DECLARE @derived TABLE(ordinal int,module_key bigint,module_id nvarchar(150) COLLATE Latin1_General_100_BIN2,
  PRIMARY KEY(ordinal,module_key));
IF EXISTS (SELECT 1 FROM @codes c CROSS JOIN @sag sag WHERE NOT EXISTS (
  SELECT 1 FROM settings.catalog_sag_license_module_approvals approval WITH (HOLDLOCK)
  JOIN licensing.license_modules m WITH (HOLDLOCK) ON m.module_key=approval.module_key AND m.status='active' AND m.deleted_at IS NULL
  WHERE approval.catalog_source_key=sag.source_key AND approval.binding_version=sag.binding_version
    AND approval.profile_version=sag.profile_version AND approval.sag_code=c.code AND approval.approved_at<=@now)) RETURN;
INSERT @derived SELECT DISTINCT c.ordinal,m.module_key,m.source_id
FROM @codes c CROSS JOIN @sag sag
JOIN settings.catalog_sag_license_module_approvals approval WITH (HOLDLOCK)
  ON approval.catalog_source_key=sag.source_key AND approval.binding_version=sag.binding_version
  AND approval.profile_version=sag.profile_version AND approval.sag_code=c.code AND approval.approved_at<=@now
JOIN licensing.license_modules m WITH (HOLDLOCK) ON m.module_key=approval.module_key AND m.status='active' AND m.deleted_at IS NULL;

-- Symmetric difference: requested planner modules must equal the full authoritative set.
IF EXISTS (SELECT q.ordinal,CONVERT(nvarchar(150),j.[value]) COLLATE Latin1_General_100_BIN2 AS module_id,
    DATALENGTH(CONVERT(nvarchar(150),j.[value])) AS module_length
  FROM @requested q CROSS APPLY OPENJSON(q.modules) j
  EXCEPT SELECT ordinal,module_id,DATALENGTH(module_id) FROM @derived) RETURN;
IF EXISTS (SELECT ordinal,module_id,DATALENGTH(module_id) FROM @derived
  EXCEPT SELECT q.ordinal,CONVERT(nvarchar(150),j.[value]) COLLATE Latin1_General_100_BIN2,
    DATALENGTH(CONVERT(nvarchar(150),j.[value]))
  FROM @requested q CROSS APPLY OPENJSON(q.modules) j) RETURN;
IF EXISTS (SELECT 1 FROM @eligible a WHERE NOT EXISTS (
  SELECT 1 FROM scheduling.licensing_scope_modules WITH (HOLDLOCK) WHERE schedule_key=a.schedule_key)) RETURN;
IF EXISTS (SELECT 1 FROM @eligible a JOIN scheduling.licensing_scope_modules requested WITH (HOLDLOCK)
  ON requested.schedule_key=a.schedule_key LEFT JOIN licensing.license_modules m WITH (HOLDLOCK)
  ON m.module_key=requested.module_key AND m.status='active' AND m.deleted_at IS NULL WHERE m.module_key IS NULL) RETURN;
IF EXISTS (SELECT 1 FROM @eligible a WHERE
  (a.match_mode='any' AND NOT EXISTS (SELECT 1 FROM scheduling.licensing_scope_modules requested WITH (HOLDLOCK)
    JOIN @derived d ON d.ordinal=a.ordinal AND d.module_key=requested.module_key WHERE requested.schedule_key=a.schedule_key))
  OR (a.match_mode='all' AND EXISTS (SELECT 1 FROM scheduling.licensing_scope_modules requested WITH (HOLDLOCK)
    WHERE requested.schedule_key=a.schedule_key AND NOT EXISTS (SELECT 1 FROM @derived d
      WHERE d.ordinal=a.ordinal AND d.module_key=requested.module_key)))) RETURN;

-- Locks can have waited: the sole result uses a new server-clock check after every proof read.
DECLARE @deadline datetime2(3)=(SELECT MIN(deadline) FROM (
  SELECT erp_until AS deadline FROM @eligible UNION ALL SELECT parent_until FROM @eligible
  UNION ALL SELECT valid_until FROM @sag) deadlines);
SELECT @deadline AS validUntil WHERE @deadline>SYSUTCDATETIME();
`;

const safeText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0
  && value.length <= max && value === value.trim() && !/\p{C}/u.test(value);
function validExecutionId(value: unknown): value is string | number {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0;
  return typeof value === "string" && value === value.trim() && /^[1-9][0-9]{0,18}$/.test(value)
    && BigInt(value) <= 9223372036854775807n;
}

/**
 * Revalidate licensing-only attachments before source attachments. Existing
 * execution links must either be active or be explicitly certified 042 aliases
 * for proof-only accounting; the caller separately checks identical physical
 * destination and current operation before opening that path. No mutation here.
 * null denies the whole registration. Driver failures throw a sanitized error;
 * the caller must roll back, never replace a denial with an empty module set.
 * The returned deadline MUST join the caller's physical-proof/cutoff deadline
 * and be checked with the SQL clock immediately before committing all writes.
 */
export async function revalidateSqlCatalogExecutionLicenses(
  transaction: sql.Transaction,
  input: CatalogExecutionLicenseProofInput,
): Promise<Date | null> {
  if (!input || !validExecutionId(input.executionId) || !["qa", "production"].includes(input.portalEnvironment)
    || !Number.isInteger(input.matchKeyVersion) || input.matchKeyVersion < 1 || input.matchKeyVersion > 32767
    || !Array.isArray(input.attachments) || input.attachments.length === 0 || input.attachments.length > 512) return null;
  const pairs = new Set<string>();
  const proofOnlyLinks = input.proofOnlyLinks ?? [];
  if (!Array.isArray(proofOnlyLinks) || proofOnlyLinks.length > input.attachments.length ||
    proofOnlyLinks.some((id: unknown) => typeof id !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) ||
    new Set(proofOnlyLinks).size !== proofOnlyLinks.length) return null;
  const proofOnly = new Set(proofOnlyLinks);
  for (const attachment of input.attachments) {
    if (!attachment || !safeText(attachment.linkId, 260) || !safeText(attachment.scheduleId, 150)
      || !Array.isArray(attachment.moduleIds) || attachment.moduleIds.length === 0 || attachment.moduleIds.length > 25
      || attachment.moduleIds.some((id: unknown) => !safeText(id, 150))
      || new Set(attachment.moduleIds).size !== attachment.moduleIds.length) return null;
    const key = JSON.stringify([attachment.linkId, attachment.scheduleId]);
    if (pairs.has(key)) return null;
    pairs.add(key);
  }
  if (proofOnlyLinks.some((id: string) => !input.attachments.some(attachment => attachment.linkId === id))) return null;
  try {
    const result = await new sql.Request(transaction)
      .input("executionId", sql.BigInt, input.executionId)
      .input("portalEnvironment", sql.VarChar(10), input.portalEnvironment)
      .input("matchKeyVersion", sql.SmallInt, input.matchKeyVersion)
      .input("attachments", sql.NVarChar(sql.MAX), JSON.stringify(input.attachments.map(({ linkId, scheduleId, moduleIds }) =>
        ({ linkId, scheduleId, moduleIds: [...moduleIds], ...(proofOnly.has(linkId) ? { proofOnly: true } : {}) }))))
      .query<{ validUntil: Date }>(licenseProofSql);
    const deadline = result.recordset?.length === 1 ? result.recordset[0].validUntil : null;
    return deadline instanceof Date && Number.isFinite(deadline.valueOf()) ? deadline : null;
  } catch {
    throw new Error("catalog_execution_license_proof_unavailable");
  }
}
