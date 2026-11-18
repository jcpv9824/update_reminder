/** Fixed, SELECT-only contracts. The transport owns TLS, credentials and target authorization. */
export type CatalogExternalContract = "erp_v1" | "sag_admin_v1";

export interface CatalogErpSourceRecord {
  sourceRecordId: number;
  officialName: string | null;
  /** Internal identity candidate. Do not publish the NIT or infer its issuer from the connection. */
  documentNumber: string | null;
  activeCode: "S" | "N" | null;
}

export interface CatalogSagSourceRecord {
  sourceRecordId: number;
  documentNumber: string | null;
  /** Reported grouping evidence, not a verified document issuer. */
  reportedCountryId: number | null;
  environment: "production" | "test" | "demo" | "unknown";
  /** null means membership cannot be interpreted; [] is a verified empty set. */
  licenseCodes: readonly string[] | null;
  domainCandidate: string | null;
  testStartedOn: string | null;
  productionStartedOn: string | null;
  demoStartedOn: string | null;
}

export interface CatalogExternalReadStatement {
  tag: "schema" | "page";
  sql: string;
  /** Bind only these parameters as SQL int. Never interpolate them into the SQL. */
  parameters: Readonly<Partial<{ afterId: number | null; pageSize: number }>>;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface CatalogExternalReadSession {
  /** The transport must not claim verification for separate mutable reads across pages. */
  consistency: "verified" | "unverified";
  select(statement: CatalogExternalReadStatement): Promise<readonly unknown[]>;
}

export interface CatalogExternalSourceTransport {
  /** One authorized source and a single consistent revision. Dispose and cancel on timeout. */
  withConsistentRead<T>(
    request: Readonly<{ contract: CatalogExternalContract; timeoutMs: number; signal: AbortSignal }>,
    read: (session: CatalogExternalReadSession) => Promise<T>,
  ): Promise<T>;
}

export interface CatalogExternalReadOptions {
  pageSize?: number;
  maxRows?: number;
  statementTimeoutMs?: number;
  totalTimeoutMs?: number;
  signal?: AbortSignal;
}

type UnavailableReason = "invalid_options" | "contract_unapproved" | "schema_unverified" | "write_access" |
  "consistency_unverified" | "invalid_rows" | "row_limit" | "timeout" | "cancelled" | "connection_failed";

export type CatalogExternalReadResult<T> = { status: "complete"; records: readonly T[] } |
  { status: "unavailable"; reason: UnavailableReason };

const textTypes = [167, 175, 231, 239] as const;
const fields = {
  erp_v1: [
    ["dbo.clientes", "ka_nl_tercero", [56]],
    ["dbo.clientes", "sc_activo", textTypes],
    ["dbo.terceros", "ka_nl_tercero", [56]],
    ["dbo.terceros", "n_nit", [106, 108]],
    ["dbo.terceros", "sc_nombre", textTypes],
  ],
  sag_admin_v1: [
    ["dbo.Customers", "Id", [56]],
    ["dbo.Customers", "Document", textTypes],
    ["dbo.Customers", "CountryId", [56]],
    ["dbo.Customers", "Environment", textTypes],
    ["dbo.Customers", "LicensedModules", textTypes],
    ["dbo.Customers", "Url", textTypes],
    ["dbo.Customers", "FechasEnvironment", textTypes],
  ],
} as const;

// Only compiler-owned, closed identifiers reach this SQL builder.
function schemaStatement(contract: CatalogExternalContract): string {
  const scope = fields[contract];
  const tables = [...new Set(scope.map(([table]) => table))];
  const matches = scope.map(([table, column, types]) => `EXISTS (
    SELECT 1 FROM sys.columns AS c
    WHERE c.object_id = OBJECT_ID(N'${table}', N'U') AND c.name = N'${column}'
      AND c.system_type_id IN (${types.join(",")})
  )`);
  const keys = tables.map(table => `EXISTS (
    SELECT 1
    FROM sys.indexes AS i
    JOIN sys.index_columns AS k ON k.object_id = i.object_id AND k.index_id = i.index_id
    JOIN sys.columns AS c ON c.object_id = k.object_id AND c.column_id = k.column_id
    WHERE i.object_id = OBJECT_ID(N'${table}', N'U') AND i.is_unique = 1 AND i.is_disabled = 0
      AND i.has_filter = 0 AND i.is_hypothetical = 0 AND k.key_ordinal = 1 AND c.is_nullable = 0
      AND c.name = N'${contract === "erp_v1" ? "ka_nl_tercero" : "Id"}'
      AND NOT EXISTS (SELECT 1 FROM sys.index_columns AS k2
        WHERE k2.object_id = i.object_id AND k2.index_id = i.index_id AND k2.key_ordinal > 1)
  )`);
  const writable = tables.flatMap(table => (["INSERT", "UPDATE", "DELETE", "ALTER", "CONTROL"] as const)
    .map(permission => `HAS_PERMS_BY_NAME(N'${table}', 'OBJECT', '${permission}') = 0`));
  return `SELECT
    CONVERT(bit, CASE WHEN ${[...matches, ...keys].join(" AND ")} THEN 1 ELSE 0 END) AS compatible,
    CONVERT(bit, CASE WHEN IS_SRVROLEMEMBER(N'sysadmin') = 0
      AND HAS_PERMS_BY_NAME(NULL, NULL, 'CONTROL SERVER') = 0
      AND HAS_PERMS_BY_NAME(NULL, NULL, 'ALTER ANY LOGIN') = 0
      AND HAS_PERMS_BY_NAME(NULL, NULL, 'ALTER ANY SERVER ROLE') = 0
      AND IS_ROLEMEMBER(N'db_owner') = 0 AND IS_ROLEMEMBER(N'db_datawriter') = 0
      AND HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CONTROL') = 0
      AND NOT EXISTS (SELECT 1 FROM sys.fn_my_permissions(DB_NAME(), 'DATABASE')
        WHERE permission_name LIKE 'CREATE %' OR permission_name LIKE 'ALTER %'
          OR permission_name IN ('INSERT', 'UPDATE', 'DELETE', 'EXECUTE', 'TAKE OWNERSHIP'))
      AND NOT EXISTS (
        SELECT 1 FROM sys.objects AS userObject
        JOIN sys.schemas AS ownerSchema ON ownerSchema.schema_id=userObject.schema_id
        CROSS APPLY sys.fn_my_permissions(QUOTENAME(ownerSchema.name)+N'.'+QUOTENAME(userObject.name), 'OBJECT') AS effective
        WHERE userObject.is_ms_shipped=0 AND userObject.[type] IN ('U','V','SN','P','PC','FN','FS','FT','IF','TF')
          AND effective.permission_name IN ('INSERT','UPDATE','DELETE','ALTER','CONTROL','EXECUTE','TAKE OWNERSHIP')
      )
      AND ${tables.map(table => `HAS_PERMS_BY_NAME(N'${table}', 'OBJECT', 'SELECT') = 1`).join(" AND ")}
      AND ${writable.join(" AND ")} THEN 1 ELSE 0 END) AS readOnly`;
}

const pages = {
  erp_v1: `SELECT TOP (@pageSize)
    c.ka_nl_tercero AS sourceRecordId,
    CASE WHEN DATALENGTH(CONVERT(nvarchar(max), t.sc_nombre)) <= 1024
      THEN CONVERT(nvarchar(512), t.sc_nombre) ELSE NULL END AS officialName,
    CASE WHEN t.n_nit = ROUND(t.n_nit, 0, 1)
      THEN CONVERT(varchar(40), CONVERT(decimal(38,0), t.n_nit)) ELSE NULL END AS documentNumber,
    CASE WHEN UPPER(LTRIM(RTRIM(c.sc_activo))) IN ('S','N')
      THEN UPPER(LTRIM(RTRIM(c.sc_activo))) ELSE NULL END AS activeCode
  FROM dbo.clientes AS c
  LEFT JOIN dbo.terceros AS t ON t.ka_nl_tercero = c.ka_nl_tercero
  WHERE @afterId IS NULL OR c.ka_nl_tercero > @afterId
  ORDER BY c.ka_nl_tercero ASC`,
  sag_admin_v1: `SELECT TOP (@pageSize)
    c.Id AS sourceRecordId,
    CASE WHEN DATALENGTH(CONVERT(nvarchar(max), c.Document)) <= 256
      THEN CONVERT(nvarchar(128), c.Document) ELSE NULL END AS documentNumber,
    c.CountryId AS reportedCountryId,
    CASE WHEN DATALENGTH(CONVERT(nvarchar(max), c.Environment)) <= 128
      THEN CONVERT(nvarchar(64), c.Environment) ELSE NULL END AS environment,
    CASE WHEN DATALENGTH(CONVERT(nvarchar(max), c.LicensedModules)) <= 2048
      THEN CONVERT(nvarchar(1024), c.LicensedModules) ELSE NULL END AS licensedModules,
    CASE WHEN LEN(host.candidate) BETWEEN 3 AND 253 AND CHARINDEX(N'.',host.candidate)>0
      AND DATALENGTH(host.candidate)=DATALENGTH(RTRIM(host.candidate))
      AND host.candidate COLLATE Latin1_General_100_BIN2 NOT LIKE N'%[^0-9A-Za-z.-]%'
      THEN CONVERT(varchar(253),LOWER(host.candidate COLLATE Latin1_General_100_BIN2)) END AS domainCandidate,
    dates.testStartedOn, dates.productionStartedOn, dates.demoStartedOn
  FROM dbo.Customers AS c
  CROSS APPLY (VALUES (CASE WHEN DATALENGTH(CONVERT(nvarchar(max),c.Url))<=8000
    THEN LTRIM(RTRIM(CONVERT(nvarchar(4000),c.Url))) END)) AS raw(link)
  CROSS APPLY (VALUES (CASE
    WHEN LOWER(LEFT(raw.link,8) COLLATE Latin1_General_100_BIN2)=N'https://' THEN SUBSTRING(raw.link,9,4000)
    WHEN LOWER(LEFT(raw.link,7) COLLATE Latin1_General_100_BIN2)=N'http://' THEN SUBSTRING(raw.link,8,4000)
    ELSE NULL END)) AS url(rest)
  CROSS APPLY (VALUES (LEFT(url.rest,PATINDEX(N'%[/?#]%',COALESCE(url.rest,N'')+N'/')-1))) AS authority(part)
  CROSS APPLY (VALUES (CHARINDEX(N':',authority.part),
    SUBSTRING(authority.part,CHARINDEX(N':',authority.part)+1,4000))) AS port(splitAt,suffix)
  CROSS APPLY (VALUES (CASE
    WHEN CHARINDEX(N'@',authority.part)>0 OR CHARINDEX(NCHAR(92),authority.part)>0 THEN NULL
    WHEN port.splitAt=0 THEN authority.part
    WHEN LEN(port.suffix) BETWEEN 1 AND 5 AND port.suffix COLLATE Latin1_General_100_BIN2 NOT LIKE N'%[^0-9]%'
      AND TRY_CONVERT(int,port.suffix) BETWEEN 1 AND 65535 THEN LEFT(authority.part,NULLIF(port.splitAt,0)-1)
    END)) AS host(candidate)
  OUTER APPLY (
    SELECT
      CASE WHEN SUM(CASE WHEN item.[key]=N'FechaInicioPruebas' THEN 1 ELSE 0 END)=1
        THEN MAX(CASE WHEN item.[key]=N'FechaInicioPruebas' THEN valid.dayText END) END AS testStartedOn,
      CASE WHEN SUM(CASE WHEN item.[key]=N'FechaInicioProduccion' THEN 1 ELSE 0 END)=1
        THEN MAX(CASE WHEN item.[key]=N'FechaInicioProduccion' THEN valid.dayText END) END AS productionStartedOn,
      CASE WHEN SUM(CASE WHEN item.[key]=N'FechaInicioDemo' THEN 1 ELSE 0 END)=1
        THEN MAX(CASE WHEN item.[key]=N'FechaInicioDemo' THEN valid.dayText END) END AS demoStartedOn
    FROM OPENJSON(CASE WHEN DATALENGTH(c.FechasEnvironment)<=8192 AND ISJSON(c.FechasEnvironment)=1
      THEN c.FechasEnvironment ELSE N'{}' END) AS item
    CROSS APPLY (VALUES (CASE WHEN item.[type]=1 AND DATALENGTH(item.[value]) BETWEEN 20 AND 128
      AND LEFT(item.[value],10) COLLATE Latin1_General_100_BIN2 LIKE N'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND (LEN(item.[value])=10 OR (SUBSTRING(item.[value],11,1)=N'T'
        AND TRY_CONVERT(datetimeoffset(3),item.[value],127) IS NOT NULL))
      AND TRY_CONVERT(date,LEFT(item.[value],10),23) IS NOT NULL
      THEN CONVERT(varchar(10),LEFT(item.[value],10)) END)) AS valid(dayText)
    WHERE item.[key] COLLATE Latin1_General_100_BIN2 IN (N'FechaInicioPruebas',N'FechaInicioProduccion',N'FechaInicioDemo')
      AND DATALENGTH(item.[key])=CASE item.[key] COLLATE Latin1_General_100_BIN2
        WHEN N'FechaInicioPruebas' THEN DATALENGTH(N'FechaInicioPruebas')
        WHEN N'FechaInicioProduccion' THEN DATALENGTH(N'FechaInicioProduccion')
        WHEN N'FechaInicioDemo' THEN DATALENGTH(N'FechaInicioDemo') END
  ) AS dates
  WHERE @afterId IS NULL OR c.Id > @afterId
  ORDER BY c.Id ASC`,
} as const;

/** Shared with the transport: callers cannot introduce any other SQL text. */
export function catalogExternalSelectSql(
  contract: CatalogExternalContract, tag: CatalogExternalReadStatement["tag"],
): string {
  return tag === "schema" ? schemaStatement(contract) : pages[contract];
}

class Unavailable extends Error {
  constructor(readonly reason: UnavailableReason) { super(reason); }
}

export { Unavailable as CatalogExternalReadUnavailable };

function rowWithKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      keys.length !== Object.keys(value).length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Unavailable("invalid_rows");
  }
  return value as Record<string, unknown>;
}

function sqlInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
    throw new Unavailable("invalid_rows");
  }
  return value;
}

function optionalText(value: unknown, max: number, preserveEmpty = false): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > max) throw new Unavailable("invalid_rows");
  const trimmed = value.trim();
  return preserveEmpty ? trimmed : trimmed || null;
}

function parseErp(value: unknown): CatalogErpSourceRecord {
  const row = rowWithKeys(value, ["sourceRecordId", "officialName", "documentNumber", "activeCode"]);
  const code = optionalText(row.activeCode, 10)?.toUpperCase();
  const document = optionalText(row.documentNumber, 40);
  return { sourceRecordId: sqlInt(row.sourceRecordId), officialName: optionalText(row.officialName, 512),
    documentNumber: document && /^\d{1,38}$/.test(document) ? document : null,
    activeCode: code === "S" || code === "N" ? code : null };
}

function parseSag(value: unknown): CatalogSagSourceRecord {
  const row = rowWithKeys(value, ["sourceRecordId", "documentNumber", "reportedCountryId", "environment", "licensedModules",
    "domainCandidate", "testStartedOn", "productionStartedOn", "demoStartedOn"]);
  const env = optionalText(row.environment, 64)?.toLowerCase();
  const environment = env && ["production", "produccion", "producción", "prod"].includes(env) ? "production" :
    env && ["test", "testing", "prueba", "pruebas", "qa"].includes(env) ? "test" : env === "demo" ? "demo" : "unknown";
  const modules = optionalText(row.licensedModules, 1024, true)?.toUpperCase();
  const document = optionalText(row.documentNumber, 128);
  return { sourceRecordId: sqlInt(row.sourceRecordId), documentNumber: document && !/\p{C}/u.test(document) ? document : null,
    reportedCountryId: row.reportedCountryId === null ? null : sqlInt(row.reportedCountryId), environment,
    licenseCodes: modules !== undefined && /^[A-Z ,;|]*$/.test(modules)
      ? [...new Set(modules.replace(/[^A-Z]/g, ""))].sort() : null,
    domainCandidate: optionalText(row.domainCandidate, 253), testStartedOn: optionalText(row.testStartedOn, 10),
    productionStartedOn: optionalText(row.productionStartedOn, 10), demoStartedOn: optionalText(row.demoStartedOn, 10) };
}

function positiveInt(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Unavailable("invalid_options");
  return value;
}

async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent?: AbortSignal): Promise<T> {
  if (parent?.aborted) throw new Unavailable("cancelled");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    function stop(reason: "timeout" | "cancelled") {
      // Reject with a controlled code before notifying the transport's abort handlers.
      reject(new Unavailable(reason));
      controller.abort();
    }
    timer = setTimeout(() => stop("timeout"), timeoutMs);
    cancel = () => stop("cancelled");
    parent?.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([deadline, Promise.resolve().then(() => work(controller.signal))]);
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) parent?.removeEventListener("abort", cancel);
  }
}

/** Prove the fixed projection can be read without storing or returning any source rows. */
export async function verifyCatalogExternalSource(
  transport: CatalogExternalSourceTransport, contract: CatalogExternalContract, signal?: AbortSignal,
): Promise<"verified" | "not_read_only" | "unavailable"> {
  if (contract !== "erp_v1" && contract !== "sag_admin_v1") return "unavailable";
  try {
    return await bounded(parent => transport.withConsistentRead({
      contract, timeoutMs: 10_000, signal: parent,
    }, async session => {
      if (session.consistency !== "verified") throw new Unavailable("consistency_unverified");
      const select = (tag: CatalogExternalReadStatement["tag"], parameters: CatalogExternalReadStatement["parameters"]) =>
        bounded(signal => session.select({ tag, sql: catalogExternalSelectSql(contract, tag), parameters, timeoutMs: 4000, signal }),
          4000, parent);
      const schema = await select("schema", {});
      if (!Array.isArray(schema) || schema.length !== 1) throw new Unavailable("schema_unverified");
      const proof = rowWithKeys(schema[0], ["compatible", "readOnly"]);
      if (proof.compatible !== true) throw new Unavailable("schema_unverified");
      if (proof.readOnly !== true) throw new Unavailable("write_access");
      const rows = await select("page", { afterId: null, pageSize: 1 });
      if (!Array.isArray(rows) || rows.length > 1) throw new Unavailable("invalid_rows");
      for (const row of rows) {
        if (contract === "erp_v1") parseErp(row);
        else parseSag(row);
      }
      return "verified" as const;
    }), 10_000, signal);
  } catch (error) {
    return error instanceof Unavailable && error.reason === "write_access" ? "not_read_only" : "unavailable";
  }
}

export function readCatalogExternalSource(transport: CatalogExternalSourceTransport, contract: "erp_v1", options?: CatalogExternalReadOptions): Promise<CatalogExternalReadResult<CatalogErpSourceRecord>>;
export function readCatalogExternalSource(transport: CatalogExternalSourceTransport, contract: "sag_admin_v1", options?: CatalogExternalReadOptions): Promise<CatalogExternalReadResult<CatalogSagSourceRecord>>;
export function readCatalogExternalSource(transport: CatalogExternalSourceTransport, contract: CatalogExternalContract, options?: CatalogExternalReadOptions): Promise<CatalogExternalReadResult<CatalogErpSourceRecord | CatalogSagSourceRecord>>;
export async function readCatalogExternalSource(
  transport: CatalogExternalSourceTransport, contract: CatalogExternalContract, options: CatalogExternalReadOptions = {},
): Promise<CatalogExternalReadResult<CatalogErpSourceRecord | CatalogSagSourceRecord>> {
  if (contract !== "erp_v1" && contract !== "sag_admin_v1") return { status: "unavailable", reason: "contract_unapproved" };
  try {
    const pageSize = positiveInt(options.pageSize, 500, 1000);
    const maxRows = positiveInt(options.maxRows, 50_000, 100_000);
    const statementTimeoutMs = positiveInt(options.statementTimeoutMs, 4000, 15_000);
    const totalTimeoutMs = positiveInt(options.totalTimeoutMs, 20_000, 120_000);
    const records = await bounded(signal => transport.withConsistentRead({ contract, timeoutMs: totalTimeoutMs, signal }, async session => {
      if (session.consistency !== "verified") throw new Unavailable("consistency_unverified");
      const select = (tag: CatalogExternalReadStatement["tag"], sql: string, parameters: CatalogExternalReadStatement["parameters"]) =>
        bounded(statementSignal => session.select({ tag, sql, parameters, timeoutMs: statementTimeoutMs, signal: statementSignal }), statementTimeoutMs, signal);
      const schema = await select("schema", catalogExternalSelectSql(contract, "schema"), {});
      if (!Array.isArray(schema) || schema.length !== 1) throw new Unavailable("schema_unverified");
      let proof: Record<string, unknown>;
      try { proof = rowWithKeys(schema[0], ["compatible", "readOnly"]); }
      catch { throw new Unavailable("schema_unverified"); }
      if (proof.compatible !== true) throw new Unavailable("schema_unverified");
      if (proof.readOnly !== true) throw new Unavailable("write_access");

      const pageRows: (CatalogErpSourceRecord | CatalogSagSourceRecord)[] = [];
      let afterId: number | null = null;
      while (!signal.aborted) {
        // The extra row is an existence probe when at the limit, not a record to publish.
        const limit = Math.min(pageSize, maxRows - pageRows.length + 1);
        const rows = await select("page", catalogExternalSelectSql(contract, "page"), { afterId, pageSize: limit });
        if (!Array.isArray(rows) || rows.length > limit) throw new Unavailable("invalid_rows");
        if (pageRows.length + rows.length > maxRows) throw new Unavailable("row_limit");
        for (const raw of rows) {
          const row = contract === "erp_v1" ? parseErp(raw) : parseSag(raw);
          if (afterId !== null && row.sourceRecordId <= afterId) throw new Unavailable("invalid_rows");
          pageRows.push(row);
          afterId = row.sourceRecordId;
        }
        if (rows.length < limit) return pageRows;
      }
      throw new Unavailable("cancelled");
    }), totalTimeoutMs, options.signal);
    return { status: "complete", records };
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Unavailable ? error.reason : "connection_failed" };
  }
}
