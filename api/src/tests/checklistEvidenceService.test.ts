import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createChecklistEvidenceService } from "../lib/checklistEvidenceService";
import { ChecklistError } from "../lib/checklistDomain";
const id = "11111111-1111-4111-8111-111111111111", parent = "22222222-2222-4222-8222-222222222222", point = "33333333-3333-4333-8333-333333333333";
const actor = { id: "owner", email: "owner@example.invalid", canView: true, canCreate: false, isSuperAdmin: false };
const png = () => readFileSync(resolve(process.cwd(), "../frontend/public/brand/sag-two-tone-icon.png"));
function record(extra = {}) { return { id, checklistId: parent, pointId: point, kind: "image", status: "pending", ownerId: "owner", createdBy: "owner",
  checklistStatus: "in_progress", checklistDeleted: false, deletedAt: null, verifiedAt: new Date(), createdAt: new Date(), fileName: "captura.png", contentType: "image/png", sizeBytes: png().length,
  sha256: createHash("sha256").update(png()).digest("hex"), locator: { storageProvider: "s3", storageBucket: "private", storageObjectKey: `checklists/${id}/payload.png` }, ...extra }; }
function setup() {
  const store = { preflight: vi.fn(async () => undefined), reserve: vi.fn(async () => record({ verifiedAt: null })), verify: vi.fn(async () => record()), get: vi.fn(async () => record()) };
  const storage = { prepare: vi.fn(() => record().locator), write: vi.fn(async () => undefined), read: vi.fn(async () => png()), remove: vi.fn(async () => true) };
  return { store, storage, newId: () => id, now: () => new Date() };
}
describe("API-09/10 evidencias · servicio con puertos simulados", () => {
  it("CA-16 reserva antes de escribir, verifica después y devuelve solo metadatos públicos", async () => {
    const d = setup(), order: string[] = [];
    d.store.reserve.mockImplementation(async () => { order.push("reserve-committed"); return record({ verifiedAt: null }); });
    d.storage.write.mockImplementation(async () => { order.push("store"); });
    d.store.verify.mockImplementation(async () => { order.push("verify-committed"); return record(); });
    const result = await createChecklistEvidenceService(d as any).createBinary(actor, parent, point, "image", "captura.png", png());
    expect(order).toEqual(["reserve-committed", "store", "verify-committed"]);
    expect(result).toMatchObject({ id, pointId: point, kind: "image", status: "pending", fileName: "captura.png" });
    expect(JSON.stringify(result)).not.toMatch(/private|locator|sha256|storageObjectKey|verifiedAt/);
  });
  it("RN-43 no borra en un commit de verificación ambiguo ni entrega éxito", async () => {
    const d = setup(); d.store.verify.mockRejectedValue(new Error("commit unknown"));
    await expect(createChecklistEvidenceService(d as any).createBinary(actor, parent, point, "image", "captura.png", png())).rejects.toThrow();
    expect(d.storage.write).toHaveBeenCalled(); expect(d.storage.remove).not.toHaveBeenCalled();
  });
  it("RN-41 no escribe bytes si la reserva rechaza el límite de 20 o la pertenencia", async () => {
    const d = setup(); d.store.reserve.mockRejectedValue(new ChecklistError(400, "evidence_limit", "Cada punto admite hasta 20 evidencias."));
    await expect(createChecklistEvidenceService(d as any).createBinary(actor, parent, point, "image", "captura.png", png())).rejects.toMatchObject({ error: "evidence_limit" });
    expect(d.storage.write).not.toHaveBeenCalled(); expect(d.storage.remove).not.toHaveBeenCalled();
  });
  it("RN-45 guardadas se leen con view; pendientes solo dueño/superadmin; no lee sin permiso", async () => {
    const d = setup(); const service = createChecklistEvidenceService(d as any);
    d.store.get.mockResolvedValue(record({ status: "saved" }));
    expect((await service.content({ ...actor, id: "reader" }, id)).disposition).toBe("inline");
    d.store.get.mockResolvedValue(record());
    await expect(service.content({ ...actor, id: "reader" }, id)).rejects.toMatchObject({ status: 404 });
    await expect(service.content({ ...actor, canView: false }, id)).rejects.toMatchObject({ status: 403 });
  });
  it("RN-43/45 una carga no verificada o tombstone nunca se sirve ni llama al proveedor", async () => {
    const d = setup(); d.store.get.mockResolvedValue(record({ verifiedAt: null }));
    await expect(createChecklistEvidenceService(d as any).content(actor, id)).rejects.toMatchObject({ status: 404 });
    d.store.get.mockResolvedValue(record({ deletedAt: new Date() }));
    await expect(createChecklistEvidenceService(d as any).content(actor, id)).rejects.toMatchObject({ status: 404 });
    expect(d.storage.read).not.toHaveBeenCalled();
  });
  it("CA-17 archivos/videos siempre attachment; enlaces no se fetchan y raster sí inline", async () => {
    const d = setup(); d.store.get.mockResolvedValue(record({ kind: "file", fileName: "archivo.html", contentType: "text/html", sizeBytes: 5 })); d.storage.read.mockResolvedValue(Buffer.from("<x/> "));
    expect(await createChecklistEvidenceService(d as any).content(actor, id)).toMatchObject({ contentType: "application/octet-stream", disposition: "attachment" });
    d.store.get.mockResolvedValue(record({ kind: "link", url: "https://example.invalid" })); d.storage.read.mockClear();
    await expect(createChecklistEvidenceService(d as any).content(actor, id)).rejects.toMatchObject({ status: 404 }); expect(d.storage.read).not.toHaveBeenCalled();
  });
});
