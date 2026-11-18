import { connect, type Socket } from "node:net";
import sql from "mssql";
import {
  CatalogExternalReadUnavailable,
  catalogExternalSelectSql,
  type CatalogExternalReadSession,
  type CatalogExternalSourceTransport,
} from "./catalogExternalSourceQueries";
import { createGuardedSqlConnector, resolveHost, type SocketConnector } from "./outboundGuard";
import { catalogSqlInstanceNamePattern } from "./catalogOriginConnectionAddress";

/** Construct server-side from an enabled binding and its resolved secret; never from HTTP input. */
export type CatalogSqlConnectionTarget = Readonly<{
  server: string;
  port: number;
  database: string;
  username: string;
  password: string;
  /** Optional assertion only: never passed as a driver address or used for discovery. */
  expectedInstanceName?: string;
}>;

const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i;
const MAX_TOTAL_MS = 120_000;
const MAX_STATEMENT_MS = 15_000;
const validMs = (value: number, max: number) => Number.isSafeInteger(value) && value >= 1 && value <= max;
const validSqlId = (value: string) => typeof value === "string" && value.length > 0 && value.length <= 128 && !/\p{Cc}/u.test(value);

type FailureReason = ConstructorParameters<typeof CatalogExternalReadUnavailable>[0];
const failure = (reason: FailureReason = "connection_failed") => new CatalogExternalReadUnavailable(reason);

function normalizeDriverError(error: unknown): CatalogExternalReadUnavailable {
  const e = error as { code?: unknown; number?: unknown; originalError?: { info?: { number?: unknown } } } | null;
  const number = e?.number ?? e?.originalError?.info?.number;
  if (number === 3952 || number === 3961) return failure("consistency_unverified");
  if (e?.code === "ETIMEOUT") return failure("timeout");
  if (e?.code === "ECANCEL") return failure("cancelled");
  return failure();
}

async function driverOperation<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) { throw normalizeDriverError(error); }
}

export function createCatalogExternalSqlTransport(target: CatalogSqlConnectionTarget): CatalogExternalSourceTransport {
  if (typeof target.server !== "string" || !HOST.test(target.server) || target.server.includes("..") ||
      !Number.isInteger(target.port) || target.port < 1 || target.port > 65535 ||
      !validSqlId(target.database) || !validSqlId(target.username) ||
      typeof target.password !== "string" || !target.password.length || target.password.length > 512 ||
      (target.expectedInstanceName !== undefined && !catalogSqlInstanceNamePattern.test(target.expectedInstanceName))) {
    throw failure();
  }
  const { server, port, database, username, password, expectedInstanceName } = target;

  return {
    async withConsistentRead({ contract, timeoutMs, signal }, read) {
      const discovery = contract === "sag_admin_v2" || contract === "sag_admin_v2_targets";
      if (contract !== "erp_v1" && contract !== "sag_admin_v1" && !discovery) throw failure("contract_unapproved");
      if (!validMs(timeoutMs, MAX_TOTAL_MS)) throw failure("invalid_options");
      if (signal.aborted) throw failure("cancelled");

      const lifetime = new AbortController();
      const sockets = new Set<Socket>();
      let active: sql.Request | undefined;
      let pool: sql.ConnectionPool | undefined;
      let rejectStopped!: (error: CatalogExternalReadUnavailable) => void;
      const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
      const stop = (reason: FailureReason) => {
        if (lifetime.signal.aborted) return;
        // Deliver the controlled reason before driver's cancellation/close errors can race it.
        const error = failure(reason);
        rejectStopped(error);
        lifetime.abort(error);
        try { active?.cancel(); } catch { /* force-close below */ }
        for (const socket of sockets) socket.destroy();
      };
      const parentAbort = () => stop("cancelled");
      const totalTimer = setTimeout(() => stop("timeout"), timeoutMs);
      signal.addEventListener("abort", parentAbort, { once: true });

      const guarded = createGuardedSqlConnector(resolveHost, options => {
        // DNS may finish after abort. Never allocate a socket for that late answer.
        lifetime.signal.throwIfAborted();
        const socket = connect(options);
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        return socket;
      });
      const connector: SocketConnector = async (options, lookup, driverSignal) => {
        if (options.host.toLowerCase() !== server.toLowerCase() || options.port !== port) throw failure();
        return guarded(options, lookup, AbortSignal.any([driverSignal, lifetime.signal]));
      };

      const run = async () => {
        pool = new sql.ConnectionPool({
          server, port, database, user: username, password,
          connectionTimeout: Math.min(timeoutMs, 10_000),
          requestTimeout: Math.min(timeoutMs, MAX_STATEMENT_MS),
          pool: { min: 0, max: 1, idleTimeoutMillis: 1000, acquireTimeoutMillis: Math.min(timeoutMs, 10_000) },
          options: {
            encrypt: true, trustServerCertificate: false, serverName: server,
            fallbackToDefaultDb: false, enableArithAbort: true,
            cancelTimeout: 1000, maxRetriesOnTransientErrors: 0,
            appName: "PortalSAGWeb-CatalogoExterno", connector: connector as never,
          },
        });
        const currentPool = pool;
        currentPool.on("error", () => stop("connection_failed"));
        await driverOperation(() => currentPool.connect());
        lifetime.signal.throwIfAborted();

        const transaction = new sql.Transaction(currentPool);
        await driverOperation(() => transaction.begin(sql.ISOLATION_LEVEL.SNAPSHOT));
        lifetime.signal.throwIfAborted();
        let schemaChecked = false;
        let schemaVerified = false;
        let discoveryCountsRead = false;
        let closed = false;
        const session: CatalogExternalReadSession = {
          consistency: "verified",
          async select(statement) {
            lifetime.signal.throwIfAborted();
            if (closed || active) throw failure("consistency_unverified");
            if (statement.signal.aborted) { stop("cancelled"); throw failure("cancelled"); }
            if (!validMs(statement.timeoutMs, MAX_STATEMENT_MS)) throw failure("invalid_options");
            const { tag, parameters } = statement;
            const fixedSql = catalogExternalSelectSql(contract, tag);
            if (statement.sql !== fixedSql) throw failure("contract_unapproved");
            const isPage = tag === "page" || tag === "customerPage" || tag === "companyPage";

            if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw failure("invalid_options");
            const keys = Reflect.ownKeys(parameters);
            if (tag === "schema") {
              if (schemaChecked || keys.length !== 0) throw failure("contract_unapproved");
              schemaChecked = true;
            } else {
              if (!schemaVerified) throw failure("schema_unverified");
              if (tag === "counts") {
                if (discoveryCountsRead || keys.length !== 0) throw failure("contract_unapproved");
              } else {
                if (discovery && !discoveryCountsRead) throw failure("contract_unapproved");
                const { afterId, pageSize } = parameters;
                if (keys.length !== 2 || !keys.includes("afterId") || !keys.includes("pageSize") ||
                    (afterId !== null && (typeof afterId !== "number" || !Number.isInteger(afterId) || afterId < -2147483648 || afterId > 2147483647)) ||
                    pageSize === undefined || !validMs(pageSize, 1000)) throw failure("invalid_options");
              }
            }

            const request = new sql.Request(transaction);
            if (isPage) {
              request.input("afterId", sql.Int, parameters.afterId);
              request.input("pageSize", sql.Int, parameters.pageSize);
            }
            active = request;
            const statementAbort = () => stop("cancelled");
            let rejectStatement!: (error: unknown) => void;
            const statementStopped = new Promise<never>((_, reject) => { rejectStatement = reject; });
            const lifetimeAbort = () => rejectStatement(lifetime.signal.reason);
            const statementTimer = setTimeout(() => stop("timeout"), statement.timeoutMs);
            statement.signal.addEventListener("abort", statementAbort, { once: true });
            lifetime.signal.addEventListener("abort", lifetimeAbort, { once: true });
            try {
              const { recordset } = await Promise.race([
                statementStopped,
                driverOperation(() => request.query<Record<string, unknown>>(fixedSql)),
              ]);
              if (tag === "schema") {
                schemaVerified = recordset?.length === 1 && recordset[0]?.compatible === true && recordset[0]?.readOnly === true;
              }
              if (tag === "counts") discoveryCountsRead = true;
              return recordset;
            } finally {
              clearTimeout(statementTimer);
              statement.signal.removeEventListener("abort", statementAbort);
              lifetime.signal.removeEventListener("abort", lifetimeAbort);
              active = undefined;
            }
          },
        };

        try {
          if (expectedInstanceName !== undefined) {
            const request = new sql.Request(transaction);
            active = request;
            try {
              const { recordset } = await driverOperation(() => request.query<{ instanceName: string | null }>(
                "SELECT CONVERT(nvarchar(128), SERVERPROPERTY('InstanceName')) AS instanceName;"));
              lifetime.signal.throwIfAborted();
              const reported = recordset.length === 1 ? recordset[0]?.instanceName : null;
              if (typeof reported !== "string" || !catalogSqlInstanceNamePattern.test(reported) ||
                reported.toUpperCase() !== expectedInstanceName.toUpperCase()) throw failure();
            } finally { active = undefined; }
          }
          const value = await read(session);
          if (!schemaVerified || active || (discovery && !discoveryCountsRead)) throw failure("consistency_unverified");
          return value;
        } finally {
          closed = true;
          // Read-only transaction: close via rollback. After abort its socket is already destroyed.
          if (active) stop("consistency_unverified");
          if (!lifetime.signal.aborted) await driverOperation(() => transaction.rollback());
        }
      };

      try {
        return await Promise.race([stopped, run()]);
      } catch (error) {
        if (error instanceof CatalogExternalReadUnavailable) throw failure(error.reason);
        throw failure();
      } finally {
        clearTimeout(totalTimer);
        signal.removeEventListener("abort", parentAbort);
        if (!lifetime.signal.aborted) lifetime.abort();
        for (const socket of sockets) socket.destroy();
        try { void pool?.close().catch(() => {}); } catch { /* socket is already closed */ }
      }
    },
  };
}
