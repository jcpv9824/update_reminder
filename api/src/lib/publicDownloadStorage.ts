import { DefaultAzureCredential } from "@azure/identity";
import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  type UserDelegationKey,
} from "@azure/storage-blob";
import sql from "mssql";
import { runSqlTransaction } from "./sqlTransaction";

type StorageConfig = {
  accountName: string;
  accountUrl: string;
  containerName: string;
};

let serviceClient: BlobServiceClient | null = null;
let cachedDelegation: { key: UserDelegationKey; expiresAt: Date } | null = null;

function readConfig(): StorageConfig | null {
  const accountUrl = process.env.PUBLIC_DOWNLOADS_STORAGE_ACCOUNT_URL?.trim().replace(/\/$/, "");
  const containerName = process.env.PUBLIC_DOWNLOADS_STORAGE_CONTAINER?.trim() || "portal-sag-public-downloads";
  if (!accountUrl) return null;
  const match = /^https:\/\/([a-z0-9]{3,24})\.blob\.core\.windows\.net$/i.exec(accountUrl);
  if (!match) throw new Error("PUBLIC_DOWNLOADS_STORAGE_ACCOUNT_URL debe ser un endpoint HTTPS válido de Azure Blob Storage.");
  if (!/^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(containerName)) {
    throw new Error("PUBLIC_DOWNLOADS_STORAGE_CONTAINER no es válido.");
  }
  return { accountName: match[1].toLowerCase(), accountUrl, containerName };
}

function getService(config: StorageConfig): BlobServiceClient {
  if (!serviceClient || serviceClient.url !== config.accountUrl) {
    serviceClient = new BlobServiceClient(config.accountUrl, new DefaultAzureCredential());
    cachedDelegation = null;
  }
  return serviceClient;
}

export function isPublicDownloadBlobStorageConfigured(): boolean {
  return readConfig() !== null;
}

export async function storePublicDownloadBlob(input: {
  bytes: Buffer;
  sha256: string;
  extension: string;
  mimeType: string;
}) {
  const config = readConfig();
  if (!config) throw Object.assign(new Error("El almacenamiento privado de archivos aún no está configurado."), { status: 503 });
  const container = getService(config).getContainerClient(config.containerName);
  const blobName = `portal-sag/runtime/public-downloads/${input.sha256}${input.extension}`;
  const blob = container.getBlockBlobClient(blobName);
  try {
    await blob.uploadData(input.bytes, {
      conditions: { ifNoneMatch: "*" },
      blobHTTPHeaders: { blobContentType: input.mimeType },
    });
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 409) throw error;
  }
  const properties = await blob.getProperties();
  if (properties.contentLength !== input.bytes.length) {
    throw new Error("La verificación remota del archivo no coincide con el tamaño cargado.");
  }
  return {
    archivoStorageProvider: "azure_blob" as const,
    archivoBlobContainer: config.containerName,
    archivoBlobName: blobName,
    archivoBlobEtag: properties.etag,
    archivoSha256: input.sha256,
  };
}

export async function deletePublicDownloadBlobIfUnreferenced(input: {
  containerName: string;
  blobName: string;
}): Promise<boolean> {
  const config = readConfig();
  if (!config || config.containerName !== input.containerName) return false;
  return runSqlTransaction(async (transaction) => {
    const request = new sql.Request(transaction);
    request.input("container", sql.NVarChar(100), input.containerName);
    request.input("blobName", sql.NVarChar(1024), input.blobName);
    const result = await request.query<{ reference_count: number }>(`
      SELECT COUNT_BIG(*) AS reference_count
      FROM content.files WITH (UPDLOCK,HOLDLOCK)
      WHERE storage_provider='azure_blob' AND storage_container=@container AND blob_name=@blobName;
    `);
    if (Number(result.recordset[0]?.reference_count ?? 0) > 0) return false;
    const container = getService(config).getContainerClient(config.containerName);
    return (await container.getBlockBlobClient(input.blobName).deleteIfExists()).succeeded;
  }, sql.ISOLATION_LEVEL.SERIALIZABLE);
}

async function getDelegationKey(service: BlobServiceClient): Promise<UserDelegationKey> {
  const now = new Date();
  if (cachedDelegation && cachedDelegation.expiresAt.getTime() - now.getTime() > 5 * 60_000) {
    return cachedDelegation.key;
  }
  const startsOn = new Date(now.getTime() - 5 * 60_000);
  const expiresAt = new Date(now.getTime() + 45 * 60_000);
  const key = await service.getUserDelegationKey(startsOn, expiresAt);
  cachedDelegation = { key, expiresAt };
  return key;
}

export async function createPublicDownloadBlobUrl(input: {
  containerName: string;
  blobName: string;
  mimeType: string;
  filename: string;
  disposition?: "inline" | "attachment";
}): Promise<string> {
  const config = readConfig();
  if (!config || config.containerName !== input.containerName) {
    throw new Error("La ubicación privada del archivo no coincide con la configuración activa.");
  }
  const service = getService(config);
  const now = new Date();
  const expiresOn = new Date(now.getTime() + 5 * 60_000);
  const sas = generateBlobSASQueryParameters({
    containerName: input.containerName,
    blobName: input.blobName,
    permissions: BlobSASPermissions.parse("r"),
    startsOn: new Date(now.getTime() - 60_000),
    expiresOn,
    contentType: input.mimeType,
    contentDisposition: `${input.disposition ?? "attachment"}; filename*=UTF-8''${encodeURIComponent(input.filename)}`,
  }, await getDelegationKey(service), config.accountName).toString();
  return `${config.accountUrl}/${encodeURIComponent(input.containerName)}/${input.blobName.split("/").map(encodeURIComponent).join("/")}?${sas}`;
}
