import { describe, expect, it, vi } from "vitest";
import { createChecklistEvidenceSqlStore, createChecklistEvidenceCleanupStore } from "../lib/checklistEvidenceSqlRepository";
const id = "11111111-1111-4111-8111-111111111111", parent = "22222222-2222-4222-8222-222222222222", point = "33333333-3333-4333-8333-333333333333";
const actor = { id: "owner", email: "owner@example.invalid", canView: true, canCreate: false, isSuperAdmin: false };
function row(extra = {}) { return { id, checklistId: parent, pointId: point, kind: "image", status: "pending", ownerId: "owner", createdBy: "owner", checklistStatus: "in_progress",
  checklistDeleted: false, deletedAt: null, verifiedAt: null, createdAt: new Date("2026-11-20Z"), fileName: "image.png", contentType: "image/png", sizeBytes: 10,
  sha256: Buffer.alloc(32), storageProvider: "s3", storageContainer: "private", storageKey: `checklists/${id}/payload.png`, url: null, text: null, ...extra }; }
function setup(extraRow = {}) {
  const events: string[] = [], tx = {} as any;
  const query = vi.fn(async (_db: unknown, statement: string) => {
    events.push(statement.includes("implementation_checklists c WITH") ? "lock-header" : statement.startsWith("UPDATE") ? "update" : "query");
    if (statement.includes("COUNT_BIG")) return [{ total: 0 }];
    if (statement.includes("implementation_checklists c WITH")) return [{ ownerId: "owner", status: "in_progress" }];
    return [row(extraRow)];
  });
  return { events, query, transaction: async (work: (db: any) => Promise<any>) => { events.push("begin"); try { const result = await work(tx); events.push("commit"); return result; } catch (e) { events.push("rollback"); throw e; } },
    getDb: async () => tx, now: () => new Date("2026-11-26Z"), newId: () => "44444444-4444-4444-8444-444444444444" };
}
describe("Evidencias SQL · parámetros/orden transaccional simulado, no motor real", () => {
  it("RN-41/43 reserva con cabecera primero y metadatos no verificados antes de confirmar", async () => {
    const d = setup(); await createChecklistEvidenceSqlStore(d as any).reserve(actor, parent, point, { id, kind: "image", fileName: "image.png", contentType: "image/png", sizeBytes: 10,
      sha256: "0".repeat(64), locator: { storageProvider: "s3", storageBucket: "private", storageObjectKey: `checklists/${id}/payload.png` }, url: null, text: null });
    expect(d.events[0]).toBe("begin"); expect(d.events[1]).toBe("lock-header"); expect(d.events.at(-1)).toBe("commit");
    const insert = d.query.mock.calls.find((c) => c[1].includes("INSERT implementation.implementation_checklist_evidence"));
    expect(insert).toBeDefined(); expect(insert?.[1]).toContain("verified_at"); expect(insert?.[1]).toContain("'pending'");
  });
  it("RN-41 rechaza capacidad antes de insertar, y no permite otro dueño", async () => {
    const d = setup(); d.query.mockImplementation(async (_db, statement) => statement.includes("COUNT_BIG") ? [{ total: 20 }] : [{ ownerId: "owner", status: "in_progress" }]);
    await expect(createChecklistEvidenceSqlStore(d as any).preflight(actor, parent, point)).rejects.toMatchObject({ error: "evidence_limit" });
    await expect(createChecklistEvidenceSqlStore(d as any).preflight({ ...actor, id: "other" }, parent, point)).rejects.toMatchObject({ status: 403 });
  });
  it("RN-43 verificación exige pendiente activo sin lease y no revive tombstones", async () => {
    const d = setup({ deletedAt: new Date("2026-11-25Z") });
    await expect(createChecklistEvidenceSqlStore(d as any).verify(actor, id)).rejects.toMatchObject({ status: 404 });
    expect(d.query.mock.calls.some((c) => c[1].includes("SET verified_at"))).toBe(false);
  });
  it("RN-43 claim de limpieza confirma tombstone y lease bajo cabecera/filas antes de salir de SQL", async () => {
    const d = setup(); const claim = await createChecklistEvidenceCleanupStore(d as any).claim({ id, checklistId: parent });
    expect(d.events[0]).toBe("begin"); expect(d.events[1]).toBe("lock-header"); expect(d.events.at(-1)).toBe("commit");
    expect(claim).toMatchObject({ status: "pending", deletedAt: new Date("2026-11-26Z"), leaseId: "44444444-4444-4444-8444-444444444444" });
    const update = d.query.mock.calls.find((c) => c[1].includes("SET deleted_at"));
    expect(update?.[1]).toContain("status='pending'"); expect(update?.[1]).toContain("cleanup_lease_until");
  });
  it("RN-43 nunca reclama saved y la confirmación vuelve a exigir token/deleted/pending", async () => {
    const d = setup({ status: "saved" });
    expect(await createChecklistEvidenceCleanupStore(d as any).claim({ id, checklistId: parent })).toBeNull();
    expect(d.query.mock.calls.some((c) => c[1].startsWith("UPDATE"))).toBe(false);
    await createChecklistEvidenceCleanupStore(d as any).confirm({ ...row(), leaseId: "token", leaseUntil: new Date("2026-11-27Z"), storageDeletedAt: null, deletedAt: new Date(), locator: { storageProvider: "s3", storageBucket: "private", storageObjectKey: `checklists/${id}/payload.png` } } as any);
    const statement = d.query.mock.calls.at(-1)?.[1];
    expect(statement).toContain("cleanup_lease_id=@lease"); expect(statement).toContain("deleted_at IS NOT NULL"); expect(statement).toContain("status='pending'");
  });
});
