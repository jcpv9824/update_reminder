import { z } from "zod";
import {
  COMPANY_STORAGE_DEFAULTS,
  CompanyLogoError,
  createCompanyStorageS3Client,
  databaseNameSchema,
  decodeCompanyLogo,
  listExistingLogos,
  putCompanyLogo,
  StorageSchema,
  storageErrorMessage,
  type CompanyStorage,
  type ExistingLogo,
  type S3Factory,
} from "./companyLogo";

/*
  COMPATIBILIDAD TEMPORAL (transición). Contrato de las rutas antiguas
  POST /implementation/company-logo/check y /upload que usa el frontend
  publicado antes de «Almacenamiento de archivos y logo». Permite publicar el
  API nuevo sin dejar sin servicio al frontend anterior, y revertir el frontend
  sin revertir el API. Solo sube el logo y devuelve el SQL (no escribe en la base
  de la compañía), igual que antes, con el servidor fijo storcube y el mismo
  transporte protegido.

  RETIRAR en el siguiente despliegue, cuando el frontend nuevo esté publicado y
  verificado en producción.
*/

const legacyConnectionShape = {
  bucket: StorageSchema.shape.bucket,
  accessKey: StorageSchema.shape.accessKey,
  secretKey: StorageSchema.shape.secretKey,
  databaseName: databaseNameSchema,
};

export const LegacyConnectionSchema = z.object(legacyConnectionShape).strict();

export const LegacyUploadSchema = z.object({
  ...legacyConnectionShape,
  imageBase64: z.string({ error: "La imagen es obligatoria." })
    .min(1, "La imagen es obligatoria.")
    .max(3_000_000, "La imagen supera 2 MB. Redúzcala e intente de nuevo."),
  imageName: z.string({ error: "El nombre de la imagen es obligatorio." }).trim().min(1).max(240),
  replaceConfirmed: z.boolean().default(false),
}).strict();

export type LegacyConnection = z.infer<typeof LegacyConnectionSchema>;
export type LegacyUpload = z.infer<typeof LegacyUploadSchema>;

function toStorage(input: LegacyConnection): CompanyStorage {
  return {
    bucket: input.bucket,
    accessKey: input.accessKey,
    secretKey: input.secretKey,
    options: { ...COMPANY_STORAGE_DEFAULTS },
  };
}

export function buildCompanyLogoSql(url: string, generatedAt = new Date()): string {
  const stamp = generatedAt.toISOString().slice(0, 16).replace("T", " ");
  return [
    `-- Logo de la compañía (generado ${stamp} UTC desde el Portal SAG Web)`,
    "-- Ejecutar en la base de datos de la compañía. Muestra el logo ANTES y DESPUÉS.",
    "SELECT 'ANTES' AS Estado, LogoEmpresa FROM parametros_web;",
    `UPDATE parametros_web SET LogoEmpresa = N'${url.replace(/'/g, "''")}';`,
    "SELECT 'DESPUES' AS Estado, LogoEmpresa FROM parametros_web;",
    "",
  ].join("\n");
}

export async function legacyCheck(
  input: LegacyConnection,
  s3Factory: S3Factory = createCompanyStorageS3Client,
): Promise<{ folder: string; existing: ExistingLogo[] }> {
  const storage = toStorage(input);
  const client = s3Factory(storage);
  try {
    return {
      folder: `${input.databaseName}/${storage.options.basePath}Imagenes/LogoEmpresa/`,
      existing: await listExistingLogos(client, storage, input.databaseName),
    };
  } catch (error) {
    throw storageErrorMessage(error);
  } finally {
    client.destroy();
  }
}

export async function legacyUpload(
  input: LegacyUpload,
  s3Factory: S3Factory = createCompanyStorageS3Client,
  now = new Date(),
) {
  const image = decodeCompanyLogo(input.imageBase64, input.imageName);
  const storage = toStorage(input);
  const client = s3Factory(storage);
  try {
    const existing = await listExistingLogos(client, storage, input.databaseName);
    if (existing.length > 0 && !input.replaceConfirmed) {
      throw new CompanyLogoError(
        `Esta compañía ya tiene ${existing.length === 1 ? "un logo" : `${existing.length} imágenes de logo`} en el almacenamiento. Confirme que desea reemplazarlo.`,
        409,
      );
    }
    const uploaded = await putCompanyLogo(client, storage, input.databaseName, image);
    return {
      url: uploaded.url,
      fileName: uploaded.fileName,
      bytes: image.bytes.length,
      replacedCount: existing.length,
      sql: buildCompanyLogoSql(uploaded.url, now),
      sqlFileName: `logo_${input.databaseName}.sql`,
    };
  } catch (error) {
    throw storageErrorMessage(error);
  } finally {
    client.destroy();
  }
}
