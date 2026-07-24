import type { PublicFileRecord } from "../types/models";
import { contentFileLocatorProjection, readContentSchemaCapabilities } from "./contentFileSqlSchema";
import { getSqlPool } from "./sql";

type SqlPublicFileRow = {
  source_id: string;
  title: string;
  slug: string;
  description: string | null;
  asset_kind: "image" | "video" | "pdf";
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

export function mapSqlPublicFile(row: SqlPublicFileRow): PublicFileRecord {
  if (!row.original_name || !row.mime_type || row.byte_count === null) {
    throw new Error("Un archivo público SQL no tiene una versión vigente.");
  }
  return {
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

export async function readSqlPublicFiles(): Promise<PublicFileRecord[]> {
  const pool = await getSqlPool();
  const capabilities = await readContentSchemaCapabilities(pool.request());
  if (!capabilities.public_files) return [];
  const locatorProjection = contentFileLocatorProjection("f", capabilities.provider_neutral_locators);
  const result = await pool.request().query<SqlPublicFileRow>(`
    SELECT p.source_id,p.title,p.slug,p.description,p.asset_kind,p.active,p.status,
      ${locatorProjection},
      f.original_name,f.mime_type,
      f.byte_count,f.content_sha256,p.created_at,p.created_by,p.updated_at,p.updated_by,
      p.deleted_at,p.deleted_by
    FROM content.public_files AS p
    LEFT JOIN content.public_file_versions AS v
      ON v.public_file_key=p.public_file_key AND v.is_current=1
    LEFT JOIN content.files AS f ON f.file_key=v.file_key
    WHERE p.status<>'deleted'
    ORDER BY p.title,p.source_id;
  `);
  return result.recordset.map(mapSqlPublicFile);
}
