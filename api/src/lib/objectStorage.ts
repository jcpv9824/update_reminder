import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DefaultAzureCredential } from "@azure/identity";
import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  type UserDelegationKey,
} from "@azure/storage-blob";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import sql from "mssql";
import { getSqlPool } from "./sql";
import { runSqlTransaction } from "./sqlTransaction";

export type ObjectStorageProvider = "s3" | "azure_blob";

export type PrivateObjectLocator =
  | {
      storageProvider: "s3";
      storageBucket: string;
      storageObjectKey: string;
      storageObjectEtag?: string;
    }
  | {
      storageProvider: "azure_blob";
      storageContainer: string;
      storageBlobName: string;
      storageBlobEtag?: string;
    };

export type StoredPrivateObject = PrivateObjectLocator & {
  storageSha256: string;
};

type RegistrationReservation = {
  token: string;
  expiresAt: number;
};

const registrationReservations = new Map<string, RegistrationReservation>();

function locatorKey(input: PrivateObjectLocator): string {
  return input.storageProvider === "s3"
    ? `s3\0${input.storageBucket}\0${input.storageObjectKey}`
    : `azure_blob\0${input.storageContainer}\0${input.storageBlobName}`;
}

export function getPrivateObjectRegistrationToken(
  input: PrivateObjectLocator,
): string | undefined {
  const key = locatorKey(input);
  const reservation = registrationReservations.get(key);
  if (!reservation) return undefined;
  if (reservation.expiresAt <= Date.now()) {
    registrationReservations.delete(key);
    return undefined;
  }
  return reservation.token;
}

export type PrivateObjectUpload = {
  locator: PrivateObjectLocator;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
};

export type PrivateObjectStat = {
  byteCount: number;
  mimeType: string | null;
  etag?: string;
};

function quotedEtag(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/^"|"$/g, "");
  return normalized ? `"${normalized}"` : undefined;
}

type SharedConfig = {
  prefix: string;
  signedUrlSeconds: number;
};

type S3Config = SharedConfig & {
  provider: "s3";
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

type AzureBlobConfig = SharedConfig & {
  provider: "azure_blob";
  accountName: string;
  accountUrl: string;
  containerName: string;
};

const S3_SETTING_NAMES = [
  "OBJECT_STORAGE_ENDPOINT",
  "OBJECT_STORAGE_REGION",
  "OBJECT_STORAGE_BUCKET",
  "OBJECT_STORAGE_FORCE_PATH_STYLE",
  "OBJECT_STORAGE_ACCESS_KEY_ID",
  "OBJECT_STORAGE_SECRET_ACCESS_KEY",
] as const;

const AZURE_SETTING_NAMES = [
  "AZURE_BLOB_STORAGE_ACCOUNT_URL",
  "AZURE_BLOB_STORAGE_CONTAINER",
  "PUBLIC_DOWNLOADS_STORAGE_ACCOUNT_URL",
  "PUBLIC_DOWNLOADS_STORAGE_CONTAINER",
] as const;

let cachedS3Client: { signature: string; client: S3Client } | null = null;
let cachedAzureService: { accountUrl: string; client: BlobServiceClient } | null = null;
let cachedDelegation: { accountUrl: string; key: UserDelegationKey; expiresAt: Date } | null = null;

function configured(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function required(name: string): string {
  const value = configured(name);
  if (!value) throw new Error(`${name} no está configurado.`);
  return value;
}

function hasAny(names: readonly string[]): boolean {
  return names.some((name) => configured(name) !== undefined);
}

function azureSetting(primaryName: string, legacyName: string): string | undefined {
  const primary = configured(primaryName);
  const legacy = configured(legacyName);
  if (primary && legacy && primary !== legacy) {
    throw new Error(`${primaryName} y ${legacyName} no pueden tener valores diferentes.`);
  }
  return primary ?? legacy;
}

function parseBoolean(name: string, fallback: boolean): boolean {
  const value = configured(name)?.toLowerCase();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} debe ser true o false.`);
}

function readSharedConfig(): SharedConfig {
  const prefix = (configured("OBJECT_STORAGE_PREFIX") || "portal-sag/runtime")
    .replace(/^\/+|\/+$/g, "");
  if (!prefix || prefix.includes("..") || !/^[a-zA-Z0-9/_-]+$/.test(prefix)) {
    throw new Error("OBJECT_STORAGE_PREFIX no es válido.");
  }

  const signedUrlSeconds = Number(configured("OBJECT_STORAGE_SIGNED_URL_SECONDS") || "300");
  if (!Number.isInteger(signedUrlSeconds) || signedUrlSeconds < 60 || signedUrlSeconds > 900) {
    throw new Error("OBJECT_STORAGE_SIGNED_URL_SECONDS debe estar entre 60 y 900.");
  }
  return { prefix, signedUrlSeconds };
}

function readWriteProvider(): ObjectStorageProvider | null {
  const raw = configured("OBJECT_STORAGE_PROVIDER")?.toLowerCase();
  if (!raw) {
    if (
      hasAny(S3_SETTING_NAMES) ||
      hasAny(AZURE_SETTING_NAMES) ||
      configured("OBJECT_STORAGE_PREFIX") ||
      configured("OBJECT_STORAGE_SIGNED_URL_SECONDS")
    ) {
      throw new Error("OBJECT_STORAGE_PROVIDER debe seleccionar explícitamente s3 o azure_blob.");
    }
    return null;
  }
  if (raw !== "s3" && raw !== "azure_blob") {
    throw new Error("OBJECT_STORAGE_PROVIDER debe ser s3 o azure_blob.");
  }
  return raw;
}

function readS3Config(requiredForOperation = false): S3Config | null {
  if (!hasAny(S3_SETTING_NAMES)) {
    if (requiredForOperation) {
      throw Object.assign(new Error("El almacenamiento S3/MinIO no está configurado."), { status: 503 });
    }
    return null;
  }

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
  const bucket = required("OBJECT_STORAGE_BUCKET");
  if (!/^(?!.*\.\.)(?!-)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error("OBJECT_STORAGE_BUCKET no es un nombre de bucket S3 válido.");
  }

  return {
    provider: "s3",
    ...readSharedConfig(),
    endpoint: endpointUrl.origin,
    region: configured("OBJECT_STORAGE_REGION") || "us-east-1",
    bucket,
    accessKeyId: required("OBJECT_STORAGE_ACCESS_KEY_ID"),
    secretAccessKey: required("OBJECT_STORAGE_SECRET_ACCESS_KEY"),
    forcePathStyle: parseBoolean("OBJECT_STORAGE_FORCE_PATH_STYLE", true),
  };
}

function readAzureBlobConfig(requiredForOperation = false): AzureBlobConfig | null {
  if (!hasAny(AZURE_SETTING_NAMES)) {
    if (requiredForOperation) {
      throw Object.assign(new Error("Azure Blob Storage no está configurado."), { status: 503 });
    }
    return null;
  }

  const accountUrlValue = azureSetting(
    "AZURE_BLOB_STORAGE_ACCOUNT_URL",
    "PUBLIC_DOWNLOADS_STORAGE_ACCOUNT_URL",
  );
  if (!accountUrlValue) throw new Error("AZURE_BLOB_STORAGE_ACCOUNT_URL no está configurado.");
  const accountUrl = accountUrlValue.replace(/\/+$/, "");
  const match = /^https:\/\/([a-z0-9]{3,24})\.blob\.core\.windows\.net$/i.exec(accountUrl);
  if (!match) {
    throw new Error("AZURE_BLOB_STORAGE_ACCOUNT_URL debe ser un endpoint HTTPS válido de Azure Blob Storage.");
  }
  const containerName = azureSetting(
    "AZURE_BLOB_STORAGE_CONTAINER",
    "PUBLIC_DOWNLOADS_STORAGE_CONTAINER",
  );
  if (!containerName) throw new Error("AZURE_BLOB_STORAGE_CONTAINER no está configurado.");
  if (!/^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(containerName)) {
    throw new Error("AZURE_BLOB_STORAGE_CONTAINER no es un nombre de container válido.");
  }

  return {
    provider: "azure_blob",
    ...readSharedConfig(),
    accountName: match[1].toLowerCase(),
    accountUrl,
    containerName,
  };
}

function getWriteConfig(): S3Config | AzureBlobConfig | null {
  const provider = readWriteProvider();
  if (!provider) return null;
  return provider === "s3"
    ? readS3Config(true)
    : readAzureBlobConfig(true);
}

function getS3Client(config: S3Config): S3Client {
  const signature = [
    config.endpoint,
    config.region,
    config.accessKeyId,
    config.forcePathStyle ? "path" : "virtual",
  ].join("|");
  if (!cachedS3Client || cachedS3Client.signature !== signature) {
    cachedS3Client?.client.destroy();
    cachedS3Client = {
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
  return cachedS3Client.client;
}

function getAzureService(config: AzureBlobConfig): BlobServiceClient {
  if (!cachedAzureService || cachedAzureService.accountUrl !== config.accountUrl) {
    cachedAzureService = {
      accountUrl: config.accountUrl,
      client: new BlobServiceClient(config.accountUrl, new DefaultAzureCredential()),
    };
    cachedDelegation = null;
  }
  return cachedAzureService.client;
}

function isS3PreconditionFailure(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "PreconditionFailed" || candidate.$metadata?.httpStatusCode === 412;
}

function isAzureConflict(error: unknown): boolean {
  return (error as { statusCode?: number }).statusCode === 409;
}

export function isObjectStorageConfigured(): boolean {
  return getWriteConfig() !== null;
}

export function getObjectStorageProvider(): ObjectStorageProvider | null {
  return readWriteProvider();
}

function validateGuideUploadInput(input: {
  objectId: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
}): void {
  if (!/^[a-zA-Z0-9_-]{8,150}$/.test(input.objectId)) {
    throw Object.assign(new Error("El identificador de carga no es válido."), { status: 400 });
  }
  if (!/^\.[a-z0-9]{2,8}$/.test(input.extension)) {
    throw Object.assign(new Error("La extensión de carga no es válida."), { status: 400 });
  }
  if (!/^[a-z0-9][a-z0-9.+-]+\/[a-z0-9][a-z0-9.+-]+$/i.test(input.mimeType)) {
    throw Object.assign(new Error("El tipo de contenido de carga no es válido."), { status: 400 });
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw Object.assign(new Error("El tamaño declarado de carga no es válido."), { status: 400 });
  }
}

export async function createPrivateObjectUpload(input: {
  objectId: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
}): Promise<PrivateObjectUpload> {
  validateGuideUploadInput(input);
  const config = getWriteConfig();
  if (!config) {
    throw Object.assign(new Error("El almacenamiento privado de archivos aún no está configurado."), { status: 503 });
  }
  const objectName = `${config.prefix}/guides/uploads/${input.objectId}${input.extension}`;
  const expiresAt = new Date(Date.now() + config.signedUrlSeconds * 1000);
  if (config.provider === "s3") {
    const command = new PutObjectCommand({
      Bucket: config.bucket,
      Key: objectName,
      ContentType: input.mimeType,
      ContentLength: input.sizeBytes,
      Metadata: { "declared-size": String(input.sizeBytes) },
    });
    return {
      locator: {
        storageProvider: "s3",
        storageBucket: config.bucket,
        storageObjectKey: objectName,
      },
      url: await getSignedUrl(getS3Client(config), command, { expiresIn: config.signedUrlSeconds }),
      method: "PUT",
      headers: {
        "Content-Type": input.mimeType,
        "x-amz-meta-declared-size": String(input.sizeBytes),
      },
      expiresAt: expiresAt.toISOString(),
    };
  }

  const sas = generateBlobSASQueryParameters({
    containerName: config.containerName,
    blobName: objectName,
    permissions: BlobSASPermissions.parse("cw"),
    startsOn: new Date(Date.now() - 60_000),
    expiresOn: expiresAt,
  }, await getDelegationKey(config), config.accountName).toString();
  const blobUrl = getAzureService(config)
    .getContainerClient(config.containerName)
    .getBlockBlobClient(objectName)
    .url;
  return {
    locator: {
      storageProvider: "azure_blob",
      storageContainer: config.containerName,
      storageBlobName: objectName,
    },
    url: `${blobUrl}?${sas}`,
    method: "PUT",
    headers: {
      "Content-Type": input.mimeType,
      "x-ms-blob-type": "BlockBlob",
      "x-ms-meta-declaredsize": String(input.sizeBytes),
    },
    expiresAt: expiresAt.toISOString(),
  };
}

async function storeS3Object(
  config: S3Config,
  input: { bytes: Buffer; sha256: string; extension: string; mimeType: string },
): Promise<StoredPrivateObject> {
  const client = getS3Client(config);
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
    if (!isS3PreconditionFailure(error)) throw error;
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
    storageProvider: "s3",
    storageBucket: config.bucket,
    storageObjectKey: objectKey,
    storageObjectEtag: properties.ETag?.replace(/^"|"$/g, ""),
    storageSha256: input.sha256,
  };
}

async function storeAzureBlob(
  config: AzureBlobConfig,
  input: { bytes: Buffer; sha256: string; extension: string; mimeType: string },
): Promise<StoredPrivateObject> {
  const container = getAzureService(config).getContainerClient(config.containerName);
  const blobName = `${config.prefix}/content/${input.sha256}${input.extension}`;
  const blob = container.getBlockBlobClient(blobName);
  try {
    await blob.uploadData(input.bytes, {
      conditions: { ifNoneMatch: "*" },
      blobHTTPHeaders: { blobContentType: input.mimeType },
      metadata: { sha256: input.sha256 },
    });
  } catch (error) {
    if (!isAzureConflict(error)) throw error;
  }

  const properties = await blob.getProperties();
  if (
    Number(properties.contentLength ?? -1) !== input.bytes.length ||
    properties.metadata?.sha256?.toLowerCase() !== input.sha256.toLowerCase()
  ) {
    throw new Error("La verificación remota del blob no coincide con tamaño y SHA-256 esperados.");
  }
  return {
    storageProvider: "azure_blob",
    storageContainer: config.containerName,
    storageBlobName: blobName,
    storageBlobEtag: properties.etag,
    storageSha256: input.sha256,
  };
}

export async function storePrivateObject(input: {
  bytes: Buffer;
  sha256: string;
  extension: string;
  mimeType: string;
}): Promise<StoredPrivateObject> {
  const config = getWriteConfig();
  if (!config) {
    throw Object.assign(new Error("El almacenamiento privado de archivos aún no está configurado."), { status: 503 });
  }
  const locator: PrivateObjectLocator = config.provider === "s3"
    ? {
        storageProvider: "s3",
        storageBucket: config.bucket,
        storageObjectKey: `${config.prefix}/content/${input.sha256}${input.extension}`,
      }
    : {
        storageProvider: "azure_blob",
        storageContainer: config.containerName,
        storageBlobName: `${config.prefix}/content/${input.sha256}${input.extension}`,
      };
  const registrationToken = await tryReserveObjectRegistration(locator);
  try {
    const stored = config.provider === "s3"
      ? await storeS3Object(config, input)
      : await storeAzureBlob(config, input);
    if (registrationToken) {
      registrationReservations.set(locatorKey(stored), {
        token: registrationToken,
        expiresAt: Date.now() + 30 * 60_000,
      });
    }
    return stored;
  } catch (error) {
    if (registrationToken) await releaseObjectDeletionClaim(locator, registrationToken);
    throw error;
  }
}

export async function statPrivateObject(input: PrivateObjectLocator): Promise<PrivateObjectStat> {
  if (input.storageProvider === "s3") {
    const config = readS3Config(true)!;
    if (config.bucket !== input.storageBucket) {
      throw new Error("La ubicación privada del objeto no coincide con la configuración S3/MinIO activa.");
    }
    const properties = await getS3Client(config).send(new HeadObjectCommand({
      Bucket: input.storageBucket,
      Key: input.storageObjectKey,
    }));
    return {
      byteCount: Number(properties.ContentLength ?? -1),
      mimeType: properties.ContentType ?? null,
      etag: properties.ETag?.replace(/^"|"$/g, ""),
    };
  }
  const config = readAzureBlobConfig(true)!;
  if (config.containerName !== input.storageContainer) {
    throw new Error("La ubicación privada del blob no coincide con la configuración Azure activa.");
  }
  const properties = await getAzureService(config)
    .getContainerClient(input.storageContainer)
    .getBlobClient(input.storageBlobName)
    .getProperties();
  return {
    byteCount: Number(properties.contentLength ?? -1),
    mimeType: properties.contentType ?? null,
    etag: properties.etag,
  };
}

export async function downloadPrivateObjectToFile(
  input: PrivateObjectLocator,
  destinationPath: string,
  maximumBytes: number,
): Promise<PrivateObjectStat> {
  const properties = await statPrivateObject(input);
  if (properties.byteCount < 0 || properties.byteCount > maximumBytes) {
    throw Object.assign(new Error("El objeto privado supera el límite permitido."), { status: 413 });
  }
  if (input.storageProvider === "s3") {
    const config = readS3Config(true)!;
    const response = await getS3Client(config).send(new GetObjectCommand({
      Bucket: input.storageBucket,
      Key: input.storageObjectKey,
      IfMatch: quotedEtag(input.storageObjectEtag),
    }));
    if (!response.Body) throw new Error("El objeto privado no tiene contenido.");
    await pipeline(Readable.from(response.Body as AsyncIterable<Uint8Array>), createWriteStream(destinationPath, { flags: "wx" }));
    return properties;
  }
  const config = readAzureBlobConfig(true)!;
  await getAzureService(config)
    .getContainerClient(input.storageContainer)
    .getBlobClient(input.storageBlobName)
    .downloadToFile(destinationPath, 0, undefined, {
      conditions: input.storageBlobEtag ? { ifMatch: input.storageBlobEtag } : undefined,
    });
  return properties;
}

async function tryClaimUnreferencedObject(input: PrivateObjectLocator): Promise<string | null> {
  const capability = await (await getSqlPool()).request().query<{ supported: boolean }>(`
    SELECT CONVERT(bit,CASE WHEN OBJECT_ID(N'content.object_deletion_claims',N'U') IS NOT NULL
      THEN 1 ELSE 0 END) AS supported;
  `);
  if (!capability.recordset[0]?.supported) return null;
  const claimedBy = `object-cleanup:${randomUUID()}`;
  return runSqlTransaction(async (transaction) => {
    const request = new sql.Request(transaction);
    request.input("provider", sql.VarChar(30), input.storageProvider);
    request.input("container", sql.NVarChar(100), input.storageProvider === "azure_blob" ? input.storageContainer : null);
    request.input("blobName", sql.NVarChar(1024), input.storageProvider === "azure_blob" ? input.storageBlobName : null);
    request.input("bucket", sql.NVarChar(255), input.storageProvider === "s3" ? input.storageBucket : null);
    request.input("objectKey", sql.NVarChar(1024), input.storageProvider === "s3" ? input.storageObjectKey : null);
    request.input("claimedBy", sql.NVarChar(150), claimedBy);
    const result = await request.query<{ claimed: boolean }>(`
      DELETE content.object_deletion_claims
      WHERE claimed_at<DATEADD(minute,-30,SYSUTCDATETIME())
        AND
        (
          (@provider='s3' AND storage_provider='s3'
            AND storage_bucket=@bucket AND object_key=@objectKey)
          OR
          (@provider='azure_blob' AND storage_provider='azure_blob'
            AND storage_container=@container AND blob_name=@blobName)
        );
      IF EXISTS
      (
        SELECT 1 FROM content.files WITH (UPDLOCK,HOLDLOCK)
        WHERE
          (@provider='s3' AND storage_provider='s3'
            AND storage_bucket=@bucket AND object_key=@objectKey)
          OR
          (@provider='azure_blob' AND storage_provider='azure_blob'
            AND storage_container=@container AND blob_name=@blobName)
      )
      BEGIN
        SELECT CONVERT(bit,0) AS claimed;
        RETURN;
      END;
      IF EXISTS
      (
        SELECT 1 FROM content.object_deletion_claims WITH (UPDLOCK,HOLDLOCK)
        WHERE
          (@provider='s3' AND storage_provider='s3'
            AND storage_bucket=@bucket AND object_key=@objectKey)
          OR
          (@provider='azure_blob' AND storage_provider='azure_blob'
            AND storage_container=@container AND blob_name=@blobName)
      )
      BEGIN
        SELECT CONVERT(bit,0) AS claimed;
        RETURN;
      END;
      INSERT content.object_deletion_claims
        (storage_provider,storage_container,blob_name,storage_bucket,object_key,claimed_by)
      VALUES(@provider,@container,@blobName,@bucket,@objectKey,@claimedBy);
      SELECT CONVERT(bit,1) AS claimed;
    `);
    return result.recordset[0]?.claimed ? claimedBy : null;
  });
}

async function tryReserveObjectRegistration(input: PrivateObjectLocator): Promise<string | null> {
  const capability = await (await getSqlPool()).request().query<{ supported: boolean }>(`
    SELECT CONVERT(bit,CASE WHEN OBJECT_ID(N'content.object_deletion_claims',N'U') IS NOT NULL
      THEN 1 ELSE 0 END) AS supported;
  `);
  if (!capability.recordset[0]?.supported) return null;
  const token = `object-registration:${randomUUID()}`;
  try {
    return await runSqlTransaction(async (transaction) => {
      const request = new sql.Request(transaction);
      request.input("provider", sql.VarChar(30), input.storageProvider);
      request.input("container", sql.NVarChar(100), input.storageProvider === "azure_blob" ? input.storageContainer : null);
      request.input("blobName", sql.NVarChar(1024), input.storageProvider === "azure_blob" ? input.storageBlobName : null);
      request.input("bucket", sql.NVarChar(255), input.storageProvider === "s3" ? input.storageBucket : null);
      request.input("objectKey", sql.NVarChar(1024), input.storageProvider === "s3" ? input.storageObjectKey : null);
      request.input("token", sql.NVarChar(150), token);
      const result = await request.query<{ reserved: boolean }>(`
        DELETE content.object_deletion_claims
        WHERE claimed_at<DATEADD(minute,-30,SYSUTCDATETIME())
          AND ((@provider='s3' AND storage_provider='s3'
              AND storage_bucket=@bucket AND object_key=@objectKey)
            OR (@provider='azure_blob' AND storage_provider='azure_blob'
              AND storage_container=@container AND blob_name=@blobName));
        IF EXISTS
        (
          SELECT 1 FROM content.files WITH (UPDLOCK,HOLDLOCK)
          WHERE (@provider='s3' AND storage_provider='s3'
              AND storage_bucket=@bucket AND object_key=@objectKey)
            OR (@provider='azure_blob' AND storage_provider='azure_blob'
              AND storage_container=@container AND blob_name=@blobName)
        )
        BEGIN
          SELECT CONVERT(bit,0) AS reserved;
          RETURN;
        END;
        IF EXISTS
        (
          SELECT 1 FROM content.object_deletion_claims WITH (UPDLOCK,HOLDLOCK)
          WHERE (@provider='s3' AND storage_provider='s3'
              AND storage_bucket=@bucket AND object_key=@objectKey)
            OR (@provider='azure_blob' AND storage_provider='azure_blob'
              AND storage_container=@container AND blob_name=@blobName)
        )
          THROW 51074,N'El objeto está reservado por otra operación.',1;
        INSERT content.object_deletion_claims
          (storage_provider,storage_container,blob_name,storage_bucket,object_key,claimed_by)
        VALUES(@provider,@container,@blobName,@bucket,@objectKey,@token);
        SELECT CONVERT(bit,1) AS reserved;
      `);
      return result.recordset[0]?.reserved ? token : null;
    });
  } catch (error) {
    const candidate = error as { number?: number; originalError?: { info?: { number?: number } } };
    if ((candidate.number ?? candidate.originalError?.info?.number) === 51074) {
      throw Object.assign(new Error("El archivo idéntico está siendo procesado por otra operación."), {
        status: 409,
        code: "object_registration_busy",
      });
    }
    throw error;
  }
}

async function releaseObjectDeletionClaim(input: PrivateObjectLocator, claimedBy: string): Promise<void> {
  const request = (await getSqlPool()).request();
  request.input("provider", sql.VarChar(30), input.storageProvider);
  request.input("container", sql.NVarChar(100), input.storageProvider === "azure_blob" ? input.storageContainer : null);
  request.input("blobName", sql.NVarChar(1024), input.storageProvider === "azure_blob" ? input.storageBlobName : null);
  request.input("bucket", sql.NVarChar(255), input.storageProvider === "s3" ? input.storageBucket : null);
  request.input("objectKey", sql.NVarChar(1024), input.storageProvider === "s3" ? input.storageObjectKey : null);
  request.input("claimedBy", sql.NVarChar(150), claimedBy);
  await request.query(`
    DELETE content.object_deletion_claims
    WHERE claimed_by=@claimedBy AND storage_provider=@provider
      AND ISNULL(storage_container,N'')=ISNULL(@container,N'')
      AND ISNULL(blob_name,N'')=ISNULL(@blobName,N'')
      AND ISNULL(storage_bucket,N'')=ISNULL(@bucket,N'')
      AND ISNULL(object_key,N'')=ISNULL(@objectKey,N'');
  `);
}

async function abandonObjectRegistration(input: PrivateObjectLocator): Promise<void> {
  const key = locatorKey(input);
  const reservation = registrationReservations.get(key);
  if (!reservation) return;
  registrationReservations.delete(key);
  await releaseObjectDeletionClaim(input, reservation.token);
}

function storageStatusCode(error: unknown): number | undefined {
  const candidate = error as { statusCode?: number; $metadata?: { httpStatusCode?: number } };
  return candidate.statusCode ?? candidate.$metadata?.httpStatusCode;
}

export async function deletePrivateObjectIfUnreferenced(input: PrivateObjectLocator): Promise<boolean> {
  await abandonObjectRegistration(input);
  const claimedBy = await tryClaimUnreferencedObject(input);
  if (!claimedBy) return false;

  try {
    if (input.storageProvider === "s3") {
      const config = readS3Config(true)!;
      if (config.bucket !== input.storageBucket) return false;
      const client = getS3Client(config);
      try {
        await client.send(new HeadObjectCommand({
          Bucket: input.storageBucket,
          Key: input.storageObjectKey,
          IfMatch: quotedEtag(input.storageObjectEtag),
        }));
      } catch (error) {
        if (storageStatusCode(error) === 404) return true;
        if (storageStatusCode(error) === 412) return false;
        throw error;
      }
      try {
        await client.send(new DeleteObjectCommand({
          Bucket: input.storageBucket,
          Key: input.storageObjectKey,
          IfMatch: quotedEtag(input.storageObjectEtag),
        }));
        return true;
      } catch (error) {
        if (storageStatusCode(error) === 404) return true;
        if (storageStatusCode(error) === 412) return false;
        throw error;
      }
    }

    const config = readAzureBlobConfig(true)!;
    if (config.containerName !== input.storageContainer) return false;
    const blob = getAzureService(config)
      .getContainerClient(input.storageContainer)
      .getBlockBlobClient(input.storageBlobName);
    try {
      await blob.deleteIfExists({
        deleteSnapshots: "include",
        conditions: quotedEtag(input.storageBlobEtag)
          ? { ifMatch: quotedEtag(input.storageBlobEtag)! }
          : undefined,
      });
      return true;
    } catch (error) {
      if (storageStatusCode(error) === 404) return true;
      if (storageStatusCode(error) === 412) return false;
      throw error;
    }
  } finally {
    await releaseObjectDeletionClaim(input, claimedBy);
  }
}

async function getDelegationKey(config: AzureBlobConfig): Promise<UserDelegationKey> {
  const now = new Date();
  if (
    cachedDelegation &&
    cachedDelegation.accountUrl === config.accountUrl &&
    cachedDelegation.expiresAt.getTime() - now.getTime() > 5 * 60_000
  ) {
    return cachedDelegation.key;
  }
  const startsOn = new Date(now.getTime() - 5 * 60_000);
  const expiresAt = new Date(now.getTime() + 45 * 60_000);
  const key = await getAzureService(config).getUserDelegationKey(startsOn, expiresAt);
  cachedDelegation = { accountUrl: config.accountUrl, key, expiresAt };
  return key;
}

async function createAzureBlobUrl(
  config: AzureBlobConfig,
  input: Extract<PrivateObjectLocator, { storageProvider: "azure_blob" }> & {
    mimeType: string;
    filename: string;
    disposition?: "inline" | "attachment";
  },
): Promise<string> {
  if (config.containerName !== input.storageContainer) {
    throw new Error("La ubicación privada del blob no coincide con la configuración Azure activa.");
  }
  const now = new Date();
  const expiresOn = new Date(now.getTime() + config.signedUrlSeconds * 1000);
  const sas = generateBlobSASQueryParameters({
    containerName: input.storageContainer,
    blobName: input.storageBlobName,
    permissions: BlobSASPermissions.parse("r"),
    startsOn: new Date(now.getTime() - 60_000),
    expiresOn,
    contentType: input.mimeType,
    contentDisposition: buildObjectContentDisposition(input.disposition ?? "attachment", input.filename),
  }, await getDelegationKey(config), config.accountName).toString();
  const blobUrl = getAzureService(config)
    .getContainerClient(input.storageContainer)
    .getBlobClient(input.storageBlobName)
    .url;
  return `${blobUrl}?${sas}`;
}

export async function createPrivateObjectUrl(
  input: PrivateObjectLocator & {
    mimeType: string;
    filename: string;
    disposition?: "inline" | "attachment";
  },
): Promise<string> {
  if (input.storageProvider === "s3") {
    const config = readS3Config(true)!;
    if (config.bucket !== input.storageBucket) {
      throw new Error("La ubicación privada del objeto no coincide con la configuración S3/MinIO activa.");
    }
    return getSignedUrl(
      getS3Client(config),
      new GetObjectCommand({
        Bucket: input.storageBucket,
        Key: input.storageObjectKey,
        ResponseContentType: input.mimeType,
        ResponseContentDisposition: buildObjectContentDisposition(input.disposition ?? "attachment", input.filename),
      }),
      { expiresIn: config.signedUrlSeconds },
    );
  }
  return createAzureBlobUrl(readAzureBlobConfig(true)!, input);
}

export function buildObjectContentDisposition(
  disposition: "inline" | "attachment",
  filename: string,
): string {
  return `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
