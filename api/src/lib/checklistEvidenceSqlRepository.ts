import sql from "mssql";
import { randomUUID } from "node:crypto";
import { getSqlPool } from "./sql";
import { runSqlTransaction } from "./sqlTransaction";
import { ChecklistError, mayWriteChecklist } from "./checklistDomain";
import { requireChecklistView, type ChecklistActor } from "./checklistSqlRepository";
import type { ChecklistEvidenceRecord, ChecklistEvidenceStore } from "./checklistEvidenceService";
import type { EvidenceCleanupStore, EvidenceCleanupClaim } from "./checklistEvidenceCleanup";
type Db = sql.Transaction | sql.ConnectionPool;
type Params = Record<string, string | number | boolean | Buffer | Date | null>;
export async function checklistEvidenceQuery<T = Record<string, any>>(db: Db, statement: string, values: Params = {}): Promise<T[]> {
  const request = db instanceof sql.Transaction ? new sql.Request(db) : new sql.Request(db);
  for (const [name, value] of Object.entries(values)) request.input(name,
    Buffer.isBuffer(value) ? sql.VarBinary(sql.MAX) : value instanceof Date ? sql.DateTime2(3) : typeof value === "number" ? sql.BigInt : typeof value === "boolean" ? sql.Bit : sql.NVarChar(sql.MAX), value);
  return (await request.query<T>(statement)).recordset ?? [];
}
type EvidenceSqlDependencies = { query: typeof checklistEvidenceQuery; transaction: typeof runSqlTransaction; getDb: typeof getSqlPool; now(): Date; newId(): string };
const defaults: EvidenceSqlDependencies = { query: checklistEvidenceQuery, transaction: runSqlTransaction, getDb: getSqlPool, now: () => new Date(), newId: randomUUID };
const who = "(SELECT user_key FROM security.users WHERE source_id=@actor AND active=1)";
const missing = () => new ChecklistError(404, "not_found", "No se encontró el punto o la evidencia del checklist.");
const selectEvidence = (lock = false) => `SELECT e.id,e.checklist_id checklistId,e.template_point_id pointId,e.kind,e.status,e.url,e.[text],e.file_name fileName,e.content_type contentType,e.size_bytes sizeBytes,
 e.storage_sha256 sha256,e.verified_at verifiedAt,e.created_at createdAt,e.deleted_at deletedAt,e.storage_provider storageProvider,e.storage_container storageContainer,e.storage_key storageKey,
 e.cleanup_lease_id leaseId,e.cleanup_lease_until leaseUntil,e.storage_deleted_at storageDeletedAt,
 u.source_id createdBy,o.source_id ownerId,c.status checklistStatus,CONVERT(bit,CASE WHEN c.deleted_at IS NULL THEN 0 ELSE 1 END) checklistDeleted
 FROM implementation.implementation_checklist_evidence e ${lock ? "WITH(UPDLOCK,HOLDLOCK)" : ""}
 JOIN implementation.implementation_checklists c ON c.id=e.checklist_id
 JOIN security.users u ON u.user_key=e.created_by JOIN security.users o ON o.user_key=c.owner_user_id`;
function mapEvidence(row: Record<string, any>): ChecklistEvidenceRecord {
  return { id: String(row.id).toLowerCase(), checklistId: String(row.checklistId).toLowerCase(), pointId: String(row.pointId).toLowerCase(), kind: row.kind, status: row.status,
    ownerId: row.ownerId, createdBy: row.createdBy, checklistStatus: row.checklistStatus, checklistDeleted: !!row.checklistDeleted,
    deletedAt: row.deletedAt, verifiedAt: row.verifiedAt, createdAt: row.createdAt, url: row.url, text: row.text, fileName: row.fileName, contentType: row.contentType,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes), sha256: row.sha256 ? Buffer.from(row.sha256).toString("hex") : null,
    locator: row.storageProvider === "s3" ? { storageProvider: "s3", storageBucket: row.storageContainer, storageObjectKey: row.storageKey }
      : row.storageProvider === "azure_blob" ? { storageProvider: "azure_blob", storageContainer: row.storageContainer, storageBlobName: row.storageKey } : null };
}
async function lockParent(d: EvidenceSqlDependencies, db: Db, checklistId: string, point: string | null, includeDeleted = false) {
  const [row] = await d.query(db, `SELECT c.status,u.source_id ownerId FROM implementation.implementation_checklists c WITH(UPDLOCK,HOLDLOCK)
    JOIN security.users u ON u.user_key=c.owner_user_id WHERE c.id=@checklist AND (@includeDeleted=1 OR c.deleted_at IS NULL)
    AND (@point IS NULL OR EXISTS(SELECT 1 FROM implementation.implementation_checklist_points p WHERE p.checklist_id=c.id AND p.template_point_id=@point));`,
  { checklist: checklistId, point, includeDeleted });
  if (!row) throw missing(); return row;
}
async function activeWrite(d: EvidenceSqlDependencies, db: Db, actor: ChecklistActor, checklistId: string, pointId: string) {
  const parent = await lockParent(d, db, checklistId, pointId);
  if (!mayWriteChecklist(actor, parent.ownerId)) throw new ChecklistError(403, "forbidden", "Solo el responsable o un superadministrador puede adjuntar evidencias.");
  if (parent.status !== "in_progress") throw new ChecklistError(409, "checklist_locked", "El checklist está completado y es de solo lectura.");
  return parent;
}
async function capacity(d: EvidenceSqlDependencies, db: Db, checklistId: string, pointId: string) {
  const [row] = await d.query(db, `SELECT COUNT_BIG(*) total FROM implementation.implementation_checklist_evidence WITH(UPDLOCK,HOLDLOCK)
    WHERE checklist_id=@checklist AND template_point_id=@point AND deleted_at IS NULL;`, { checklist: checklistId, point: pointId });
  if (Number(row.total) >= 20) throw new ChecklistError(400, "evidence_limit", "Cada punto admite hasta 20 evidencias.");
}
export function createChecklistEvidenceSqlStore(overrides: Partial<EvidenceSqlDependencies> = {}): ChecklistEvidenceStore {
  const d = { ...defaults, ...overrides };
  async function get(db: Db, id: string, lock = false) { const [row] = await d.query(db, `${selectEvidence(lock)} WHERE e.id=@id;`, { id }); return row ? mapEvidence(row) : null; }
  return {
    async preflight(actor, checklistId, pointId) {
      requireChecklistView(actor);
      await d.transaction(async (tx) => { await activeWrite(d, tx, actor, checklistId, pointId); await capacity(d, tx, checklistId, pointId); });
    },
    async reserve(actor, checklistId, pointId, input) {
      requireChecklistView(actor);
      return d.transaction(async (tx) => {
        await activeWrite(d, tx, actor, checklistId, pointId); await capacity(d, tx, checklistId, pointId);
        const loc = input.locator;
        await d.query(tx, `INSERT implementation.implementation_checklist_evidence(id,checklist_id,template_point_id,kind,url,[text],file_name,content_type,size_bytes,
          storage_provider,storage_container,storage_key,storage_sha256,verified_at,status,created_by,created_at,updated_at)
          VALUES(@id,@checklist,@point,@kind,@url,@text,@name,@mime,@size,@provider,@container,@key,@hash,NULL,'pending',${who},@now,@now);`,
        { id: input.id, checklist: checklistId, point: pointId, kind: input.kind, url: input.url, text: input.text, name: input.fileName, mime: input.contentType, size: input.sizeBytes,
          provider: loc?.storageProvider ?? null, container: loc ? loc.storageProvider === "s3" ? loc.storageBucket : loc.storageContainer : null,
          key: loc ? loc.storageProvider === "s3" ? loc.storageObjectKey : loc.storageBlobName : null, hash: input.sha256 ? Buffer.from(input.sha256, "hex") : null, actor: actor.id, now: d.now() });
        const result = await get(tx, input.id); if (!result) throw missing(); return result;
      });
    },
    async verify(actor, id) {
      requireChecklistView(actor);
      const lookup = await get(await d.getDb(), id); if (!lookup) throw missing();
      return d.transaction(async (tx) => {
        await activeWrite(d, tx, actor, lookup.checklistId, lookup.pointId);
        const row = await get(tx, id, true);
        if (!row || row.deletedAt || row.status !== "pending" || row.createdAt.getTime() <= d.now().getTime() - 86_400_000) throw missing();
        if (row.createdBy !== actor.id && !actor.isSuperAdmin) throw new ChecklistError(403, "forbidden", "No tiene permiso para verificar esta carga.");
        await d.query(tx, `UPDATE implementation.implementation_checklist_evidence SET verified_at=COALESCE(verified_at,@now),updated_at=@now
          WHERE id=@id AND status='pending' AND deleted_at IS NULL AND cleanup_lease_id IS NULL AND storage_sha256 IS NOT NULL;`, { id, now: d.now() });
        const result = await get(tx, id); if (!result?.verifiedAt) throw missing(); return result;
      });
    },
    async get(id) { return get(await d.getDb(), id); },
  };
}
export function createChecklistEvidenceCleanupStore(overrides: Partial<EvidenceSqlDependencies> = {}): EvidenceCleanupStore {
  const d = { ...defaults, ...overrides };
  return {
    async candidates(limit) {
      return d.query(await d.getDb(), `SELECT TOP (@limit) id,checklist_id checklistId FROM implementation.implementation_checklist_evidence
        WHERE status='pending' AND created_at<=DATEADD(hour,-24,@now) AND storage_deleted_at IS NULL
        AND (deleted_at IS NULL OR kind IN ('image','video','file')) AND (cleanup_lease_until IS NULL OR cleanup_lease_until<=@now)
        ORDER BY created_at,id;`, { limit: Math.min(50, Math.max(1, limit)), now: d.now() });
    },
    async claim(candidate) {
      return d.transaction(async (tx) => {
        await lockParent(d, tx, candidate.checklistId, null, true);
        const [row] = await d.query(tx, `${selectEvidence(true)} WHERE e.id=@id AND e.checklist_id=@checklist AND e.status='pending'
          AND e.created_at<=DATEADD(hour,-24,@now) AND e.storage_deleted_at IS NULL AND (e.cleanup_lease_until IS NULL OR e.cleanup_lease_until<=@now);`,
        { id: candidate.id, checklist: candidate.checklistId, now: d.now() });
        if (!row || row.status !== "pending" || row.createdAt.getTime() > d.now().getTime() - 86_400_000 || row.storageDeletedAt || row.leaseUntil && row.leaseUntil > d.now()) return null;
        const now = d.now();
        if (row.kind === "link" || row.kind === "text") {
          await d.query(tx, `UPDATE implementation.implementation_checklist_evidence SET deleted_at=COALESCE(deleted_at,@now),deleted_by=COALESCE(deleted_by,created_by),updated_at=@now
            WHERE id=@id AND status='pending' AND deleted_at IS NULL;`, { id: candidate.id, now }); return null;
        }
        const leaseId = d.newId(), leaseUntil = new Date(now.getTime() + 300_000), evidence = mapEvidence(row);
        if (!evidence.locator) return null;
        await d.query(tx, `UPDATE implementation.implementation_checklist_evidence SET deleted_at=COALESCE(deleted_at,@now),deleted_by=COALESCE(deleted_by,created_by),
          cleanup_lease_id=@lease,cleanup_lease_until=@until,updated_at=@now WHERE id=@id AND status='pending' AND storage_deleted_at IS NULL;`,
        { id: candidate.id, now, lease: leaseId, until: leaseUntil });
        return { id: candidate.id, checklistId: candidate.checklistId, kind: evidence.kind, status: evidence.status,
          deletedAt: evidence.deletedAt ?? now, leaseId, leaseUntil, storageDeletedAt: null, locator: evidence.locator };
      });
    },
    async confirm(claim) {
      const rows = await d.query(await d.getDb(), `SELECT id FROM implementation.implementation_checklist_evidence WHERE id=@id AND status='pending' AND deleted_at IS NOT NULL
        AND cleanup_lease_id=@lease AND cleanup_lease_until>@now AND storage_deleted_at IS NULL AND storage_provider=@provider AND storage_container=@container AND storage_key=@key;`,
      { id: claim.id, lease: claim.leaseId, now: d.now(), provider: claim.locator.storageProvider,
        container: claim.locator.storageProvider === "s3" ? claim.locator.storageBucket : claim.locator.storageContainer,
        key: claim.locator.storageProvider === "s3" ? claim.locator.storageObjectKey : claim.locator.storageBlobName });
      return rows.length > 0;
    },
    async finish(claim) {
      await d.query(await d.getDb(), `UPDATE implementation.implementation_checklist_evidence SET storage_deleted_at=@now,cleanup_lease_id=NULL,cleanup_lease_until=NULL,updated_at=@now
        WHERE id=@id AND status='pending' AND deleted_at IS NOT NULL AND cleanup_lease_id=@lease AND storage_deleted_at IS NULL;`, { id: claim.id, lease: claim.leaseId, now: d.now() });
    },
  };
}
