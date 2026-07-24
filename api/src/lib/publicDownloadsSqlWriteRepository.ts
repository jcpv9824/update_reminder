import sql from "mssql";
import type { PublicDownloadDocumentRecord } from "../types/models";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { ensureSqlContentFile } from "./contentFileSqlWriter";
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

async function ensureFile(transaction: sql.Transaction, record: PublicDownloadDocumentRecord, actorId: string): Promise<number> {
  return ensureSqlContentFile(transaction, {
    storageProvider: record.archivoStorageProvider,
    storageBucket: record.archivoStorageBucket,
    storageObjectKey: record.archivoObjectKey,
    storageObjectEtag: record.archivoObjectEtag,
    storageContainer: record.archivoStorageContainer,
    storageBlobName: record.archivoBlobName,
    storageBlobEtag: record.archivoBlobEtag,
    originalName: record.archivoNombreOriginal,
    mimeType: record.archivoMimeType,
    byteCount: record.archivoBytes,
    sha256: record.archivoSha256,
  }, actorId);
}

export async function createSqlPublicDownload(
  record: PublicDownloadDocumentRecord,
  actor: Actor,
): Promise<PublicDownloadDocumentRecord> {
  try {
    return await runSqlTransaction(async (transaction) => {
      const fileKey = await ensureFile(transaction, record, actor.id);
      const request = new sql.Request(transaction);
      request.input("sourceId", sql.NVarChar(150), record.id);
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
        VALUES(@sourceId,NULL,@assetKind,@title,@slug,@slugNormalized,@description,@active,@status,@now,@actorId,@now,@actorId);
        INSERT content.public_download_files(document_key,version_no,file_key,is_current,created_at,created_by)
        SELECT document_key,1,@fileKey,1,@now,@actorId FROM @inserted;
      `);
      await writeSqlAuditLog(transaction, {
        entityType: "publicDownload", entityId: record.id, action: "public_download_document_created",
        performedBy: actor.id, performedByEmail: actor.email, after: record,
        metadata: { fileLoaded: true, assetKind: record.assetKind },
      });
      return record;
    });
  } catch (error) {
    if (uniqueError(error)) throw Object.assign(new Error("Ya existe una descarga con ese endpoint."), { status: 409 });
    throw error;
  }
}

export async function updateSqlPublicDownload(
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
      const request = new sql.Request(transaction);
      request.input("documentKey", sql.BigInt, documentKey);
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
        UPDATE content.public_download_documents SET section_key=NULL,asset_kind=@assetKind,
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
        entityType: "publicDownload", entityId: after.id,
        action: replacedFile ? "public_download_document_file_replaced" : "public_download_document_updated",
        performedBy: actor.id, performedByEmail: actor.email, before, after,
        metadata: replacedFile
          ? { previousFileName: before.archivoNombreOriginal, newFileName: after.archivoNombreOriginal, assetKind: after.assetKind }
          : undefined,
      });
      return after;
    });
  } catch (error) {
    if (uniqueError(error)) throw Object.assign(new Error("Ya existe una descarga con ese endpoint."), { status: 409 });
    throw error;
  }
}

export async function deleteSqlPublicDownload(record: PublicDownloadDocumentRecord, actor: Actor): Promise<boolean> {
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
      entityType: "publicDownload", entityId: record.id, action: "public_download_document_deleted",
      performedBy: actor.id, performedByEmail: actor.email, before: record,
      after: { ...record, activo: false, status: "deleted" },
    });
    return true;
  });
}
