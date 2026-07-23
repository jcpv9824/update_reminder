import sql from "mssql";
import type { PublicDownloadDocumentRecord, PublicDownloadSectionRecord } from "../types/models";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { runSqlTransaction } from "./sqlTransaction";

type Actor = { id: string; email: string };

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("es-CO");
}

function uniqueError(error: unknown): boolean {
  const candidate = error as { number?: number; originalError?: { info?: { number?: number } } };
  const number = candidate.number ?? candidate.originalError?.info?.number;
  return number === 2601 || number === 2627;
}

async function lockSection(transaction: sql.Transaction, id: string): Promise<{ key: number; record: PublicDownloadSectionRecord } | null> {
  const request = new sql.Request(transaction);
  request.input("sourceId", sql.NVarChar(150), id);
  const result = await request.query<{
    section_key: number; source_id: string; name: string; slug: string; description: string | null;
    active: boolean; status: "active" | "inactive" | "deleted"; created_at: Date; created_by: string;
    updated_at: Date; updated_by: string; deleted_at: Date | null; deleted_by: string | null;
  }>(`
    SELECT section_key,source_id,name,slug,description,active,status,created_at,created_by,
      updated_at,updated_by,deleted_at,deleted_by
    FROM content.public_download_sections WITH (UPDLOCK,HOLDLOCK)
    WHERE source_id=@sourceId;
  `);
  const row = result.recordset[0];
  if (!row) return null;
  return { key: row.section_key, record: {
    id: row.source_id, nombre: row.name, slug: row.slug, descripcion: row.description ?? undefined,
    activa: row.active, status: row.status, createdAt: row.created_at.toISOString(), createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(), updatedBy: row.updated_by,
    deletedAt: row.deleted_at?.toISOString() ?? null, deletedBy: row.deleted_by,
  } };
}

async function ensureFile(transaction: sql.Transaction, record: PublicDownloadDocumentRecord, actorId: string): Promise<number> {
  if (record.archivoStorageProvider !== "azure_blob" || !record.archivoBlobContainer || !record.archivoBlobName || !record.archivoSha256) {
    throw Object.assign(new Error("SQL requiere una ubicación privada de Azure Blob verificada."), { status: 503 });
  }
  const sha = Buffer.from(record.archivoSha256, "hex");
  if (sha.length !== 32) throw Object.assign(new Error("La huella SHA-256 del archivo no es válida."), { status: 400 });
  const request = new sql.Request(transaction);
  request.input("container", sql.NVarChar(100), record.archivoBlobContainer);
  request.input("blobName", sql.NVarChar(1024), record.archivoBlobName);
  request.input("originalName", sql.NVarChar(260), record.archivoNombreOriginal);
  request.input("mimeType", sql.NVarChar(160), record.archivoMimeType);
  request.input("byteCount", sql.BigInt, record.archivoBytes);
  request.input("sha", sql.VarBinary(32), sha);
  request.input("createdBy", sql.NVarChar(150), actorId);
  const result = await request.query<{ file_key: number }>(`
    DECLARE @fileKey BIGINT=(SELECT file_key FROM content.files WITH (UPDLOCK,HOLDLOCK)
      WHERE storage_provider='azure_blob' AND storage_container=@container AND blob_name=@blobName);
    IF @fileKey IS NULL
    BEGIN
      INSERT content.files(storage_provider,storage_container,blob_name,original_name,mime_type,byte_count,content_sha256,created_by)
      VALUES('azure_blob',@container,@blobName,@originalName,@mimeType,@byteCount,@sha,@createdBy);
      SET @fileKey=SCOPE_IDENTITY();
    END
    ELSE IF EXISTS (SELECT 1 FROM content.files WHERE file_key=@fileKey AND (content_sha256<>@sha OR byte_count<>@byteCount))
      THROW 51072,N'El blob existente no coincide con el archivo verificado.',1;
    SELECT @fileKey AS file_key;
  `);
  return result.recordset[0].file_key;
}

export async function createSqlPublicDownloadSection(record: PublicDownloadSectionRecord, actor: Actor): Promise<PublicDownloadSectionRecord> {
  try {
    return await runSqlTransaction(async (transaction) => {
      const request = new sql.Request(transaction);
      request.input("sourceId", sql.NVarChar(150), record.id);
      request.input("name", sql.NVarChar(200), record.nombre);
      request.input("nameNormalized", sql.NVarChar(200), normalize(record.nombre));
      request.input("slug", sql.NVarChar(200), record.slug);
      request.input("slugNormalized", sql.NVarChar(200), normalize(record.slug));
      request.input("description", sql.NVarChar(1000), record.descripcion ?? null);
      request.input("active", sql.Bit, record.activa);
      request.input("status", sql.VarChar(20), record.status);
      request.input("now", sql.DateTime2(3), new Date(record.createdAt));
      request.input("actorId", sql.NVarChar(150), actor.id);
      await request.query(`
        INSERT content.public_download_sections
        (source_id,name,name_normalized,slug,slug_normalized,description,active,status,created_at,created_by,updated_at,updated_by)
        VALUES(@sourceId,@name,@nameNormalized,@slug,@slugNormalized,@description,@active,@status,@now,@actorId,@now,@actorId);
      `);
      await writeSqlAuditLog(transaction, {
        entityType: "publicDownloadSection", entityId: record.id, action: "public_download_section_created",
        performedBy: actor.id, performedByEmail: actor.email, after: record,
      });
      return record;
    });
  } catch (error) {
    if (uniqueError(error)) throw Object.assign(new Error("Ya existe una sección con ese nombre o endpoint."), { status: 409 });
    throw error;
  }
}

export async function updateSqlPublicDownloadSection(record: PublicDownloadSectionRecord, actor: Actor): Promise<PublicDownloadSectionRecord | null> {
  try {
    return await runSqlTransaction(async (transaction) => {
      const existing = await lockSection(transaction, record.id);
      if (!existing || existing.record.status === "deleted") return null;
      const request = new sql.Request(transaction);
      request.input("sourceId", sql.NVarChar(150), record.id);
      request.input("name", sql.NVarChar(200), record.nombre);
      request.input("nameNormalized", sql.NVarChar(200), normalize(record.nombre));
      request.input("slug", sql.NVarChar(200), record.slug);
      request.input("slugNormalized", sql.NVarChar(200), normalize(record.slug));
      request.input("description", sql.NVarChar(1000), record.descripcion ?? null);
      request.input("active", sql.Bit, record.activa);
      request.input("status", sql.VarChar(20), record.status);
      request.input("updatedAt", sql.DateTime2(3), new Date(record.updatedAt));
      request.input("updatedBy", sql.NVarChar(150), actor.id);
      await request.query(`
        UPDATE content.public_download_sections SET name=@name,name_normalized=@nameNormalized,
          slug=@slug,slug_normalized=@slugNormalized,description=@description,active=@active,status=@status,
          updated_at=@updatedAt,updated_by=@updatedBy WHERE source_id=@sourceId;
      `);
      await writeSqlAuditLog(transaction, {
        entityType: "publicDownloadSection", entityId: record.id, action: "public_download_section_updated",
        performedBy: actor.id, performedByEmail: actor.email, before: existing.record, after: record,
      });
      return record;
    });
  } catch (error) {
    if (uniqueError(error)) throw Object.assign(new Error("Ya existe una sección con ese nombre o endpoint."), { status: 409 });
    throw error;
  }
}

export async function deleteSqlPublicDownloadSection(id: string, actor: Actor): Promise<{ found: boolean; documents: number }> {
  return runSqlTransaction(async (transaction) => {
    const existing = await lockSection(transaction, id);
    if (!existing || existing.record.status === "deleted") return { found: false, documents: 0 };
    const dependencies = new sql.Request(transaction);
    dependencies.input("sectionKey", sql.BigInt, existing.key);
    const result = await dependencies.query<{ count: number }>(`
      SELECT COUNT_BIG(*) AS count FROM content.public_download_documents WITH (UPDLOCK,HOLDLOCK)
      WHERE section_key=@sectionKey AND status<>'deleted';
    `);
    const documents = Number(result.recordset[0]?.count ?? 0);
    if (documents) return { found: true, documents };
    const now = new Date();
    const remove = new sql.Request(transaction);
    remove.input("sectionKey", sql.BigInt, existing.key);
    remove.input("now", sql.DateTime2(3), now);
    remove.input("actorId", sql.NVarChar(150), actor.id);
    await remove.query(`
      UPDATE content.public_download_sections SET active=0,status='deleted',deleted_at=@now,deleted_by=@actorId,
        updated_at=@now,updated_by=@actorId WHERE section_key=@sectionKey;
    `);
    await writeSqlAuditLog(transaction, {
      entityType: "publicDownloadSection", entityId: id, action: "public_download_section_deleted",
      performedBy: actor.id, performedByEmail: actor.email, before: existing.record,
      after: { ...existing.record, activa: false, status: "deleted", deletedAt: now.toISOString(), deletedBy: actor.id },
    });
    return { found: true, documents: 0 };
  });
}

export async function createSqlPublicDownloadDocument(record: PublicDownloadDocumentRecord, actor: Actor): Promise<PublicDownloadDocumentRecord> {
  try {
    return await runSqlTransaction(async (transaction) => {
      const section = await lockSection(transaction, record.sectionId);
      if (!section || !section.record.activa || section.record.status !== "active") {
        throw Object.assign(new Error("La sección seleccionada no existe o está inactiva."), { status: 400 });
      }
      const fileKey = await ensureFile(transaction, record, actor.id);
      const request = new sql.Request(transaction);
      request.input("sourceId", sql.NVarChar(150), record.id);
      request.input("sectionKey", sql.BigInt, section.key);
      request.input("assetKind", sql.VarChar(20), record.assetKind ?? "document");
      request.input("title", sql.NVarChar(240), record.titulo);
      request.input("slug", sql.NVarChar(200), record.slug);
      request.input("slugNormalized", sql.NVarChar(200), normalize(record.slug));
      request.input("description", sql.NVarChar(1000), record.descripcion ?? null);
      request.input("active", sql.Bit, record.activo);
      request.input("status", sql.VarChar(20), record.status);
      request.input("now", sql.DateTime2(3), new Date(record.createdAt));
      request.input("actorId", sql.NVarChar(150), actor.id);
      request.input("fileKey", sql.BigInt, fileKey);
      await request.query(`
        DECLARE @inserted TABLE(document_key BIGINT NOT NULL);
        INSERT content.public_download_documents
        (source_id,section_key,asset_kind,title,slug,slug_normalized,description,active,status,created_at,created_by,updated_at,updated_by)
        OUTPUT INSERTED.document_key INTO @inserted(document_key)
        VALUES(@sourceId,@sectionKey,@assetKind,@title,@slug,@slugNormalized,@description,@active,@status,@now,@actorId,@now,@actorId);
        INSERT content.public_download_files(document_key,version_no,file_key,is_current,created_at,created_by)
        SELECT document_key,1,@fileKey,1,@now,@actorId FROM @inserted;
      `);
      await writeSqlAuditLog(transaction, {
        entityType: "publicDownloadDocument", entityId: record.id, action: "public_download_document_created",
        performedBy: actor.id, performedByEmail: actor.email, after: record,
        metadata: { fileLoaded: true, assetKind: record.assetKind },
      });
      return { ...record, sectionName: section.record.nombre, sectionSlug: section.record.slug };
    });
  } catch (error) {
    if (uniqueError(error)) throw Object.assign(new Error("Ya existe un archivo con ese endpoint."), { status: 409 });
    throw error;
  }
}

export async function updateSqlPublicDownloadDocument(
  before: PublicDownloadDocumentRecord,
  after: PublicDownloadDocumentRecord,
  actor: Actor,
  replacedFile: boolean,
): Promise<PublicDownloadDocumentRecord | null> {
  try {
    return await runSqlTransaction(async (transaction) => {
      const lookup = new sql.Request(transaction);
      lookup.input("sourceId", sql.NVarChar(150), before.id);
      const document = await lookup.query<{ document_key: number }>(`
        SELECT document_key FROM content.public_download_documents WITH (UPDLOCK,HOLDLOCK)
        WHERE source_id=@sourceId AND status<>'deleted';
      `);
      const documentKey = document.recordset[0]?.document_key;
      if (!documentKey) return null;
      const section = await lockSection(transaction, after.sectionId);
      if (!section || section.record.status === "deleted") throw Object.assign(new Error("La sección seleccionada no existe."), { status: 400 });
      const request = new sql.Request(transaction);
      request.input("documentKey", sql.BigInt, documentKey);
      request.input("sectionKey", sql.BigInt, section.key);
      request.input("assetKind", sql.VarChar(20), after.assetKind ?? "document");
      request.input("title", sql.NVarChar(240), after.titulo);
      request.input("slug", sql.NVarChar(200), after.slug);
      request.input("slugNormalized", sql.NVarChar(200), normalize(after.slug));
      request.input("description", sql.NVarChar(1000), after.descripcion ?? null);
      request.input("active", sql.Bit, after.activo);
      request.input("status", sql.VarChar(20), after.status);
      request.input("updatedAt", sql.DateTime2(3), new Date(after.updatedAt));
      request.input("updatedBy", sql.NVarChar(150), actor.id);
      await request.query(`
        UPDATE content.public_download_documents SET section_key=@sectionKey,asset_kind=@assetKind,
          title=@title,slug=@slug,slug_normalized=@slugNormalized,description=@description,
          active=@active,status=@status,updated_at=@updatedAt,updated_by=@updatedBy
        WHERE document_key=@documentKey;
      `);
      if (replacedFile) {
        const fileKey = await ensureFile(transaction, after, actor.id);
        const version = new sql.Request(transaction);
        version.input("documentKey", sql.BigInt, documentKey);
        version.input("fileKey", sql.BigInt, fileKey);
        version.input("now", sql.DateTime2(3), new Date(after.updatedAt));
        version.input("actorId", sql.NVarChar(150), actor.id);
        await version.query(`
          DECLARE @version INT=ISNULL((SELECT MAX(version_no) FROM content.public_download_files WITH (UPDLOCK,HOLDLOCK) WHERE document_key=@documentKey),0)+1;
          UPDATE content.public_download_files SET is_current=0 WHERE document_key=@documentKey AND is_current=1;
          INSERT content.public_download_files(document_key,version_no,file_key,is_current,created_at,created_by)
          VALUES(@documentKey,@version,@fileKey,1,@now,@actorId);
        `);
      }
      await writeSqlAuditLog(transaction, {
        entityType: "publicDownloadDocument", entityId: after.id,
        action: replacedFile ? "public_download_document_file_replaced" : "public_download_document_updated",
        performedBy: actor.id, performedByEmail: actor.email, before, after,
        metadata: replacedFile ? { previousFileName: before.archivoNombreOriginal, newFileName: after.archivoNombreOriginal, assetKind: after.assetKind } : undefined,
      });
      return { ...after, sectionName: section.record.nombre, sectionSlug: section.record.slug };
    });
  } catch (error) {
    if (uniqueError(error)) throw Object.assign(new Error("Ya existe un archivo con ese endpoint."), { status: 409 });
    throw error;
  }
}

export async function deleteSqlPublicDownloadDocument(record: PublicDownloadDocumentRecord, actor: Actor): Promise<boolean> {
  return runSqlTransaction(async (transaction) => {
    const request = new sql.Request(transaction);
    request.input("sourceId", sql.NVarChar(150), record.id);
    request.input("now", sql.DateTime2(3), new Date());
    request.input("actorId", sql.NVarChar(150), actor.id);
    const result = await request.query(`
      UPDATE content.public_download_documents SET active=0,status='deleted',deleted_at=@now,deleted_by=@actorId,
        updated_at=@now,updated_by=@actorId WHERE source_id=@sourceId AND status<>'deleted';
      SELECT @@ROWCOUNT AS updated_count;
    `);
    if (Number(result.recordset[0]?.updated_count ?? 0) !== 1) return false;
    await writeSqlAuditLog(transaction, {
      entityType: "publicDownloadDocument", entityId: record.id, action: "public_download_document_deleted",
      performedBy: actor.id, performedByEmail: actor.email, before: record,
      after: { ...record, activo: false, status: "deleted" },
    });
    return true;
  });
}
