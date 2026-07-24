import type { PublicDownloadDocumentRecord } from "../types/models";
import { contentFileLocatorProjection, readContentSchemaCapabilities } from "./contentFileSqlSchema";
import { getSqlPool } from "./sql";

type SqlDownloadRow = {
  source_id: string;
  title: string;
  slug: string;
  description: string | null;
  asset_kind: "document" | "video";
  active: boolean;
  status: "active" | "inactive" | "deleted";
  storage_provider: "s3" | "azure_blob" | null;
  storage_container: string | null;
  blob_name: string | null;
  storage_bucket: string | null;
  object_key: string | null;
  object_etag: string | null;
  original_name: string | null;
  mime_type: string | null;
  byte_count: number | null;
  content_sha256: Buffer | null;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
  deleted_at: Date | null;
  deleted_by: string | null;
};

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function mapSqlPublicDownload(
  row: SqlDownloadRow,
): PublicDownloadDocumentRecord & { type: "document" } {
  if (!row.original_name || !row.mime_type || row.byte_count === null) {
    throw new Error("Una descarga pública SQL no tiene una versión de archivo vigente.");
  }
  return {
    type: "document",
    id: row.source_id,
    titulo: row.title,
    slug: row.slug,
    descripcion: row.description ?? undefined,
    assetKind: row.asset_kind,
    archivoNombreOriginal: row.original_name,
    archivoMimeType: row.mime_type,
    archivoBytes: Number(row.byte_count),
    archivoStorageProvider: row.storage_provider ?? undefined,
    archivoStorageContainer: row.storage_provider === "azure_blob" ? row.storage_container ?? undefined : undefined,
    archivoBlobName: row.storage_provider === "azure_blob" ? row.blob_name ?? undefined : undefined,
    archivoBlobEtag: row.storage_provider === "azure_blob" ? row.object_etag ?? undefined : undefined,
    archivoStorageBucket: row.storage_provider === "s3" ? row.storage_bucket ?? undefined : undefined,
    archivoObjectKey: row.storage_provider === "s3" ? row.object_key ?? undefined : undefined,
    archivoObjectEtag: row.storage_provider === "s3" ? row.object_etag ?? undefined : undefined,
    archivoSha256: row.content_sha256?.toString("hex"),
    activo: Boolean(row.active),
    status: row.status,
    createdAt: iso(row.created_at)!,
    createdBy: row.created_by,
    updatedAt: iso(row.updated_at)!,
    updatedBy: row.updated_by,
    deletedAt: iso(row.deleted_at),
    deletedBy: row.deleted_by,
  };
}

export async function readSqlPublicDownloads(): Promise<Array<PublicDownloadDocumentRecord & { type: "document" }>> {
  const pool = await getSqlPool();
  const capabilities = await readContentSchemaCapabilities(pool.request());
  const locatorProjection = contentFileLocatorProjection("f", capabilities.provider_neutral_locators);
  const result = await pool.request().query<SqlDownloadRow>(`
    SELECT d.source_id,d.title,d.slug,d.description,d.asset_kind,d.active,d.status,
      ${locatorProjection},
      f.original_name,f.mime_type,
      f.byte_count,f.content_sha256,d.created_at,d.created_by,d.updated_at,d.updated_by,
      d.deleted_at,d.deleted_by
    FROM content.public_download_documents AS d
    LEFT JOIN content.public_download_files AS v
      ON v.document_key=d.document_key AND v.is_current=1
    LEFT JOIN content.files AS f ON f.file_key=v.file_key
    WHERE d.status<>'deleted'
    ORDER BY d.title,d.source_id;
  `);
  return result.recordset.map(mapSqlPublicDownload);
}
