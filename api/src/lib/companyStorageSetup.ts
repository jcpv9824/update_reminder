import { z } from "zod";
import {
  assertStorageReachable,
  CompanyLogoError,
  createCompanyStorageS3Client,
  decodeCompanyLogo,
  listExistingLogos,
  LogoImageSchema,
  probeCompanyStorage,
  putCompanyLogo,
  removeCompanyLogo,
  StorageSchema,
  storageErrorMessage,
  type S3Factory,
} from "./companyLogo";
import { resolveHost, type HostResolver } from "./outboundGuard";
import {
  CommitOutcomeUnknownError,
  CompanyDatabaseSchema,
  databaseErrorMessage,
  openCompanyDatabase,
  type CompanyDatabase,
  type CompanyDatabaseOpener,
  type CompanyDatabaseSession,
  type ParametrosWebValues,
  type StorageWrite,
} from "./companyDatabase";

/*
  Configurar el almacenamiento de archivos (y opcionalmente el logo) de una
  compañía directamente en su parametros_web.

  Orden: validar todo → abrir la base y revisar parametros_web → probar el
  almacenamiento de verdad (escribir, leer y borrar un archivo de prueba) →
  pedir confirmación ligada a la huella de la configuración vista → subir el
  logo → escribir en UNA transacción que bloquea la fila, comprueba la huella,
  actualiza y verifica antes de confirmar.

  Garantía para quien lo usa: cualquier error devuelve databaseChanged=false.
  La base solo cambia en el último paso (commit), y después de ese paso este
  módulo ya no puede fallar. Si el logo se subió y la base no se pudo
  actualizar, se borra el logo recién subido (mejor esfuerzo).
*/

const FINGERPRINT = /^[0-9a-f]{64}$/;

export const ApplyCompanyStorageSchema = z.object({
  storage: StorageSchema,
  database: CompanyDatabaseSchema,
  logo: LogoImageSchema.optional(),
  /** Huella de la configuración que el operador revisó y confirmó (viene en la respuesta 409). */
  confirmationToken: z.string().regex(FINGERPRINT, "La confirmación no es válida. Revise de nuevo y confirme.").optional(),
}).strict();

export const CheckDatabaseSchema = z.object({ database: CompanyDatabaseSchema }).strict();

export type ApplyCompanyStorageInput = z.infer<typeof ApplyCompanyStorageSchema>;

export type FieldChange = { field: string; label: string; before: string; after: string };

export type DatabaseCheckResult = {
  databaseName: string;
  current: {
    hasLogo: boolean;
    bucket: string;
    folder: string;
    endpoint: string;
    port: string;
    useSsl: string;
    basePath: string;
    keysConfigured: boolean;
  };
};

export type ApplyCompanyStorageResult = {
  databaseName: string;
  storageConfigured: true;
  databaseChanged: true;
  logoUpdated: boolean;
  logoUrl: string | null;
  fileName: string | null;
  bytes: number | null;
  previousLogoCount: number;
  changes: FieldChange[];
  keysChanged: boolean;
};

/** Lo escrito coincide campo por campo con lo que se quería escribir. */
function matchesTarget(values: ParametrosWebValues, target: StorageWrite): boolean {
  return (Object.keys(target) as Array<keyof StorageWrite>).every((field) => {
    const expected = String(target[field] ?? "");
    const actual = values[field].trim();
    return field === "MinioPort" ? Number(actual) === Number(expected) : actual === expected;
  });
}

/**
 * Tras un COMMIT de resultado incierto, revisa el estado real con una conexión
 * nueva. Devuelve "applied", "not-applied" o "unknown" (si no se pudo revisar).
 */
async function verifyCommitOutcome(
  database: CompanyDatabase,
  openDatabase: CompanyDatabaseOpener,
  target: StorageWrite,
): Promise<"applied" | "not-applied" | "unknown"> {
  let verifier: CompanyDatabaseSession | null = null;
  try {
    verifier = await openDatabase(database);
    const { current } = await verifier.inspect();
    return matchesTarget(current, target) ? "applied" : "not-applied";
  } catch {
    return "unknown";
  } finally {
    await verifier?.close().catch(() => undefined);
  }
}

export type CompanyStorageDeps = {
  openDatabase?: CompanyDatabaseOpener;
  s3Factory?: S3Factory;
  resolver?: HostResolver;
};

const VISIBLE_FIELDS: Array<{ field: keyof ParametrosWebValues; label: string }> = [
  { field: "MinioBucketName", label: "Bucket" },
  { field: "MinioNameEnterprise", label: "Carpeta (nombre de la base de datos)" },
  { field: "MinioEndpoint", label: "Servidor del almacenamiento" },
  { field: "MinioPort", label: "Puerto del almacenamiento" },
  { field: "MinioUseSSL", label: "SSL" },
  { field: "MinioBasePath", label: "Ruta base" },
];

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function samePort(a: string, b: string): boolean {
  return Number(a) === Number(b) && a.trim() !== "";
}

/** Error con la garantía explícita de que la base de la compañía no cambió. */
function unchanged(error: unknown, stage: string, translate: (error: unknown) => CompanyLogoError, extra: Record<string, unknown> = {}): CompanyLogoError {
  const base = translate(error);
  return new CompanyLogoError(base.message, base.status, { ...(base.details ?? {}), ...extra, stage, databaseChanged: false });
}

function summarize(current: ParametrosWebValues): DatabaseCheckResult["current"] {
  // Nunca se devuelve LogoEmpresa: podría traer un enlace firmado. Solo si hay logo.
  return {
    hasLogo: current.LogoEmpresa.trim() !== "",
    bucket: current.MinioBucketName.trim(),
    folder: current.MinioNameEnterprise.trim(),
    endpoint: current.MinioEndpoint.trim(),
    port: current.MinioPort.trim(),
    useSsl: current.MinioUseSSL.trim(),
    basePath: current.MinioBasePath.trim(),
    keysConfigured: Boolean(current.MinioAccessKey.trim() && current.MinioSecretKey.trim()),
  };
}

async function openAndInspect(database: CompanyDatabase, openDatabase: CompanyDatabaseOpener) {
  let session: CompanyDatabaseSession | null = null;
  try {
    session = await openDatabase(database);
    const state = await session.inspect();
    if (state.rows < 1) {
      throw new CompanyLogoError("parametros_web no tiene registros en esa base. Revise que la base esté configurada para SAG Web.", 400);
    }
    if (state.rows > 1) {
      throw new CompanyLogoError(`parametros_web tiene ${state.rows} filas en esa base y SAG Web usa una sola. Revise la base antes de configurar: no se cambió nada.`, 409);
    }
    return { session, state };
  } catch (error) {
    await session?.close();
    throw unchanged(error, "database", databaseErrorMessage);
  }
}

/** Prueba la conexión a la base: entra, revisa parametros_web y el permiso de actualizarla. No escribe nada. */
export async function checkCompanyDatabase(
  database: CompanyDatabase,
  openDatabase: CompanyDatabaseOpener = openCompanyDatabase,
): Promise<DatabaseCheckResult> {
  const { session, state } = await openAndInspect(database, openDatabase);
  await session.close();
  return { databaseName: database.databaseName, current: summarize(state.current) };
}

export async function applyCompanyStorage(
  input: ApplyCompanyStorageInput,
  deps: CompanyStorageDeps = {},
): Promise<ApplyCompanyStorageResult> {
  const openDatabase = deps.openDatabase ?? openCompanyDatabase;
  const s3Factory = deps.s3Factory ?? createCompanyStorageS3Client;
  const { storage, database } = input;

  let image;
  try {
    image = input.logo ? decodeCompanyLogo(input.logo.imageBase64, input.logo.imageName) : null;
    await assertStorageReachable(storage, deps.resolver ?? resolveHost);
  } catch (error) {
    throw unchanged(error, "validation", storageErrorMessage);
  }

  const { session, state } = await openAndInspect(database, openDatabase);
  const s3 = s3Factory(storage);
  try {
    let existing;
    try {
      existing = await listExistingLogos(s3, storage, database.databaseName);
      await probeCompanyStorage(s3, storage, database.databaseName);
    } catch (error) {
      throw unchanged(error, "storage", storageErrorMessage);
    }

    const target: StorageWrite = {
      MinioNameEnterprise: database.databaseName,
      MinioBucketName: storage.bucket,
      MinioAccessKey: storage.accessKey,
      MinioSecretKey: storage.secretKey,
      MinioEndpoint: storage.options.endpoint,
      MinioPort: String(storage.options.port),
      MinioUseSSL: "S",
      MinioBasePath: storage.options.basePath,
    };

    const current = state.current;
    const changes: FieldChange[] = VISIBLE_FIELDS
      .filter(({ field }) => current[field].trim() !== "")
      .filter(({ field }) => (field === "MinioPort"
        ? !samePort(current[field], target[field]!)
        : !same(current[field], target[field]!)))
      .map(({ field, label }) => ({ field, label, before: current[field].trim(), after: target[field]! }));
    const keysChanged = (current.MinioAccessKey.trim() !== "" && current.MinioAccessKey.trim() !== storage.accessKey)
      || (current.MinioSecretKey.trim() !== "" && current.MinioSecretKey.trim() !== storage.secretKey);
    const hasLogo = current.LogoEmpresa.trim() !== "";
    const replacesLogo = Boolean(image && (hasLogo || existing.length > 0));
    const needsConfirmation = changes.length > 0 || keysChanged || replacesLogo;

    if (needsConfirmation && input.confirmationToken !== state.fingerprint) {
      const stale = input.confirmationToken !== undefined;
      throw new CompanyLogoError(
        stale
          ? "La configuración de la compañía cambió desde que la revisó. No se cambió nada: revise de nuevo y confirme."
          : "Esta compañía ya tiene una configuración o un logo. Revise qué cambia y confirme.",
        409,
        {
          requiresConfirmation: true,
          stale,
          confirmationToken: state.fingerprint,
          changes,
          keysChanged,
          hasLogo,
          existingLogoCount: existing.length,
          replacesLogo,
          stage: "confirmation",
          databaseChanged: false,
        },
      );
    }

    let uploaded: { url: string; fileName: string } | null = null;
    if (image) {
      try {
        uploaded = await putCompanyLogo(s3, storage, database.databaseName, image);
      } catch (error) {
        throw unchanged(error, "logo", storageErrorMessage);
      }
      target.LogoEmpresa = uploaded.url;
    }

    try {
      // La huella esperada es la que se revisó (o la de la inspección, si no hubo nada que confirmar).
      await session.write(target, state.fingerprint);
    } catch (error) {
      if (error instanceof CommitOutcomeUnknownError) {
        // La base pudo haber quedado apuntando al logo nuevo: NO se borra nada
        // hasta saber qué pasó.
        const outcome = await verifyCommitOutcome(database, openDatabase, target);
        if (outcome === "applied") {
          return {
            databaseName: database.databaseName,
            storageConfigured: true,
            databaseChanged: true,
            logoUpdated: Boolean(uploaded),
            logoUrl: uploaded?.url ?? null,
            fileName: uploaded?.fileName ?? null,
            bytes: image ? image.bytes.length : null,
            previousLogoCount: existing.length,
            changes,
            keysChanged,
          };
        }
        if (outcome === "unknown") {
          throw new CompanyLogoError(
            "No fue posible confirmar si la configuración quedó guardada (se perdió la conexión al confirmar). No se borró nada. Use «Probar conexión» de la base de datos para revisar el estado antes de intentar de nuevo.",
            502,
            { stage: "commit", databaseChanged: "unknown", uploadedLogoKept: Boolean(uploaded) },
          );
        }
        // "not-applied": la base no cambió; se sigue con la limpieza normal.
      }
      const removed = uploaded ? await removeCompanyLogo(s3, storage, database.databaseName, uploaded.fileName) : undefined;
      const extra: Record<string, unknown> = uploaded ? { uploadedLogoRemoved: removed } : {};
      const translated = databaseErrorMessage(error);
      if (translated.status === 409 && (translated.details as { stale?: boolean } | undefined)?.stale) {
        extra.requiresConfirmation = false;
      }
      throw unchanged(error, "database", databaseErrorMessage, extra);
    }

    return {
      databaseName: database.databaseName,
      storageConfigured: true,
      databaseChanged: true,
      logoUpdated: Boolean(uploaded),
      logoUrl: uploaded?.url ?? null,
      fileName: uploaded?.fileName ?? null,
      bytes: image ? image.bytes.length : null,
      previousLogoCount: existing.length,
      changes,
      keysChanged,
    };
  } finally {
    s3.destroy();
    await session.close();
  }
}
