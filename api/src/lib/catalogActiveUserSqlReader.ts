import { connect, isIP, type Socket } from "node:net";
import sql from "mssql";
import type { CatalogActiveUserCountReader, CatalogActiveUserTarget } from "./catalogActiveUserReport";
import type { CatalogSqlConnectionTarget } from "./catalogExternalSqlTransport";
import { createGuardedSqlConnector, resolveHost, type SocketConnector } from "./outboundGuard";

/** Filled from a reviewed, destination-specific schema certification, never from HTTP. */
export type CatalogActiveUserContract =
  | Readonly<{ contract: "approved_aggregate_view_v1" }>
  | Readonly<{
    contract: "certified_usuarios_v1";
    population: "all_rows";
    activeColumn: string;
  } & (
    | { storage: "bit"; activeValue: 0 | 1 }
    | { storage: "text"; activeValue: string; inactiveValue: string }
  )>;

export type CertifiedCatalogActiveUserSqlTarget = Readonly<{
  target: CatalogActiveUserTarget;
  connection: CatalogSqlConnectionTarget;
  evidence: CatalogActiveUserContract;
}>;

export type ResolveCertifiedCatalogActiveUserSqlTarget = (
  reference: CatalogActiveUserTarget,
  signal: AbortSignal,
) => Promise<CertifiedCatalogActiveUserSqlTarget | null>;

type Binding = Readonly<{ name: string; type: "text" | "bit_code"; value: string | number }>;
type SelectPlan = { proof: string; proofBindings: readonly Binding[]; count: string; countBindings: readonly Binding[]; tableCount: boolean };
type Failure = "cancelled" | "timeout" | "uncertified" | "schema_unverified" | "invalid_count" | "connection_failed";

export class CatalogActiveUserSqlUnavailable extends Error {
  constructor(readonly reason: Failure) { super(reason); }
}

const failure = (reason: Failure) => new CatalogActiveUserSqlUnavailable(reason);
const AGGREGATE_VIEW = "dbo.v_portal_usuarios_activos";
const USER_TABLE = "dbo.usuarios";
const COLUMN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const DNS_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const validText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= max && !/\p{Cc}/u.test(value);

function sameTarget(a: CatalogActiveUserTarget, b: CatalogActiveUserTarget): boolean {
  return !!b && a.physicalDatabaseId === b.physicalDatabaseId &&
    a.serverGroupId === b.serverGroupId && a.reportingProfileId === b.reportingProfileId;
}

function validConnection(connection: CatalogSqlConnectionTarget): boolean {
  return !!connection && validText(connection.server, 253) && DNS_HOST.test(connection.server) && !isIP(connection.server) &&
    Number.isSafeInteger(connection.port) && connection.port >= 1 && connection.port <= 65535 &&
    validText(connection.database, 128) && validText(connection.username, 128) && validText(connection.password, 512);
}

function schemaProof(object: typeof AGGREGATE_VIEW | typeof USER_TABLE, columnType: string): string {
  const isTable = object === USER_TABLE;
  const objectType = isTable ? "U" : "V";
  // Identifiers here are code constants. Catalogue name and certified status column are bound.
  return `SELECT
    CONVERT(bit, CASE WHEN DB_NAME() COLLATE Latin1_General_100_BIN2 = @expectedDatabase COLLATE Latin1_General_100_BIN2
      AND IS_SRVROLEMEMBER(N'sysadmin') = 0 AND IS_ROLEMEMBER(N'db_owner') = 0
      AND IS_ROLEMEMBER(N'db_datawriter') = 0 AND IS_ROLEMEMBER(N'db_datareader') = 0
      AND IS_ROLEMEMBER(N'db_ddladmin') = 0 AND IS_ROLEMEMBER(N'db_securityadmin') = 0
      AND NOT EXISTS (SELECT 1 FROM sys.fn_my_permissions(NULL, 'SERVER')
        WHERE permission_name LIKE 'ALTER %' OR permission_name LIKE 'IMPERSONATE %'
          OR permission_name = 'CONTROL SERVER')
      AND NOT EXISTS (SELECT 1 FROM sys.fn_my_permissions(NULL, 'DATABASE')
        WHERE permission_name LIKE 'ALTER %' OR permission_name LIKE 'CREATE %'
          OR permission_name IN ('SELECT','INSERT','UPDATE','DELETE','EXECUTE','CONTROL','TAKE OWNERSHIP','IMPERSONATE'))
      AND HAS_PERMS_BY_NAME(N'dbo', 'SCHEMA', 'SELECT') = 0
      AND HAS_PERMS_BY_NAME(N'dbo', 'SCHEMA', 'ALTER') = 0
      AND HAS_PERMS_BY_NAME(N'${object}', 'OBJECT', 'INSERT') = 0
      AND HAS_PERMS_BY_NAME(N'${object}', 'OBJECT', 'UPDATE') = 0
      AND HAS_PERMS_BY_NAME(N'${object}', 'OBJECT', 'DELETE') = 0
      AND HAS_PERMS_BY_NAME(N'${object}', 'OBJECT', 'ALTER') = 0
      AND HAS_PERMS_BY_NAME(N'${object}', 'OBJECT', 'CONTROL') = 0
      AND HAS_PERMS_BY_NAME(N'${object}', 'OBJECT', 'TAKE OWNERSHIP') = 0
      AND HAS_PERMS_BY_NAME(N'${object}', 'OBJECT', 'SELECT', @statusColumn, 'COLUMN') = 1
      AND EXISTS (SELECT 1 FROM sys.columns AS c
        WHERE c.object_id = OBJECT_ID(N'${object}', N'${objectType}')
          AND c.name COLLATE Latin1_General_100_BIN2 = @statusColumn COLLATE Latin1_General_100_BIN2
          AND ${columnType})
      AND NOT EXISTS (SELECT 1 FROM sys.columns AS c
        WHERE c.object_id = OBJECT_ID(N'${object}', N'${objectType}')
          AND (ISNULL(HAS_PERMS_BY_NAME(N'${object}', 'OBJECT', 'UPDATE', c.name, 'COLUMN'), -1) <> 0
            OR (c.name COLLATE Latin1_General_100_BIN2 <> @statusColumn COLLATE Latin1_General_100_BIN2
              AND ${isTable ? `ISNULL(HAS_PERMS_BY_NAME(N'${object}', 'OBJECT', 'SELECT', c.name, 'COLUMN'), -1) <> 0` : "1 = 1"})))
      ${isTable ? `AND HAS_PERMS_BY_NAME(N'${object}', 'OBJECT', 'SELECT') = 0` : ""}
      THEN 1 ELSE 0 END) AS certified`;
}

function compile(evidence: CatalogActiveUserContract, database: string): SelectPlan {
  if (evidence?.contract === "approved_aggregate_view_v1") {
    return {
      proof: schemaProof(AGGREGATE_VIEW, "c.system_type_id = 127 AND c.max_length = 8"),
      proofBindings: [
        { name: "expectedDatabase", type: "text", value: database },
        { name: "statusColumn", type: "text", value: "active_user_count" },
      ],
      count: "SELECT TOP (2) [active_user_count] AS activeUsers FROM [dbo].[v_portal_usuarios_activos]",
      countBindings: [],
      tableCount: false,
    };
  }

  if (evidence?.contract !== "certified_usuarios_v1" || evidence.population !== "all_rows" ||
      typeof evidence.activeColumn !== "string" || !COLUMN.test(evidence.activeColumn)) throw failure("uncertified");
  const identifier = `[${evidence.activeColumn}]`; // Exact certified identifier, restricted to the identifier alphabet.
  let columnType: string;
  let isActive: string;
  let isInactive: string;
  let countBindings: Binding[];
  if (evidence.storage === "bit") {
    if (evidence.activeValue !== 0 && evidence.activeValue !== 1) throw failure("uncertified");
    columnType = "c.system_type_id = 104 AND c.max_length = 1";
    isActive = `${identifier} = @activeValue`;
    isInactive = `${identifier} <> @activeValue`;
    countBindings = [{ name: "activeValue", type: "bit_code", value: evidence.activeValue }];
  } else if (evidence.storage === "text") {
    if (!validText(evidence.activeValue, 32) || !validText(evidence.inactiveValue, 32) ||
        !evidence.activeValue.trim() || !evidence.inactiveValue.trim() || evidence.activeValue === evidence.inactiveValue) {
      throw failure("uncertified");
    }
    columnType = "c.system_type_id IN (167,175,231,239) AND c.max_length BETWEEN 1 AND 64";
    const value = `CONVERT(nvarchar(64), ${identifier}) COLLATE Latin1_General_100_BIN2`;
    isActive = `(${value} = @activeValue COLLATE Latin1_General_100_BIN2 AND DATALENGTH(${value}) = DATALENGTH(@activeValue))`;
    isInactive = `(${value} = @inactiveValue COLLATE Latin1_General_100_BIN2 AND DATALENGTH(${value}) = DATALENGTH(@inactiveValue))`;
    countBindings = [{ name: "activeValue", type: "text", value: evidence.activeValue },
      { name: "inactiveValue", type: "text", value: evidence.inactiveValue }];
  } else {
    throw failure("uncertified");
  }
  return {
    proof: schemaProof(USER_TABLE, columnType),
    proofBindings: [{ name: "expectedDatabase", type: "text", value: database },
      { name: "statusColumn", type: "text", value: evidence.activeColumn }],
    count: `SELECT COUNT_BIG(CASE WHEN ${isActive} THEN 1 END) AS activeUsers,
      COUNT_BIG(CASE WHEN ${isActive} OR ${isInactive} THEN NULL ELSE 1 END) AS unknownStatuses
      FROM [dbo].[usuarios]`,
    countBindings,
    tableCount: true,
  };
}

function onlyRow(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== "object" ||
      Object.keys(value[0]).length !== keys.length || keys.some(key => !Object.hasOwn(value[0], key))) return null;
  return value[0] as Record<string, unknown>;
}

function parseCount(value: unknown): number | null {
  // Tedious can return SQL bigint as a decimal string.
  const count = typeof value === "string" && /^(?:0|[1-9]\d{0,15})$/.test(value) ? Number(value) : value;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export function createCatalogActiveUserSqlReader(
  resolveCertifiedTarget: ResolveCertifiedCatalogActiveUserSqlTarget,
  options: Readonly<{ timeoutMs?: number }> = {},
): CatalogActiveUserCountReader {
  const timeout = options.timeoutMs ?? 8_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) throw failure("uncertified");

  return async (reference, parentSignal) => {
    if (parentSignal.aborted) throw failure("cancelled");
    const lifetime = new AbortController();
    const sockets = new Set<Socket>();
    let rejectStopped!: (error: CatalogActiveUserSqlUnavailable) => void;
    const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
    let active: sql.Request | undefined;
    let pool: sql.ConnectionPool | undefined;
    const stop = (reason: Failure) => {
      if (lifetime.signal.aborted) return;
      const error = failure(reason);
      rejectStopped(error);
      lifetime.abort(error);
      try { active?.cancel(); } catch { /* force-close below */ }
      for (const socket of sockets) socket.destroy();
    };
    const parentAbort = () => stop("cancelled");
    const timer = setTimeout(() => stop("timeout"), timeout);
    parentSignal.addEventListener("abort", parentAbort, { once: true });

    const run = async () => {
      const certified = await resolveCertifiedTarget(reference, lifetime.signal);
      lifetime.signal.throwIfAborted();
      if (!certified || !sameTarget(reference, certified.target) || !validConnection(certified.connection)) throw failure("uncertified");
      const { server, port, database, username, password } = certified.connection;
      const plan = compile(certified.evidence, database);
      const connectGuard = createGuardedSqlConnector(resolveHost, options => {
        lifetime.signal.throwIfAborted();
        const socket = connect(options);
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        return socket;
      });
      const connector: SocketConnector = (target, lookup, driverSignal) => {
        if (target.host.toLowerCase() !== server.toLowerCase() || target.port !== port) {
          return Promise.reject(failure("uncertified"));
        }
        return connectGuard(target, lookup, AbortSignal.any([driverSignal, lifetime.signal]));
      };
      pool = new sql.ConnectionPool({
        server, port, database, user: username, password,
        connectionTimeout: Math.min(timeout, 10_000),
        requestTimeout: Math.min(timeout, 15_000),
        pool: { min: 0, max: 1, idleTimeoutMillis: 1000, acquireTimeoutMillis: Math.min(timeout, 10_000) },
        options: {
          encrypt: true, trustServerCertificate: false, serverName: server,
          fallbackToDefaultDb: false, enableArithAbort: true, cancelTimeout: 1000,
          maxRetriesOnTransientErrors: 0, appName: "PortalSAGWeb-ReporteUsuariosActivos", connector: connector as never,
        },
      });
      pool.on("error", () => stop("connection_failed"));
      await pool.connect();
      lifetime.signal.throwIfAborted();
      // Pin metadata/permission proof and aggregate to one authenticated SQL session.
      const transaction = new sql.Transaction(pool);
      await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
      lifetime.signal.throwIfAborted();
      const select = async (statement: string, bindings: readonly Binding[]) => {
        lifetime.signal.throwIfAborted();
        const request = new sql.Request(transaction);
        for (const { name, type, value } of bindings) {
          request.input(name, type === "text" ? sql.NVarChar(128) : sql.TinyInt, value);
        }
        active = request;
        try { return (await request.query<Record<string, unknown>>(statement)).recordset; }
        finally { active = undefined; }
      };
      try {
        const proof = onlyRow(await select(plan.proof, plan.proofBindings), ["certified"]);
        if (proof?.certified !== true) throw failure("schema_unverified");
        const aggregate = onlyRow(await select(plan.count, plan.countBindings),
          plan.tableCount ? ["activeUsers", "unknownStatuses"] : ["activeUsers"]);
        const count = parseCount(aggregate?.activeUsers);
        if (count === null || (plan.tableCount && parseCount(aggregate?.unknownStatuses) !== 0)) throw failure("invalid_count");
        return count;
      } finally {
        if (!lifetime.signal.aborted) await transaction.rollback();
      }
    };

    try {
      return await Promise.race([stopped, run()]);
    } catch (error) {
      throw failure(error instanceof CatalogActiveUserSqlUnavailable ? error.reason : "connection_failed");
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", parentAbort);
      if (!lifetime.signal.aborted) lifetime.abort();
      for (const socket of sockets) socket.destroy();
      try { void pool?.close().catch(() => {}); } catch { /* sockets are already closed */ }
    }
  };
}
