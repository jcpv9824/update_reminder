import sql from "mssql";
import type { PublicFileRecord } from "../types/models";
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

async function ensureFile(transaction: sql.Transaction, record: PublicFileRecord, actorId: string): Promise<number> {
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

export async function createSqlPublicFile(record: PublicFileRecord, actor: Actor): Promise<PublicFileRecord> {
  try {
    return await runSqlTransaction(async (transaction) => {
      const fileKey = await ensureFile(transaction, record, actor.id);
      const request = new sql.Request(transaction);
      request.input("sourceId", sql.NVarChar(150), record.id);
      request.input("assetKind", sql.VarChar(20), record.assetKind);
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
        DECLARE @inserted TABLE(public_file_key BIGINT NOT NULL);
        INSERT content.public_files
        (source_id,asset_kind,title,slug,slug_normalized,description,active,status,created_at,created_by,updated_at,updated_by)
        OUTPUT INSERTED.public_file_key INTO @inserted(public_file_key)
        VALUES(@sourceId,@assetKind,@title,@slug,@slugNormalized,@description,@active,@status,@now,@actorId,@now,@actorId);
        INSERT content.public_file_versions(public_file_key,version_no,file_key,is_current,created_at,created_by)
        SELECT public_file_key,1,@fileKey,1,@now,@actorId FROM @inserted;
      `);
      await writeSqlAuditLog(transaction, {
        entityType: "publicFile", entityId: record.id, action: "public_file_created",
        performedBy: actor.id, performedByEmail: actor.email, after: record,
        metadata: { fileLoaded: true, assetKind: record.assetKind },
      });
      return record;
    });
  } catch (error) {
    if (uniqueError(error)) throw Object.assign(new Error("Ya existe un archivo público con ese endpoint."), { status: 409 });
    throw error;
  }
}

export async function updateSqlPublicFile(
  before: PublicFileRecord,
  after: PublicFileRecord,
  actor: Actor,
  replacedFile: boolean,
): Promise<PublicFileRecord | null> {
  try {
    return await runSqlTransaction(async (transaction) => {
      const lookup = new sql.Request(transaction);
      lookup.input("sourceId", sql.NVarChar(150), before.id);
      const result = await lookup.query<{ public_file_key: number }>(`
        SELECT public_file_key FROM content.public_files WITH (UPDLOCK,HOLDLOCK)
        WHERE source_id=@sourceId AND status<>'deleted';
      `);
      const publicFileKey = result.recordset[0]?.public_file_key;
      if (!publicFileKey) return null;
      const request = new sql.Request(transaction);
      request.input("publicFileKey", sql.BigInt, publicFileKey);
      request.input("assetKind", sql.VarChar(20), after.assetKind);
      request.input("title", sql.NVarChar(240), after.titulo);
      request.input("slug", sql.NVarChar(200), after.slug);
      request.input("slugNormalized", sql.NVarChar(200), normalize(after.slug));
      request.input("description", sql.NVarChar(1000), after.descripcion ?? null);
      request.input("active", sql.Bit, after.activo);
      request.input("status", sql.VarChar(20), after.status);
      request.input("updatedAt", sql.DateTime2(3), new Date(after.updatedAt));
      request.input("updatedBy", sql.NVarChar(150), actor.id);
      await request.query(`
        UPDATE content.public_files SET asset_kind=@assetKind,title=@title,slug=@slug,
          slug_normalized=@slugNormalized,description=@description,active=@active,status=@status,
          updated_at=@updatedAt,updated_by=@updatedBy
        WHERE public_file_key=@publicFileKey;
      `);
      if (replacedFile) {
        const fileKey = await ensureFile(transaction, after, actor.id);
        const version = new sql.Request(transaction);
        version.input("publicFileKey", sql.BigInt, publicFileKey);
        version.input("fileKey", sql.BigInt, fileKey);
        version.input("now", sql.DateTime2(3), new Date(after.updatedAt));
        version.input("actorId", sql.NVarChar(150), actor.id);
        await version.query(`
          DECLARE @version INT=ISNULL((SELECT MAX(version_no) FROM content.public_file_versions WITH (UPDLOCK,HOLDLOCK) WHERE public_file_key=@publicFileKey),0)+1;
          UPDATE content.public_file_versions SET is_current=0 WHERE public_file_key=@publicFileKey AND is_current=1;
          INSERT content.public_file_versions(public_file_key,version_no,file_key,is_current,created_at,created_by)
          VALUES(@publicFileKey,@version,@fileKey,1,@now,@actorId);
        `);
      }
      await writeSqlAuditLog(transaction, {
        entityType: "publicFile", entityId: after.id,
        action: replacedFile ? "public_file_replaced" : "public_file_updated",
        performedBy: actor.id, performedByEmail: actor.email, before, after,
        metadata: replacedFile
          ? { previousFileName: before.archivoNombreOriginal, newFileName: after.archivoNombreOriginal, assetKind: after.assetKind }
          : undefined,
      });
      return after;
    });
  } catch (error) {
    if (uniqueError(error)) throw Object.assign(new Error("Ya existe un archivo público con ese endpoint."), { status: 409 });
    throw error;
  }
}

export async function deleteSqlPublicFile(record: PublicFileRecord, actor: Actor): Promise<boolean> {
  return runSqlTransaction(async (transaction) => {
    const request = new sql.Request(transaction);
    request.input("sourceId", sql.NVarChar(150), record.id);
    request.input("now", sql.DateTime2(3), new Date());
    request.input("actorId", sql.NVarChar(150), actor.id);
    const result = await request.query(`
      UPDATE content.public_files SET active=0,status='deleted',deleted_at=@now,deleted_by=@actorId,
        updated_at=@now,updated_by=@actorId WHERE source_id=@sourceId AND status<>'deleted';
      SELECT @@ROWCOUNT AS updated_count;
    `);
    if (Number(result.recordset[0]?.updated_count ?? 0) !== 1) return false;
    await writeSqlAuditLog(transaction, {
      entityType: "publicFile", entityId: record.id, action: "public_file_deleted",
      performedBy: actor.id, performedByEmail: actor.email, before: record,
      after: { ...record, activo: false, status: "deleted" },
    });
    return true;
  });
}
