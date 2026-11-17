import sql from "mssql";
import { z } from "zod";
import { CompanyLogoError, databaseNameSchema, trimmed } from "./companyLogo";

/*
  Conexión temporal a la base de datos de una compañía de SAG Web para
  configurar el almacenamiento de archivos y el logo en parametros_web.

  - Usuario y contraseña viven solo en memoria durante la solicitud: no se
    guardan, no se registran y no se devuelven.
  - Solo se ejecutan consultas fijas y parametrizadas; nunca SQL escrito por la
    persona.
  - Cifrado obligatorio, confiando en el certificado del servidor (igual que la
    casilla «Trust server certificate» de SSMS), con tiempos límite.
*/

/** servidor[\instancia][,puerto] — como en SSMS. */
const SERVER_PATTERN = /^([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?:\\([A-Za-z0-9_$-]{1,64}))?(?:,(\d{1,5}))?$/;

const serverSchema = trimmed("El servidor y puerto", z.string()
  .min(1, "El servidor y puerto es obligatorio.")
  .max(300, "El servidor y puerto es demasiado largo.")
  .regex(/^\S+$/, "El servidor y puerto no puede tener espacios. Escríbalo así: servidor,puerto (ej.: data14.sagerp.co,54103).")
  .refine((value) => {
    const match = SERVER_PATTERN.exec(value);
    if (!match) return false;
    return match[3] === undefined || (Number(match[3]) >= 1 && Number(match[3]) <= 65535);
  }, "Escriba el servidor y el puerto así: servidor,puerto (ej.: data14.sagerp.co,54103 o 10.0.0.5,1433)."));

export const CompanyDatabaseSchema = z.object({
  server: serverSchema,
  databaseName: databaseNameSchema,
  username: trimmed("El usuario de SQL", z.string()
    .min(1, "El usuario de SQL es obligatorio.")
    .max(128, "El usuario de SQL es demasiado largo.")
    .regex(/^\S+$/, "El usuario de SQL no puede tener espacios.")),
  password: trimmed("La contraseña de SQL", z.string()
    .min(1, "La contraseña de SQL es obligatoria.")
    .max(128, "La contraseña de SQL es demasiado larga.")),
}).strict();

export type CompanyDatabase = z.infer<typeof CompanyDatabaseSchema>;

export type ParsedServer = { host: string; instanceName?: string; port?: number };

export function parseServer(value: string): ParsedServer {
  const match = SERVER_PATTERN.exec(value);
  if (!match) throw new CompanyLogoError("Escriba el servidor y el puerto así: servidor,puerto.", 400);
  return {
    host: match[1],
    ...(match[2] ? { instanceName: match[2] } : {}),
    ...(match[3] ? { port: Number(match[3]) } : {}),
  };
}

/** Columnas de parametros_web que se leen o escriben. */
export const STORAGE_COLUMNS = [
  "LogoEmpresa",
  "MinioNameEnterprise",
  "MinioBucketName",
  "MinioAccessKey",
  "MinioSecretKey",
  "MinioEndpoint",
  "MinioPort",
  "MinioUseSSL",
  "MinioBasePath",
] as const;

export type StorageColumn = (typeof STORAGE_COLUMNS)[number];
export type ParametrosWebValues = Record<StorageColumn, string>;

export type CompanyDatabaseState = {
  rows: number;
  /** Valores actuales (incluye llaves: SOLO para comparar en el servidor; nunca se devuelven). */
  current: ParametrosWebValues;
};

/** Valores que se escriben. `LogoEmpresa` solo si se sube logo. */
export type StorageWrite = Omit<ParametrosWebValues, "LogoEmpresa"> & { LogoEmpresa?: string };

export interface CompanyDatabaseSession {
  inspect(): Promise<CompanyDatabaseState>;
  write(values: StorageWrite): Promise<void>;
  close(): Promise<void>;
}

export type CompanyDatabaseOpener = (database: CompanyDatabase) => Promise<CompanyDatabaseSession>;

/** Traduce los errores de SQL Server a mensajes controlados, sin detalle técnico. */
export function databaseErrorMessage(error: unknown): CompanyLogoError {
  if (error instanceof CompanyLogoError) return error;
  const candidate = error as { code?: string; number?: number; originalError?: { info?: { number?: number }; code?: string } };
  const number = candidate?.number ?? candidate?.originalError?.info?.number;
  const code = candidate?.code ?? candidate?.originalError?.code ?? "";
  if (number === 4060) {
    return new CompanyLogoError("La base de datos no existe en ese servidor o el usuario de SQL no tiene acceso a ella. Revise el nombre de la base de datos.", 400);
  }
  if (number === 18456 || code === "ELOGIN") {
    return new CompanyLogoError("El servidor rechazó el usuario o la contraseña de SQL. Revíselos e intente de nuevo.", 400);
  }
  if (code === "ETIMEOUT") {
    return new CompanyLogoError("El servidor de base de datos no respondió a tiempo. Revise el servidor y el puerto.", 504);
  }
  if (code === "ESOCKET" || code === "EINSTLOOKUP" || code === "ECONNCLOSED") {
    return new CompanyLogoError("No fue posible conectar con el servidor de base de datos. Revise el servidor y el puerto.", 502);
  }
  if (number === 229 || number === 230) {
    return new CompanyLogoError("El usuario de SQL no tiene permiso para leer o actualizar parametros_web en esa base.", 400);
  }
  return new CompanyLogoError("No fue posible completar la operación en la base de datos de la compañía. Intente de nuevo.", 502);
}

const INSPECT_SQL = `
SELECT DB_NAME() AS database_name,
  CASE WHEN OBJECT_ID(N'parametros_web', N'U') IS NULL THEN 0 ELSE 1 END AS has_table,
  CASE WHEN OBJECT_ID(N'parametros_web', N'U') IS NULL THEN 0
       ELSE ISNULL(HAS_PERMS_BY_NAME(N'parametros_web', N'OBJECT', N'UPDATE'), 0) END AS can_update;
SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(N'parametros_web', N'U');`;

const READ_SQL = `
SELECT COUNT(*) AS row_count FROM parametros_web;
SELECT TOP 1 ${STORAGE_COLUMNS.map((column) => `CONVERT(NVARCHAR(4000), ${column}) AS ${column}`).join(", ")} FROM parametros_web;`;

function emptyValues(): ParametrosWebValues {
  return Object.fromEntries(STORAGE_COLUMNS.map((column) => [column, ""])) as ParametrosWebValues;
}

/** Abre una conexión real con mssql. */
export const openCompanyDatabase: CompanyDatabaseOpener = async (database) => {
  const server = parseServer(database.server);
  const pool = new sql.ConnectionPool({
    server: server.host,
    ...(server.port ? { port: server.port } : {}),
    database: database.databaseName,
    user: database.username,
    password: database.password,
    connectionTimeout: 15_000,
    requestTimeout: 15_000,
    pool: { min: 0, max: 1, idleTimeoutMillis: 5_000 },
    options: {
      encrypt: true,
      trustServerCertificate: true,
      enableArithAbort: true,
      appName: "PortalSAGWeb-AlmacenamientoLogo",
      ...(server.instanceName ? { instanceName: server.instanceName } : {}),
    },
  });
  try {
    await pool.connect();
  } catch (error) {
    await pool.close().catch(() => undefined);
    throw databaseErrorMessage(error);
  }

  return {
    async inspect() {
      const meta = await pool.request().query(INSPECT_SQL);
      const sets = meta.recordsets as unknown as Array<Array<Record<string, unknown>>>;
      const info = sets[0]?.[0] ?? {};
      if (String(info.database_name ?? "").toLowerCase() !== database.databaseName.toLowerCase()) {
        throw new CompanyLogoError("El servidor abrió una base distinta a la solicitada. Revise el nombre de la base de datos.", 400);
      }
      if (Number(info.has_table) !== 1) {
        throw new CompanyLogoError("Esa base de datos no tiene la tabla parametros_web. Revise que sea la base de SAG Web de la compañía.", 400);
      }
      const columns = new Set((sets[1] ?? []).map((row) => String(row.name).toLowerCase()));
      const missing = STORAGE_COLUMNS.filter((column) => !columns.has(column.toLowerCase()));
      if (missing.length > 0) {
        throw new CompanyLogoError(`La tabla parametros_web de esa base no tiene ${missing.join(", ")}. Actualice primero la base con los scripts de SAG Web.`, 400);
      }
      if (Number(info.can_update) !== 1) {
        throw new CompanyLogoError("El usuario de SQL no tiene permiso para actualizar parametros_web en esa base.", 400);
      }
      const read = await pool.request().query(READ_SQL);
      const readSets = read.recordsets as unknown as Array<Array<Record<string, unknown>>>;
      const rows = Number(readSets[0]?.[0]?.row_count ?? 0);
      const row = readSets[1]?.[0] ?? {};
      const current = emptyValues();
      for (const column of STORAGE_COLUMNS) current[column] = row[column] == null ? "" : String(row[column]);
      return { rows, current };
    },

    async write(values) {
      const transaction = new sql.Transaction(pool);
      await transaction.begin();
      try {
        const request = new sql.Request(transaction);
        request.input("nameEnterprise", sql.NVarChar(4000), values.MinioNameEnterprise);
        request.input("bucket", sql.NVarChar(4000), values.MinioBucketName);
        request.input("accessKey", sql.NVarChar(4000), values.MinioAccessKey);
        request.input("secretKey", sql.NVarChar(4000), values.MinioSecretKey);
        request.input("endpoint", sql.NVarChar(4000), values.MinioEndpoint);
        request.input("port", sql.Int, Number(values.MinioPort));
        request.input("useSsl", sql.NVarChar(10), values.MinioUseSSL);
        request.input("basePath", sql.NVarChar(4000), values.MinioBasePath);
        if (values.LogoEmpresa !== undefined) request.input("logo", sql.NVarChar(4000), values.LogoEmpresa);
        const result = await request.query(`
UPDATE parametros_web
SET MinioNameEnterprise = @nameEnterprise,
    MinioBucketName = @bucket,
    MinioAccessKey = @accessKey,
    MinioSecretKey = @secretKey,
    MinioEndpoint = @endpoint,
    MinioPort = @port,
    MinioUseSSL = @useSsl,
    MinioBasePath = @basePath${values.LogoEmpresa !== undefined ? ",\n    LogoEmpresa = @logo" : ""};`);
        if ((result.rowsAffected?.[0] ?? 0) < 1) {
          throw new CompanyLogoError("parametros_web no tiene registros en esa base. Revise que la base esté configurada para SAG Web.", 400);
        }
        await transaction.commit();
      } catch (error) {
        await transaction.rollback().catch(() => undefined);
        throw error;
      }
    },

    async close() {
      await pool.close().catch(() => undefined);
    },
  };
};
