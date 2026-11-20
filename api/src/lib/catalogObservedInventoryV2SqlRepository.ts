import sql from "mssql";
import { CatalogDirectoryError } from "./catalogCustomerDirectory";
import { catalogLicenseDisplayNames } from "./catalogLicenseDisplayNames";
import type { CatalogObservedInventoryV2Item, CatalogObservedInventoryV2Query,
  CatalogObservedInventoryV2Result } from "./catalogObservedInventoryV2Http";
import { catalogReconciledIdentitySql } from "./catalogReconciledIdentitySql";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { runSqlTransaction } from "./sqlTransaction";

type Scope = CatalogObservedInventoryV2Query & { environment: CatalogEnvironment; matchKeyVersion: number };
type Env = NonNullable<CatalogObservedInventoryV2Item["environment"]>;
type SqlItem = {
  id: string; customerId: string | null; customerName: string | null; name: string | null;
  environment: Env | null; detail: string | null; code: string | null; licenseList: string | null;
};
const environments = new Set<Env>(["production", "test", "demo", "unknown"]);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const rowId = /^[0-9a-f]{64}$/;
const moduleNames = catalogLicenseDisplayNames;

function invalid(): never { throw new CatalogDirectoryError("invalid_filter"); }
function label(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.trim() === value && !/\p{C}/u.test(value);
}
function host(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 253 || /[^a-z0-9.-]/.test(value)) return false;
  const parts = value.split(".");
  return parts.length > 1 && /[a-z]/.test(parts[parts.length - 1]) &&
    parts.every(n => n.length > 0 && n.length <= 63 && !n.startsWith("-") && !n.endsWith("-"));
}
function dbName(value: unknown): value is string {
  return label(value, 128) && /^[A-Za-z0-9_. -]+$/.test(value) && /[A-Za-z0-9]/.test(value);
}
function knownCode(value: unknown): value is keyof typeof moduleNames {
  return typeof value === "string" && Object.hasOwn(moduleNames, value);
}

/** Only safe, permission-filtered display fields are projected outside SQL. */
export const readCatalogObservedInventoryV2Sql = `
${catalogReconciledIdentitySql}
DECLARE @displayModules table(code char(1) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY,name nvarchar(150) NOT NULL);
INSERT @displayModules(code,name)
SELECT [key],CONVERT(nvarchar(150),[value]) FROM OPENJSON(@portalDisplayModules);
DECLARE @displayItems table(id varchar(64) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY,
  customerId char(36) COLLATE Latin1_General_100_BIN2 NULL,customerName nvarchar(512) NULL,name nvarchar(255) NULL,
  environment varchar(10) COLLATE Latin1_General_100_BIN2 NULL,detail nvarchar(253) NULL,
  code char(1) COLLATE Latin1_General_100_BIN2 NULL,licenseList varchar(255) NULL);
DECLARE @displayState varchar(11)='unavailable';

IF @observedActor IS NOT NULL AND (@observedIsSuper=1 OR EXISTS(SELECT 1 FROM @observedAllowed))
BEGIN
  IF @view='licenses' AND @tab='available'
  BEGIN
    INSERT @displayItems(id,code,name) SELECT CONCAT('license-',code),code,name FROM @displayModules;
    SET @displayState='verified';
  END
  ELSE IF @observedSagReady=1 AND (
    EXISTS(SELECT 1 FROM @observedSelected s JOIN @observedHeads h ON h.source_key=s.source_key)
    OR (@observedIsSuper=1 AND @selectedSourceIds IS NULL))
  BEGIN
    IF @view IN ('domains','databases')
    BEGIN
      -- Confirmed public host, sanitized DB name, and explicit environment only.
      -- Do not coalesce the same relation across distinct environments.
      DECLARE @displayLinks table(revision_key bigint NOT NULL, source_record_id int NOT NULL,
        customerId char(36) COLLATE Latin1_General_100_BIN2 NOT NULL,customerName nvarchar(512) NOT NULL,
        observedHost varchar(253) COLLATE Latin1_General_100_BIN2 NULL,environment varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
        PRIMARY KEY(revision_key,source_record_id));
      INSERT @displayLinks
      SELECT i.revision_key,i.source_record_id,i.customer_id,i.customer_name,
        CASE WHEN LEN(e.domain_candidate) BETWEEN 3 AND 253 AND CHARINDEX('.',e.domain_candidate)>0
          AND e.domain_candidate NOT LIKE '%..%' AND RIGHT(e.domain_candidate,1)<>'.' AND LEFT(e.domain_candidate,1)<>'.'
          AND REPLACE(e.domain_candidate,'-','') COLLATE Latin1_General_100_BIN2 NOT LIKE '%[^a-z0-9.]%'
          AND REVERSE(LEFT(REVERSE(e.domain_candidate),CHARINDEX('.',REVERSE(COALESCE(e.domain_candidate,''))+'.')-1))
            COLLATE Latin1_General_100_BIN2 LIKE '%[a-z]%'
          AND NOT EXISTS(SELECT 1 FROM STRING_SPLIT(e.domain_candidate,'.') p WHERE LEN(p.[value]) NOT BETWEEN 1 AND 63
              OR LEFT(p.[value],1)='-' OR RIGHT(p.[value],1)='-')
          THEN e.domain_candidate END,e.environment_kind
      FROM @observedIdentity i JOIN core.catalog_sag_revision_evidence e
        ON e.revision_key=i.revision_key AND e.source_record_id=i.source_record_id;
      IF EXISTS(SELECT 1 FROM @displayLinks d WHERE d.observedHost IS NULL OR d.environment='unknown') SET @observedPartial=1;
      IF @view='domains'
      BEGIN
        ;WITH uniqueLinks AS(
          SELECT customerId,MIN(customerName) AS customerName,observedHost,environment FROM @displayLinks
          WHERE observedHost IS NOT NULL AND (@environmentFilter IS NULL OR environment=@environmentFilter)
          GROUP BY customerId,observedHost,environment)
        INSERT @displayItems(id,customerId,customerName,name,environment)
          SELECT LOWER(CONVERT(char(64),HASHBYTES('SHA2_256',CONCAT('observed-domain:v2:',customerId,':',observedHost,':',environment)),2)),
            customerId,customerName,observedHost,environment
          FROM uniqueLinks;
      END
      ELSE
      BEGIN
        IF EXISTS(SELECT 1 FROM @displayLinks d JOIN core.catalog_sag_company_revision_rows c
          ON c.revision_key=d.revision_key AND c.customer_record_id=d.source_record_id
          LEFT JOIN core.catalog_sag_company_database_names n ON n.revision_key=c.revision_key AND n.company_record_id=c.company_record_id
          WHERE c.is_available IS NULL OR (c.is_available=1 AND n.database_name IS NULL)) SET @observedPartial=1;
        ;WITH uniqueLinks AS(
          SELECT d.customerId,MIN(d.customerName) AS customerName,d.observedHost,d.environment,
            LOWER(n.database_name COLLATE Latin1_General_100_BIN2) AS loweredName,MIN(n.database_name) AS safeName
          FROM @displayLinks d JOIN core.catalog_sag_company_revision_rows c
            ON c.revision_key=d.revision_key AND c.customer_record_id=d.source_record_id AND c.is_available=1
          JOIN core.catalog_sag_company_database_names n ON n.revision_key=c.revision_key AND n.company_record_id=c.company_record_id
          WHERE d.observedHost IS NOT NULL AND (@environmentFilter IS NULL OR d.environment=@environmentFilter)
          GROUP BY d.customerId,d.observedHost,d.environment,LOWER(n.database_name COLLATE Latin1_General_100_BIN2))
        INSERT @displayItems(id,customerId,customerName,name,environment,detail)
          SELECT LOWER(CONVERT(char(64),HASHBYTES('SHA2_256',CONCAT('observed-database:v2:',customerId,':',observedHost,':',
            environment,':',loweredName)),2)),customerId,customerName,safeName,environment,observedHost FROM uniqueLinks;
      END;
    END
    ELSE IF @view='licenses' AND @web IN ('all','in_web')
    BEGIN
      DECLARE @displayCodes table(customerId char(36) COLLATE Latin1_General_100_BIN2 NOT NULL,
        customerName nvarchar(512) NOT NULL,code char(1) COLLATE Latin1_General_100_BIN2 NOT NULL,PRIMARY KEY(customerId,code));
      IF EXISTS(SELECT 1 FROM @observedIdentity i JOIN core.catalog_sag_revision_evidence e
          ON e.revision_key=i.revision_key AND e.source_record_id=i.source_record_id
        WHERE (@state='all' OR i.active_state=@state) AND (e.license_codes IS NULL OR e.license_codes LIKE '%S%'))
        SET @observedPartial=1;
      INSERT @displayCodes
      SELECT i.customer_id,MIN(i.customer_name),m.code
      FROM @observedIdentity i JOIN core.catalog_sag_revision_evidence d
        ON d.revision_key=i.revision_key AND d.source_record_id=i.source_record_id
      JOIN @displayModules m ON CHARINDEX(m.code,d.license_codes COLLATE Latin1_General_100_BIN2)>0
      WHERE (@state='all' OR i.active_state=@state)
      GROUP BY i.customer_id,m.code;
      IF @tab='customers'
      BEGIN
        INSERT @displayItems(id,customerId,customerName,licenseList)
          SELECT c.customerId,c.customerId,c.customerName,m.licenseList
          FROM (SELECT i.customer_id AS customerId,MIN(i.customer_name) AS customerName
            FROM @observedIdentity i WHERE (@state='all' OR i.active_state=@state) GROUP BY i.customer_id) c
          LEFT JOIN (SELECT customerId,STRING_AGG(CONVERT(varchar(1),code),',') WITHIN GROUP(ORDER BY code) AS licenseList
            FROM @displayCodes GROUP BY customerId) m ON m.customerId=c.customerId;
      END
      ELSE IF @tab='licenseCustomers'
      BEGIN
        INSERT @displayItems(id,customerId,customerName)
          SELECT customerId,customerId,customerName FROM @displayCodes WHERE code=@code;
      END;
    END;
    SET @displayState=CASE WHEN @observedPartial=1 THEN 'partial' ELSE 'verified' END;
  END;
END;

-- Filter the entire authorized result set. The same relation yields total and
-- page; CHARINDEX treats % and _ literally (not wildcard syntax).
DECLARE @pageRows table(id varchar(64) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY, position bigint NOT NULL);
INSERT @pageRows
SELECT id,ROW_NUMBER() OVER(ORDER BY customerName COLLATE Latin1_General_100_CI_AI,name COLLATE Latin1_General_100_CI_AI,environment,id)
FROM @displayItems q
WHERE @search IS NULL OR CHARINDEX(@search COLLATE Latin1_General_100_CI_AI,
  q.customerName COLLATE Latin1_General_100_CI_AI)>0
  OR CHARINDEX(@search COLLATE Latin1_General_100_CI_AI,q.customerId COLLATE Latin1_General_100_CI_AI)>0
  OR CHARINDEX(@search COLLATE Latin1_General_100_CI_AI,q.name COLLATE Latin1_General_100_CI_AI)>0
  OR CHARINDEX(@search COLLATE Latin1_General_100_CI_AI,q.detail COLLATE Latin1_General_100_CI_AI)>0;
SELECT @displayState AS state,(SELECT COUNT(*) FROM @pageRows) AS total;
SELECT q.id,q.customerId,q.customerName,q.name,q.environment,q.detail,q.code,q.licenseList
FROM @pageRows r JOIN @displayItems q ON q.id=r.id
WHERE r.position>@skip AND r.position<=@skip+@take ORDER BY r.position;
SELECT source_id AS id,label FROM @observedAllowed ORDER BY label,source_id;
`;

function rejectResponse(): never { throw new Error("catalog_observed_inventory_v2_result_invalid"); }

export function mapCatalogObservedInventoryV2Result(scope: Pick<Scope, "view" | "tab" | "pageSize">,
  summary: readonly { state: CatalogObservedInventoryV2Result["state"]; total: number }[],
  rows: readonly SqlItem[], sources: readonly { id: string; label: string }[]): CatalogObservedInventoryV2Result {
  const head = summary[0];
  if (summary.length !== 1 || !head || !["verified", "partial", "unavailable"].includes(head.state) ||
      !Number.isSafeInteger(head.total) || head.total < 0 || rows.length > scope.pageSize ||
      rows.length > head.total || (head.state === "unavailable" && head.total !== 0) ||
      sources.length > 50 || new Set(sources.map(s => s.id)).size !== sources.length ||
      sources.some(s => !uuid.test(s.id) || !label(s.label, 150))) return rejectResponse();
  const ids = new Set<string>();
  const items = rows.map((r): CatalogObservedInventoryV2Item => {
    if (typeof r.id !== "string" || ids.has(r.id)) return rejectResponse();
    ids.add(r.id);
    if (scope.view === "licenses" && (scope.tab ?? "available") === "available") {
      if (!knownCode(r.code) || r.id !== "license-" + r.code || r.name !== moduleNames[r.code]) return rejectResponse();
      return { id: r.id, code: r.code, name: r.name };
    }
    if (typeof r.customerId !== "string" || !uuid.test(r.customerId) || !label(r.customerName, 512)) return rejectResponse();
    if (scope.view !== "licenses") {
      if (!rowId.test(r.id) || r.environment === null || !environments.has(r.environment) ||
          (scope.view === "domains" ? !host(r.name) || r.detail !== null : !dbName(r.name) || !host(r.detail))) {
        return rejectResponse();
      }
      return { id: r.id, customerId: r.customerId, customerName: r.customerName, name: r.name!,
        environment: r.environment, ...(scope.view === "databases" ? { detail: r.detail! } : {}) };
    }
    if (r.id !== r.customerId) return rejectResponse();
    const customer = { id: r.id, customerId: r.customerId, customerName: r.customerName };
    if (scope.tab !== "customers") return customer;
    const licenses = r.licenseList?.split(",") ?? [];
    if (licenses.length > 24 || licenses.some((v, i) => !knownCode(v) || (i > 0 && licenses[i - 1] >= v))) {
      return rejectResponse();
    }
    return { ...customer, licenses: licenses.map(code => knownCode(code) ? moduleNames[code] : rejectResponse()) };
  });
  return { state: head.state, total: head.total, items, sources: sources.map(({ id, label: name }) => ({ id, label: name })) };
}

export async function readSqlCatalogObservedInventoryV2(scope: Scope): Promise<CatalogObservedInventoryV2Result> {
  if (!["domains", "databases", "licenses"].includes(scope.view) || !["qa", "production"].includes(scope.environment) ||
      !Number.isInteger(scope.matchKeyVersion) || scope.matchKeyVersion < 1 || scope.matchKeyVersion > 32767 ||
      !Number.isInteger(scope.page) || scope.page < 1 || scope.page > 2000 ||
      !Number.isInteger(scope.pageSize) || scope.pageSize < 1 || scope.pageSize > 100 || !label(scope.actorId, 150) ||
      scope.allowedSourceIds.size > 50 || [...scope.allowedSourceIds].some(id => !uuid.test(id)) ||
      (scope.sourceIds && (scope.sourceIds.length < 1 || scope.sourceIds.length > 50 ||
        scope.sourceIds.some(id => !scope.allowedSourceIds.has(id)))) ||
      (scope.search && (scope.search.length > 120 || /\p{C}/u.test(scope.search))) ||
      (scope.environmentFilter !== undefined && !environments.has(scope.environmentFilter)) ||
      (scope.state !== undefined && !["all", "active", "inactive", "unverified"].includes(scope.state)) ||
      (scope.web !== undefined && !["all", "in_web", "not_in_web", "unverified"].includes(scope.web)) ||
      (scope.tab !== undefined && !["available", "customers", "licenseCustomers"].includes(scope.tab)) ||
      (scope.tab === "licenseCustomers" ? !knownCode(scope.code) : scope.code !== undefined)) return invalid();
  const result = await runSqlTransaction(transaction => new sql.Request(transaction)
    .input("actorId", sql.NVarChar(150), scope.actorId)
    .input("environment", sql.VarChar(10), scope.environment)
    .input("matchKeyVersion", sql.SmallInt, scope.matchKeyVersion)
    .input("sourceIds", sql.NVarChar(sql.MAX), JSON.stringify([...scope.allowedSourceIds]))
    .input("selectedSourceIds", sql.NVarChar(sql.MAX), scope.sourceIds ? JSON.stringify(scope.sourceIds) : null)
    .input("portalDisplayModules", sql.NVarChar(sql.MAX), JSON.stringify(moduleNames))
    .input("view", sql.VarChar(10), scope.view)
    .input("tab", sql.VarChar(16), scope.tab ?? "available")
    .input("code", sql.Char(1), scope.code ?? null)
    .input("state", sql.VarChar(10), scope.state ?? (scope.tab === "licenseCustomers" ? "active" : "all"))
    .input("web", sql.VarChar(10), scope.web ?? "in_web")
    .input("environmentFilter", sql.VarChar(10), scope.environmentFilter ?? null)
    .input("search", sql.NVarChar(120), scope.search?.trim() || null)
    .input("skip", sql.Int, (scope.page - 1) * scope.pageSize)
    .input("take", sql.Int, scope.pageSize)
    .query(readCatalogObservedInventoryV2Sql));
  if (!Array.isArray(result.recordsets) || result.recordsets.length !== 3 ||
      !result.recordsets.every(recordset => Array.isArray(recordset))) return rejectResponse();
  return mapCatalogObservedInventoryV2Result(scope, result.recordsets[0], result.recordsets[1], result.recordsets[2]);
}
