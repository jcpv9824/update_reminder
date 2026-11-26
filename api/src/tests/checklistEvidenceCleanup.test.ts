import { describe, expect, it, vi } from "vitest";
import { cleanupPendingChecklistEvidence } from "../lib/checklistEvidenceCleanup";

const id = "11111111-1111-4111-8111-111111111111";
function claim(extra = {}) { return { id, checklistId: "parent", kind: "image", status: "pending", deletedAt: new Date("2026-11-24Z"),
  leaseId: "lease", leaseUntil: new Date("2026-11-27Z"), storageDeletedAt: null,
  locator: { storageProvider: "s3", storageBucket: "private", storageObjectKey: `checklists/${id}/payload.png` }, ...extra }; }
function setup(extra = {}) {
  return { store: { candidates: vi.fn(async () => [{ id, checklistId: "parent" }]), claim: vi.fn(async () => claim()), confirm: vi.fn(async () => true), finish: vi.fn(async () => undefined) },
    storage: { remove: vi.fn(async () => true) }, now: () => new Date("2026-11-26Z"), ...extra };
}
describe("RN-43 limpieza · pruebas con puertos simulados, sin borrar objetos reales", () => {
  it("no inicia lecturas, cambios SQL ni almacenamiento durante mantenimiento", async () => {
    const d = { ...setup(), maintenance: () => true };
    await cleanupPendingChecklistEvidence(d as any);
    expect(d.store.candidates).not.toHaveBeenCalled(); expect(d.store.claim).not.toHaveBeenCalled(); expect(d.storage.remove).not.toHaveBeenCalled();
  });
  it("solo borra después de confirmación de tombstone/lease SQL y termina el mismo claim", async () => {
    const d = setup(); const order: string[] = [];
    d.store.claim.mockImplementation(async () => { order.push("claim-committed"); return claim(); });
    d.store.confirm.mockImplementation(async () => { order.push("confirm"); return true; });
    d.storage.remove.mockImplementation(async () => { order.push("storage"); return true; });
    d.store.finish.mockImplementation(async () => { order.push("finish"); });
    expect(await cleanupPendingChecklistEvidence(d as any)).toMatchObject({ deleted: 1 });
    expect(order).toEqual(["claim-committed", "confirm", "storage", "finish"]);
  });
  it.each([{ status: "saved" }, { deletedAt: null }, { leaseUntil: new Date("2026-11-25Z") }, { storageDeletedAt: new Date("2026-11-25Z") }])("nunca elimina evidencia guardada/no reclamada o lease vencido: %o", async (extra) => {
    const d = setup(); d.store.claim.mockResolvedValue(claim(extra));
    await cleanupPendingChecklistEvidence(d as any); expect(d.storage.remove).not.toHaveBeenCalled();
  });
  it("un commit SQL ambiguo o un claim perdido jamás desencadena borrado", async () => {
    const d = setup(); d.store.claim.mockRejectedValue(new Error("Commit outcome unknown"));
    await cleanupPendingChecklistEvidence(d as any); expect(d.storage.remove).not.toHaveBeenCalled();
    d.store.claim.mockResolvedValue(claim()); d.store.confirm.mockResolvedValue(false);
    await cleanupPendingChecklistEvidence(d as any); expect(d.storage.remove).not.toHaveBeenCalled();
  });
  it("fallo del proveedor conserva tombstone para reintentar y nunca marca eliminado", async () => {
    const d = setup(); d.storage.remove.mockRejectedValue(new Error("Provider unavailable"));
    expect(await cleanupPendingChecklistEvidence(d as any)).toMatchObject({ failed: 1 });
    expect(d.store.finish).not.toHaveBeenCalled();
  });
  it("no acepta una ubicación ajena al UUID reclamado ni cambia de proveedor", async () => {
    const d = setup(); d.store.claim.mockResolvedValue(claim({ locator: { storageProvider: "s3", storageBucket: "private", storageObjectKey: "content/other-saved-object" } }));
    await cleanupPendingChecklistEvidence(d as any); expect(d.storage.remove).not.toHaveBeenCalled();
  });
});
