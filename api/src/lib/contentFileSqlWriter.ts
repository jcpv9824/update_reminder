import sql from "mssql";
import type { ObjectStorageProvider } from "./objectStorage";

export type ContentFileInput = {
  storageProvider?: ObjectStorageProvider;
  storageBucket?: string;
  storageObjectKey?: string;
  storageObjectEtag?: string;
  storageContainer?: string;
  storageBlobName?: string;
  storageBlobEtag?: string;
  originalName: string;
  mimeType: string;
  byteCount: number;
  sha256?: string;
};

function validateLocator(input: ContentFileInput): void {
  if (input.storageProvider === "s3" && input.storageBucket && input.storageObjectKey) return;
  if (input.storageProvider === "azure_blob" && input.storageContainer && input.storageBlobName) return;
  throw Object.assign(new Error("SQL requiere una ubicación privada de archivo verificada."), { status: 503 });
}

export async function ensureSqlContentFile(
  transaction: sql.Transaction,
  input: ContentFileInput,
  actorId: string,
): Promise<number> {
  validateLocator(input);
  if (!input.sha256 || !/^[a-f0-9]{64}$/i.test(input.sha256)) {
    throw Object.assign(new Error("La huella SHA-256 del archivo no es válida."), { status: 400 });
  }
  if (!Number.isSafeInteger(input.byteCount) || input.byteCount <= 0) {
    throw Object.assign(new Error("El tamaño del archivo no es válido."), { status: 400 });
  }

  const request = new sql.Request(transaction);
  request.input("provider", sql.VarChar(30), input.storageProvider);
  request.input("container", sql.NVarChar(100), input.storageContainer ?? null);
  request.input("blobName", sql.NVarChar(1024), input.storageBlobName ?? null);
  request.input("bucket", sql.NVarChar(255), input.storageBucket ?? null);
  request.input("objectKey", sql.NVarChar(1024), input.storageObjectKey ?? null);
  request.input("objectEtag", sql.NVarChar(200), input.storageObjectEtag ?? input.storageBlobEtag ?? null);
  request.input("originalName", sql.NVarChar(260), input.originalName);
  request.input("mimeType", sql.NVarChar(160), input.mimeType);
  request.input("byteCount", sql.BigInt, input.byteCount);
  request.input("sha", sql.VarBinary(32), Buffer.from(input.sha256, "hex"));
  request.input("createdBy", sql.NVarChar(150), actorId);
  const result = await request.query<{ file_key: number }>(`
    DECLARE @fileKey BIGINT;
    IF @provider='s3'
      SELECT @fileKey=file_key FROM content.files WITH (UPDLOCK,HOLDLOCK)
      WHERE storage_provider='s3' AND storage_bucket=@bucket AND object_key=@objectKey;
    ELSE IF @provider='azure_blob'
      SELECT @fileKey=file_key FROM content.files WITH (UPDLOCK,HOLDLOCK)
      WHERE storage_provider='azure_blob' AND storage_container=@container AND blob_name=@blobName;
    ELSE
      THROW 51071,N'Proveedor de almacenamiento no soportado.',1;

    IF @fileKey IS NULL
    BEGIN
      INSERT content.files
        (storage_provider,storage_container,blob_name,storage_bucket,object_key,object_etag,
         original_name,mime_type,byte_count,content_sha256,created_by)
      VALUES
        (@provider,@container,@blobName,@bucket,@objectKey,@objectEtag,
         @originalName,@mimeType,@byteCount,@sha,@createdBy);
      SET @fileKey=SCOPE_IDENTITY();
    END
    ELSE IF EXISTS
    (
      SELECT 1 FROM content.files
      WHERE file_key=@fileKey
        AND (content_sha256<>@sha OR byte_count<>@byteCount OR mime_type<>@mimeType)
    )
      THROW 51072,N'El objeto existente no coincide con el archivo verificado.',1;

    SELECT @fileKey AS file_key;
  `);
  return result.recordset[0].file_key;
}
