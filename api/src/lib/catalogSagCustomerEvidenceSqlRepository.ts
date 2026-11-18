import sql from "mssql";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { normalizeCatalogSagInventoryEvidence, type CatalogSagInventoryEvidence } from "./catalogSagInventoryEvidence";
import { getSqlPool } from "./sql";
import type { CertifiedCatalogLicenseModule } from "./catalogLicenseMembership";

type ReadScope = Readonly<{
  customerId: string;
  environment: CatalogEnvironment;
  matchKeyVersion: number;
  allowedSourceIds: ReadonlySet<string>;
}>;

export type CatalogSagCustomerEvidence = Readonly<{
  state: "verified" | "stale" | "unavailable";
  verifiedAt: string | null;
  items: readonly CatalogSagInventoryEvidence[];
  licenseModules?: readonly CertifiedCatalogLicenseModule[];
}>;

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const isUuid = (value: string) => value.length === 36 && uuid.test(value);
const maxSources = 50;
const maxItems = 128;

const readEvidence = `
  SET NOCOUNT ON;
  DECLARE @now datetime2(3)=SYSUTCDATETIME();
  DECLARE @heads TABLE (
    revision_key bigint NOT NULL PRIMARY KEY,
    source_role varchar(15) NOT NULL,
    fresh bit NOT NULL,
    has_inventory bit NOT NULL,
    observed_at datetime2(3) NOT NULL
  );
  -- Capture accepted, authorized pointers before inspecting immutable rows.
  INSERT INTO @heads
  SELECT r.revision_key,b.source_role,
    CASE WHEN h.attempt_status='succeeded' AND h.attempted_at<=@now AND r.verified_until>@now THEN 1 ELSE 0 END,
    r.has_sag_inventory_evidence,r.observed_at
  FROM settings.catalog_source_bindings AS b
  JOIN settings.external_database_connections AS p
    ON p.external_database_connection_key=b.external_database_connection_key
  JOIN settings.catalog_customer_revision_heads AS h ON h.catalog_source_key=b.catalog_source_key
  JOIN core.catalog_customer_source_revisions AS r
    ON r.catalog_source_key=b.catalog_source_key AND r.revision_key=h.revision_key AND r.source_role=b.source_role
  WHERE b.portal_environment=@environment AND b.source_state='active'
    AND b.validated_at IS NOT NULL AND b.validated_profile_version=p.row_version
    AND p.active=1 AND p.status='active' AND p.encrypt_connection=1 AND p.password_configured=1
    AND r.sealed_at IS NOT NULL AND r.sealed_at<=@now AND r.profile_version=p.row_version AND r.binding_version=b.row_version
    AND r.match_key_version=@matchKeyVersion
    AND (b.source_role='sag-admin' OR (b.source_role='erp-customers' AND EXISTS (
      SELECT 1 FROM OPENJSON(@allowedSourceIds) AS a WHERE TRY_CONVERT(uniqueidentifier,a.[value])=b.source_id)));

  DECLARE @state varchar(11), @verifiedAt datetime2(3), @sagObserved datetime2(3);
  DECLARE @customerKey bigint, @sagKey bigint, @sagFresh bit, @hasInventory bit;
  DECLARE @issuer char(2), @documentType varchar(32), @token binary(32), @erpFresh bit;
  DECLARE @members TABLE (
    issuer char(2) COLLATE Latin1_General_100_BIN2 NULL,
    document_type varchar(32) COLLATE Latin1_General_100_BIN2 NULL,
    token binary(32) NULL, fresh bit NOT NULL
  );
  DECLARE @details TABLE (
    source_record_id int NOT NULL PRIMARY KEY,
    domain_candidate varchar(253) NULL, environment_kind varchar(10) NOT NULL, license_codes varchar(25) NULL,
    test_started_on date NULL, production_started_on date NULL, demo_started_on date NULL
  );

  SELECT @customerKey=c.catalog_customer_key FROM core.catalog_customer_ids AS c WHERE c.customer_id=@customerId;
  INSERT INTO @members
  -- For one identity there can be only the two freshness variants. Three
  -- distinct observations are already enough to prove ambiguity.
  SELECT DISTINCT TOP (3) r.issuer,r.document_type,r.document_number_token,h.fresh
  FROM @heads AS h
  JOIN core.catalog_customer_revision_rows AS r ON r.revision_key=h.revision_key
  WHERE h.source_role='erp-customers' AND r.catalog_customer_key=@customerKey;

  IF EXISTS (SELECT 1 FROM @members)
  BEGIN
    SET @state='unavailable';
    IF NOT EXISTS (SELECT 1 FROM @members WHERE issuer IS NULL OR document_type IS NULL OR token IS NULL)
      AND (SELECT COUNT_BIG(*) FROM (SELECT DISTINCT issuer,document_type,token FROM @members) AS identities)=1
      AND NOT EXISTS (
        SELECT 1 FROM @heads AS h JOIN core.catalog_customer_revision_rows AS r ON r.revision_key=h.revision_key
        WHERE h.source_role='erp-customers' AND r.catalog_customer_key=@customerKey
        GROUP BY h.revision_key HAVING COUNT_BIG(*)>1
      )
      AND (SELECT COUNT_BIG(*) FROM @heads WHERE source_role='sag-admin')=1
    BEGIN
      SELECT TOP (1) @issuer=issuer,@documentType=document_type,@token=token FROM @members;
      SELECT @erpFresh=CASE WHEN EXISTS (SELECT 1 FROM @members WHERE fresh=1) THEN 1 ELSE 0 END;
      SELECT @sagKey=revision_key,@sagObserved=observed_at,@sagFresh=fresh,@hasInventory=has_inventory
      FROM @heads WHERE source_role='sag-admin';

      IF @hasInventory=1 AND NOT EXISTS (
        SELECT 1 FROM @heads AS h JOIN core.catalog_customer_revision_rows AS r ON r.revision_key=h.revision_key
        WHERE h.source_role='erp-customers' AND r.catalog_customer_key<>@customerKey
          AND r.issuer=@issuer AND r.document_type=@documentType AND r.document_number_token=@token
      ) AND NOT EXISTS (
        -- An unresolved issuer cannot authorize any join; conflicting evidence blocks this result.
        SELECT 1 FROM core.catalog_customer_revision_rows AS r WHERE r.revision_key=@sagKey
          AND r.issuer IS NULL AND r.document_number_token=@token
      ) AND NOT EXISTS (
        SELECT 1 FROM core.catalog_customer_revision_rows AS r
        LEFT JOIN core.catalog_sag_revision_evidence AS d
          ON d.revision_key=r.revision_key AND d.source_record_id=r.source_record_id
        WHERE r.revision_key=@sagKey AND r.issuer=@issuer AND r.document_type=@documentType
          AND r.document_number_token=@token AND d.source_record_id IS NULL
      )
      BEGIN
        INSERT INTO @details
        SELECT TOP (@itemLimit+1) d.source_record_id,d.domain_candidate,d.environment_kind,d.license_codes,
          d.test_started_on,d.production_started_on,d.demo_started_on
        FROM core.catalog_customer_revision_rows AS r
        JOIN core.catalog_sag_revision_evidence AS d
          ON d.revision_key=r.revision_key AND d.source_record_id=r.source_record_id
        WHERE r.revision_key=@sagKey AND r.issuer=@issuer AND r.document_type=@documentType
          AND r.document_number_token=@token
        ORDER BY d.source_record_id;

        DECLARE @itemCount bigint=(SELECT COUNT_BIG(*) FROM @details);
        IF @itemCount<=@itemLimit
        BEGIN
          IF @erpFresh=0 OR @sagFresh=0
            SET @state='stale';
          ELSE IF @itemCount>0 OR (
            EXISTS (SELECT 1 FROM core.catalog_customer_revision_scopes AS s
              WHERE s.revision_key=@sagKey AND s.issuer=@issuer AND s.document_type=@documentType)
            AND NOT EXISTS (SELECT 1 FROM core.catalog_customer_revision_rows AS r
              WHERE r.revision_key=@sagKey AND (r.issuer IS NULL OR r.document_number_token IS NULL))
          )
            SET @state='verified';
          IF @state IN ('verified','stale') SET @verifiedAt=@sagObserved;
        END
      END
    END
  END

  SELECT @state AS evidence_state,@verifiedAt AS verified_at WHERE @state IS NOT NULL;
  SELECT domain_candidate,environment_kind,license_codes,CONVERT(char(10),test_started_on,23) AS test_started_on,
    CONVERT(char(10),production_started_on,23) AS production_started_on,CONVERT(char(10),demo_started_on,23) AS demo_started_on
  FROM @details WHERE @state IN ('verified','stale') ORDER BY source_record_id;
  SELECT mapping.sag_code, module.source_id AS module_id, module.name AS module_name, module.description AS module_description
  FROM core.catalog_customer_source_revisions AS sag
  JOIN settings.catalog_sag_license_module_approvals AS mapping ON mapping.catalog_source_key=sag.catalog_source_key
    AND mapping.binding_version=sag.binding_version AND mapping.profile_version=sag.profile_version
  JOIN settings.catalog_source_bindings AS currentBinding ON currentBinding.catalog_source_key=sag.catalog_source_key
    AND currentBinding.row_version=sag.binding_version AND currentBinding.source_state='active' AND currentBinding.source_role='sag-admin'
  JOIN settings.external_database_connections AS currentProfile ON currentProfile.external_database_connection_key=currentBinding.external_database_connection_key
    AND currentProfile.row_version=sag.profile_version AND currentBinding.validated_profile_version=currentProfile.row_version
    AND currentProfile.status='active' AND currentProfile.active=1 AND currentProfile.encrypt_connection=1 AND currentProfile.password_configured=1
  JOIN licensing.license_modules AS module ON module.module_key=mapping.module_key AND module.status='active' AND module.deleted_at IS NULL
  WHERE sag.revision_key=@sagKey AND @state IN ('verified','stale')
    AND mapping.approved_at<=@now
    AND EXISTS (SELECT 1 FROM @details AS detail
      WHERE CHARINDEX(mapping.sag_code,detail.license_codes COLLATE Latin1_General_100_BIN2)>0)
  ORDER BY mapping.sag_code;
`;

function fail(): never {
  throw new Error("catalog_sag_customer_evidence_unavailable");
}

function mapItem(row: Record<string, unknown>): CatalogSagInventoryEvidence {
  const codes = typeof row.license_codes === "string" ? [...row.license_codes] : row.license_codes;
  const item = normalizeCatalogSagInventoryEvidence({
    domainCandidate: row.domain_candidate, environment: row.environment_kind, licenseCodes: codes,
    testStartedOn: row.test_started_on, productionStartedOn: row.production_started_on, demoStartedOn: row.demo_started_on,
  }, "9999-12-31");
  if (item.domainCandidate !== row.domain_candidate || item.environment !== row.environment_kind ||
      (item.licenseCodes?.join("") ?? null) !== row.license_codes ||
      item.testStartedOn !== row.test_started_on || item.productionStartedOn !== row.production_started_on ||
      item.demoStartedOn !== row.demo_started_on) fail();
  return item;
}

function mapModules(rows: Array<Record<string, unknown>>): CertifiedCatalogLicenseModule[] {
  if (rows.length > 25) return fail();
  const seen = new Set<string>();
  return rows.map(({ sag_code: code, module_id: moduleId, module_name: name, module_description: description }) => {
    if (typeof code !== "string" || !/^[A-SU-Z]$/.test(code) || seen.has(code) ||
      typeof moduleId !== "string" || !moduleId.trim() || moduleId.length > 150 ||
      typeof name !== "string" || !name.trim() || name.length > 200 ||
      (description !== null && (typeof description !== "string" || description.length > 2000))) return fail();
    seen.add(code);
    return { code, moduleId, name, description };
  });
}

/** Service-only; callers must provide an authorization-derived ERP source set. */
export async function readSqlCatalogSagCustomerEvidence(scope: ReadScope): Promise<CatalogSagCustomerEvidence | null> {
  if (!isUuid(scope.customerId) || scope.allowedSourceIds.size === 0) return null;
  if (!["qa", "production"].includes(scope.environment) || !Number.isInteger(scope.matchKeyVersion) ||
      scope.matchKeyVersion < 1 || scope.matchKeyVersion > 32767 || scope.allowedSourceIds.size > maxSources ||
      [...scope.allowedSourceIds].some(id => !isUuid(id))) fail();

  try {
    const pool = await getSqlPool();
    const { recordsets } = await pool.request()
      .input("customerId", sql.UniqueIdentifier, scope.customerId.toLowerCase())
      .input("environment", sql.VarChar(10), scope.environment)
      .input("matchKeyVersion", sql.SmallInt, scope.matchKeyVersion)
      .input("allowedSourceIds", sql.NVarChar(2048), JSON.stringify([...scope.allowedSourceIds].map(id => id.toLowerCase())))
      .input("itemLimit", sql.Int, maxItems)
      .query(readEvidence);
    if (!Array.isArray(recordsets) || recordsets.length !== 3 || !recordsets.every(Array.isArray)) fail();
    const [headers, rows, modules] = recordsets as unknown as Array<Array<Record<string, unknown>>>;
    if (headers.length === 0 && rows.length === 0 && modules.length === 0) return null;
    if (headers.length !== 1 || rows.length > maxItems) fail();
    const { evidence_state: state, verified_at: observedAt } = headers[0];
    if (state !== "verified" && state !== "stale" && state !== "unavailable") fail();
    if (state === "unavailable") {
      if (observedAt !== null || rows.length !== 0 || modules.length !== 0) fail();
      return { state, verifiedAt: null, items: [] };
    }
    if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.valueOf())) fail();
    const items = rows.map(mapItem);
    const licenseModules = mapModules(modules);
    const observedCodes = new Set(items.flatMap(item => item.licenseCodes ?? []));
    if (licenseModules.some(module => !observedCodes.has(module.code))) return fail();
    return { state, verifiedAt: observedAt.toISOString(), items, ...(licenseModules.length ? { licenseModules } : {}) };
  } catch {
    // Never expose comparison tokens, authority denials, connection or SQL details.
    fail();
  }
}
