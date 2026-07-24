import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import sql from "mssql";
import { runSqlTransaction } from "./sqlTransaction";

type ObjectStorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  signedUrlSeconds: number;
};

let cachedClient: { signature: string; client: S3Client } | null = null;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} no está configurado.`);
  return value;
}

function parseBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} debe ser true o false.`);
}

function readConfig(): ObjectStorageConfig | null {
  const rawEndpoint = process.env.OBJECT_STORAGE_ENDPOINT?.trim();
  const bucket = process.env.OBJECT_STORAGE_BUCKET?.trim();
  const accessKeyId = process.env.OBJECT_STORAGE_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim();
  if (!rawEndpoint && !bucket && !accessKeyId && !secretAccessKey) return null;

  const endpointUrl = new URL(required("OBJECT_STORAGE_ENDPOINT"));
  if (
    endpointUrl.protocol !== "https:" ||
    endpointUrl.username ||
    endpointUrl.password ||
    endpointUrl.search ||
    endpointUrl.hash ||
    !["", "/"].includes(endpointUrl.pathname)
  ) {
    throw new Error("OBJECT_STORAGE_ENDPOINT debe ser un endpoint HTTPS raíz sin credenciales, ruta ni query string.");
  }
  if (!/^(?!.*\.\.)(?!-)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(required("OBJECT_STORAGE_BUCKET"))) {
    throw new Error("OBJECT_STORAGE_BUCKET no es un nombre de bucket S3 válido.");
  }

  const prefix = (process.env.OBJECT_STORAGE_PREFIX?.trim() || "portal-sag/runtime")
    .replace(/^\/+|\/+$/g, "");
  if (!prefix || prefix.includes("..") || !/^[a-zA-Z0-9/_-]+$/.test(prefix)) {
    throw new Error("OBJECT_STORAGE_PREFIX no es válido.");
  }

  const signedUrlSeconds = Number(process.env.OBJECT_STORAGE_SIGNED_URL_SECONDS?.trim() || "300");
  if (!Number.isInteger(signedUrlSeconds) || signedUrlSeconds < 60 || signedUrlSeconds > 900) {
    throw new Error("OBJECT_STORAGE_SIGNED_URL_SECONDS debe estar entre 60 y 900.");
  }

  return {
    endpoint: endpointUrl.origin,
    region: process.env.OBJECT_STORAGE_REGION?.trim() || "us-east-1",
    bucket: required("OBJECT_STORAGE_BUCKET"),
    prefix,
    accessKeyId: required("OBJECT_STORAGE_ACCESS_KEY_ID"),
    secretAccessKey: required("OBJECT_STORAGE_SECRET_ACCESS_KEY"),
    forcePathStyle: parseBoolean("OBJECT_STORAGE_FORCE_PATH_STYLE", true),
    signedUrlSeconds,
  };
}

function getClient(config: ObjectStorageConfig): S3Client {
  const signature = [
    config.endpoint,
    config.region,
    config.accessKeyId,
    config.forcePathStyle ? "path" : "virtual",
  ].join("|");
  if (!cachedClient || cachedClient.signature !== signature) {
    cachedClient?.client.destroy();
    cachedClient = {
      signature,
      client: new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        forcePathStyle: config.forcePathStyle,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      }),
    };
  }
  return cachedClient.client;
}

function isPreconditionFailure(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "PreconditionFailed" || candidate.$metadata?.httpStatusCode === 412;
}

export function isObjectStorageConfigured(): boolean {
  return readConfig() !== null;
}

export async function storePrivateObject(input: {
  bytes: Buffer;
  sha256: string;
  extension: string;
  mimeType: string;
}) {
  const config = readConfig();
  if (!config) throw Object.assign(new Error("El almacenamiento S3/MinIO aún no está configurado."), { status: 503 });
  const client = getClient(config);
  const objectKey = `${config.prefix}/content/${input.sha256}${input.extension}`;
  try {
    await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
      Body: input.bytes,
      ContentLength: input.bytes.length,
      ContentType: input.mimeType,
      Metadata: { sha256: input.sha256 },
      IfNoneMatch: "*",
    }));
  } catch (error) {
    if (!isPreconditionFailure(error)) throw error;
  }

  const properties = await client.send(new HeadObjectCommand({
    Bucket: config.bucket,
    Key: objectKey,
  }));
  if (
    Number(properties.ContentLength ?? -1) !== input.bytes.length ||
    properties.Metadata?.sha256?.toLowerCase() !== input.sha256.toLowerCase()
  ) {
    throw new Error("La verificación remota del objeto no coincide con tamaño y SHA-256 esperados.");
  }
  return {
    storageProvider: "s3" as const,
    storageBucket: config.bucket,
    storageObjectKey: objectKey,
    storageObjectEtag: properties.ETag?.replace(/^"|"$/g, ""),
    storageSha256: input.sha256,
  };
}

export async function deletePrivateObjectIfUnreferenced(input: {
  bucket: string;
  objectKey: string;
}): Promise<boolean> {
  const config = readConfig();
  if (!config || config.bucket !== input.bucket) return false;
  return runSqlTransaction(async (transaction) => {
    const request = new sql.Request(transaction);
    request.input("bucket", sql.NVarChar(255), input.bucket);
    request.input("objectKey", sql.NVarChar(1024), input.objectKey);
    const result = await request.query<{ reference_count: number }>(`
      SELECT COUNT_BIG(*) AS reference_count
      FROM content.files WITH (UPDLOCK,HOLDLOCK)
      WHERE storage_provider='s3' AND storage_bucket=@bucket AND object_key=@objectKey;
    `);
    if (Number(result.recordset[0]?.reference_count ?? 0) > 0) return false;
    const client = getClient(config);
    try {
      await client.send(new HeadObjectCommand({ Bucket: input.bucket, Key: input.objectKey }));
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false;
      throw error;
    }
    await client.send(new DeleteObjectCommand({ Bucket: input.bucket, Key: input.objectKey }));
    return true;
  }, sql.ISOLATION_LEVEL.SERIALIZABLE);
}

export async function createPrivateObjectUrl(input: {
  bucket: string;
  objectKey: string;
  mimeType: string;
  filename: string;
  disposition?: "inline" | "attachment";
}): Promise<string> {
  const config = readConfig();
  if (!config || config.bucket !== input.bucket) {
    throw new Error("La ubicación privada del objeto no coincide con la configuración S3/MinIO activa.");
  }
  return getSignedUrl(
    getClient(config),
    new GetObjectCommand({
      Bucket: input.bucket,
      Key: input.objectKey,
      ResponseContentType: input.mimeType,
      ResponseContentDisposition: buildObjectContentDisposition(input.disposition ?? "attachment", input.filename),
    }),
    { expiresIn: config.signedUrlSeconds },
  );
}

export function buildObjectContentDisposition(
  disposition: "inline" | "attachment",
  filename: string,
): string {
  return `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
