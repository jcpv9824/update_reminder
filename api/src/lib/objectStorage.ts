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
import sql from "mssql";
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
  return config.provider === "s3"
    ? storeS3Object(config, input)
    : storeAzureBlob(config, input);
}

async function hasSqlReference(input: PrivateObjectLocator, transaction: sql.Transaction): Promise<boolean> {
  const request = new sql.Request(transaction);
  if (input.storageProvider === "s3") {
    request.input("bucket", sql.NVarChar(255), input.storageBucket);
    request.input("objectKey", sql.NVarChar(1024), input.storageObjectKey);
    const result = await request.query<{ reference_count: number }>(`
      SELECT COUNT_BIG(*) AS reference_count
      FROM content.files WITH (UPDLOCK,HOLDLOCK)
      WHERE storage_provider='s3' AND storage_bucket=@bucket AND object_key=@objectKey;
    `);
    return Number(result.recordset[0]?.reference_count ?? 0) > 0;
  }
  request.input("container", sql.NVarChar(100), input.storageContainer);
  request.input("blobName", sql.NVarChar(1024), input.storageBlobName);
  const result = await request.query<{ reference_count: number }>(`
    SELECT COUNT_BIG(*) AS reference_count
    FROM content.files WITH (UPDLOCK,HOLDLOCK)
    WHERE storage_provider='azure_blob' AND storage_container=@container AND blob_name=@blobName;
  `);
  return Number(result.recordset[0]?.reference_count ?? 0) > 0;
}

export async function deletePrivateObjectIfUnreferenced(input: PrivateObjectLocator): Promise<boolean> {
  return runSqlTransaction(async (transaction) => {
    if (await hasSqlReference(input, transaction)) return false;

    if (input.storageProvider === "s3") {
      const config = readS3Config(true)!;
      if (config.bucket !== input.storageBucket) return false;
      const client = getS3Client(config);
      try {
        await client.send(new HeadObjectCommand({ Bucket: input.storageBucket, Key: input.storageObjectKey }));
      } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false;
        throw error;
      }
      await client.send(new DeleteObjectCommand({ Bucket: input.storageBucket, Key: input.storageObjectKey }));
      return true;
    }

    const config = readAzureBlobConfig(true)!;
    if (config.containerName !== input.storageContainer) return false;
    const blob = getAzureService(config)
      .getContainerClient(input.storageContainer)
      .getBlockBlobClient(input.storageBlobName);
    return (await blob.deleteIfExists({ deleteSnapshots: "include" })).succeeded;
  }, sql.ISOLATION_LEVEL.SERIALIZABLE);
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
