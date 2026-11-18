import sql from "mssql";
import { runSqlTransaction } from "./sqlTransaction";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import type { CatalogMasterInventoryQuery, CatalogMasterInventoryResult, CatalogMasterInventoryRow } from "./catalogMasterInventoryHttp";
import { catalogSagPositiveLicenseRevisionSql } from "./catalogSagPositiveLicenseSql";

// Only the small allowlisted projection leaves SQL. Source/document lineage
// stays in the database and a held relationship never becomes a public row.
export const readCatalogMasterInventorySql = `
SET NOCOUNT ON;
DECLARE @now datetime2(7)=SYSUTCDATETIME(), @partial bit=0, @unavailable bit=0;
DECLARE @allowed table (source_key bigint PRIMARY KEY);
INSERT @allowed
SELECT b.catalog_source_key
FROM settings.catalog_source_bindings b
JOIN security.users u ON u.source_id=@actorId AND u.active=1
WHERE b.portal_environment=@environment AND b.source_role='erp-customers' AND b.source_state='active'
  AND EXISTS(SELECT 1 FROM OPENJSON(@sourceIds) ids WHERE TRY_CONVERT(uniqueidentifier,ids.[value])=b.source_id)
  AND (EXISTS(SELECT 1 FROM security.catalog_source_readers r
    WHERE r.user_key=u.user_key AND r.catalog_source_key=b.catalog_source_key AND r.revoked_at IS NULL)
  OR EXISTS(SELECT 1 FROM security.user_roles ur JOIN security.roles rr ON rr.role_id=ur.role_id
    WHERE ur.user_key=u.user_key AND rr.role_id=N'super_admin' AND rr.active=1));

DECLARE @heads table (
  source_key bigint PRIMARY KEY, revision_key bigint UNIQUE, source_role varchar(15),
  binding_version binary(8),profile_version binary(8)
);
INSERT @heads
SELECT b.catalog_source_key,r.revision_key,b.source_role,CONVERT(binary(8),b.row_version),CONVERT(binary(8),p.row_version)
FROM settings.catalog_source_bindings b
JOIN settings.external_database_connections p ON p.external_database_connection_key=b.external_database_connection_key
  AND p.active=1 AND p.status='active' AND p.encrypt_connection=1 AND p.password_configured=1
  AND b.validated_profile_version=p.row_version
JOIN settings.catalog_customer_revision_heads h ON h.catalog_source_key=b.catalog_source_key
  AND h.attempt_status='succeeded' AND h.attempted_at<=@now
JOIN core.catalog_customer_source_revisions r ON r.revision_key=h.revision_key AND r.catalog_source_key=b.catalog_source_key
  AND r.source_role=b.source_role AND r.attempt_ordinal=h.attempt_ordinal AND r.binding_version=b.row_version
  AND r.profile_version=p.row_version AND r.match_key_version=@matchKeyVersion
  AND r.sealed_at<=@now AND r.observed_at<=@now AND r.verified_until>@now
WHERE b.portal_environment=@environment AND b.source_state='active' AND b.validated_at<=@now
  AND ((b.source_role='erp-customers' AND b.contract_version='erp_v1'
    AND EXISTS(SELECT 1 FROM @allowed a WHERE a.source_key=b.catalog_source_key))
    OR (@view='licenses' AND b.source_role='sag-admin' AND ${catalogSagPositiveLicenseRevisionSql}));

IF (SELECT COUNT(*) FROM @heads WHERE source_role='erp-customers')<>(SELECT COUNT(*) FROM @allowed) SET @partial=1;
IF NOT EXISTS(SELECT 1 FROM @heads WHERE source_role='erp-customers')
  OR (@view='licenses' AND ((SELECT COUNT(*) FROM @heads WHERE source_role='sag-admin')<>1
    OR (SELECT COUNT(*) FROM settings.catalog_source_bindings WHERE portal_environment=@environment
      AND source_role='sag-admin' AND source_state='active')<>1))
  SET @unavailable=1;

DECLARE @rows table(id char(64) NOT NULL PRIMARY KEY, customerName nvarchar(512) NOT NULL, name nvarchar(500) NOT NULL,
  environment varchar(20) NOT NULL, detail nvarchar(500) NULL);
IF @unavailable=0 AND @view IN ('domains','databases')
BEGIN
  IF EXISTS(SELECT 1 FROM core.catalog_operational_link_evidence e JOIN @allowed a ON a.source_key=e.catalog_source_key
    WHERE e.portal_environment=@environment AND e.retired_at IS NULL AND e.owner_retired_at IS NULL
      AND e.target_kind=@kind AND e.evidence_state<>'verified') SET @partial=1;
  ;WITH approved AS (
    SELECT e.catalog_customer_key,e.domain_key,e.database_key,e.link_environment,customer.official_name,
      CASE WHEN @view='domains' THEN d.domain_name_normalized
        WHEN NULLIF(profile.initial_catalog,N'') IS NOT NULL THEN CONCAT(db.company_name,N' / ',profile.initial_catalog)
        ELSE db.company_name END AS itemName,
      d.domain_name_normalized AS parentDomain,
      ROW_NUMBER() OVER (PARTITION BY e.catalog_customer_key,e.domain_key,e.database_key,e.link_environment
        ORDER BY b.source_id,e.link_key) AS ordinal
    FROM core.catalog_operational_link_evidence e
    JOIN @allowed a ON a.source_key=e.catalog_source_key
    JOIN @heads h ON h.source_key=e.catalog_source_key AND h.revision_key=e.revision_key AND h.source_role='erp-customers'
    JOIN settings.catalog_source_bindings b ON b.catalog_source_key=e.catalog_source_key
    JOIN core.catalog_customer_revision_rows r ON r.revision_key=h.revision_key AND r.source_record_id=e.source_record_id
      AND r.catalog_customer_key=e.catalog_customer_key AND r.active_code='S'
    CROSS APPLY (
      SELECT TOP (1) LTRIM(RTRIM(named.official_name)) AS official_name
      FROM @heads origin
      JOIN settings.catalog_source_bindings binding ON binding.catalog_source_key=origin.source_key
      JOIN core.catalog_customer_revision_rows named ON named.revision_key=origin.revision_key
        AND named.catalog_customer_key=e.catalog_customer_key
      WHERE origin.source_role='erp-customers' AND LEN(LTRIM(RTRIM(named.official_name)))>0
      ORDER BY LOWER(CONVERT(char(36),binding.source_id)) COLLATE Latin1_General_100_BIN2,
        CONVERT(varchar(11),named.source_record_id) COLLATE Latin1_General_100_BIN2
    ) customer
    JOIN core.domains d ON d.domain_key=e.domain_key AND d.client_key=e.client_key
    LEFT JOIN core.databases db ON db.database_key=e.database_key AND db.domain_key=e.domain_key AND db.client_key=e.client_key
    LEFT JOIN core.database_access_profiles profile ON @view='databases'
      AND profile.access_profile_key=db.access_profile_key AND profile.active=1
    WHERE e.portal_environment=@environment AND e.retired_at IS NULL AND e.owner_retired_at IS NULL
      AND e.target_kind=@kind AND e.evidence_state='verified' AND (@view='domains' OR db.database_key IS NOT NULL)
  )
  INSERT @rows
  SELECT TOP (5001) LOWER(CONVERT(char(64),HASHBYTES('SHA2_256',CONCAT(@kind,':',catalog_customer_key,':',domain_key,':',
    database_key,':',link_environment)),2)),official_name,itemName,link_environment,
    CASE WHEN @view='databases' THEN parentDomain ELSE NULL END
  FROM approved WHERE ordinal=1 AND itemName IS NOT NULL;
END;
IF @unavailable=0 AND @view='licenses'
BEGIN
  DECLARE @members table(customer_key bigint,issuer char(2) COLLATE Latin1_General_100_BIN2,
    document_type varchar(32) COLLATE Latin1_General_100_BIN2,token binary(32),name nvarchar(512),
    source_key bigint,source_order char(36) COLLATE Latin1_General_100_BIN2,
    source_row_order varchar(11) COLLATE Latin1_General_100_BIN2,active_code char(1));
  INSERT @members
  SELECT TOP (50001) r.catalog_customer_key,r.issuer,r.document_type,r.document_number_token,LTRIM(RTRIM(r.official_name)),
    h.source_key,LOWER(CONVERT(char(36),b.source_id)),CONVERT(varchar(11),r.source_record_id),r.active_code
  FROM @heads h JOIN core.catalog_customer_revision_rows r ON r.revision_key=h.revision_key
  JOIN settings.catalog_source_bindings b ON b.catalog_source_key=h.source_key
  WHERE h.source_role='erp-customers';
  IF @@ROWCOUNT>50000 THROW 54976,N'Catalog inventory bounds exceeded.',1;
  IF EXISTS(SELECT 1 FROM @members WHERE active_code='S' AND (issuer IS NULL OR document_type IS NULL OR token IS NULL OR name IS NULL))
    SET @partial=1;
  DECLARE @named table (customer_key bigint PRIMARY KEY,issuer char(2) COLLATE Latin1_General_100_BIN2,
    document_type varchar(32) COLLATE Latin1_General_100_BIN2,token binary(32),name nvarchar(512));
  ;WITH named AS (
    SELECT m.*,ROW_NUMBER() OVER(PARTITION BY m.customer_key ORDER BY m.source_order,m.source_row_order) AS ordinal
    FROM @members m
    WHERE m.active_code='S' AND m.issuer IS NOT NULL AND m.document_type IS NOT NULL AND m.token IS NOT NULL
      AND DATALENGTH(m.name)>0
      AND NOT EXISTS(SELECT 1 FROM @members x WHERE x.customer_key=m.customer_key
        AND (x.issuer IS NULL OR x.document_type IS NULL OR x.token IS NULL
          OR x.issuer<>m.issuer OR x.document_type<>m.document_type OR x.token<>m.token))
      AND NOT EXISTS(SELECT 1 FROM @members x WHERE x.issuer=m.issuer AND x.document_type=m.document_type
        AND x.token=m.token AND x.customer_key<>m.customer_key)
      AND NOT EXISTS(SELECT 1 FROM @members x WHERE x.customer_key=m.customer_key
        GROUP BY x.source_key HAVING COUNT_BIG(*)>1)
  )
  INSERT @named SELECT customer_key,issuer,document_type,token,name FROM named WHERE ordinal=1;
  IF (SELECT COUNT(*) FROM @named)<>(SELECT COUNT(DISTINCT customer_key) FROM @members WHERE active_code='S')
    SET @partial=1;
  IF EXISTS(
    SELECT 1 FROM @named n
    JOIN @heads h ON h.source_role='sag-admin'
    WHERE NOT EXISTS(SELECT 1 FROM core.catalog_customer_revision_rows s
      JOIN core.catalog_sag_revision_evidence d ON d.revision_key=s.revision_key AND d.source_record_id=s.source_record_id
      WHERE s.revision_key=h.revision_key AND s.issuer=n.issuer AND s.document_type=n.document_type
        AND s.document_number_token=n.token)
    OR EXISTS(SELECT 1 FROM core.catalog_customer_revision_rows s
      LEFT JOIN core.catalog_sag_revision_evidence d ON d.revision_key=s.revision_key AND d.source_record_id=s.source_record_id
      WHERE s.revision_key=h.revision_key AND s.document_number_token=n.token
        AND (s.issuer IS NULL OR (s.issuer=n.issuer AND s.document_type=n.document_type
          AND (d.source_record_id IS NULL OR d.license_codes IS NULL))))
  ) SET @partial=1;
  ;WITH items AS (
    SELECT DISTINCT n.customer_key,n.name AS customerName,d.environment_kind,code.code,
      COALESCE(m.name COLLATE DATABASE_DEFAULT,CONCAT(N'Código ',code.code) COLLATE DATABASE_DEFAULT) AS licenseName,
      CASE WHEN m.module_key IS NULL THEN N'Correspondencia no verificada' ELSE NULL END AS detail
    FROM @named n
    JOIN @heads h ON h.source_role='sag-admin'
    JOIN core.catalog_customer_revision_rows s ON s.revision_key=h.revision_key AND s.issuer=n.issuer
      AND s.document_type=n.document_type AND s.document_number_token=n.token
    JOIN core.catalog_sag_revision_evidence d ON d.revision_key=s.revision_key AND d.source_record_id=s.source_record_id
    CROSS APPLY (SELECT TOP (25) ROW_NUMBER() OVER(ORDER BY (SELECT NULL)) AS pos
      FROM (VALUES(0),(0),(0),(0),(0)) a(n) CROSS JOIN (VALUES(0),(0),(0),(0),(0)) b(n)) pos
    CROSS APPLY (VALUES(SUBSTRING(d.license_codes,pos.pos,1))) code(code)
    LEFT JOIN settings.catalog_sag_license_module_approvals a ON a.catalog_source_key=h.source_key
      AND a.binding_version=h.binding_version AND a.profile_version=h.profile_version
      AND a.sag_code=code.code COLLATE Latin1_General_100_BIN2 AND a.approved_at<=@now
    LEFT JOIN licensing.license_modules m ON m.module_key=a.module_key AND m.status='active' AND m.deleted_at IS NULL
    WHERE pos.pos<=DATALENGTH(d.license_codes)
      AND NOT EXISTS(SELECT 1 FROM core.catalog_customer_revision_rows x WHERE x.revision_key=h.revision_key
        AND x.issuer IS NULL AND x.document_number_token=n.token)
  )
  INSERT @rows
  SELECT TOP (5001) LOWER(CONVERT(char(64),HASHBYTES('SHA2_256',CONCAT('license:',customer_key,':',environment_kind,':',code)),2)),
    customerName,licenseName,environment_kind,detail FROM items;
  -- No absence claim for incomplete license evidence, including unrecognized codes.
  IF EXISTS(SELECT 1 FROM @rows WHERE detail IS NOT NULL OR environment='unknown') SET @partial=1;
END;
DECLARE @total int=(SELECT COUNT(*) FROM @rows);
IF @total>5000 THROW 54976,N'Catalog inventory bounds exceeded.',1;
SELECT @total AS total,CASE WHEN @unavailable=1 THEN 'unavailable'
  WHEN @partial=1 OR @total=0 THEN 'partial' ELSE 'verified' END AS state;
SELECT id,customerName,name,environment,detail FROM @rows
ORDER BY customerName,name,environment,id OFFSET @skip ROWS FETCH NEXT @take ROWS ONLY;
`;

export async function readSqlCatalogMasterInventory(scope: CatalogMasterInventoryQuery & {
  actorId: string; environment: CatalogEnvironment; matchKeyVersion: number;
}): Promise<CatalogMasterInventoryResult> {
  const types = ["domains", "databases", "licenses"];
  if (!types.includes(scope.view) || !["qa", "production"].includes(scope.environment) ||
      !Number.isInteger(scope.matchKeyVersion) || scope.matchKeyVersion < 1 || scope.matchKeyVersion > 32767 ||
      !Number.isInteger(scope.page) || scope.page < 1 || scope.page > 10000 ||
      !Number.isInteger(scope.pageSize) || scope.pageSize < 1 || scope.pageSize > 100 ||
      scope.allowedSourceIds.size < 1 || scope.allowedSourceIds.size > 50 ||
      [...scope.allowedSourceIds].some(id => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))) {
    throw new Error("catalog_master_inventory_scope_invalid");
  }
  const result = await runSqlTransaction(transaction => new sql.Request(transaction)
    .input("actorId", sql.NVarChar(150), scope.actorId).input("sourceIds", sql.NVarChar(sql.MAX), JSON.stringify([...scope.allowedSourceIds]))
    .input("environment", sql.VarChar(10), scope.environment).input("view", sql.VarChar(10), scope.view)
    .input("kind", sql.VarChar(10), scope.view === "databases" ? "database" : "domain")
    .input("matchKeyVersion", sql.SmallInt, scope.matchKeyVersion)
    .input("skip", sql.Int, (scope.page - 1) * scope.pageSize).input("take", sql.Int, scope.pageSize)
    .query(readCatalogMasterInventorySql));
  const [summary, rows] = result.recordsets as unknown as [Array<{ state: CatalogMasterInventoryResult["state"]; total: number }>, CatalogMasterInventoryRow[]];
  const state = summary[0]?.state;
  const total = summary[0]?.total;
  if (summary.length !== 1 || !["verified", "partial", "unavailable"].includes(state) ||
      !Number.isInteger(total) || total < 0 || total > 5000 || rows.length > scope.pageSize ||
      (state === "unavailable" && (rows.length || total)) ||
      rows.some(row => !/^[a-f0-9]{64}$/.test(row.id) || !row.customerName?.trim() || !row.name?.trim() ||
        !["production", "test", "demo", "unknown"].includes(row.environment))) {
    throw new Error("catalog_master_inventory_result_invalid");
  }
  let incompleteDomain = false;
  const publicHost = (value: string) => {
    // This is a domain display, not a hyperlink or a connection endpoint.
    // Never return user info, the path, query parameters or fragments.
    try {
      const publicUrl = new URL(value);
      if (publicUrl.protocol === "https:" && publicUrl.hostname && !publicUrl.username && !publicUrl.password) return publicUrl.hostname;
    } catch { /* Never expose the original invalid label. */ }
    incompleteDomain = true;
    return "Dominio no verificado";
  };
  const items = rows.map(row => scope.view === "domains" ? { ...row, name: publicHost(row.name) }
    : scope.view === "databases" && row.detail ? { ...row, detail: publicHost(row.detail) } : row);
  return { state: incompleteDomain ? "partial" : state, total, items };
}
