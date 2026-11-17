import {
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { sanitizeSvg, UnsafeSvgError } from "./svgSanitizer";

/*
  Logo de la compañía en SAG Web.

  El almacenamiento de cada cliente es el mismo servidor S3 (storcube) con un
  bucket y llaves propios. Este módulo NO guarda nada: las llaves viven solo en
  memoria durante la solicitud y nunca se escriben en SQL, logs, auditoría ni
  respuestas JSON. El servidor, el puerto, el SSL y la ruta base son fijos (los
  mismos de GenerarSQLAlmacenamiento) para que el portal no pueda usarse como
  proxy hacia otros hosts.
*/

export const COMPANY_LOGO_STORAGE = {
  endpoint: "storcube.sagweb.co",
  port: 8333,
  useSsl: true,
  basePath: "Archivos/",
  logoFolder: "Imagenes/LogoEmpresa/",
  region: "us-east-1",
} as const;

export const COMPANY_LOGO_MAX_BYTES = 2 * 1024 * 1024;

const TIMEOUT_MS = 20_000;

export class CompanyLogoError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function trimmed(label: string, schema: z.ZodType<string, string>) {
  return z.string({ error: `${label} es obligatorio.` })
    .transform((value) => value.trim())
    .pipe(schema);
}

/* Reglas de nombres de bucket S3: 3–63, minúsculas, números, puntos y guiones. */
const bucketSchema = trimmed("El bucket", z.string()
  .min(3, "El bucket debe tener entre 3 y 63 caracteres.")
  .max(63, "El bucket debe tener entre 3 y 63 caracteres.")
  .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, "El bucket solo admite minúsculas, números, puntos y guiones, y debe empezar y terminar en letra o número.")
  .refine((value) => !value.includes(".."), "El bucket no puede tener dos puntos seguidos."));

/* El nombre de la base es la carpeta raíz de la compañía (MinioNameEnterprise). */
const databaseNameSchema = trimmed("El nombre de la base de datos", z.string()
  .min(1, "El nombre de la base de datos es obligatorio.")
  .max(128, "El nombre de la base de datos admite máximo 128 caracteres.")
  .regex(/^[A-Za-z0-9_-]+$/, "El nombre de la base de datos solo admite letras sin tildes, números, guion y guion bajo (sin espacios)."));

const accessKeySchema = trimmed("La llave de acceso (access key)", z.string()
  .min(3, "La llave de acceso (access key) es obligatoria.")
  .max(256, "La llave de acceso (access key) es demasiado larga.")
  .regex(/^[\x21-\x7E]+$/, "La llave de acceso (access key) no puede tener espacios ni caracteres especiales invisibles."));

const secretKeySchema = trimmed("La llave secreta (secret key)", z.string()
  .min(8, "La llave secreta (secret key) es obligatoria.")
  .max(256, "La llave secreta (secret key) es demasiado larga.")
  .regex(/^[\x21-\x7E]+$/, "La llave secreta (secret key) no puede tener espacios ni caracteres especiales invisibles."));

export const CompanyLogoConnectionSchema = z.object({
  bucket: bucketSchema,
  accessKey: accessKeySchema,
  secretKey: secretKeySchema,
  databaseName: databaseNameSchema,
}).strict();

export const CompanyLogoUploadSchema = CompanyLogoConnectionSchema.extend({
  imageBase64: z.string({ error: "La imagen es obligatoria." })
    .min(1, "La imagen es obligatoria.")
    .max(3_000_000, "La imagen supera 2 MB. Redúzcala e intente de nuevo."),
  imageName: trimmed("El nombre de la imagen", z.string().min(1, "El nombre de la imagen es obligatorio.").max(240)),
  replaceConfirmed: z.boolean().default(false),
}).strict();

export type CompanyLogoConnection = z.infer<typeof CompanyLogoConnectionSchema>;
export type CompanyLogoUpload = z.infer<typeof CompanyLogoUploadSchema>;

export type ExistingLogo = { name: string; bytes: number; lastModified: string | null };

export type CompanyLogoCheckResult = {
  folder: string;
  existing: ExistingLogo[];
};

export type CompanyLogoUploadResult = {
  url: string;
  fileName: string;
  bytes: number;
  replacedCount: number;
  sql: string;
  sqlFileName: string;
};

export type LogoExtension = "png" | "jpg" | "gif" | "webp" | "svg";
export type DecodedLogo = { bytes: Buffer; extension: LogoExtension; mimeType: string };

const UNSUPPORTED_IMAGE =
  "Este archivo no es una imagen que SAG Web pueda mostrar. Ábralo en un editor de imágenes, guárdelo como imagen e intente de nuevo.";

/*
  Un SVG es texto y puede traer código. No se sube el archivo original: se
  reconstruye con una lista blanca (svgSanitizer) y se sube ese resultado.
*/
const UNSAFE_SVG =
  "La imagen SVG trae código o enlaces externos y no se puede usar. Expórtela de nuevo como imagen simple e intente otra vez.";

function decodeSvg(bytes: Buffer): DecodedLogo | null {
  const decoded = bytes.toString("utf8");
  const text = decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
  // Parece SVG si empieza con el prólogo XML, un comentario, una DTD o <svg, y trae <svg.
  if (!/^\s*(?:<\?xml|<!--|<!DOCTYPE|<svg[\s>])/i.test(text) || !/<svg[\s>]/i.test(text)) return null;
  let clean: Buffer;
  try {
    clean = Buffer.from(sanitizeSvg(text), "utf8");
  } catch (error) {
    if (error instanceof UnsafeSvgError) throw new CompanyLogoError(UNSAFE_SVG, 400);
    throw new CompanyLogoError(UNSUPPORTED_IMAGE, 400);
  }
  if (clean.length > COMPANY_LOGO_MAX_BYTES) {
    throw new CompanyLogoError("La imagen supera 2 MB. Redúzcala e intente de nuevo.", 400);
  }
  return { bytes: clean, extension: "svg", mimeType: "image/svg+xml" };
}

/** Valida la imagen por su contenido (firma), no por el nombre. El SVG sale reconstruido y limpio. */
export function decodeCompanyLogo(imageBase64: string, imageName: string): DecodedLogo {
  const raw = imageBase64.includes(",") && imageBase64.startsWith("data:")
    ? imageBase64.slice(imageBase64.indexOf(",") + 1)
    : imageBase64;
  const clean = raw.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
    throw new CompanyLogoError("La imagen no llegó completa. Vuelva a seleccionarla.", 400);
  }
  if (Math.floor(clean.length * 3 / 4) > COMPANY_LOGO_MAX_BYTES + 3) {
    throw new CompanyLogoError("La imagen supera 2 MB. Redúzcala e intente de nuevo.", 400);
  }
  const bytes = Buffer.from(clean, "base64");
  if (bytes.length === 0) throw new CompanyLogoError("La imagen está vacía.", 400);
  if (bytes.length > COMPANY_LOGO_MAX_BYTES) {
    throw new CompanyLogoError("La imagen supera 2 MB. Redúzcala e intente de nuevo.", 400);
  }
  const starts = (...signature: number[]) => bytes.length > signature.length && signature.every((b, i) => bytes[i] === b);
  // El tipo sale del contenido, no del nombre: un logo .jpeg que en realidad es PNG también sirve.
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { bytes, extension: "png", mimeType: "image/png" };
  if (starts(0xff, 0xd8, 0xff)) return { bytes, extension: "jpg", mimeType: "image/jpeg" };
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") {
    return { bytes, extension: "gif", mimeType: "image/gif" };
  }
  if (bytes.length > 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return { bytes, extension: "webp", mimeType: "image/webp" };
  }
  const svg = decodeSvg(bytes);
  if (svg) return svg;
  void imageName;
  throw new CompanyLogoError(UNSUPPORTED_IMAGE, 400);
}

export function companyLogoFolder(databaseName: string): string {
  return `${databaseName}/${COMPANY_LOGO_STORAGE.basePath}${COMPANY_LOGO_STORAGE.logoFolder}`;
}

export function companyLogoBaseUrl(): string {
  const { useSsl, endpoint, port } = COMPANY_LOGO_STORAGE;
  return `${useSsl ? "https" : "http"}://${endpoint}:${port}`;
}

export function companyLogoUrl(bucket: string, objectKey: string): string {
  return `${companyLogoBaseUrl()}/${bucket}/${objectKey}`;
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

export type S3Sender = Pick<S3Client, "send" | "destroy">;

/**
 * El nginx de storcube reenvía el Host SIN el puerto; la firma SigV4 debe
 * calcularse igual o el servidor responde SignatureDoesNotMatch/403.
 * La conexión sigue yendo al puerto configurado.
 */
export function createCompanyLogoS3Client(connection: CompanyLogoConnection): S3Client {
  const client = new S3Client({
    endpoint: companyLogoBaseUrl(),
    region: COMPANY_LOGO_STORAGE.region,
    forcePathStyle: true,
    maxAttempts: 2,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId: connection.accessKey, secretAccessKey: connection.secretKey },
  });
  type Middleware = Parameters<typeof client.middlewareStack.addRelativeTo>[0];
  const hostWithoutPort = ((next: (args: unknown) => Promise<unknown>) => async (args: unknown) => {
    const request = (args as { request?: { headers?: Record<string, string>; hostname?: string } }).request;
    if (request?.headers && request.hostname) request.headers.host = request.hostname;
    return next(args);
  }) as unknown as Middleware;
  client.middlewareStack.addRelativeTo(hostWithoutPort, {
    relation: "before",
    toMiddleware: "httpSigningMiddleware",
    name: "companyLogoHostWithoutPort",
  });
  return client;
}

/** Traduce cualquier error del proveedor a un mensaje controlado: nunca se devuelve el detalle técnico. */
export function storageErrorMessage(error: unknown): CompanyLogoError {
  if (error instanceof CompanyLogoError) return error;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  const status = candidate?.$metadata?.httpStatusCode;
  const name = candidate?.name ?? "";
  if (name === "NoSuchBucket" || status === 404) {
    return new CompanyLogoError("El bucket no existe en el almacenamiento. Revise el nombre del bucket.", 400);
  }
  if (status === 403 || status === 401 || /AccessDenied|SignatureDoesNotMatch|InvalidAccessKeyId/.test(name)) {
    return new CompanyLogoError("El almacenamiento rechazó las llaves. Revise la llave de acceso, la llave secreta y que correspondan a ese bucket.", 400);
  }
  if (name === "TimeoutError" || name === "AbortError") {
    return new CompanyLogoError("El almacenamiento no respondió a tiempo. Intente de nuevo en unos minutos.", 504);
  }
  return new CompanyLogoError("No fue posible conectar con el almacenamiento. Intente de nuevo; si persiste, escale a Infraestructura.", 502);
}

async function listExisting(client: S3Sender, connection: CompanyLogoConnection): Promise<ExistingLogo[]> {
  const prefix = companyLogoFolder(connection.databaseName);
  const result = await client.send(
    new ListObjectsV2Command({ Bucket: connection.bucket, Prefix: prefix, Delimiter: "/", MaxKeys: 100 }),
    { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  return (result.Contents ?? [])
    .filter((item) => item.Key && item.Key.length > prefix.length)
    .map((item) => ({
      name: item.Key!.slice(prefix.length),
      bytes: Number(item.Size ?? 0),
      lastModified: item.LastModified ? new Date(item.LastModified).toISOString() : null,
    }))
    .sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));
}

/** Prueba la conexión (listar exige llaves válidas para ese bucket) y devuelve los logos que ya existen. */
export async function checkCompanyLogoStorage(
  connection: CompanyLogoConnection,
  clientFactory: (connection: CompanyLogoConnection) => S3Sender = createCompanyLogoS3Client,
): Promise<CompanyLogoCheckResult> {
  const client = clientFactory(connection);
  try {
    return { folder: companyLogoFolder(connection.databaseName), existing: await listExisting(client, connection) };
  } catch (error) {
    throw storageErrorMessage(error);
  } finally {
    client.destroy();
  }
}

/**
 * Sube el logo con un nombre nuevo (UUID), igual que SAG Web. Las imágenes
 * anteriores NO se borran: el logo vigente sigue funcionando hasta que se
 * ejecute el SQL nuevo en la base del cliente.
 */
export async function uploadCompanyLogo(
  input: CompanyLogoUpload,
  clientFactory: (connection: CompanyLogoConnection) => S3Sender = createCompanyLogoS3Client,
  now = new Date(),
): Promise<CompanyLogoUploadResult> {
  const image = decodeCompanyLogo(input.imageBase64, input.imageName);
  const client = clientFactory(input);
  try {
    const existing = await listExisting(client, input);
    if (existing.length > 0 && !input.replaceConfirmed) {
      throw new CompanyLogoError(
        `Esta compañía ya tiene ${existing.length === 1 ? "un logo" : `${existing.length} imágenes de logo`} en el almacenamiento. Confirme que desea reemplazarlo.`,
        409,
      );
    }
    const fileName = `${randomUUID()}.${image.extension}`;
    const objectKey = `${companyLogoFolder(input.databaseName)}${fileName}`;
    const sha256 = createHash("sha256").update(image.bytes).digest("hex");
    await client.send(new PutObjectCommand({
      Bucket: input.bucket,
      Key: objectKey,
      Body: image.bytes,
      ContentLength: image.bytes.length,
      ContentType: image.mimeType,
      Metadata: { sha256 },
    }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
    const head = await client.send(
      new HeadObjectCommand({ Bucket: input.bucket, Key: objectKey }),
      { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (Number(head.ContentLength) !== image.bytes.length) {
      throw new CompanyLogoError("El almacenamiento no confirmó la imagen completa. Intente de nuevo.", 502);
    }
    const url = companyLogoUrl(input.bucket, objectKey);
    return {
      url,
      fileName,
      bytes: image.bytes.length,
      replacedCount: existing.length,
      sql: buildCompanyLogoSql(url, now),
      sqlFileName: `logo_${input.databaseName}.sql`,
    };
  } catch (error) {
    throw storageErrorMessage(error);
  } finally {
    client.destroy();
  }
}
