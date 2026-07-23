import type { PublicDownloadDocumentRecord, PublicDownloadSectionRecord } from "../types/models";
import { getSqlPool } from "./sql";

type SqlSectionRow = {
  source_id: string;
  name: string;
  slug: string;
  description: string | null;
  active: boolean;
  status: "active" | "inactive" | "deleted";
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
  deleted_at: Date | null;
  deleted_by: string | null;
};

type SqlDocumentRow = {
  source_id: string;
  section_source_id: string;
  section_name: string;
  section_slug: string;
  title: string;
  slug: string;
  description: string | null;
  asset_kind: "document" | "video";
  active: boolean;
  status: "active" | "inactive" | "deleted";
  storage_provider: "azure_blob" | null;
  storage_container: string | null;
  blob_name: string | null;
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

export function mapSqlPublicDownloadSection(
  row: SqlSectionRow,
): PublicDownloadSectionRecord & { type: "section" } {
  return {
    type: "section",
    id: row.source_id,
    nombre: row.name,
    slug: row.slug,
    descripcion: row.description ?? undefined,
    activa: Boolean(row.active),
    status: row.status,
    createdAt: iso(row.created_at)!,
    createdBy: row.created_by,
    updatedAt: iso(row.updated_at)!,
    updatedBy: row.updated_by,
    deletedAt: iso(row.deleted_at),
    deletedBy: row.deleted_by,
  };
}

export function mapSqlPublicDownloadDocument(
  row: SqlDocumentRow,
): PublicDownloadDocumentRecord & { type: "document" } {
  if (!row.original_name || !row.mime_type || row.byte_count === null) {
    throw new Error("Un archivo público SQL no tiene una versión de archivo vigente.");
  }
  return {
    type: "document",
    id: row.source_id,
    sectionId: row.section_source_id,
    sectionName: row.section_name,
    sectionSlug: row.section_slug,
    titulo: row.title,
    slug: row.slug,
    descripcion: row.description ?? undefined,
    assetKind: row.asset_kind,
    archivoNombreOriginal: row.original_name,
    archivoMimeType: row.mime_type,
    archivoBytes: Number(row.byte_count),
    archivoStorageProvider: row.storage_provider ?? undefined,
    archivoBlobContainer: row.storage_container ?? undefined,
    archivoBlobName: row.blob_name ?? undefined,
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

export async function readSqlPublicDownloads(): Promise<
  Array<
    (PublicDownloadSectionRecord & { type: "section" }) |
    (PublicDownloadDocumentRecord & { type: "document" })
  >
> {
  const pool = await getSqlPool();
  const [sections, documents] = await Promise.all([
    pool.request().query<SqlSectionRow>(`
      SELECT source_id,name,slug,description,active,status,
        created_at,created_by,updated_at,updated_by,deleted_at,deleted_by
      FROM content.public_download_sections
      WHERE status<>'deleted'
      ORDER BY name,source_id;
    `),
    pool.request().query<SqlDocumentRow>(`
      SELECT d.source_id,s.source_id AS section_source_id,s.name AS section_name,s.slug AS section_slug,
        d.title,d.slug,d.description,d.asset_kind,d.active,d.status,
        f.storage_provider,f.storage_container,f.blob_name,f.original_name,f.mime_type,
        f.byte_count,f.content_sha256,d.created_at,d.created_by,d.updated_at,d.updated_by,
        d.deleted_at,d.deleted_by
      FROM content.public_download_documents AS d
      JOIN content.public_download_sections AS s ON s.section_key=d.section_key
      LEFT JOIN content.public_download_files AS v
        ON v.document_key=d.document_key AND v.is_current=1
      LEFT JOIN content.files AS f ON f.file_key=v.file_key
      WHERE d.status<>'deleted'
      ORDER BY d.title,d.source_id;
    `),
  ]);
  return [
    ...sections.recordset.map(mapSqlPublicDownloadSection),
    ...documents.recordset.map(mapSqlPublicDownloadDocument),
  ];
}
