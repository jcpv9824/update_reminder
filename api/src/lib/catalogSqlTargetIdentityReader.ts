import { connect, isIP, type Socket } from "node:net";
import sql from "mssql";
import type { CatalogSqlConnectionTarget } from "./catalogExternalSqlTransport";
import { fingerprintCatalogSqlTarget } from "./catalogPhysicalTargetIdentity";
import { createGuardedSqlConnector, resolveHost, type SocketConnector } from "./outboundGuard";

export type CertifiedSqlIdentityTarget = Readonly<{
  /** Stable namespace explicitly assigned by the server-side destination registry. */
  instanceId: string;
  connection: CatalogSqlConnectionTarget;
}>;

export const CATALOG_SQL_TARGET_IDENTITY_SELECT = `SELECT DB_NAME() AS databaseName, database_guid AS databaseGuid
FROM sys.database_recovery_status WHERE database_id = DB_ID()`;
const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const DNS_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const validUuid = (value: unknown): value is string => typeof value === "string" &&
  UUID.test(value) && value !== "00000000-0000-0000-0000-000000000000";
export const isCatalogSqlInstanceId = validUuid;
const boundedText = (value: unknown, max: number): value is string => typeof value === "string" &&
  value.length >= 1 && value.length <= max && !/\p{Cc}/u.test(value);

function isApprovedInput(target: CertifiedSqlIdentityTarget): boolean {
  if (!validUuid(target?.instanceId) || !target?.connection) return false;
  const { server, port, database, username, password } = target.connection;
  return boundedText(server, 253) && DNS_HOST.test(server) && !isIP(server) &&
    Number.isSafeInteger(port) && port >= 1 && port <= 65535 && boundedText(database, 128) &&
    boundedText(username, 128) && boundedText(password, 512);
}

/** Internal parser for the fixed metadata SELECT, including calls inside an existing SQL transaction. */
export function fingerprintCatalogSqlTargetRows(
  rows: unknown, instanceId: string, expectedDatabase: string,
): Buffer | null {
  if (!isCatalogSqlInstanceId(instanceId) || !Array.isArray(rows) || rows.length !== 1) return null;
  const row = rows[0];
  if (!row || typeof row !== "object" || Object.keys(row).length !== 2 ||
      !Object.hasOwn(row, "databaseName") || !Object.hasOwn(row, "databaseGuid") ||
      row.databaseName !== expectedDatabase || !validUuid(row.databaseGuid)) return null;
  return fingerprintCatalogSqlTarget({ instanceId, databaseGuid: row.databaseGuid });
}

/**
 * Returns only the opaque identity of an already-certified target, or null
 * when the current login cannot verify it. Does not request or change grants.
 */
export async function readCatalogSqlTargetIdentity(
  target: CertifiedSqlIdentityTarget,
  signal: AbortSignal,
  options: Readonly<{ timeoutMs?: number }> = {},
): Promise<Buffer | null> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (signal.aborted || !isApprovedInput(target) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) return null;
  const { instanceId, connection: { server, port, database, username, password } } = target;

  const lifetime = new AbortController();
  const sockets = new Set<Socket>();
  let request: sql.Request | undefined;
  let pool: sql.ConnectionPool | undefined;
  let resolveStopped!: (value: null) => void;
  const stopped = new Promise<null>(resolve => { resolveStopped = resolve; });
  const closeSockets = () => {
    for (const socket of sockets) socket.destroy();
  };
  const stop = () => {
    if (lifetime.signal.aborted) return;
    resolveStopped(null);
    lifetime.abort();
    try { request?.cancel(); } catch { /* force-close socket below */ }
    closeSockets();
  };
  const timer = setTimeout(stop, timeoutMs);
  signal.addEventListener("abort", stop, { once: true });

  const observe = async (): Promise<Buffer | null> => {
    const guarded = createGuardedSqlConnector(resolveHost, socketOptions => {
      lifetime.signal.throwIfAborted(); // An in-flight lookup may finish after cancellation.
      const socket = connect(socketOptions);
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      return socket;
    });
    const connector: SocketConnector = async (destination, lookup, driverSignal) => {
      if (destination.host.toLowerCase() !== server.toLowerCase() || destination.port !== port) {
        throw new Error("catalog_identity_route_unapproved");
      }
      return guarded(destination, lookup, AbortSignal.any([lifetime.signal, driverSignal]));
    };

    pool = new sql.ConnectionPool({
      server, port, database, user: username, password,
      connectionTimeout: timeoutMs,
      requestTimeout: timeoutMs,
      pool: { min: 0, max: 1, acquireTimeoutMillis: timeoutMs, idleTimeoutMillis: 1000 },
      options: {
        encrypt: true, trustServerCertificate: false, serverName: server,
        fallbackToDefaultDb: false, cancelTimeout: 1000, maxRetriesOnTransientErrors: 0,
        appName: "PortalSAGWeb-CatalogoIdentidad", connector: connector as never,
      },
    });
    pool.on("error", stop);
    await pool.connect();
    lifetime.signal.throwIfAborted();
    request = pool.request();
    const rows = (await request.query<Record<string, unknown>>(CATALOG_SQL_TARGET_IDENTITY_SELECT)).recordset;
    request = undefined;
    return lifetime.signal.aborted ? null : fingerprintCatalogSqlTargetRows(rows, instanceId, database);
  };

  try {
    return await Promise.race([stopped, observe()]);
  } catch {
    // No driver errors, credentials, database names, or GUIDs cross this boundary.
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    if (!lifetime.signal.aborted) lifetime.abort();
    closeSockets();
    try { void pool?.close().catch(() => {}); } catch { /* sockets are already closed */ }
  }
}
