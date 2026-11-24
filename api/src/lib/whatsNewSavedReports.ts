import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { ensureSqlContentFile } from "./contentFileSqlWriter";
import { readPrivateSeaweedFSBuffer, storePrivateObject } from "./objectStorage";
import { getSqlPool } from "./sql";
import { runSqlTransaction } from "./sqlTransaction";
import { access, requirePermission, type WhatsNewActor } from "./whatsNewAccess";
import { WhatsNewError } from "./whatsNewModel";
import { ReportInput, reportSnapshot } from "./whatsNewService";
import { query, type Db } from "./whatsNewSqlRepository";
import { requestFingerprint } from "./whatsNewSqlWriteRepository";

const MAX_BYTES = 2_000_000;
const MIME = "text/html";
const missing = () => new WhatsNewError(404, "no_encontrado", "No encontrado.");
const unavailable = () => new WhatsNewError(503, "almacenamiento_no_disponible", "El almacenamiento privado del reporte no está disponible.");
const visible = "w.report_key IS NULL AND (@admin=1 OR u.source_id=@actor)";
const matchesId = z.string().uuid();
const listInput = z.object({ page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20) }).strict();
const actorParams = (actor: WhatsNewActor) => ({ actor: actor.id, admin: access.superAdmin(actor) });
const reportFrom = `FROM whats_new.reports r
  JOIN security.users u ON u.user_key=r.generated_by_user_key
  LEFT JOIN whats_new.report_withdrawals w ON w.report_key=r.report_key`;

export async function listSavedReports(actor: WhatsNewActor, input: unknown) {
  requirePermission(actor, access.savedReports);
  const { page, pageSize } = listInput.parse(input);
  const params = { ...actorParams(actor), offset: (page - 1) * pageSize, size: pageSize };
  return runSqlTransaction(async db => {
    const [count] = await query(db, `SELECT COUNT_BIG(*) total ${reportFrom} WHERE ${visible};`, params);
    const rows = await query(db, `SELECT r.source_id id,r.generated_at generatedAt,u.source_id generatedById,
      u.display_name generatedByName,r.entry_count entryCount,r.approved_count approvedCount,r.failed_count failedCount
      ${reportFrom} WHERE ${visible}
      ORDER BY r.generated_at DESC,r.report_key DESC OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY;`, params);
    return { items: rows.map(row => ({ id: row.id as string, generatedAt: (row.generatedAt as Date).toISOString(),
      generatedBy: { id: row.generatedById as string, displayName: row.generatedByName as string }, entryCount: Number(row.entryCount),
      approvedCount: Number(row.approvedCount), failedCount: Number(row.failedCount), canDelete: true })),
    total: Number(count.total), page, pageSize };
  });
}

type SaveMarker = { id: string; filters: string | null; removed: number };
async function priorReport(db: Db, actor: WhatsNewActor, key: string, marker: string, lock = false) {
  const [r] = await query<SaveMarker>(db, `SELECT r.source_id id,r.filters_json filters,
    CASE WHEN w.report_key IS NULL THEN 0 ELSE 1 END removed
    FROM whats_new.reports r ${lock ? "WITH (UPDLOCK,HOLDLOCK)" : ""}
    JOIN security.users u ON u.user_key=r.generated_by_user_key
    LEFT JOIN whats_new.report_withdrawals w ON w.report_key=r.report_key
    WHERE u.source_id=@actor AND r.idempotency_key=@key;`, { actor: actor.id, key });
  if (!r) return undefined;
  if (r.filters !== marker || r.removed) {
    throw new WhatsNewError(409, "llave_idempotencia_reutilizada", "Esa llave ya corresponde a otra operación o a un reporte retirado.");
  }
  return { id: r.id, replayed: true };
}

export async function savePrivateReport(actor: WhatsNewActor, input: unknown, key: string) {
  requirePermission(actor, access.savedReports);
  const body = ReportInput.parse(input);
  const marker = JSON.stringify({ ...body.filters, requestHash: requestFingerprint("save-private-report", null, body).toString("hex") });
  const replay = await priorReport(await getSqlPool(), actor, key, marker);
  if (replay) return replay;
  const snapshot = await reportSnapshot(actor, body);
  if (!snapshot.entryCount) throw new WhatsNewError(422, "reporte_vacio", "No hay entradas probadas con estos filtros.");
  const bytes = Buffer.from(snapshot.html, "utf8");
  if (bytes.length > MAX_BYTES) throw new WhatsNewError(422, "reporte_muy_grande", "El reporte supera el tamaño permitido. Limite el rango.");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const stored = await storePrivateObject({ bytes, sha256: sha, extension: ".html", mimeType: MIME, requiredProvider: "seaweedfs" })
    .catch(() => { throw unavailable(); });
  if (stored.storageProvider !== "s3") throw unavailable();
  // Recheck current result versions after object I/O. No transaction is held
  // open across storage, and a failed write never deletes a shared object.
  return runSqlTransaction(async db => {
    const already = await priorReport(db, actor, key, marker, true);
    if (already) return already;
    const evidence = JSON.stringify(snapshot.entries.map(e => ({ id: e.id,
      version: Buffer.from(e.etag.slice(1, -1), "base64").toString("hex") })));
    const [current] = await query(db, `SELECT COUNT_BIG(*) total
      FROM OPENJSON(@evidence) WITH (id NVARCHAR(150) '$.id', version VARCHAR(16) '$.version') v
      JOIN whats_new.entries e WITH (HOLDLOCK) ON e.source_id=v.id AND e.row_version=TRY_CONVERT(binary(8),v.version,2)
      WHERE e.status IN ('probado','archivada','fallida');`, { evidence });
    if (Number(current.total) !== snapshot.entryCount) {
      throw new WhatsNewError(409, "version_desactualizada", "Las entradas del reporte cambiaron. Genere una nueva vista previa.");
    }
    const id = randomUUID(), now = new Date();
    const file = await ensureSqlContentFile(db, { ...stored, originalName: "reporte-novedades.html",
      mimeType: MIME, byteCount: bytes.length, sha256: sha }, actor.id);
    const [created] = await query(db, `INSERT whats_new.reports
      (source_id,include_mode,filters_json,entry_count,approved_count,failed_count,recipient_count,file_key,snapshot_sha256,
       generated_by_user_key,generated_at,idempotency_key)
      OUTPUT inserted.report_key AS reportKey
      SELECT @id,@mode,@marker,@total,@approved,@failed,0,@file,@hash,user_key,@now,@key
      FROM security.users WHERE source_id=@actor AND active=1;`, { id, mode: body.include, marker, total: snapshot.entryCount,
      approved: snapshot.approvedCount, failed: snapshot.failedCount, file, hash: Buffer.from(sha, "hex"), actor: actor.id, now, key });
    if (!created) throw new WhatsNewError(401, "no_autenticado", "No autenticado.");
    await query(db, `INSERT whats_new.report_entries(report_key,entry_key,status_snapshot,revision_no,round_count,finding_count)
      SELECT @report,e.entry_key,CASE WHEN e.status='archivada' THEN 'probado' ELSE e.status END,
        e.current_revision_no,(SELECT COUNT(*) FROM whats_new.test_rounds r WHERE r.entry_key=e.entry_key),
        (SELECT COUNT(*) FROM whats_new.findings f WHERE f.entry_key=e.entry_key)
      FROM OPENJSON(@evidence) WITH (id NVARCHAR(150) '$.id') v JOIN whats_new.entries e ON e.source_id=v.id;`,
    { report: Number(created.reportKey), evidence });
    await writeSqlAuditLog(db, { entityType: "whats_new_report", entityId: id, action: "whats_new_report_saved",
      performedBy: actor.id, performedByEmail: actor.email, metadata: { entryCount: snapshot.entryCount } });
    return { id, replayed: false };
  });
}

export async function readSavedReport(actor: WhatsNewActor, id: string) {
  requirePermission(actor, access.savedReports);
  if (!matchesId.safeParse(id).success) throw missing();
  const db = await getSqlPool();
  const params = { id, ...actorParams(actor) };
  const [r] = await query(db, `SELECT c.storage_provider provider,c.storage_bucket bucket,c.object_key objectKey,
    c.object_etag etag,c.byte_count bytes,c.mime_type mime,r.snapshot_sha256 sha
    ${reportFrom}
    JOIN content.files c ON c.file_key=r.file_key AND c.content_sha256=r.snapshot_sha256
    WHERE r.source_id=@id AND ${visible};`, params);
  if (!r) throw missing();
  const count = Number(r.bytes);
  if (r.provider !== "s3" || r.mime !== MIME || !Number.isSafeInteger(count) || count < 1 || count > MAX_BYTES ||
    !Buffer.isBuffer(r.sha) || r.sha.length !== 32) throw unavailable();
  const bytes = await readPrivateSeaweedFSBuffer({ storageProvider: "s3", storageBucket: r.bucket, storageObjectKey: r.objectKey,
    storageObjectEtag: r.etag ?? undefined }, count, r.sha.toString("hex")).catch(() => { throw unavailable(); });
  const [stillVisible] = await query(db, `SELECT 1 visible ${reportFrom} WHERE r.source_id=@id AND ${visible};`, params);
  if (!stillVisible) throw missing();
  return bytes;
}

export async function withdrawSavedReport(actor: WhatsNewActor, id: string) {
  requirePermission(actor, access.savedReports);
  if (!matchesId.safeParse(id).success) throw missing();
  await runSqlTransaction(async db => {
    const [r] = await query(db, `SELECT r.report_key reportKey
      FROM whats_new.reports r WITH (UPDLOCK,HOLDLOCK)
      JOIN security.users u ON u.user_key=r.generated_by_user_key WHERE r.source_id=@id AND (@admin=1 OR u.source_id=@actor);`,
    { id, ...actorParams(actor) });
    if (!r) throw missing();
    const [changed] = await query(db, `INSERT whats_new.report_withdrawals(report_key,withdrawn_by_user_key,withdrawn_at)
      OUTPUT inserted.report_key
      SELECT @report,u.user_key,SYSUTCDATETIME() FROM security.users u WHERE u.source_id=@actor AND u.active=1
      AND NOT EXISTS (SELECT 1 FROM whats_new.report_withdrawals WITH (UPDLOCK,HOLDLOCK) WHERE report_key=@report);`,
    { actor: actor.id, report: Number(r.reportKey) });
    if (!changed) return; // retry is harmless; history is not rewritten
    await writeSqlAuditLog(db, { entityType: "whats_new_report", entityId: id, action: "whats_new_report_withdrawn",
      performedBy: actor.id, performedByEmail: actor.email });
  });
}
