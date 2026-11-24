import { createHash, randomUUID } from "node:crypto";
import { ensureSqlContentFile } from "./contentFileSqlWriter";
import { writeSqlAuditLog } from "./auditSqlWriter";
import {
  getObjectStorageProvider, isObjectStorageConfigured, readPrivateSeaweedFSBuffer, storePrivateObject,
} from "./objectStorage";
import { fileExtension, inspectPublicInlineFile, sanitizePublicFileName } from "./publicDownloadFiles";
import { getSqlPool } from "./sql";
import { runSqlTransaction } from "./sqlTransaction";
import { access, assertCanSeeEntry, requireView, type WhatsNewActor } from "./whatsNewAccess";
import { WhatsNewError, type EntryStatus, type EntryType } from "./whatsNewModel";
import { query, type Db } from "./whatsNewSqlRepository";

const IMAGE_BYTES = 5_000_000;
const DOCUMENT_BYTES = 20_000_000;
const VIDEO_BYTES = 30_000_000;
export const WHATS_NEW_UPLOAD_BODY_MAX = VIDEO_BYTES + 32_768;
const LIMIT_PER_ENTRY = 48;
const FILE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export type MediaKind = "imagen" | "documento" | "video";
export type MediaTarget = "que_cambio" | "reglas_negocio" | "video";
const officeMime = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;
const extensions: Record<MediaKind, ReadonlySet<string>> = {
  imagen: new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]),
  documento: new Set([".pdf", ...Object.keys(officeMime)]),
  video: new Set([".mp4", ".webm"]),
};
const limit: Record<MediaKind, number> = { imagen: IMAGE_BYTES, documento: DOCUMENT_BYTES, video: VIDEO_BYTES };
const mimeByKind: Record<MediaKind, ReadonlySet<string>> = {
  imagen: new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  documento: new Set(["application/pdf", ...Object.values(officeMime)]),
  video: new Set(["video/mp4", "video/webm"]),
};

const unavailable = () => new WhatsNewError(503, "almacenamiento_no_disponible", "El almacenamiento privado de archivos no está disponible.");
const invalid = () => new WhatsNewError(400, "archivo_invalido", "Seleccione un archivo permitido para esta sección.");
const tooBig = () => new WhatsNewError(413, "contenido_muy_grande", "El archivo supera el tamaño permitido.");
const missing = () => new WhatsNewError(404, "no_encontrado", "No encontrado.");

export function whatsNewMediaAvailable() {
  if (process.env.WHATS_NEW_MEDIA_ENABLED !== "true") return false;
  try { return getObjectStorageProvider() === "seaweedfs" && isObjectStorageConfigured(); }
  catch { return false; }
}

export function parseWhatsNewMediaFields(kind: unknown, target: unknown): { kind: MediaKind; target: MediaTarget } {
  if ((kind !== "imagen" && kind !== "documento" && kind !== "video") ||
      (target !== "que_cambio" && target !== "reglas_negocio" && target !== "video") ||
      (target === "reglas_negocio" && kind !== "documento") || (target === "video" && kind !== "video")) throw invalid();
  return { kind, target };
}
export function assertWhatsNewMediaSize(kind: MediaKind, size: number) {
  if (!Number.isSafeInteger(size) || size < 1) throw invalid();
  if (size > limit[kind]) throw tooBig();
}

// Only inspect bounded ZIP directory metadata. Never open or expand Office content.
function officeContainerMatches(bytes: Buffer, expected: string): boolean {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) return false;
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65_557); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
  }
  if (end < 0 || bytes.readUInt32LE(end + 4) !== 0) return false;
  const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12);
  const directory = bytes.readUInt32LE(end + 16);
  if (!count || count > 4096 || bytes.readUInt16LE(end + 8) !== count || directory + directorySize !== end) return false;
  const paths = new Set<string>();
  let pos = directory;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || bytes.readUInt32LE(pos) !== 0x02014b50 || (bytes.readUInt16LE(pos + 8) & 0x41) || bytes.readUInt16LE(pos + 34) !== 0) return false;
    const nameLen = bytes.readUInt16LE(pos + 28), local = bytes.readUInt32LE(pos + 42);
    const next = pos + 46 + nameLen + bytes.readUInt16LE(pos + 30) + bytes.readUInt16LE(pos + 32);
    if (!nameLen || next > end || local + 30 + nameLen > directory || bytes.readUInt32LE(local) !== 0x04034b50 ||
      (bytes.readUInt16LE(local + 6) & 0x41) || bytes.readUInt16LE(local + 26) !== nameLen) return false;
    const localEnd = local + 30 + nameLen + bytes.readUInt16LE(local + 28) + bytes.readUInt32LE(pos + 20);
    if (localEnd > directory) return false;
    const name = bytes.subarray(pos + 46, pos + 46 + nameLen);
    if (!name.equals(bytes.subarray(local + 30, local + 30 + nameLen))) return false;
    const path = name.toString("utf8").toLowerCase();
    if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..") ||
        /[\x00-\x1f\ufffd]/.test(path) || /(?:^|\/)vbaproject(?:signature)?\.bin$/.test(path) || paths.has(path)) return false;
    paths.add(path); pos = next;
  }
  return pos === end && paths.has("[content_types].xml") && paths.has(expected);
}
export function inspectWhatsNewMedia(fields: { kind: MediaKind; target: MediaTarget }, filename: string, bytes: Buffer) {
  const { kind, target } = parseWhatsNewMediaFields(fields.kind, fields.target);
  assertWhatsNewMediaSize(kind, bytes.length);
  const clean = sanitizePublicFileName(filename.replace(/[\p{C}]/gu, "-"));
  if (!clean || clean.length > 200 || !extensions[kind].has(fileExtension(clean))) throw invalid();
  if (kind === "documento") {
    const extension = fileExtension(clean);
    let mime = "application/pdf";
    if (extension === ".docx" || extension === ".xlsx") {
      if (!officeContainerMatches(bytes, extension === ".docx" ? "word/document.xml" : "xl/workbook.xml")) throw invalid();
      mime = officeMime[extension];
    } else if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw invalid();
    return { kind, target, name: clean, mime, bytes, extension,
      sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  try {
    const inspected = inspectPublicInlineFile(clean, bytes);
    if (!mimeByKind[kind].has(inspected.mimeType)) throw invalid();
    return { kind, target, name: inspected.filename, mime: inspected.mimeType, bytes,
      extension: inspected.extension === ".jpeg" ? ".jpg" : inspected.extension, sha256: inspected.sha256 };
  } catch { throw invalid(); }
}
type Upload = ReturnType<typeof inspectWhatsNewMedia>;
type MediaEntry = { entryKey: number; status: EntryStatus; type: EntryType | null; developerId: string };

export function assertCanUploadWhatsNewMedia(actor: WhatsNewActor, entry: MediaEntry, target?: MediaTarget) {
  assertCanSeeEntry(actor, entry);
  if (!(entry.developerId === actor.id && access.developer(actor)) &&
      !(access.manage(actor) && (entry.status === "sin_probar" || entry.status === "fallida"))) {
    throw new WhatsNewError(403, "no_es_autor", "Solo el autor puede modificar esta entrada.");
  }
  if (!["borrador", "sin_probar", "fallida"].includes(entry.status) ||
      (target !== undefined && target !== "que_cambio" && (entry.status !== "borrador" || entry.type !== "nuevo"))) {
    throw new WhatsNewError(409, "estado_no_permite_accion", "La entrada no admite este archivo.");
  }
}

async function entryForUpload(db: Db, id: string, actor: WhatsNewActor, target?: MediaTarget, lock = false) {
  requireView(actor);
  if (!FILE_ID.test(id)) throw missing();
  const [entry] = await query<MediaEntry>(db, `SELECT e.entry_key entryKey,e.status,e.entry_type [type],d.source_id developerId
    FROM whats_new.entries e ${lock ? "WITH(UPDLOCK,HOLDLOCK)" : ""}
    JOIN security.users d ON d.user_key=e.developer_user_key
    WHERE e.source_id=@id AND EXISTS(SELECT 1 FROM security.users u WHERE u.source_id=@actor AND u.active=1);`,
  { id, actor: actor.id });
  if (!entry) throw missing();
  assertCanUploadWhatsNewMedia(actor, entry, target);
  return entry;
}

export async function preflightWhatsNewUpload(actor: WhatsNewActor, id: string) {
  requireView(actor);
  await entryForUpload(await getSqlPool(), id, actor);
  if (!whatsNewMediaAvailable()) throw unavailable();
}

async function previousUpload(db: Db, actor: WhatsNewActor, key: string, entry: MediaEntry, upload: Upload, lock = false) {
  const [previous] = await query(db, `SELECT CONVERT(char(36),f.public_id) fileId,f.entry_key,f.target,f.kind,f.original_name [name],
    f.mime_type mime,f.declared_byte_count bytes,f.declared_sha256,f.status,
    CONVERT(bit,CASE WHEN f.status='verificada' AND f.expires_at<=SYSUTCDATETIME() THEN 1 ELSE 0 END) expired
    FROM whats_new.entry_files f ${lock ? "WITH(UPDLOCK,HOLDLOCK)" : ""}
    WHERE f.uploaded_by_user_key=(SELECT user_key FROM security.users WHERE source_id=@actor AND active=1)
      AND f.authorize_idempotency_key=@key;`, { actor: actor.id, key });
  if (!previous) return null;
  if (Number(previous.entry_key) !== Number(entry.entryKey) || previous.target !== upload.target || previous.kind !== upload.kind ||
      previous.name !== upload.name || previous.mime !== upload.mime || Number(previous.bytes) !== upload.bytes.length ||
      !Buffer.isBuffer(previous.declared_sha256) || previous.declared_sha256.toString("hex") !== upload.sha256 ||
      !["verificada", "en_entrada"].includes(previous.status) || previous.expired) {
    throw new WhatsNewError(409, "llave_idempotencia_reutilizada", "La llave de idempotencia ya se usó con otra solicitud.");
  }
  return { fileId: String(previous.fileId).toLowerCase(), name: upload.name, mime: upload.mime, bytes: upload.bytes.length };
}

async function assertUploadCapacity(db: Db, entryKey: number) {
  const [count] = await query(db, "SELECT COUNT_BIG(*) total FROM whats_new.entry_files WHERE entry_key=@entry;", { entry: entryKey });
  if (Number(count.total) >= LIMIT_PER_ENTRY) throw new WhatsNewError(409, "limite_archivos_entrada", "La entrada alcanzó el límite de archivos.");
}

export async function uploadWhatsNewMedia(actor: WhatsNewActor, id: string, idempotencyKey: string, upload: Upload) {
  const db = await getSqlPool();
  const entry = await entryForUpload(db, id, actor, upload.target);
  const replay = await previousUpload(db, actor, idempotencyKey, entry, upload);
  if (replay) return { ...replay, replayed: true };
  if (!whatsNewMediaAvailable()) throw unavailable();
  await assertUploadCapacity(db, entry.entryKey);
  let stored;
  try {
    stored = await storePrivateObject({ bytes: upload.bytes, sha256: upload.sha256, extension: upload.extension, mimeType: upload.mime,
      requiredProvider: "seaweedfs" });
  } catch (error) {
    if ((error as { code?: unknown })?.code === "object_registration_busy") {
      throw new WhatsNewError(409, "archivo_en_proceso", "El archivo está siendo procesado. Reintente con la misma llave.");
    }
    throw unavailable();
  }
  if (stored.storageProvider !== "s3") throw unavailable();
  const locator = stored;
  // Revalidate visibility, status and limits with the entry serialized. A failed
  // final registration never deletes possibly shared bytes from object storage.
  return runSqlTransaction(async (tx) => {
    const latest = await entryForUpload(tx, id, actor, upload.target, true);
    const already = await previousUpload(tx, actor, idempotencyKey, latest, upload, true);
    if (already) return { ...already, replayed: true };
    await assertUploadCapacity(tx, latest.entryKey);
    await ensureSqlContentFile(tx, { ...locator, originalName: upload.name, mimeType: upload.mime, byteCount: upload.bytes.length, sha256: upload.sha256 }, actor.id);
    const fileId = randomUUID();
    await query(tx, `INSERT whats_new.entry_files
       (public_id,entry_key,target,kind,original_name,mime_type,declared_byte_count,declared_sha256,status,
        storage_provider,storage_bucket,object_key,uploaded_by_user_key,authorize_idempotency_key,created_at,expires_at,verified_at)
       VALUES(CONVERT(uniqueidentifier,@id),@entry,@target,@kind,@name,@mime,@bytes,@hash,'verificada',
        's3',@bucket,@objectKey,(SELECT user_key FROM security.users WHERE source_id=@actor AND active=1),@idem,
        SYSUTCDATETIME(),DATEADD(hour,24,SYSUTCDATETIME()),SYSUTCDATETIME());`, {
      id: fileId, entry: latest.entryKey, target: upload.target, kind: upload.kind, name: upload.name, mime: upload.mime,
      bytes: upload.bytes.length, hash: Buffer.from(upload.sha256, "hex"), bucket: locator.storageBucket,
      objectKey: locator.storageObjectKey, actor: actor.id, idem: idempotencyKey,
    });
    await writeSqlAuditLog(tx, { entityType: "whats_new_entry", entityId: id, action: "whats_new_media_verified",
      performedBy: actor.id, performedByEmail: actor.email, metadata: { kind: upload.kind, target: upload.target } });
    return { fileId, name: upload.name, mime: upload.mime, bytes: upload.bytes.length, replayed: false };
  });
}

export async function readWhatsNewMedia(actor: WhatsNewActor, id: string) {
  requireView(actor);
  if (!FILE_ID.test(id)) throw missing();
  const [row] = await query(await getSqlPool(), `SELECT e.status,d.source_id developerId,u.source_id uploader,
    f.status fileStatus,f.kind,f.original_name [name],f.mime_type mime,f.declared_byte_count bytes,
    f.declared_sha256,f.storage_bucket bucket,f.object_key objectKey,c.object_etag etag
    FROM whats_new.entry_files f JOIN whats_new.entries e ON e.entry_key=f.entry_key
    JOIN security.users d ON d.user_key=e.developer_user_key
    JOIN security.users u ON u.user_key=f.uploaded_by_user_key
    JOIN content.files c ON c.storage_provider='s3' AND c.storage_bucket=f.storage_bucket AND c.object_key=f.object_key
      AND c.byte_count=f.declared_byte_count AND c.content_sha256=f.declared_sha256 AND c.mime_type=f.mime_type
    WHERE f.public_id=CONVERT(uniqueidentifier,@id) AND f.storage_provider='s3'
      AND f.target IN ('que_cambio','reglas_negocio','video')
      AND ((f.status='en_entrada' AND c.file_key=f.file_key) OR (f.status='verificada' AND f.expires_at>SYSUTCDATETIME()));`, { id });
  if (!row || row.status === "eliminada") throw missing();
  assertCanSeeEntry(actor, { status: row.status, developerId: row.developerId });
  if (row.fileStatus !== "en_entrada" && row.uploader !== actor.id) throw missing();
  const kind = row.kind as MediaKind;
  const count = Number(row.bytes);
  if (!Object.hasOwn(mimeByKind, kind) || !mimeByKind[kind].has(row.mime) ||
      !Number.isSafeInteger(count) || count < 1 || count > limit[kind] || !Buffer.isBuffer(row.declared_sha256)) throw unavailable();
  try {
    const bytes = await readPrivateSeaweedFSBuffer({ storageProvider: "s3", storageBucket: row.bucket,
      storageObjectKey: row.objectKey, storageObjectEtag: row.etag ?? undefined }, count, row.declared_sha256.toString("hex"));
    return { bytes, kind, mime: String(row.mime), name: String(row.name) };
  } catch { throw unavailable(); }
}
