import sql from "mssql";
import {
  isCatalogScheduleChoiceDatabase, isCatalogScheduleChoiceDomain, isCatalogScheduleChoiceEnvironment,
  isCatalogScheduleChoiceText, isCatalogScheduleChoiceUuid, parseCatalogScheduleLicenseOption, validCatalogScheduleChoiceFilters,
  type CatalogScheduleChoice, type CatalogScheduleChoicesQuery, type CatalogScheduleChoicesResult,
} from "./catalogScheduleChoices";
import { catalogLicenseDisplayNames } from "./catalogLicenseDisplayNames";
import { catalogReconciledIdentitySql } from "./catalogReconciledIdentitySql";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { runSqlTransaction } from "./sqlTransaction";

type Scope = CatalogScheduleChoicesQuery & Readonly<{ portalEnvironment: CatalogEnvironment; matchKeyVersion: number }>;
const fail = (): never => { throw new Error("catalog_schedule_choices_unavailable"); };

/** A snapshot display relation. There is deliberately no operational target/link ID projection. */
export const readCatalogScheduleChoicesSql = `
${catalogReconciledIdentitySql}
DECLARE @choiceItems table(id varchar(64) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY,
  customerId char(36) COLLATE Latin1_General_100_BIN2 NOT NULL,customerName nvarchar(512) NOT NULL,
  domainName nvarchar(253) COLLATE Latin1_General_100_BIN2 NULL,databaseName nvarchar(128) COLLATE Latin1_General_100_BIN2 NULL,
  targetEnvironment varchar(10) COLLATE Latin1_General_100_BIN2 NULL);
DECLARE @choiceState varchar(11)='unavailable';
DECLARE @choiceLicenseOptions table(code char(1) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY,name nvarchar(150) NOT NULL);
IF @observedActor IS NOT NULL AND @observedSagReady=1 AND (
  EXISTS(SELECT 1 FROM @observedSelected s JOIN @observedHeads h ON h.source_key=s.source_key)
  OR (@observedIsSuper=1 AND @selectedSourceIds IS NULL))
BEGIN
  IF @kind='customer' AND @moduleCode IS NULL
  BEGIN
    INSERT @choiceItems(id,customerId,customerName)
      SELECT i.customer_id,i.customer_id,MIN(i.customer_name) FROM @observedIdentity i
      JOIN core.catalog_sag_revision_evidence d ON d.revision_key=i.revision_key AND d.source_record_id=i.source_record_id
      WHERE i.active_state IN ('active','unverified') AND (@customerId IS NULL OR i.customer_id=@customerId)
      GROUP BY i.customer_id;
  END
  ELSE
  BEGIN
    DECLARE @choiceLinks table(revision_key bigint NOT NULL,source_record_id int NOT NULL,
      customerId char(36) COLLATE Latin1_General_100_BIN2 NOT NULL,customerName nvarchar(512) NOT NULL,
      domainName nvarchar(253) COLLATE Latin1_General_100_BIN2 NULL,targetEnvironment varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
      licenseCodes varchar(25) COLLATE Latin1_General_100_BIN2 NULL,
      PRIMARY KEY(revision_key,source_record_id));
    INSERT @choiceLinks
    SELECT i.revision_key,i.source_record_id,i.customer_id,i.customer_name,
      CASE WHEN LEN(d.domain_candidate) BETWEEN 3 AND 253 AND CHARINDEX('.',d.domain_candidate)>0
        AND d.domain_candidate NOT LIKE '%..%' AND RIGHT(d.domain_candidate,1)<>'.' AND LEFT(d.domain_candidate,1)<>'.'
        AND REPLACE(d.domain_candidate,'-','') COLLATE Latin1_General_100_BIN2 NOT LIKE '%[^a-z0-9.]%'
        AND REVERSE(LEFT(REVERSE(d.domain_candidate),CHARINDEX('.',REVERSE(COALESCE(d.domain_candidate,''))+'.')-1))
          COLLATE Latin1_General_100_BIN2 LIKE '%[a-z]%'
        AND NOT EXISTS(SELECT 1 FROM STRING_SPLIT(d.domain_candidate,'.') p WHERE LEN(p.[value]) NOT BETWEEN 1 AND 63
              OR LEFT(p.[value],1)='-' OR RIGHT(p.[value],1)='-') THEN d.domain_candidate END,d.environment_kind,d.license_codes
    FROM @observedIdentity i
    JOIN core.catalog_sag_revision_evidence d ON d.revision_key=i.revision_key AND d.source_record_id=i.source_record_id
    WHERE i.active_state IN ('active','unverified') AND (@customerId IS NULL OR i.customer_id=@customerId)
      AND (@targetEnvironment IS NULL OR d.environment_kind=@targetEnvironment OR d.environment_kind='unknown')
      AND (@domain IS NULL OR d.domain_candidate IS NULL OR (d.domain_candidate COLLATE Latin1_General_100_BIN2=@domain COLLATE Latin1_General_100_BIN2
        AND DATALENGTH(d.domain_candidate)=DATALENGTH(@domain)));
    IF EXISTS(SELECT 1 FROM @choiceLinks x WHERE x.domainName IS NULL OR x.targetEnvironment='unknown')
      SET @observedPartial=1;
    -- An unresolved license claim holds that observation; never inherit it from
    -- a sibling tenant, a different environment, or another Company parent.
    IF EXISTS(SELECT 1 FROM @choiceLinks l WHERE
      (@kind<>'database' AND @moduleCode IS NOT NULL AND l.licenseCodes IS NULL)
        OR (@kind='license' AND (l.licenseCodes IS NULL OR CHARINDEX('S',l.licenseCodes)>0))) SET @observedPartial=1;
    IF @kind='license'
    BEGIN
      DECLARE @choiceModules table(code char(1) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY,name nvarchar(150) NOT NULL);
      INSERT @choiceModules(code,name)
        SELECT [key],CONVERT(nvarchar(150),[value]) FROM OPENJSON(@moduleDictionary);
      INSERT @choiceLicenseOptions(code,name)
        SELECT m.code,m.name FROM @choiceModules m
        WHERE EXISTS(SELECT 1 FROM @choiceLinks l
          WHERE l.domainName IS NOT NULL AND l.targetEnvironment IN ('production','test','demo') AND CHARINDEX(m.code,l.licenseCodes)>0)
          AND (@search IS NULL OR CHARINDEX(@search COLLATE Latin1_General_100_CI_AI,m.name COLLATE Latin1_General_100_CI_AI)>0
            OR CHARINDEX(@search COLLATE Latin1_General_100_CI_AI,m.code COLLATE Latin1_General_100_CI_AI)>0);
    END
    ELSE IF @kind='customer'
    BEGIN
      INSERT @choiceItems(id,customerId,customerName)
        SELECT l.customerId,l.customerId,MIN(l.customerName) FROM @choiceLinks l
        WHERE l.domainName IS NOT NULL AND l.targetEnvironment IN ('production','test','demo')
          AND CHARINDEX(@moduleCode,l.licenseCodes)>0
        GROUP BY l.customerId;
    END
    ELSE IF @kind='domain'
    BEGIN
      ;WITH domains AS (
        SELECT l.customerId,MIN(l.customerName) AS customerName,l.domainName,l.targetEnvironment
        FROM @choiceLinks l WHERE l.domainName IS NOT NULL AND l.targetEnvironment IN ('production','test','demo')
          AND (@moduleCode IS NULL OR CHARINDEX(@moduleCode,l.licenseCodes)>0)
        GROUP BY l.customerId,l.domainName,l.targetEnvironment)
      INSERT @choiceItems(id,customerId,customerName,domainName,targetEnvironment)
        SELECT LOWER(CONVERT(char(64),HASHBYTES('SHA2_256',CONCAT(N'catalog-schedule-choice:domain:',
          d.customerId,N':',d.domainName,N':',d.targetEnvironment)),2)),d.customerId,d.customerName,d.domainName,d.targetEnvironment
        FROM domains d;
    END
    ELSE IF @kind='database'
    BEGIN
      IF EXISTS(SELECT 1 FROM @choiceLinks l JOIN core.catalog_sag_company_revision_rows c
        ON c.revision_key=l.revision_key AND c.customer_record_id=l.source_record_id
        LEFT JOIN core.catalog_sag_company_database_names n ON n.revision_key=c.revision_key AND n.company_record_id=c.company_record_id
        WHERE (@database IS NULL OR n.database_name IS NULL OR
            (n.database_name COLLATE Latin1_General_100_BIN2=@database COLLATE Latin1_General_100_BIN2
              AND DATALENGTH(n.database_name)=DATALENGTH(@database)))
          AND (c.is_available IS NULL OR (c.is_available=1 AND
            (n.database_name IS NULL OR (@moduleCode IS NOT NULL AND l.licenseCodes IS NULL)))))
        SET @observedPartial=1;
      ;WITH databases AS (
        SELECT l.customerId,MIN(l.customerName) AS customerName,l.domainName,l.targetEnvironment,
          n.database_name COLLATE Latin1_General_100_BIN2 AS database_name
        FROM @choiceLinks l JOIN core.catalog_sag_company_revision_rows c
          ON c.revision_key=l.revision_key AND c.customer_record_id=l.source_record_id AND c.is_available=1
        JOIN core.catalog_sag_company_database_names n ON n.revision_key=c.revision_key AND n.company_record_id=c.company_record_id
        WHERE l.domainName IS NOT NULL AND l.targetEnvironment IN ('production','test','demo')
          AND (@moduleCode IS NULL OR CHARINDEX(@moduleCode,l.licenseCodes)>0)
          AND (@database IS NULL OR (n.database_name COLLATE Latin1_General_100_BIN2=@database COLLATE Latin1_General_100_BIN2
            AND DATALENGTH(n.database_name)=DATALENGTH(@database)))
        GROUP BY l.customerId,l.domainName,l.targetEnvironment,n.database_name COLLATE Latin1_General_100_BIN2)
      INSERT @choiceItems(id,customerId,customerName,domainName,databaseName,targetEnvironment)
        SELECT LOWER(CONVERT(char(64),HASHBYTES('SHA2_256',CONCAT(N'catalog-schedule-choice:database:',
          d.customerId,N':',d.domainName,N':',d.targetEnvironment,N':',d.database_name)),2)),d.customerId,d.customerName,
          d.domainName,d.database_name,d.targetEnvironment FROM databases d;
    END;
  END;
  SET @choiceState=CASE WHEN @observedPartial=1 THEN 'partial' ELSE 'verified' END;
END;

IF @kind='license'
BEGIN
  SELECT @choiceState AS state,(SELECT COUNT(*) FROM @choiceLicenseOptions) AS total;
  SELECT code,name FROM @choiceLicenseOptions ORDER BY name COLLATE Latin1_General_100_CI_AI,code
    OFFSET @skip ROWS FETCH NEXT @take ROWS ONLY;
  RETURN;
END;

DECLARE @choicePage table(id varchar(64) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY,position bigint NOT NULL);
INSERT @choicePage
SELECT i.id,ROW_NUMBER() OVER(ORDER BY i.customerName COLLATE Latin1_General_100_CI_AI,i.domainName,i.databaseName,i.targetEnvironment,i.id)
FROM @choiceItems i
WHERE @search IS NULL OR CHARINDEX(@search COLLATE Latin1_General_100_CI_AI,i.customerName COLLATE Latin1_General_100_CI_AI)>0
  OR CHARINDEX(@search COLLATE Latin1_General_100_CI_AI,i.domainName COLLATE Latin1_General_100_CI_AI)>0
  OR CHARINDEX(@search COLLATE Latin1_General_100_CI_AI,i.databaseName COLLATE Latin1_General_100_CI_AI)>0;
SELECT @choiceState AS state,(SELECT COUNT(*) FROM @choicePage) AS total;
SELECT i.id,i.customerId,i.customerName,i.domainName,i.databaseName,i.targetEnvironment
FROM @choicePage q JOIN @choiceItems i ON i.id=q.id
WHERE q.position>@skip AND q.position<=@skip+@take ORDER BY q.position;
`;

export function parseCatalogScheduleChoicesSqlResult(scope: CatalogScheduleChoicesQuery, input: unknown): CatalogScheduleChoicesResult {
  if (!Array.isArray(input) || input.length !== 2 || !Array.isArray(input[0]) || input[0].length !== 1 ||
      !Array.isArray(input[1])) return fail();
  const head: unknown = input[0][0];
  if (!head || typeof head !== "object" || !("state" in head) || !("total" in head)) return fail();
  const { state, total } = head;
  if ((state !== "verified" && state !== "partial" && state !== "unavailable") ||
      typeof total !== "number" || !Number.isSafeInteger(total) || total < 0 || (state === "unavailable" && total !== 0) ||
      input[1].length > scope.pageSize || input[1].length > total) return fail();
  const seen = new Set<string>();
  if (scope.kind === "license") {
    if (total > Object.keys(catalogLicenseDisplayNames).length) return fail();
    const licenseOptions = input[1].map((row: unknown) => {
      const option = parseCatalogScheduleLicenseOption(row);
      if (!option || seen.has(option.code)) return fail();
      seen.add(option.code);
      return option;
    });
    return { state, total, items: [], licenseOptions };
  }
  const items = input[1].map((row: Record<string, unknown>): CatalogScheduleChoice => {
    if (!row || typeof row !== "object") return fail();
    const { id, customerId, customerName, domainName, databaseName, targetEnvironment } = row;
    if (typeof id !== "string" || seen.has(id) || !isCatalogScheduleChoiceUuid(customerId) ||
        (scope.customerId !== undefined && customerId !== scope.customerId) || !isCatalogScheduleChoiceText(customerName, 512)) return fail();
    seen.add(id);
    const core = { id, customerId, customerName, eligibility: "observed_only" as const };
    if (scope.kind === "customer") {
      if (id !== customerId || domainName !== null || databaseName !== null || targetEnvironment !== null) return fail();
      return core;
    }
    if (id.length !== 64 || !/^[0-9a-f]{64}$/.test(id) || !isCatalogScheduleChoiceDomain(domainName) ||
        (scope.domain !== undefined && domainName !== scope.domain) ||
        !isCatalogScheduleChoiceEnvironment(targetEnvironment) ||
        (scope.environment !== undefined && targetEnvironment !== scope.environment)) return fail();
    const target = { ...core, domain: domainName, environment: targetEnvironment };
    if (scope.kind === "domain" && databaseName === null) return target;
    if (scope.kind === "database" && isCatalogScheduleChoiceDatabase(databaseName) &&
        (scope.database === undefined || databaseName === scope.database)) return { ...target, database: databaseName };
    return fail();
  });
  return { state, total, items };
}

export async function readSqlCatalogScheduleChoices(scope: Scope): Promise<CatalogScheduleChoicesResult> {
  if (!validCatalogScheduleChoiceFilters(scope) || !isCatalogScheduleChoiceText(scope.actorId, 150)
      || !["qa", "production"].includes(scope.portalEnvironment) || !Number.isInteger(scope.matchKeyVersion)
      || scope.matchKeyVersion < 1 || scope.matchKeyVersion > 32767 || scope.allowedSourceIds.size > 50
      || [...scope.allowedSourceIds].some(id => !isCatalogScheduleChoiceUuid(id))) return fail();
  const { recordsets } = await runSqlTransaction(tx => new sql.Request(tx)
    .input("actorId", sql.NVarChar(150), scope.actorId)
    .input("environment", sql.VarChar(10), scope.portalEnvironment)
    .input("matchKeyVersion", sql.SmallInt, scope.matchKeyVersion)
    .input("sourceIds", sql.NVarChar(sql.MAX), JSON.stringify([...scope.allowedSourceIds]))
    .input("selectedSourceIds", sql.NVarChar(sql.MAX), null)
    .input("kind", sql.VarChar(10), scope.kind)
    .input("moduleCode", sql.Char(1), scope.moduleCode ?? null)
    .input("moduleDictionary", sql.NVarChar(sql.MAX), JSON.stringify(catalogLicenseDisplayNames))
    .input("customerId", sql.Char(36), scope.customerId ?? null)
    .input("domain", sql.VarChar(253), scope.domain ?? null)
    .input("database", sql.NVarChar(128), scope.database ?? null)
    .input("targetEnvironment", sql.VarChar(10), scope.environment ?? null)
    .input("search", sql.NVarChar(120), scope.search ?? null)
    .input("skip", sql.Int, (scope.page - 1) * scope.pageSize)
    .input("take", sql.Int, scope.pageSize)
    .query(readCatalogScheduleChoicesSql));
  return parseCatalogScheduleChoicesSqlResult(scope, recordsets);
}
