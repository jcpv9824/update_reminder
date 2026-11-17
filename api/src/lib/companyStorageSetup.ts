import { z } from "zod";
import {
  assertStorageReachable,
  CompanyLogoError,
  createCompanyStorageS3Client,
  decodeCompanyLogo,
  listExistingLogos,
  LogoImageSchema,
  putCompanyLogo,
  StorageSchema,
  storageErrorMessage,
  type S3Factory,
} from "./companyLogo";
import { resolveHost, type HostResolver } from "./outboundGuard";
import {
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
  almacenamiento → pedir confirmación si algo ya tenía otro valor → subir el
  logo → escribir en una transacción → volver a leer y confirmar.
*/

export const ApplyCompanyStorageSchema = z.object({
  storage: StorageSchema,
  database: CompanyDatabaseSchema,
  logo: LogoImageSchema.optional(),
  confirmed: z.boolean().default(false),
}).strict();

export const CheckDatabaseSchema = z.object({ database: CompanyDatabaseSchema }).strict();

export type ApplyCompanyStorageInput = z.infer<typeof ApplyCompanyStorageSchema>;

export type FieldChange = { field: string; label: string; before: string; after: string };

export type DatabaseCheckResult = {
  databaseName: string;
  current: {
    logoUrl: string;
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
  logoUpdated: boolean;
  logoUrl: string | null;
  fileName: string | null;
  bytes: number | null;
  previousLogoCount: number;
  changes: FieldChange[];
  keysChanged: boolean;
};

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

function summarize(current: ParametrosWebValues): DatabaseCheckResult["current"] {
  return {
    logoUrl: current.LogoEmpresa.trim(),
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
    throw databaseErrorMessage(error);
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
  const image = input.logo ? decodeCompanyLogo(input.logo.imageBase64, input.logo.imageName) : null;
  await assertStorageReachable(storage, deps.resolver ?? resolveHost);

  const { session, state } = await openAndInspect(database, openDatabase);
  const s3 = s3Factory(storage);
  try {
    let existing;
    try {
      existing = await listExistingLogos(s3, storage, database.databaseName);
    } catch (error) {
      throw storageErrorMessage(error);
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
    const replacesLogo = Boolean(image && (current.LogoEmpresa.trim() !== "" || existing.length > 0));

    if ((changes.length > 0 || keysChanged || replacesLogo) && !input.confirmed) {
      throw new CompanyLogoError(
        "Esta compañía ya tiene una configuración o un logo. Revise qué cambia y confirme.",
        409,
        {
          requiresConfirmation: true,
          changes,
          keysChanged,
          currentLogoUrl: current.LogoEmpresa.trim(),
          existingLogoCount: existing.length,
          replacesLogo,
        },
      );
    }

    let uploaded: { url: string; fileName: string } | null = null;
    if (image) {
      try {
        uploaded = await putCompanyLogo(s3, storage, database.databaseName, image);
      } catch (error) {
        throw storageErrorMessage(error);
      }
      target.LogoEmpresa = uploaded.url;
    }

    try {
      await session.write(target);
      const after = (await session.inspect()).current;
      const mismatch = (Object.keys(target) as Array<keyof StorageWrite>).some((field) => {
        const expected = target[field] ?? "";
        const actual = after[field].trim();
        return field === "MinioPort" ? !samePort(actual, expected) : actual !== expected;
      });
      if (mismatch) {
        throw new CompanyLogoError("La base de datos no confirmó los valores escritos. Revise parametros_web e intente de nuevo.", 502);
      }
    } catch (error) {
      throw databaseErrorMessage(error);
    }

    return {
      databaseName: database.databaseName,
      storageConfigured: true,
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
