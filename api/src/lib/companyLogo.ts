import {
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { Agent as HttpsAgent, type AgentOptions } from "node:https";
import { z } from "zod";
import { sanitizeSvg, UnsafeSvgError } from "./svgSanitizer";
import { createGuardedLookup, hostMatchesAllowList, resolveHost, resolvesToPublicAddresses, type HostResolver } from "./outboundGuard";

/*
  Almacenamiento de archivos y logo de la compañía en SAG Web.

  El almacenamiento de cada cliente es un servidor S3 (por defecto storcube)
  con un bucket y llaves propios. Este módulo NO guarda nada: las llaves viven
  solo en memoria durante la solicitud y nunca se escriben en logs, auditoría
  ni respuestas JSON del portal. Solo se escriben en parametros_web de la
  compañía, que es donde SAG Web las necesita.
*/

/**
 * Valores por defecto (los mismos de GenerarSQLAlmacenamiento). Se pueden cambiar en
 * «parámetros adicionales», salvo el cifrado: la conexión es SIEMPRE HTTPS.
 */
export const COMPANY_STORAGE_DEFAULTS = {
  endpoint: "storcube.sagweb.co",
  port: 8333,
  basePath: "Archivos/",
  region: "us-east-1",
} as const;

export const COMPANY_LOGO_FOLDER = "Imagenes/LogoEmpresa/";
export const COMPANY_LOGO_MAX_BYTES = 2 * 1024 * 1024;

const TIMEOUT_MS = 20_000;

export class CompanyLogoError extends Error {
  constructor(message: string, readonly status: number, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

/** Quita espacios de los extremos y exige el campo; luego aplica la regla propia. */
export function trimmed(label: string, schema: z.ZodType<string, string>) {
  return z.string({ error: `${label} es obligatorio.` })
    .transform((value) => value.trim())
    .pipe(schema);
}

function noSpaces(label: string, max: number, min = 1) {
  return z.string()
    .min(min, `${label} es obligatorio.`)
    .max(max, `${label} es demasiado largo.`)
    .regex(/^\S+$/, `${label} no puede tener espacios.`);
}

/* Reglas de nombres de bucket S3: 3–63, minúsculas, números, puntos y guiones. */
const bucketSchema = trimmed("El bucket", noSpaces("El bucket", 63)
  .min(3, "El bucket debe tener entre 3 y 63 caracteres.")
  .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, "El bucket solo admite minúsculas, números, puntos y guiones, y debe empezar y terminar en letra o número.")
  .refine((value) => !value.includes(".."), "El bucket no puede tener dos puntos seguidos."));

const accessKeySchema = trimmed("El access key", noSpaces("El access key", 256, 3)
  .regex(/^[\x21-\x7E]+$/, "El access key no puede tener caracteres especiales invisibles."));

const secretKeySchema = trimmed("El secret key", noSpaces("El secret key", 256)
  .min(8, "El secret key parece incompleto. Cópielo de nuevo.")
  .regex(/^[\x21-\x7E]+$/, "El secret key no puede tener caracteres especiales invisibles."));

/* El nombre de la base es también la carpeta raíz de la compañía (MinioNameEnterprise). */
export const databaseNameSchema = trimmed("El nombre de la base de datos", noSpaces("El nombre de la base de datos", 128)
  .regex(/^[A-Za-z0-9_-]+$/, "El nombre de la base de datos solo admite letras sin tildes, números, guion y guion bajo."));

/**
 * Servidores de almacenamiento aprobados. Se configuran en el API con
 * COMPANY_STORAGE_ALLOWED_HOSTS (lista separada por comas; admite «*.dominio»).
 */
export const DEFAULT_STORAGE_ALLOWED_HOSTS = "storcube.sagweb.co,*.sagweb.co";

export function storageAllowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.COMPANY_STORAGE_ALLOWED_HOSTS?.trim() || DEFAULT_STORAGE_ALLOWED_HOSTS)
    .split(",").map((item) => item.trim()).filter(Boolean);
}

const endpointSchema = trimmed("El servidor del almacenamiento", noSpaces("El servidor del almacenamiento", 253)
  .regex(/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/, "Escriba solo el nombre del servidor del almacenamiento, sin https:// ni barras (ej.: storcube.sagweb.co).")
  .refine((value) => hostMatchesAllowList(value, storageAllowedHosts()), {
    error: () => `Ese servidor del almacenamiento no está aprobado. Servidores aprobados: ${storageAllowedHosts().join(", ")}.`,
  }));

const basePathSchema = trimmed("La ruta base", noSpaces("La ruta base", 120)
  .regex(/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\/$/, "La ruta base solo admite letras, números, guion y guion bajo, separados por / y terminada en / (ej.: Archivos/)."));

const regionSchema = trimmed("La región", noSpaces("La región", 32)
  .regex(/^[a-z0-9-]+$/, "La región solo admite minúsculas, números y guiones (ej.: us-east-1)."));

export const StorageOptionsSchema = z.object({
  endpoint: endpointSchema.default(COMPANY_STORAGE_DEFAULTS.endpoint),
  port: z.number({ error: "El puerto del almacenamiento debe ser un número." })
    .int("El puerto del almacenamiento debe ser un número entero.")
    .min(1, "El puerto del almacenamiento debe estar entre 1 y 65535.")
    .max(65535, "El puerto del almacenamiento debe estar entre 1 y 65535.")
    .default(COMPANY_STORAGE_DEFAULTS.port),
  basePath: basePathSchema.default(COMPANY_STORAGE_DEFAULTS.basePath),
  region: regionSchema.default(COMPANY_STORAGE_DEFAULTS.region),
}).strict();

export const StorageSchema = z.object({
  bucket: bucketSchema,
  accessKey: accessKeySchema,
  secretKey: secretKeySchema,
  options: StorageOptionsSchema.default({
    endpoint: COMPANY_STORAGE_DEFAULTS.endpoint,
    port: COMPANY_STORAGE_DEFAULTS.port,
    basePath: COMPANY_STORAGE_DEFAULTS.basePath,
    region: COMPANY_STORAGE_DEFAULTS.region,
  }),
}).strict();

export type CompanyStorage = z.infer<typeof StorageSchema>;
export type StorageOptions = z.infer<typeof StorageOptionsSchema>;

export const LogoImageSchema = z.object({
  imageBase64: z.string({ error: "La imagen es obligatoria." })
    .min(1, "La imagen es obligatoria.")
    .max(3_000_000, "La imagen supera 2 MB. Redúzcala e intente de nuevo."),
  imageName: trimmed("El nombre de la imagen", z.string().min(1, "El nombre de la imagen es obligatorio.").max(240)),
}).strict();

export type ExistingLogo = { name: string; bytes: number; lastModified: string | null };

export type StorageCheckResult = {
  folder: string | null;
  existing: ExistingLogo[];
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

export function companyLogoFolder(databaseName: string, options: StorageOptions): string {
  return `${databaseName}/${options.basePath}${COMPANY_LOGO_FOLDER}`;
}

export function storageBaseUrl(options: StorageOptions): string {
  return `https://${options.endpoint}:${options.port}`;
}

export function companyLogoUrl(storage: CompanyStorage, objectKey: string): string {
  return `${storageBaseUrl(storage.options)}/${storage.bucket}/${objectKey}`;
}

export type S3Sender = Pick<S3Client, "send" | "destroy">;
export type S3Factory = (storage: CompanyStorage) => S3Sender;

/**
 * El nginx de storcube reenvía el Host SIN el puerto; la firma SigV4 debe
 * calcularse igual o el servidor responde SignatureDoesNotMatch/403.
 * La conexión sigue yendo al puerto configurado.
 */
export function createCompanyStorageS3Client(storage: CompanyStorage): S3Client {
  const client = new S3Client({
    endpoint: storageBaseUrl(storage.options),
    region: storage.options.region,
    forcePathStyle: true,
    maxAttempts: 2,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId: storage.accessKey, secretAccessKey: storage.secretKey },
    // El transporte HTTPS se conecta SOLO a direcciones públicas validadas al conectar;
    // el certificado se valida con el nombre original del servidor.
    requestHandler: {
      httpsAgent: new HttpsAgent({ keepAlive: false, lookup: createGuardedLookup() as unknown as AgentOptions["lookup"] }),
      connectionTimeout: TIMEOUT_MS,
      requestTimeout: TIMEOUT_MS,
    },
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
  const candidate = error as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  const status = candidate?.$metadata?.httpStatusCode;
  const name = candidate?.name ?? "";
  if (name === "NoSuchBucket" || status === 404) {
    return new CompanyLogoError("El bucket no existe en el almacenamiento. Revise el nombre del bucket.", 400);
  }
  if (status === 403 || status === 401 || /AccessDenied|SignatureDoesNotMatch|InvalidAccessKeyId/.test(name)) {
    return new CompanyLogoError("El almacenamiento rechazó las llaves. Revise el access key, el secret key y que correspondan a ese bucket.", 400);
  }
  if (name === "TimeoutError" || name === "AbortError") {
    return new CompanyLogoError("El almacenamiento no respondió a tiempo. Revise el servidor y el puerto en los parámetros adicionales, o intente de nuevo.", 504);
  }
  if (candidate?.code === "EINTERNALDESTINATION" || /internal or invalid address/i.test(String((error as { message?: string })?.message ?? ""))) {
    return new CompanyLogoError("No fue posible usar ese servidor del almacenamiento: no existe o apunta a una red interna. Revise el servidor en los parámetros adicionales.", 400);
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EPROTO/.test(`${name} ${candidate?.code ?? ""}`)) {
    return new CompanyLogoError("No fue posible llegar al servidor del almacenamiento. Revise el servidor, el puerto y el SSL en los parámetros adicionales.", 502);
  }
  return new CompanyLogoError("No fue posible conectar con el almacenamiento. Intente de nuevo; si persiste, escale a Infraestructura.", 502);
}

export async function listExistingLogos(client: S3Sender, storage: CompanyStorage, databaseName: string): Promise<ExistingLogo[]> {
  const prefix = companyLogoFolder(databaseName, storage.options);
  const result = await client.send(
    new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: prefix, Delimiter: "/", MaxKeys: 100 }),
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

/** El servidor del almacenamiento debe resolver solo a direcciones públicas (no a la red interna). */
export async function assertStorageReachable(storage: CompanyStorage, resolver: HostResolver = resolveHost): Promise<void> {
  if (!(await resolvesToPublicAddresses(storage.options.endpoint, resolver))) {
    throw new CompanyLogoError("No fue posible usar ese servidor del almacenamiento: no existe o apunta a una red interna. Revise el servidor en los parámetros adicionales.", 400);
  }
}

/**
 * Prueba el almacenamiento (listar exige llaves válidas para ese bucket).
 * Con el nombre de la base, devuelve además los logos que ya existen.
 */
export async function checkCompanyStorage(
  storage: CompanyStorage,
  databaseName: string | null,
  clientFactory: S3Factory = createCompanyStorageS3Client,
  resolver: HostResolver = resolveHost,
): Promise<StorageCheckResult> {
  await assertStorageReachable(storage, resolver);
  const client = clientFactory(storage);
  try {
    if (!databaseName) {
      await client.send(
        new ListObjectsV2Command({ Bucket: storage.bucket, MaxKeys: 1 }),
        { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      return { folder: null, existing: [] };
    }
    return {
      folder: companyLogoFolder(databaseName, storage.options),
      existing: await listExistingLogos(client, storage, databaseName),
    };
  } catch (error) {
    throw storageErrorMessage(error);
  } finally {
    client.destroy();
  }
}

/**
 * Sube el logo con un nombre nuevo (UUID), igual que SAG Web, y confirma su
 * tamaño. Las imágenes anteriores NO se borran.
 */
export async function putCompanyLogo(
  client: S3Sender,
  storage: CompanyStorage,
  databaseName: string,
  image: DecodedLogo,
): Promise<{ url: string; fileName: string }> {
  const fileName = `${randomUUID()}.${image.extension}`;
  const objectKey = `${companyLogoFolder(databaseName, storage.options)}${fileName}`;
  const sha256 = createHash("sha256").update(image.bytes).digest("hex");
  await client.send(new PutObjectCommand({
    Bucket: storage.bucket,
    Key: objectKey,
    Body: image.bytes,
    ContentLength: image.bytes.length,
    ContentType: image.mimeType,
    Metadata: { sha256 },
  }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
  const head = await client.send(
    new HeadObjectCommand({ Bucket: storage.bucket, Key: objectKey }),
    { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  if (Number(head.ContentLength) !== image.bytes.length) {
    throw new CompanyLogoError("El almacenamiento no confirmó la imagen completa. Intente de nuevo.", 502);
  }
  return { url: companyLogoUrl(storage, objectKey), fileName };
}
