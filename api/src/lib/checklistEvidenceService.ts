import { ChecklistError, mayWriteChecklist } from "./checklistDomain";
import { requireChecklistView, type ChecklistActor } from "./checklistSqlRepository";
import { TemplateEntityIdSchema } from "./checklistTemplateSchemas";
import { checklistEvidenceLimits, inspectChecklistEvidence, validateChecklistEvidenceJson, type ChecklistEvidenceKind, type ChecklistEvidenceBinaryKind } from "./checklistEvidenceValidation";
import { isChecklistEvidenceLocator } from "./checklistEvidenceCleanup";
import type { PrivateObjectLocator } from "./objectStorage";
import type { ChecklistEvidenceStorage } from "./checklistEvidenceStorage";
export type ChecklistEvidenceRecord = {
  id: string; checklistId: string; pointId: string; kind: ChecklistEvidenceKind; status: "pending" | "saved";
  ownerId: string; createdBy: string; checklistStatus: "in_progress" | "completed"; checklistDeleted: boolean;
  deletedAt: Date | null; verifiedAt: Date | null; createdAt: Date; url: string | null; text: string | null;
  fileName: string | null; contentType: string | null; sizeBytes: number | null; sha256: string | null; locator: PrivateObjectLocator | null;
};
export type EvidenceReservation = Pick<ChecklistEvidenceRecord, "id" | "kind" | "url" | "text" | "fileName" | "contentType" | "sizeBytes" | "sha256" | "locator">;
export interface ChecklistEvidenceStore {
  preflight(actor: ChecklistActor, checklistId: string, pointId: string): Promise<void>;
  reserve(actor: ChecklistActor, checklistId: string, pointId: string, input: EvidenceReservation): Promise<ChecklistEvidenceRecord>;
  verify(actor: ChecklistActor, evidenceId: string): Promise<ChecklistEvidenceRecord>;
  get(evidenceId: string): Promise<ChecklistEvidenceRecord | null>;
}
export function projectChecklistEvidence(row: ChecklistEvidenceRecord) {
  return { id: row.id, pointId: row.pointId, kind: row.kind, status: row.status,
    ...(row.kind === "link" ? { url: row.url } : row.kind === "text" ? { text: row.text }
      : { fileName: row.fileName, contentType: row.contentType, sizeBytes: row.sizeBytes }) };
}
const missing = () => new ChecklistError(404, "not_found", "No se encontró la evidencia.");
const unavailable = () => new ChecklistError(503, "storage_unavailable", "El almacenamiento privado no está disponible.");
export function createChecklistEvidenceService(deps: { store: ChecklistEvidenceStore; storage: ChecklistEvidenceStorage; newId(): string; now(): Date }) {
  async function preflight(actor: ChecklistActor, checklistId: string, pointId: string) {
    requireChecklistView(actor);
    await deps.store.preflight(actor, TemplateEntityIdSchema.parse(checklistId), TemplateEntityIdSchema.parse(pointId));
  }
  return {
    preflight,
    async createJson(actor: ChecklistActor, checklistId: string, pointId: string, value: unknown) {
      await preflight(actor, checklistId, pointId); const input = validateChecklistEvidenceJson(value);
      const row = await deps.store.reserve(actor, checklistId, pointId, { id: deps.newId(), kind: input.kind, url: input.kind === "link" ? input.url : null,
        text: input.kind === "text" ? input.text : null, fileName: null, contentType: null, sizeBytes: null, sha256: null, locator: null });
      return projectChecklistEvidence(row);
    },
    async createBinary(actor: ChecklistActor, checklistId: string, pointId: string, kind: ChecklistEvidenceBinaryKind, name: string, bytes: Buffer) {
      await preflight(actor, checklistId, pointId);
      const file = inspectChecklistEvidence(kind, name, bytes), id = deps.newId();
      let locator: PrivateObjectLocator;
      try { locator = deps.storage.prepare(id, file.extension); } catch { throw unavailable(); }
      if (!isChecklistEvidenceLocator(id, locator)) throw unavailable();
      // A confirmed SQL reservation precedes bytes. Unknown commits never
      // trigger compensating deletion; the durable pending row owns cleanup.
      await deps.store.reserve(actor, checklistId, pointId, { id, kind: file.kind, url: null, text: null, fileName: file.fileName,
        contentType: file.contentType, sizeBytes: file.sizeBytes, sha256: file.sha256, locator });
      try { await deps.storage.write(locator, bytes, file.sha256, file.contentType); } catch { throw unavailable(); }
      const verified = await deps.store.verify(actor, id);
      return projectChecklistEvidence(verified);
    },
    async content(actor: ChecklistActor, evidenceId: string) {
      requireChecklistView(actor);
      const row = await deps.store.get(TemplateEntityIdSchema.parse(evidenceId));
      if (!row || row.deletedAt || row.checklistDeleted || row.kind === "link" || row.kind === "text") throw missing();
      if (row.status === "pending" && (!mayWriteChecklist(actor, row.ownerId) || row.createdAt.getTime() <= deps.now().getTime() - 86_400_000)) throw missing();
      if (!row.verifiedAt || !row.locator || !row.sha256 || !row.sizeBytes || !row.fileName || !isChecklistEvidenceLocator(row.id, row.locator)) throw missing();
      if (row.sizeBytes < 1 || row.sizeBytes > checklistEvidenceLimits[row.kind] || !/^[0-9a-f]{64}$/.test(row.sha256)) throw unavailable();
      let bytes: Buffer;
      try { bytes = await deps.storage.read(row.locator, row.sizeBytes, row.sha256); } catch { throw unavailable(); }
      if (bytes.length !== row.sizeBytes) throw unavailable();
      let inspected;
      try { inspected = inspectChecklistEvidence(row.kind, row.fileName, bytes, undefined, checklistEvidenceLimits); } catch { throw unavailable(); }
      return { bytes, fileName: inspected.fileName, contentType: inspected.contentType, disposition: row.kind === "image" ? "inline" as const : "attachment" as const };
    },
  };
}
export type ChecklistEvidenceService = ReturnType<typeof createChecklistEvidenceService>;
