import { createHash } from "node:crypto";
import sql from "mssql";
import { z } from "zod";
import { CompanyLogoError, databaseNameSchema, trimmed } from "./companyLogo";
import { createGuardedSqlConnector, resolveHost, resolvesToPublicAddresses, type HostResolver } from "./outboundGuard";

/*
  Conexión temporal a la base de datos de una compañía de SAG Web para
  configurar el almacenamiento de archivos y el logo en parametros_web.

  - Usuario y contraseña viven solo en memoria durante la solicitud: no se
    guardan, no se registran y no se devuelven.
  - Solo se ejecutan consultas fijas y parametrizadas; nunca SQL escrito por la
    persona.
  - Cifrado obligatorio y certificado VALIDADO: se comprueba la identidad del
    servidor antes de enviar la contraseña. Tiempos límite cortos.
  - El nombre del servidor debe resolver a direcciones públicas: nunca a la red
    interna (loopback, privadas, link-local, metadatos de Azure).
*/

/**
 * servidor[,puerto] — como en SSMS (sin puerto: 1433). No se admiten instancias con
 * nombre (servidor\instancia): su búsqueda por UDP no pasaría por el filtro de destinos.
 */
const SERVER_PATTERN = /^([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?:,(\d{1,5}))?$/;

const serverSchema = trimmed("El servidor y puerto", z.string()
  .min(1, "El servidor y puerto es obligatorio.")
  .max(300, "El servidor y puerto es demasiado largo.")
  .regex(/^\S+$/, "El servidor y puerto no puede tener espacios. Escríbalo así: servidor,puerto (ej.: data14.sagerp.co,54103).")
  .refine((value) => {
    const match = SERVER_PATTERN.exec(value);
    if (!match) return false;
    return match[2] === undefined || (Number(match[2]) >= 1 && Number(match[2]) <= 65535);
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

export type ParsedServer = { host: string; port: number };

export function parseServer(value: string): ParsedServer {
  const match = SERVER_PATTERN.exec(value);
  if (!match) throw new CompanyLogoError("Escriba el servidor y el puerto así: servidor,puerto.", 400);
  return { host: match[1], port: match[2] ? Number(match[2]) : 1433 };
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

/**
 * Huella de la configuración actual de parametros_web. La confirmación del
 * operador queda ligada a esta huella: si la configuración cambia antes de
 * escribir, la huella no coincide y no se escribe nada. Las llaves entran
 * solo como su propio SHA-256 (la huella no permite recuperarlas).
 */
export function configurationFingerprint(values: ParametrosWebValues): string {
  const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  const material = STORAGE_COLUMNS.map((column) => {
    const value = values[column] ?? "";
    return `${column}=${column === "MinioAccessKey" || column === "MinioSecretKey" ? digest(value) : value}`;
  }).join("\n");
  return digest(`parametros_web/v1\n${material}`);
}

/**
 * El COMMIT se envió pero no llegó respuesta (conexión caída, tiempo agotado):
 * SQL Server pudo haber confirmado o revertido. Quien llama NO debe suponer
 * ninguna de las dos cosas: debe verificar el estado real antes de actuar.
 */
export class CommitOutcomeUnknownError extends Error {
  readonly code = "ECOMMITUNKNOWN";
  constructor() {
    super("Commit outcome unknown.");
  }
}

export type CompanyDatabaseState = {
  rows: number;
  fingerprint: string;
  /** Valores actuales (incluye llaves: SOLO para comparar en el servidor; nunca se devuelven). */
  current: ParametrosWebValues;
};

/** Valores que se escriben. `LogoEmpresa` solo si se sube logo. */
export type StorageWrite = Omit<ParametrosWebValues, "LogoEmpresa"> & { LogoEmpresa?: string };

export interface CompanyDatabaseSession {
  inspect(): Promise<CompanyDatabaseState>;
  /**
   * En UNA transacción: bloquea la fila, comprueba que la configuración sigue
   * siendo la de `expectedFingerprint`, actualiza exactamente una fila, vuelve a
   * leer y verifica lo escrito. Cualquier diferencia revierte todo.
   */
  write(values: StorageWrite, expectedFingerprint: string): Promise<void>;
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
  const text = `${(error as { message?: string })?.message ?? ""} ${(candidate?.originalError as { message?: string } | undefined)?.message ?? ""}`;
  if (code === "EPLAINTEXTLOGIN" || /plaintext sql traffic blocked/i.test(text)) {
    return new CompanyLogoError("El servidor de base de datos no aceptó una conexión cifrada. Por seguridad no se envió la contraseña. Pida a Infraestructura habilitar el cifrado (TLS) en ese servidor.", 400);
  }
  if (code === "EINTERNALDESTINATION" || /internal or invalid address/i.test(text)) {
    return new CompanyLogoError("No fue posible usar ese servidor de base de datos: no existe o apunta a una red interna. Revise el servidor y puerto.", 400);
  }
  if (/certificate|self[ -]signed|altname|hostname\/ip does not match|CERT_|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(text)) {
    return new CompanyLogoError("El servidor de base de datos no presentó un certificado válido para ese nombre. Escriba el servidor con el nombre que aparece en su certificado (no la IP) o pida a Infraestructura instalar un certificado válido.", 400);
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
export function createCompanyDatabaseOpener(
  resolver: HostResolver = resolveHost,
  connectFn?: Parameters<typeof createGuardedSqlConnector>[1],
): CompanyDatabaseOpener {
  return (database) => openWithResolver(database, resolver, connectFn);
}

export const openCompanyDatabase: CompanyDatabaseOpener = (database) => openWithResolver(database, resolveHost);

async function openWithResolver(
  database: CompanyDatabase,
  resolver: HostResolver,
  connectFn?: Parameters<typeof createGuardedSqlConnector>[1],
): Promise<CompanyDatabaseSession> {
  const server = parseServer(database.server);
  if (!(await resolvesToPublicAddresses(server.host, resolver))) {
    throw new CompanyLogoError("No fue posible usar ese servidor de base de datos: no existe o apunta a una red interna. Revise el servidor y puerto.", 400);
  }
  const pool = new sql.ConnectionPool({
    server: server.host,
    port: server.port,
    database: database.databaseName,
    user: database.username,
    password: database.password,
    connectionTimeout: 15_000,
    requestTimeout: 15_000,
    pool: { min: 0, max: 1, idleTimeoutMillis: 5_000 },
    options: {
      encrypt: true,
      trustServerCertificate: false,
      enableArithAbort: true,
      appName: "PortalSAGWeb-AlmacenamientoLogo",
      // El transporte se conecta SOLO a direcciones públicas validadas en ese momento
      // (también si el servidor redirige). El certificado se valida con el nombre original.
      // Los tipos de mssql declaran el conector sin argumentos; tedious sí se los pasa.
      connector: createGuardedSqlConnector(resolver, connectFn) as never,
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
      return { rows, current, fingerprint: configurationFingerprint(current) };
    },

    async write(values, expectedFingerprint) {
      const transaction = new sql.Transaction(pool);
      await transaction.begin();
      try {
        // 1) Bloquear y releer: la confirmación debe seguir correspondiendo a lo que hay.
        const locked = await new sql.Request(transaction).query(`
SELECT COUNT(*) AS row_count FROM parametros_web WITH (UPDLOCK, HOLDLOCK);
SELECT TOP 1 ${STORAGE_COLUMNS.map((column) => `CONVERT(NVARCHAR(4000), ${column}) AS ${column}`).join(", ")}
FROM parametros_web WITH (UPDLOCK, HOLDLOCK);`);
        const lockedSets = locked.recordsets as unknown as Array<Array<Record<string, unknown>>>;
        const lockedRows = Number(lockedSets[0]?.[0]?.row_count ?? 0);
        if (lockedRows !== 1) {
          throw new CompanyLogoError(`parametros_web tiene ${lockedRows} filas y debe ser exactamente una. No se cambió nada.`, 409);
        }
        const lockedValues = emptyValues();
        for (const column of STORAGE_COLUMNS) {
          const value = lockedSets[1]?.[0]?.[column];
          lockedValues[column] = value == null ? "" : String(value);
        }
        if (configurationFingerprint(lockedValues) !== expectedFingerprint) {
          throw new CompanyLogoError("La configuración de la compañía cambió mientras se revisaba. No se cambió nada: revise de nuevo y confirme.", 409, { stale: true });
        }
        // 2) Actualizar.
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
        const affected = result.rowsAffected?.[0] ?? 0;
        if (affected !== 1) {
          // Se revierte: la confirmación solo cubre una fila.
          throw new CompanyLogoError(`Se iban a modificar ${affected} filas de parametros_web y debe ser exactamente una. No se cambió nada.`, 409);
        }
        // 3) Verificar dentro de la misma transacción, ANTES de confirmar.
        const check = await new sql.Request(transaction).query(`
SELECT TOP 1 ${STORAGE_COLUMNS.map((column) => `CONVERT(NVARCHAR(4000), ${column}) AS ${column}`).join(", ")} FROM parametros_web;`);
        const written = (check.recordset?.[0] ?? {}) as Record<string, unknown>;
        const mismatch = (Object.keys(values) as Array<keyof StorageWrite>).some((field) => {
          const expected = String(values[field] ?? "");
          const actual = written[field] == null ? "" : String(written[field]).trim();
          return field === "MinioPort" ? Number(actual) !== Number(expected) : actual !== expected;
        });
        if (mismatch) {
          throw new CompanyLogoError("La base de datos no conservó los valores escritos. No se cambió nada.", 502);
        }
        try {
          await transaction.commit();
        } catch {
          // No se sabe si quedó confirmado: no se intenta revertir ni se supone nada.
          throw new CommitOutcomeUnknownError();
        }
      } catch (error) {
        if (!(error instanceof CommitOutcomeUnknownError)) await transaction.rollback().catch(() => undefined);
        throw error;
      }
    },

    async close() {
      await pool.close().catch(() => undefined);
    },
  };
}
