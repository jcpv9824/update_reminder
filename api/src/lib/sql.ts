import sql, { ConnectionPool, config as SqlConfig } from "mssql";

const REQUIRED_DATABASE = "PortalSAGWeb";
const REQUIRED_ENGINE_MAJOR = 15;
const REQUIRED_COMPATIBILITY = 150;
const REQUIRED_COLLATION = "Modern_Spanish_CI_AS";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Falta la variable de entorno ${name}.`);
  return value;
}

function integerSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} no es válido.`);
  }
  return value;
}

function parseServer(env: NodeJS.ProcessEnv): { server: string; port: number } {
  const rawServer = required(env, "SQL_SERVER_HOST");
  const comma = rawServer.lastIndexOf(",");
  const embeddedPort = comma > 0 ? rawServer.slice(comma + 1).trim() : "";
  const server = comma > 0 && /^\d+$/.test(embeddedPort)
    ? rawServer.slice(0, comma).trim()
    : rawServer;
  if (!server || server.includes("\\") || /[;=]/.test(server)) {
    throw new Error("SQL_SERVER_HOST debe ser un host TCP sin instancia ni opciones adicionales.");
  }
  const portEnv = comma > 0 && /^\d+$/.test(embeddedPort)
    ? { ...env, SQL_SERVER_PORT: embeddedPort }
    : env;
  return { server, port: integerSetting(portEnv, "SQL_SERVER_PORT", 1433, 1, 65535) };
}

export function buildSqlConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SqlConfig {
  const { server, port } = parseServer(env);
  const database = required(env, "SQL_DATABASE");
  if (database !== REQUIRED_DATABASE) {
    throw new Error(`SQL_DATABASE debe ser ${REQUIRED_DATABASE}.`);
  }

  return {
    server,
    port,
    database,
    user: required(env, "SQL_USERNAME"),
    password: required(env, "SQL_PASSWORD"),
    connectionTimeout: integerSetting(env, "SQL_CONNECTION_TIMEOUT_MS", 15_000, 1_000, 120_000),
    requestTimeout: integerSetting(env, "SQL_REQUEST_TIMEOUT_MS", 30_000, 1_000, 900_000),
    pool: {
      max: integerSetting(env, "SQL_POOL_MAX", 10, 1, 100),
      min: 0,
      idleTimeoutMillis: integerSetting(env, "SQL_POOL_IDLE_TIMEOUT_MS", 30_000, 1_000, 300_000),
    },
    options: {
      encrypt: true,
      trustServerCertificate: false,
      enableArithAbort: true,
      appName: "PortalSAGWeb-API",
    },
  };
}

let poolPromise: Promise<ConnectionPool> | null = null;

export function getSqlPool(): Promise<ConnectionPool> {
  if (poolPromise) return poolPromise;
  const pool = new sql.ConnectionPool(buildSqlConfigFromEnv());
  pool.on("error", () => {
    poolPromise = null;
  });
  poolPromise = pool.connect().catch((error) => {
    poolPromise = null;
    throw error;
  });
  return poolPromise;
}

export async function assertSqlRuntimeReady(): Promise<void> {
  const pool = await getSqlPool();
  const result = await pool.request().query<{
    major_version: number;
    compatibility_level: number;
    collation_name: string;
    database_name: string;
  }>(`
    SELECT
      CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS major_version,
      d.compatibility_level,
      d.collation_name,
      DB_NAME() AS database_name
    FROM sys.databases AS d
    WHERE d.database_id=DB_ID();
  `);
  const row = result.recordset[0];
  if (!row
      || row.major_version !== REQUIRED_ENGINE_MAJOR
      || row.compatibility_level !== REQUIRED_COMPATIBILITY
      || row.collation_name !== REQUIRED_COLLATION
      || row.database_name !== REQUIRED_DATABASE) {
    throw new Error("La conexión SQL no coincide con el contrato certificado de Portal SAG Web.");
  }
}

export async function closeSqlPool(): Promise<void> {
  const current = poolPromise;
  poolPromise = null;
  if (current) await (await current).close();
}
