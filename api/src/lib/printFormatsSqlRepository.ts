import type { FormatoImpresionRecord, FuenteFormatoRecord } from "../types/models";
import { getSqlPool } from "./sql";

type SourceRow = {
  source_id: string; name: string; active: boolean; status: "active" | "inactive" | "deleted";
  created_at: Date; created_by: string; updated_at: Date; updated_by: string;
  deleted_at: Date | null; deleted_by: string | null;
};

type FormatRow = {
  source_id: string; name: string; description: string | null; format_size: FormatoImpresionRecord["tamanoFormato"] | null;
  custom_format_size: string | null; requires_license: boolean; module_source_id: string | null;
  module_name: string | null; module_code: string | null; active: boolean;
  status: "active" | "inactive" | "deleted"; created_at: Date; created_by: string;
  updated_at: Date; updated_by: string; deleted_at: Date | null; deleted_by: string | null;
  source_type_id: string; source_type_name: string; display_order: number; is_primary: boolean;
  storage_provider: "azure_blob" | null; storage_container: string | null; blob_name: string | null;
  original_name: string | null; mime_type: string | null; byte_count: number | null;
  content_sha256: Buffer | null;
};

const iso = (value: Date | null) => value ? value.toISOString() : null;

export function mapSqlPrintFormatSource(row: SourceRow): FuenteFormatoRecord {
  return {
    id: row.source_id, nombre: row.name, activa: Boolean(row.active), status: row.status,
    createdAt: iso(row.created_at)!, createdBy: row.created_by,
    updatedAt: iso(row.updated_at)!, updatedBy: row.updated_by,
    deletedAt: iso(row.deleted_at), deletedBy: row.deleted_by,
  };
}

export function mapSqlPrintFormatRows(rows: FormatRow[]): FormatoImpresionRecord {
  const first = rows[0];
  if (!first || !first.original_name || !first.mime_type || first.byte_count === null) {
    throw new Error("Un formato SQL no tiene una versión PDF vigente.");
  }
  const ordered = [...rows].sort((a, b) => a.display_order - b.display_order);
  const primary = ordered.find((row) => row.is_primary) ?? ordered[0];
  return {
    id: first.source_id, nombre: first.name,
    fuenteId: primary.source_type_id, fuenteNombre: primary.source_type_name,
    fuenteIds: ordered.map((row) => row.source_type_id),
    fuenteNombres: ordered.map((row) => row.source_type_name),
    descripcion: first.description ?? "", tamanoFormato: first.format_size ?? undefined,
    tamanoFormatoPersonalizado: first.custom_format_size ?? undefined,
    requiereLicencia: Boolean(first.requires_license),
    licenciaModuloId: first.module_source_id ?? undefined,
    licenciaModuloNombre: first.module_name ?? undefined,
    licenciaModuloCodigo: first.module_code ?? undefined,
    pdfNombreOriginal: first.original_name, pdfMimeType: "application/pdf",
    pdfBytes: Number(first.byte_count), pdfStorageProvider: first.storage_provider ?? undefined,
    pdfBlobContainer: first.storage_container ?? undefined, pdfBlobName: first.blob_name ?? undefined,
    pdfSha256: first.content_sha256?.toString("hex"),
    activo: Boolean(first.active), status: first.status,
    createdAt: iso(first.created_at)!, createdBy: first.created_by,
    updatedAt: iso(first.updated_at)!, updatedBy: first.updated_by,
    deletedAt: iso(first.deleted_at), deletedBy: first.deleted_by,
  };
}

export async function readSqlPrintFormats(): Promise<{
  sources: FuenteFormatoRecord[]; formats: FormatoImpresionRecord[];
}> {
  const pool = await getSqlPool();
  const [sourceResult, formatResult] = await Promise.all([
    pool.request().query<SourceRow>(`
      SELECT source_id,name,active,status,created_at,created_by,updated_at,updated_by,deleted_at,deleted_by
      FROM content.print_format_sources WHERE status<>'deleted' ORDER BY name,source_id;
    `),
    pool.request().query<FormatRow>(`
      SELECT f.source_id,f.name,f.description,f.format_size,f.custom_format_size,f.requires_license,
        m.source_id AS module_source_id,m.name AS module_name,m.code AS module_code,
        f.active,f.status,f.created_at,f.created_by,f.updated_at,f.updated_by,f.deleted_at,f.deleted_by,
        s.source_id AS source_type_id,s.name AS source_type_name,a.display_order,
        CONVERT(bit,CASE WHEN f.print_format_source_key=s.print_format_source_key THEN 1 ELSE 0 END) AS is_primary,
        file_record.storage_provider,file_record.storage_container,file_record.blob_name,
        file_record.original_name,file_record.mime_type,file_record.byte_count,file_record.content_sha256
      FROM content.print_formats AS f
      JOIN content.print_format_source_assignments AS a ON a.print_format_key=f.print_format_key
      JOIN content.print_format_sources AS s ON s.print_format_source_key=a.print_format_source_key
      LEFT JOIN licensing.license_modules AS m ON m.module_key=f.module_key
      LEFT JOIN content.print_format_files AS file_version
        ON file_version.print_format_key=f.print_format_key AND file_version.is_current=1
      LEFT JOIN content.files AS file_record ON file_record.file_key=file_version.file_key
      WHERE f.status<>'deleted'
      ORDER BY f.name,f.source_id,a.display_order;
    `),
  ]);
  const grouped = new Map<string, FormatRow[]>();
  for (const row of formatResult.recordset) grouped.set(row.source_id, [...(grouped.get(row.source_id) ?? []), row]);
  return {
    sources: sourceResult.recordset.map(mapSqlPrintFormatSource),
    formats: [...grouped.values()].map(mapSqlPrintFormatRows),
  };
}
