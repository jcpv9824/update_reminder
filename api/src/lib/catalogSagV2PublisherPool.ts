import { connect as netConnect, isIP, type Socket } from "node:net";
import sql from "mssql";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { getSecret } from "./keyVault";
import { createGuardedSqlConnector, type SocketConnector } from "./outboundGuard";
import { CATALOG_SAG_V2_OWNER_PROCEDURES, readCatalogSagV2PublisherMode } from "./catalogSagV2PublisherMode";

const missing = () => new Error("catalog_sag_v2_publisher_unavailable");
const namespace = "PORTAL_CATALOG_SAG_V2_PUBLISHER_";
const fqdn = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const reservedHost = /(?:^|\.)(?:localhost|localdomain|invalid|example|test)$|(?:^|\.)example\.(?:com|net|org)$/i;
const placeholderHost = /(?:^|\.)(?:change-?me|replace-?me|placeholder|your-host|your-server)(?:\.|$)/i;
const namePattern = /^[A-Za-z][A-Za-z0-9_.@-]{0,127}$/;
const all = /[\p{C}\s]/u;
function portNumber(port: string | undefined): number | undefined | null {
  if (port === undefined) return undefined;
  if (typeof port !== "string" || !/^[0-9]{1,5}$/.test(port) || all.test(port)) return null;
  const n = Number(port);
  return n >= 1 && n <= 65535 ? n : null;
}

type Settings = Readonly<{ environment: CatalogEnvironment; database: "PortalSAGWeb" | "PortalSAGWeb-TEST";
  server: string; port: number } & ({ mode: "dedicated"; username: string; secretName: string; secretVersion: string }
    | { mode: "portal-owner"; username: "SAGWebDev" })>;

const validPassword = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 &&
  !/[\r\n\u0000]/.test(value) && !!value.trim() && !value.startsWith("@Microsoft.KeyVault(");

export function readCatalogSagV2PublisherPoolSettings(env: NodeJS.ProcessEnv): Settings | null {
  const mode = readCatalogSagV2PublisherMode(env);
  if (!mode) return null;
  const environment = env.PORTAL_SAG_ENVIRONMENT;
  if (environment !== "qa" && environment !== "production") return null;
  const database = environment === "qa" ? "PortalSAGWeb-TEST" : "PortalSAGWeb";
  if (env.SQL_DATABASE !== database || typeof env.SQL_SERVER_HOST !== "string" || all.test(env.SQL_SERVER_HOST)) return null;
  const address = /^([^,:]+)(?:[,:]([0-9]{1,5}))?$/.exec(env.SQL_SERVER_HOST);
  const server = address?.[1].toLowerCase();
  const inline = portNumber(address?.[2]);
  const separate = portNumber(env.SQL_SERVER_PORT);
  if (!server || server.length > 253 || !fqdn.test(server) || reservedHost.test(server) || placeholderHost.test(server) || isIP(server) !== 0 ||
    inline === null || separate === null || (inline !== undefined && separate !== undefined && inline !== separate)) return null;
  const port = inline ?? separate;
  if (port === undefined) return null;

  if (mode === "portal-owner") {
    // Never place the resolved credential in Settings: callers serialize Settings
    // as pool/policy comparison keys. Mixed dedicated credentials are ambiguous.
    if (env.SQL_USERNAME !== "SAGWebDev" || !validPassword(env.SQL_PASSWORD) ||
      Object.keys(env).some(key => key.startsWith(namespace) && key !== namespace + "MODE" && env[key] !== undefined)) return null;
    return Object.freeze({ mode, environment, database, server, port, username: "SAGWebDev" });
  }

  const username = env[namespace + "USERNAME"];
  const secretName = env[namespace + "PASSWORD_SECRET_NAME"];
  const secretVersion = env[namespace + "PASSWORD_SECRET_VERSION"];
  if (typeof username !== "string" || !namePattern.test(username) || all.test(username) ||
    /^(?:sa|dbo|guest|public)$/i.test(username) || username.toLowerCase() === env.SQL_USERNAME?.trim().toLowerCase() ||
    typeof secretName !== "string" || !/^[a-z0-9-]{1,127}$/i.test(secretName) || all.test(secretName) ||
    typeof secretVersion !== "string" || secretVersion.length !== 32 || !/^[a-f0-9]{32}$/i.test(secretVersion)) return null;
  return Object.freeze({ mode, environment, database, server, port, username, secretName, secretVersion });
}

// The owner exception is explicit, not a weaker retry of dedicated readiness.
// No grants, impersonation or data writes occur here. SQL wrappers repeat the
// owner identity checks and enforce the exact claim inside their transaction.
export const CATALOG_SAG_V2_OWNER_PUBLISHER_READINESS_SQL = `
SELECT CAST(CASE WHEN
    DB_NAME() COLLATE Latin1_General_100_BIN2 = @expectedDatabase COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(DB_NAME()) = DATALENGTH(@expectedDatabase)
    AND @expectedLogin COLLATE Latin1_General_100_BIN2 = N'SAGWebDev'
    AND DATALENGTH(@expectedLogin) = DATALENGTH(N'SAGWebDev')
    AND USER_NAME() COLLATE Latin1_General_100_BIN2 = @expectedLogin COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(USER_NAME()) = DATALENGTH(@expectedLogin)
    AND ORIGINAL_LOGIN() COLLATE Latin1_General_100_BIN2 = @expectedLogin COLLATE Latin1_General_100_BIN2
    AND SUSER_SNAME() COLLATE Latin1_General_100_BIN2 = @expectedLogin COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(ORIGINAL_LOGIN()) = DATALENGTH(@expectedLogin)
    AND DATALENGTH(SUSER_SNAME()) = DATALENGTH(@expectedLogin)
    AND CAST(SERVERPROPERTY(N'ProductMajorVersion') AS int) = 15
    AND d.compatibility_level = 150 AND d.is_read_only = 0
    AND d.collation_name COLLATE Latin1_General_100_BIN2 = N'Modern_Spanish_CI_AS'
    AND IS_SRVROLEMEMBER(N'sysadmin') = 0
    AND IS_ROLEMEMBER(N'db_owner') = 1
    AND HAS_PERMS_BY_NAME(DB_NAME(), N'DATABASE', N'CONTROL') = 1
    AND OBJECT_ID(N'settings.reserve_catalog_sag_v2_owner_attempt', N'P') IS NOT NULL
    AND OBJECT_ID(N'settings.publish_catalog_sag_v2_owner_with_targets', N'P') IS NOT NULL
    AND OBJECT_ID(N'settings.fail_catalog_sag_v2_owner_attempt', N'P') IS NOT NULL
    AND HAS_PERMS_BY_NAME(N'settings.reserve_catalog_sag_v2_owner_attempt', N'OBJECT', N'EXECUTE') = 1
    AND HAS_PERMS_BY_NAME(N'settings.publish_catalog_sag_v2_owner_with_targets', N'OBJECT', N'EXECUTE') = 1
    AND HAS_PERMS_BY_NAME(N'settings.fail_catalog_sag_v2_owner_attempt', N'OBJECT', N'EXECUTE') = 1
  THEN 1 ELSE 0 END AS bit) AS ready
FROM sys.databases AS d WHERE d.database_id = DB_ID();`;

// Check effective permissions under this connection, not role grants viewed from an administrative pool.
// Metadata is visible for securables over which the caller has permissions. For named private
// objects, NULL is appropriate when they are invisible; named public entry points must prove 1.
export const CATALOG_SAG_V2_PUBLISHER_READINESS_SQL = `
SELECT CAST(CASE WHEN
    DB_NAME() COLLATE Latin1_General_100_BIN2 = @expectedDatabase COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(DB_NAME()) = DATALENGTH(@expectedDatabase)
    AND ORIGINAL_LOGIN() COLLATE Latin1_General_100_BIN2 = @expectedLogin COLLATE Latin1_General_100_BIN2
    AND SUSER_SNAME() COLLATE Latin1_General_100_BIN2 = @expectedLogin COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(ORIGINAL_LOGIN()) = DATALENGTH(@expectedLogin)
    AND DATALENGTH(SUSER_SNAME()) = DATALENGTH(@expectedLogin)
    AND CAST(SERVERPROPERTY(N'ProductMajorVersion') AS int) = 15
    AND d.compatibility_level = 150 AND d.is_read_only = 0
    AND d.collation_name COLLATE Latin1_General_100_BIN2 = N'Modern_Spanish_CI_AS'
    AND IS_SRVROLEMEMBER(N'sysadmin') = 0 AND USER_NAME() NOT IN (N'dbo', N'guest')
    AND IS_ROLEMEMBER(N'portal_catalog_v2_publisher') = 1
    AND COALESCE(IS_ROLEMEMBER(N'db_owner'),0) = 0 AND COALESCE(IS_ROLEMEMBER(N'portal_runtime'),0) = 0
    AND EXISTS (SELECT 1 FROM sys.login_token WHERE [type] = N'SQL LOGIN'
      AND name COLLATE Latin1_General_100_BIN2 = @expectedLogin COLLATE Latin1_General_100_BIN2)
    AND NOT EXISTS (SELECT 1 FROM sys.login_token WHERE
      [type] <> N'SQL LOGIN' AND NOT ([type] = N'SERVER ROLE' AND name = N'public'))
    AND NOT EXISTS (SELECT 1 FROM sys.user_token WHERE
      [type] <> N'SQL USER' AND NOT ([type] IN (N'ROLE',N'DATABASE ROLE') AND name IN (N'public',N'portal_catalog_v2_publisher')))
    AND NOT EXISTS (SELECT 1 FROM sys.fn_my_permissions(NULL, N'SERVER')
      WHERE permission_name LIKE N'CREATE %' OR permission_name LIKE N'ALTER %'
        OR permission_name LIKE N'IMPERSONATE%' OR permission_name IN (N'CONTROL SERVER',N'SHUTDOWN',N'TAKE OWNERSHIP'))
    AND NOT EXISTS (SELECT 1 FROM sys.fn_my_permissions(NULL, N'DATABASE')
      WHERE permission_name LIKE N'CREATE %' OR permission_name LIKE N'ALTER %'
        OR permission_name LIKE N'IMPERSONATE%' OR permission_name IN
        (N'CONTROL',N'TAKE OWNERSHIP',N'SELECT',N'INSERT',N'UPDATE',N'DELETE',N'EXECUTE'))
    AND NOT EXISTS (SELECT 1 FROM sys.server_principals AS p
      WHERE p.[type] IN (N'S',N'U',N'G') AND p.sid <> SUSER_SID()
        AND HAS_PERMS_BY_NAME(QUOTENAME(p.name), N'LOGIN', N'IMPERSONATE') = 1)
    AND NOT EXISTS (SELECT 1 FROM sys.database_principals AS p
      WHERE p.[type] IN (N'S',N'U',N'G') AND p.principal_id <> USER_ID()
        AND HAS_PERMS_BY_NAME(QUOTENAME(p.name), N'USER', N'IMPERSONATE') = 1)
    AND NOT EXISTS (SELECT 1 FROM sys.schemas AS s
      CROSS APPLY sys.fn_my_permissions(QUOTENAME(s.name), N'SCHEMA') AS p
      WHERE s.name NOT IN (N'sys',N'INFORMATION_SCHEMA')
        AND p.permission_name IN (N'CONTROL',N'ALTER',N'TAKE OWNERSHIP',N'SELECT',N'INSERT',N'UPDATE',N'DELETE',N'EXECUTE'))
    AND OBJECT_ID(N'settings.reserve_catalog_sag_v2_attempt', N'P') IS NOT NULL
    AND OBJECT_ID(N'settings.publish_catalog_sag_v2_revision', N'P') IS NOT NULL
    AND OBJECT_ID(N'settings.publish_catalog_sag_v2_with_targets', N'P') IS NOT NULL
    AND OBJECT_ID(N'settings.fail_catalog_sag_v2_attempt', N'P') IS NOT NULL
    AND HAS_PERMS_BY_NAME(N'settings.reserve_catalog_sag_v2_attempt', N'OBJECT', N'EXECUTE') = 1
    AND HAS_PERMS_BY_NAME(N'settings.publish_catalog_sag_v2_revision', N'OBJECT', N'EXECUTE') = 1
    AND HAS_PERMS_BY_NAME(N'settings.publish_catalog_sag_v2_with_targets', N'OBJECT', N'EXECUTE') = 1
    AND HAS_PERMS_BY_NAME(N'settings.fail_catalog_sag_v2_attempt', N'OBJECT', N'EXECUTE') = 1
    AND COALESCE(HAS_PERMS_BY_NAME(N'settings.catalog_sag_v2_transition_internal',N'OBJECT',N'EXECUTE'),0) = 0
    AND COALESCE(HAS_PERMS_BY_NAME(N'settings.catalog_customer_attempt_sequence',N'OBJECT',N'UPDATE'),0) = 0
    AND COALESCE(HAS_PERMS_BY_NAME(N'core.catalog_sag_company_location_observations',N'OBJECT',N'SELECT'),0) = 0
    AND COALESCE(HAS_PERMS_BY_NAME(N'core.catalog_sag_company_location_observations',N'OBJECT',N'INSERT'),0) = 0
    AND COALESCE(HAS_PERMS_BY_NAME(N'core.catalog_sag_company_location_observations',N'OBJECT',N'UPDATE'),0) = 0
    AND COALESCE(HAS_PERMS_BY_NAME(N'core.catalog_sag_company_location_observations',N'OBJECT',N'DELETE'),0) = 0
    AND COALESCE(HAS_PERMS_BY_NAME(N'core.catalog_sag_company_location_seals',N'OBJECT',N'SELECT'),0) = 0
    AND COALESCE(HAS_PERMS_BY_NAME(N'core.catalog_sag_company_location_seals',N'OBJECT',N'INSERT'),0) = 0
    AND COALESCE(HAS_PERMS_BY_NAME(N'core.catalog_sag_company_location_seals',N'OBJECT',N'UPDATE'),0) = 0
    AND COALESCE(HAS_PERMS_BY_NAME(N'core.catalog_sag_company_location_seals',N'OBJECT',N'DELETE'),0) = 0
    AND NOT EXISTS (SELECT 1 FROM sys.objects AS o JOIN sys.schemas AS s ON s.schema_id=o.schema_id
      CROSS APPLY sys.fn_my_permissions(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), N'OBJECT') AS p
      WHERE o.is_ms_shipped = 0 AND (
        p.permission_name IN (N'CONTROL',N'ALTER',N'TAKE OWNERSHIP',N'SELECT',N'INSERT',N'UPDATE',N'DELETE')
        OR (p.permission_name = N'EXECUTE' AND o.object_id NOT IN (
          OBJECT_ID(N'settings.reserve_catalog_sag_v2_attempt', N'P'),
          OBJECT_ID(N'settings.publish_catalog_sag_v2_revision', N'P'),
          OBJECT_ID(N'settings.publish_catalog_sag_v2_with_targets', N'P'),
          OBJECT_ID(N'settings.fail_catalog_sag_v2_attempt', N'P')))))
  THEN 1 ELSE 0 END AS bit) AS ready
FROM sys.databases AS d WHERE d.database_id = DB_ID();`;

type Pool = Pick<sql.ConnectionPool, "request">;
type NativePool = { request: Pool["request"]; connect(): Promise<unknown>; close(): Promise<void>;
  on(event: "error", handler: (reason: unknown) => void): unknown };
type IO = { getSecret(name: string, signal: AbortSignal, version: string): Promise<string>;
  newPool(config: sql.config): NativePool; guardedConnector: SocketConnector };

const defaultIO: IO = {
  getSecret,
  newPool: config => new sql.ConnectionPool(config),
  guardedConnector: (options, lookup, signal) => createGuardedSqlConnector(undefined, address => {
    // DNS may finish after cancellation. Do not dial a late answer.
    signal.throwIfAborted();
    return netConnect(address);
  })(options, lookup, signal),
};

function timed<T>(ms: number, parent: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    function clean() { if (timer !== undefined) clearTimeout(timer); parent?.removeEventListener("abort", stop); }
    function stop() { clean(); timeout.abort(missing()); reject(missing()); }
    if (parent?.aborted) { stop(); return; }
    timer = setTimeout(stop, ms);
    parent?.addEventListener("abort", stop, { once: true });
    Promise.resolve().then(() => {
      if (timeout.signal.aborted) throw missing();
      return work(timeout.signal);
    }).then(value => { clean(); if (!timeout.signal.aborted) resolve(value); }, () => { clean(); reject(missing()); });
  });
}

function exactReady(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const sets = (result as { recordsets?: unknown }).recordsets;
  if (!Array.isArray(sets) || sets.length !== 1 || !Array.isArray(sets[0]) || sets[0].length !== 1) return false;
  const row: unknown = sets[0][0];
  if (!row || typeof row !== "object" || Reflect.ownKeys(row).length !== 1) return false;
  const prototype = Object.getPrototypeOf(row);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ready = Object.getOwnPropertyDescriptor(row, "ready");
  return ready?.enumerable === true && ready.value === true;
}

type Attempt = {
  controller: AbortController; sockets: Set<Socket>; pool?: NativePool;
  opening?: Promise<unknown>; disposal?: Promise<void>; promise?: Promise<Pool>;
};

/** The caller owns this loader/process lifetime. No timer or general Portal pool is referenced here. */
export function createCatalogSagV2PublisherPoolLoader(env: NodeJS.ProcessEnv, io: IO = defaultIO) {
  let settings: Settings | null = null;
  try { settings = readCatalogSagV2PublisherPoolSettings(env); } catch { /* Controlled rejection below. */ }
  const pinned = settings;
  // Secret stays only in this private closure and the driver's in-memory config.
  const ownerPassword = pinned?.mode === "portal-owner" ? env.SQL_PASSWORD : undefined;
  let current: Attempt | undefined;
  let closed = false;

  function retire(attempt: Attempt): Promise<void> {
    if (current === attempt) current = undefined;
    if (!attempt.controller.signal.aborted) attempt.controller.abort(missing());
    for (const socket of attempt.sockets) socket.destroy();
    attempt.sockets.clear();
    if (!attempt.pool) return Promise.resolve();
    const pool = attempt.pool;
    if (!attempt.disposal) {
      const close = () => timed(5_000, undefined, () => pool.close());
      attempt.disposal = close().catch(() => {
        // mssql rejects close during connect: retry disposal once it settles, never reconnect.
        if (attempt.opening) void attempt.opening.then(close, close).catch(() => {});
      });
    }
    return attempt.disposal;
  }

  async function open(attempt: Attempt, config: Settings): Promise<Pool> {
    const lifetime = attempt.controller.signal;
    const { server, port, database, username } = config;
    try {
      const password = config.mode === "portal-owner" ? ownerPassword :
        await timed(5_000, lifetime, signal => io.getSecret(config.secretName, signal, config.secretVersion));
      if (lifetime.aborted || typeof password !== "string" || !password || password.length > 512 ||
        /[\r\n\u0000]/.test(password) || !password.trim()) throw missing();
      const connector: SocketConnector = async (options, lookup, driverSignal) => {
        try {
          if (options.host.toLowerCase() !== server || options.port !== port) throw missing();
          const signal = AbortSignal.any([driverSignal, lifetime]);
          if (signal.aborted) throw missing();
          const socket = await io.guardedConnector(options, lookup, signal);
          if (signal.aborted) { socket.destroy(); throw missing(); }
          attempt.sockets.add(socket);
          socket.once("close", () => attempt.sockets.delete(socket));
          return socket;
        } catch { throw missing(); }
      };
      const pool = io.newPool({
        server, port, database, user: username, password,
        connectionTimeout: 8_000, requestTimeout: 20_000,
        pool: { min: 0, max: 2, idleTimeoutMillis: 30_000, acquireTimeoutMillis: 10_000, createTimeoutMillis: 10_000 },
        options: { encrypt: true, trustServerCertificate: false, serverName: server, fallbackToDefaultDb: false,
          enableArithAbort: true, cancelTimeout: 1_000, maxRetriesOnTransientErrors: 0,
          appName: "PortalSAGWeb-SAGv2Publisher", connector: connector as never },
      });
      attempt.pool = pool;
      pool.on("error", () => { void retire(attempt); });
      await timed(8_000, lifetime, () => {
        attempt.opening = Promise.resolve(pool.connect());
        return attempt.opening;
      });
      const ready = await timed(8_000, lifetime, async signal => {
        const req = pool.request()
          .input("expectedDatabase", sql.NVarChar(128), database)
          .input("expectedLogin", sql.NVarChar(128), username);
        const cancel = () => { try { req.cancel(); } catch { /* sockets are closed on failure */ } };
        signal.addEventListener("abort", cancel, { once: true });
        try { return await req.query(config.mode === "portal-owner" ? CATALOG_SAG_V2_OWNER_PUBLISHER_READINESS_SQL : CATALOG_SAG_V2_PUBLISHER_READINESS_SQL); }
        finally { signal.removeEventListener("abort", cancel); }
      });
      if (!exactReady(ready) || lifetime.aborted || current !== attempt || closed) throw missing();
      const assertCurrent = () => { if (closed || current !== attempt || lifetime.aborted) throw missing(); };
      return Object.freeze({ request() {
        try {
          assertCurrent();
          const request = pool.request();
          if (config.mode !== "portal-owner") return request;
          // Do not expose query/batch/transaction/output or the native request's
          // parent pool to an owner-mode consumer. Only fixed wrapper RPCs exist.
          const allowed: readonly string[] = Object.values(CATALOG_SAG_V2_OWNER_PROCEDURES);
          const facade = Object.freeze({
            input(...args: Parameters<sql.Request["input"]>): sql.Request {
              try { assertCurrent(); request.input(...args); return facade as unknown as sql.Request; } catch { throw missing(); }
            },
            async execute(procedure: string) {
              try {
                assertCurrent();
                if (!allowed.includes(procedure)) throw missing();
                return await request.execute(procedure);
              } catch { throw missing(); }
            },
            cancel() { try { request.cancel(); } catch { throw missing(); } },
          });
          return facade as unknown as sql.Request;
        } catch { throw missing(); }
      } });
    } catch {
      await retire(attempt);
      throw missing();
    }
  }

  return Object.freeze({
    get(): Promise<Pool> {
      if (closed || !pinned) return Promise.reject(missing());
      if (current?.promise) return current.promise;
      const attempt: Attempt = { controller: new AbortController(), sockets: new Set() };
      current = attempt;
      return attempt.promise = Promise.resolve().then(() => open(attempt, pinned));
    },
    async close(): Promise<void> {
      closed = true;
      if (current) await retire(current);
    },
  });
}
