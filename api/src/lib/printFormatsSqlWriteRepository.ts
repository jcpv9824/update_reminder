import sql from "mssql";
import type { FormatoImpresionRecord, FuenteFormatoRecord } from "../types/models";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { runSqlTransaction } from "./sqlTransaction";

type Actor = { id: string; email: string };
const normalized = (value: string) => value.trim().toLocaleLowerCase("es-CO");

async function sourceKey(transaction: sql.Transaction, id: string, activeOnly = false): Promise<number | null> {
  const request = new sql.Request(transaction);
  request.input("sourceId", sql.NVarChar(150), id);
  const result = await request.query<{ print_format_source_key: number }>(`
    SELECT print_format_source_key FROM content.print_format_sources WITH (UPDLOCK,HOLDLOCK)
    WHERE source_id=@sourceId AND status<>'deleted' ${activeOnly ? "AND active=1" : ""};
  `);
  return result.recordset[0]?.print_format_source_key ?? null;
}

export async function createSqlPrintSource(record: FuenteFormatoRecord, actor: Actor): Promise<FuenteFormatoRecord> {
  return runSqlTransaction(async (transaction) => {
    const request = new sql.Request(transaction);
    request.input("sourceId", sql.NVarChar(150), record.id);
    request.input("name", sql.NVarChar(200), record.nombre);
    request.input("normalized", sql.NVarChar(200), normalized(record.nombre));
    request.input("active", sql.Bit, record.activa);
    request.input("status", sql.VarChar(20), record.status);
    request.input("now", sql.DateTime2(3), new Date(record.createdAt));
    request.input("actorId", sql.NVarChar(150), actor.id);
    await request.query(`
      INSERT content.print_format_sources
        (source_id,name,name_normalized,active,status,created_at,created_by,updated_at,updated_by)
      VALUES(@sourceId,@name,@normalized,@active,@status,@now,@actorId,@now,@actorId);
    `);
    await writeSqlAuditLog(transaction, { entityType: "fuenteFormato", entityId: record.id,
      action: "fuente_formato_created", performedBy: actor.id, performedByEmail: actor.email, after: record });
    return record;
  });
}

export async function updateSqlPrintSource(before: FuenteFormatoRecord, after: FuenteFormatoRecord, actor: Actor): Promise<FuenteFormatoRecord | null> {
  return runSqlTransaction(async (transaction) => {
    if (!await sourceKey(transaction, before.id)) return null;
    const request = new sql.Request(transaction);
    request.input("sourceId", sql.NVarChar(150), after.id);
    request.input("name", sql.NVarChar(200), after.nombre);
    request.input("normalized", sql.NVarChar(200), normalized(after.nombre));
    request.input("active", sql.Bit, after.activa);
    request.input("status", sql.VarChar(20), after.status);
    request.input("updatedAt", sql.DateTime2(3), new Date(after.updatedAt));
    request.input("updatedBy", sql.NVarChar(150), actor.id);
    await request.query(`
      UPDATE content.print_format_sources SET name=@name,name_normalized=@normalized,
        active=@active,status=@status,updated_at=@updatedAt,updated_by=@updatedBy WHERE source_id=@sourceId;
    `);
    await writeSqlAuditLog(transaction, { entityType: "fuenteFormato", entityId: after.id,
      action: "fuente_formato_updated", performedBy: actor.id, performedByEmail: actor.email, before, after });
    return after;
  });
}

export async function deleteSqlPrintSource(record: FuenteFormatoRecord, actor: Actor): Promise<{ found: boolean; formats: number }> {
  return runSqlTransaction(async (transaction) => {
    const key = await sourceKey(transaction, record.id);
    if (!key) return { found: false, formats: 0 };
    const dependencies = new sql.Request(transaction);
    dependencies.input("sourceKey", sql.BigInt, key);
    const count = await dependencies.query<{ count: number }>(`
      SELECT COUNT_BIG(*) AS count FROM content.print_format_source_assignments assignment WITH (UPDLOCK,HOLDLOCK)
      JOIN content.print_formats format_record ON format_record.print_format_key=assignment.print_format_key
      WHERE assignment.print_format_source_key=@sourceKey AND format_record.status<>'deleted';
    `);
    const formats = Number(count.recordset[0]?.count ?? 0);
    if (formats) return { found: true, formats };
    const now = new Date();
    const remove = new sql.Request(transaction);
    remove.input("sourceKey", sql.BigInt, key);
    remove.input("now", sql.DateTime2(3), now);
    remove.input("actorId", sql.NVarChar(150), actor.id);
    await remove.query(`UPDATE content.print_format_sources SET active=0,status='deleted',deleted_at=@now,
      deleted_by=@actorId,updated_at=@now,updated_by=@actorId WHERE print_format_source_key=@sourceKey;`);
    await writeSqlAuditLog(transaction, { entityType: "fuenteFormato", entityId: record.id,
      action: "fuente_formato_deleted", performedBy: actor.id, performedByEmail: actor.email, before: record,
      after: { ...record, activa: false, status: "deleted" } });
    return { found: true, formats: 0 };
  });
}

async function ensurePdfFile(transaction: sql.Transaction, record: FormatoImpresionRecord, actorId: string): Promise<number> {
  if (record.pdfStorageProvider !== "s3" || !record.pdfStorageBucket || !record.pdfObjectKey || !record.pdfSha256) {
    throw Object.assign(new Error("SQL requiere que el PDF esté almacenado en S3/MinIO."), { status: 503 });
  }
  const sha = Buffer.from(record.pdfSha256, "hex");
  const request = new sql.Request(transaction);
  request.input("bucket", sql.NVarChar(255), record.pdfStorageBucket);
  request.input("objectKey", sql.NVarChar(1024), record.pdfObjectKey);
  request.input("objectEtag", sql.NVarChar(200), record.pdfObjectEtag ?? null);
  request.input("originalName", sql.NVarChar(260), record.pdfNombreOriginal);
  request.input("byteCount", sql.BigInt, record.pdfBytes ?? 1);
  request.input("sha", sql.VarBinary(32), sha);
  request.input("actorId", sql.NVarChar(150), actorId);
  const result = await request.query<{ file_key: number }>(`
    DECLARE @fileKey BIGINT=(SELECT file_key FROM content.files WITH (UPDLOCK,HOLDLOCK)
      WHERE storage_provider='s3' AND storage_bucket=@bucket AND object_key=@objectKey);
    IF @fileKey IS NULL BEGIN
      INSERT content.files(storage_provider,storage_bucket,object_key,object_etag,original_name,mime_type,byte_count,content_sha256,created_by)
      VALUES('s3',@bucket,@objectKey,@objectEtag,@originalName,N'application/pdf',@byteCount,@sha,@actorId);
      SET @fileKey=SCOPE_IDENTITY();
    END
    SELECT @fileKey AS file_key;
  `);
  return result.recordset[0].file_key;
}

async function resolveSourceKeys(transaction: sql.Transaction, sourceIds: string[]): Promise<number[]> {
  const keys: number[] = [];
  for (const id of [...new Set(sourceIds)]) {
    const key = await sourceKey(transaction, id);
    if (!key) throw Object.assign(new Error("Uno o más tipos de fuente no existen."), { status: 400 });
    keys.push(key);
  }
  if (!keys.length) throw Object.assign(new Error("Seleccione al menos un tipo de fuente."), { status: 400 });
  if (keys.length > 50) throw Object.assign(new Error("Un formato no puede tener más de 50 tipos de fuente."), { status: 400 });
  return keys;
}

async function replaceSources(transaction: sql.Transaction, formatKey: number, sourceIds: string[], actorId: string, at: Date): Promise<number> {
  const keys = await resolveSourceKeys(transaction, sourceIds);
  const remove = new sql.Request(transaction);
  remove.input("formatKey", sql.BigInt, formatKey);
  await remove.query("DELETE content.print_format_source_assignments WHERE print_format_key=@formatKey;");
  for (const [order, key] of keys.entries()) {
    const insert = new sql.Request(transaction);
    insert.input("formatKey", sql.BigInt, formatKey);
    insert.input("sourceKey", sql.BigInt, key);
    insert.input("displayOrder", sql.SmallInt, order);
    insert.input("assignedAt", sql.DateTime2(3), at);
    insert.input("assignedBy", sql.NVarChar(150), actorId);
    await insert.query(`INSERT content.print_format_source_assignments
      (print_format_key,print_format_source_key,display_order,assigned_at,assigned_by)
      VALUES(@formatKey,@sourceKey,@displayOrder,@assignedAt,@assignedBy);`);
  }
  return keys[0];
}

async function preparePrimarySourceForUpdate(
  transaction: sql.Transaction,
  formatKey: number,
  currentPrimaryKey: number,
  desiredPrimaryKey: number,
  actorId: string,
  at: Date,
): Promise<void> {
  const lookup = new sql.Request(transaction);
  lookup.input("formatKey", sql.BigInt, formatKey);
  const assignments = await lookup.query<{ print_format_source_key: number; display_order: number }>(`
    SELECT print_format_source_key,display_order
    FROM content.print_format_source_assignments WITH (UPDLOCK,HOLDLOCK)
    WHERE print_format_key=@formatKey ORDER BY display_order;
  `);
  if (assignments.recordset.some((row) => Number(row.print_format_source_key) === desiredPrimaryKey)) return;

  let availableOrder: number | undefined;
  const removable = assignments.recordset.find((row) => Number(row.print_format_source_key) !== currentPrimaryKey);
  if (removable) {
    const remove = new sql.Request(transaction);
    remove.input("formatKey", sql.BigInt, formatKey);
    remove.input("sourceKey", sql.BigInt, removable.print_format_source_key);
    await remove.query(`DELETE content.print_format_source_assignments
      WHERE print_format_key=@formatKey AND print_format_source_key=@sourceKey;`);
    availableOrder = Number(removable.display_order);
  } else {
    const used = new Set(assignments.recordset.map((row) => Number(row.display_order)));
    availableOrder = Array.from({ length: 50 }, (_, index) => index).find((order) => !used.has(order));
  }
  if (availableOrder === undefined) throw new Error("No fue posible reservar la fuente principal del formato.");
  const insert = new sql.Request(transaction);
  insert.input("formatKey", sql.BigInt, formatKey);
  insert.input("sourceKey", sql.BigInt, desiredPrimaryKey);
  insert.input("displayOrder", sql.SmallInt, availableOrder);
  insert.input("assignedAt", sql.DateTime2(3), at);
  insert.input("assignedBy", sql.NVarChar(150), actorId);
  await insert.query(`INSERT content.print_format_source_assignments
    (print_format_key,print_format_source_key,display_order,assigned_at,assigned_by)
    VALUES(@formatKey,@sourceKey,@displayOrder,@assignedAt,@assignedBy);`);
}

async function finalizeSourcesAfterPrimaryUpdate(
  transaction: sql.Transaction,
  formatKey: number,
  keys: number[],
  actorId: string,
  at: Date,
): Promise<void> {
  const primaryKey = keys[0];
  const reset = new sql.Request(transaction);
  reset.input("formatKey", sql.BigInt, formatKey);
  reset.input("primaryKey", sql.BigInt, primaryKey);
  await reset.query(`
    DELETE content.print_format_source_assignments
    WHERE print_format_key=@formatKey AND print_format_source_key<>@primaryKey;
    UPDATE content.print_format_source_assignments SET display_order=0
    WHERE print_format_key=@formatKey AND print_format_source_key=@primaryKey;
  `);
  for (const [order, key] of keys.slice(1).entries()) {
    const insert = new sql.Request(transaction);
    insert.input("formatKey", sql.BigInt, formatKey);
    insert.input("sourceKey", sql.BigInt, key);
    insert.input("displayOrder", sql.SmallInt, order + 1);
    insert.input("assignedAt", sql.DateTime2(3), at);
    insert.input("assignedBy", sql.NVarChar(150), actorId);
    await insert.query(`INSERT content.print_format_source_assignments
      (print_format_key,print_format_source_key,display_order,assigned_at,assigned_by)
      VALUES(@formatKey,@sourceKey,@displayOrder,@assignedAt,@assignedBy);`);
  }
}

function formatSourceIds(record: FormatoImpresionRecord): string[] {
  return record.fuenteIds?.length ? record.fuenteIds : [record.fuenteId];
}

async function moduleKey(transaction: sql.Transaction, record: FormatoImpresionRecord): Promise<number | null> {
  if (!record.requiereLicencia) return null;
  const request = new sql.Request(transaction);
  request.input("moduleId", sql.NVarChar(150), record.licenciaModuloId ?? null);
  const result = await request.query<{ module_key: number }>(`SELECT module_key FROM licensing.license_modules
    WHERE source_id=@moduleId AND status='active';`);
  if (!result.recordset[0]) throw Object.assign(new Error("La licencia seleccionada no existe o está inactiva."), { status: 400 });
  return result.recordset[0].module_key;
}

export async function createSqlPrintFormat(record: FormatoImpresionRecord, actor: Actor): Promise<FormatoImpresionRecord> {
  return runSqlTransaction(async (transaction) => {
    const primarySource = await sourceKey(transaction, record.fuenteId, true);
    if (!primarySource) throw Object.assign(new Error("El tipo de fuente principal no está activo."), { status: 400 });
    const license = await moduleKey(transaction, record);
    const file = await ensurePdfFile(transaction, record, actor.id);
    const request = new sql.Request(transaction);
    request.input("sourceId", sql.NVarChar(150), record.id); request.input("primarySource", sql.BigInt, primarySource);
    request.input("name", sql.NVarChar(240), record.nombre); request.input("normalized", sql.NVarChar(240), normalized(record.nombre));
    request.input("description", sql.NVarChar(sql.MAX), record.descripcion); request.input("size", sql.VarChar(30), record.tamanoFormato ?? null);
    request.input("customSize", sql.NVarChar(100), record.tamanoFormatoPersonalizado ?? null); request.input("requiresLicense", sql.Bit, !!record.requiereLicencia);
    request.input("moduleKey", sql.BigInt, license); request.input("active", sql.Bit, record.activo); request.input("status", sql.VarChar(20), record.status);
    request.input("now", sql.DateTime2(3), new Date(record.createdAt)); request.input("actorId", sql.NVarChar(150), actor.id); request.input("fileKey", sql.BigInt, file);
    const inserted = await request.query<{ print_format_key: number }>(`
      INSERT content.print_formats(source_id,print_format_source_key,name,name_normalized,description,format_size,
        custom_format_size,requires_license,module_key,active,status,created_at,created_by,updated_at,updated_by)
      OUTPUT INSERTED.print_format_key
      VALUES(@sourceId,@primarySource,@name,@normalized,@description,@size,@customSize,@requiresLicense,@moduleKey,
        @active,@status,@now,@actorId,@now,@actorId);
    `);
    const formatKey = inserted.recordset[0].print_format_key;
    await replaceSources(transaction, formatKey, formatSourceIds(record), actor.id, new Date(record.createdAt));
    const version = new sql.Request(transaction);
    version.input("formatKey", sql.BigInt, formatKey); version.input("fileKey", sql.BigInt, file); version.input("now", sql.DateTime2(3), new Date(record.createdAt)); version.input("actorId", sql.NVarChar(150), actor.id);
    await version.query(`INSERT content.print_format_files(print_format_key,version_no,file_key,is_current,created_at,created_by)
      VALUES(@formatKey,1,@fileKey,1,@now,@actorId);`);
    await writeSqlAuditLog(transaction, { entityType: "formatoImpresion", entityId: record.id,
      action: "formato_impresion_created", performedBy: actor.id, performedByEmail: actor.email, after: record, metadata: { pdfLoaded: true } });
    return record;
  });
}

export async function updateSqlPrintFormat(before: FormatoImpresionRecord, after: FormatoImpresionRecord, actor: Actor, replacePdf: boolean): Promise<FormatoImpresionRecord | null> {
  return runSqlTransaction(async (transaction) => {
    const lookup = new sql.Request(transaction); lookup.input("sourceId", sql.NVarChar(150), after.id);
    const found = await lookup.query<{ print_format_key: number; print_format_source_key: number }>(`SELECT print_format_key,print_format_source_key FROM content.print_formats WITH (UPDLOCK,HOLDLOCK)
      WHERE source_id=@sourceId AND status<>'deleted';`);
    const formatKey = found.recordset[0]?.print_format_key; if (!formatKey) return null;
    const primarySource = await sourceKey(transaction, after.fuenteId); if (!primarySource) throw Object.assign(new Error("El tipo de fuente principal no existe."), { status: 400 });
    const desiredSourceKeys = await resolveSourceKeys(transaction, formatSourceIds(after));
    if (desiredSourceKeys[0] !== primarySource) throw Object.assign(new Error("La fuente principal debe ser la primera fuente asignada."), { status: 400 });
    await preparePrimarySourceForUpdate(transaction, formatKey, Number(found.recordset[0].print_format_source_key),
      primarySource, actor.id, new Date(after.updatedAt));
    const license = await moduleKey(transaction, after);
    const request = new sql.Request(transaction);
    request.input("formatKey", sql.BigInt, formatKey); request.input("primarySource", sql.BigInt, primarySource);
    request.input("name", sql.NVarChar(240), after.nombre); request.input("normalized", sql.NVarChar(240), normalized(after.nombre)); request.input("description", sql.NVarChar(sql.MAX), after.descripcion);
    request.input("size", sql.VarChar(30), after.tamanoFormato ?? null); request.input("customSize", sql.NVarChar(100), after.tamanoFormatoPersonalizado ?? null);
    request.input("requiresLicense", sql.Bit, !!after.requiereLicencia); request.input("moduleKey", sql.BigInt, license); request.input("active", sql.Bit, after.activo); request.input("status", sql.VarChar(20), after.status);
    request.input("updatedAt", sql.DateTime2(3), new Date(after.updatedAt)); request.input("updatedBy", sql.NVarChar(150), actor.id);
    await request.query(`UPDATE content.print_formats SET print_format_source_key=@primarySource,name=@name,name_normalized=@normalized,
      description=@description,format_size=@size,custom_format_size=@customSize,requires_license=@requiresLicense,module_key=@moduleKey,
      active=@active,status=@status,updated_at=@updatedAt,updated_by=@updatedBy WHERE print_format_key=@formatKey;`);
    await finalizeSourcesAfterPrimaryUpdate(transaction, formatKey, desiredSourceKeys, actor.id, new Date(after.updatedAt));
    if (replacePdf) {
      const file = await ensurePdfFile(transaction, after, actor.id); const version = new sql.Request(transaction);
      version.input("formatKey", sql.BigInt, formatKey); version.input("fileKey", sql.BigInt, file); version.input("now", sql.DateTime2(3), new Date(after.updatedAt)); version.input("actorId", sql.NVarChar(150), actor.id);
      await version.query(`DECLARE @version INT=ISNULL((SELECT MAX(version_no) FROM content.print_format_files WITH (UPDLOCK,HOLDLOCK) WHERE print_format_key=@formatKey),0)+1;
        UPDATE content.print_format_files SET is_current=0 WHERE print_format_key=@formatKey AND is_current=1;
        INSERT content.print_format_files(print_format_key,version_no,file_key,is_current,created_at,created_by) VALUES(@formatKey,@version,@fileKey,1,@now,@actorId);`);
    }
    await writeSqlAuditLog(transaction, { entityType: "formatoImpresion", entityId: after.id,
      action: replacePdf ? "formato_impresion_pdf_replaced" : "formato_impresion_updated", performedBy: actor.id, performedByEmail: actor.email,
      before, after, metadata: replacePdf ? { previousPdfName: before.pdfNombreOriginal, newPdfName: after.pdfNombreOriginal } : undefined });
    return after;
  });
}

export async function deleteSqlPrintFormat(record: FormatoImpresionRecord, actor: Actor): Promise<boolean> {
  return runSqlTransaction(async (transaction) => {
    const request = new sql.Request(transaction); request.input("sourceId", sql.NVarChar(150), record.id); request.input("now", sql.DateTime2(3), new Date()); request.input("actorId", sql.NVarChar(150), actor.id);
    const result = await request.query(`UPDATE content.print_formats SET active=0,status='deleted',deleted_at=@now,deleted_by=@actorId,
      updated_at=@now,updated_by=@actorId WHERE source_id=@sourceId AND status<>'deleted'; SELECT @@ROWCOUNT AS updated_count;`);
    if (Number(result.recordset[0]?.updated_count ?? 0) !== 1) return false;
    await writeSqlAuditLog(transaction, { entityType: "formatoImpresion", entityId: record.id,
      action: "formato_impresion_deleted", performedBy: actor.id, performedByEmail: actor.email, before: record, after: { ...record, activo: false, status: "deleted" } });
    return true;
  });
}
