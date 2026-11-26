import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChecklistTemplateSqlStore } from "../lib/checklistTemplateSqlWriteRepository";
import type { StoredTemplate } from "../lib/checklistTemplateService";
import { readSqlChecklistTemplate, listSqlChecklistTemplates, type checklistTemplateQuery } from "../lib/checklistTemplateSqlRepository";

const id = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const pointId = "33333333-3333-4333-8333-333333333333";
const actor = { id: "user", email: "user@example.invalid", canManageTemplates: true, isSuperAdmin: false };
const rowVersion = "AAAAAAAAAAE=";
function record(): StoredTemplate { return { id, name: "Plantilla", deleted: false, createdAt: "2026-11-26T15:00:00.000Z", versions: [
  { id: versionId, number: 1, status: "editing", requiresEnvironment: false, uses: 0, deleted: false, rowVersion, points: [{ id: pointId, position: 1, title: "Punto", detail: null }] },
] }; }
describe("Plantillas · unidad transaccional con SQL simulado (no prueba una base real)", () => {
  let events: string[]; let query: ReturnType<typeof vi.fn>; let read: ReturnType<typeof vi.fn>; let audit: ReturnType<typeof vi.fn>;
  const tx = {} as any;
  function store() {
    return createChecklistTemplateSqlStore({
      transaction: async (work: (db: any) => Promise<any>) => { events.push("begin"); try { const result = await work(tx); events.push("commit"); return result; } catch (e) { events.push("rollback"); throw e; } },
      query, read, audit, newId: (() => { let n = 40; return () => `00000000-0000-4000-8000-${String(n++).padStart(12, "0")}`; })(),
      now: () => new Date("2026-11-26T15:00:00Z"),
    });
  }
  beforeEach(() => {
    events = []; query = vi.fn(async () => { events.push("query"); return [{ id: versionId }]; });
    read = vi.fn(async (_db, _id, lock) => { events.push(lock ? "lock-template" : "reread"); return record(); });
    audit = vi.fn(async () => { events.push("audit"); });
  });
  it("CA-37 bloquea primero la plantilla, guarda, audita en la misma transacción y relee ROWVERSION", async () => {
    await store().execute(actor, "saveVersion", { id, number: 1, input: { requiresEnvironment: false, points: [{ id: pointId, title: "Punto" }], rowVersion } });
    expect(events[0]).toBe("begin"); expect(events[1]).toBe("lock-template");
    expect(events.indexOf("audit")).toBeGreaterThan(events.indexOf("query"));
    expect(events.at(-2)).toBe("reread"); expect(events.at(-1)).toBe("commit");
    expect(read.mock.calls.every((c) => c[0] === tx)).toBe(true);
    expect(query.mock.calls.every((c) => c[0] === tx)).toBe(true);
    expect(audit.mock.calls[0][0]).toBe(tx);
    expect(audit.mock.calls[0][1]).toMatchObject({ action: "checklist_version_saved", performedBy: actor.id });
    expect(JSON.stringify(audit.mock.calls[0][1])).not.toContain("Punto");
  });
  it("CA-37 conflicto stale no escribe ni audita y revierte la operación", async () => {
    await expect(store().execute(actor, "saveVersion", { id, number: 1, input: { requiresEnvironment: true, points: [], rowVersion: "AAAAAAAAAAI=" } })).rejects.toMatchObject({ status: 409, error: "stale" });
    expect(query).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled(); expect(events).toEqual(["begin", "lock-template", "rollback"]);
  });
  it("CA-31 una plantilla usada no se elimina ni se audita", async () => {
    const used = record(); used.versions[0].uses = 1; read.mockResolvedValue(used);
    await expect(store().execute({ ...actor, isSuperAdmin: true }, "remove", { id })).rejects.toMatchObject({ status: 409, error: "in_use" });
    expect(query).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled(); expect(events.at(-1)).toBe("rollback");
  });
  it("CA-23 publicar congela antes la vigente para respetar el índice único y no cambia sus puntos", async () => {
    const state = record(); state.versions[0].number = 2;
    state.versions.unshift({ ...state.versions[0], id: "44444444-4444-4444-8444-444444444444", number: 1, status: "current", points: [] });
    read.mockImplementation(async (_db, _id, lock) => { events.push(lock ? "lock-template" : "reread"); return state; });
    await store().execute(actor, "publishVersion", { id, number: 2 });
    const statements = query.mock.calls.map((c) => c[1] as string);
    expect(statements.findIndex((s) => s.includes("SET status='frozen'"))).toBeLessThan(statements.findIndex((s) => s.includes("SET status='current'")));
    expect(statements.some((s) => s.includes("UPDATE implementation.checklist_template_points"))).toBe(false);
  });
  it("CA-26 descartar conserva datos con borrado lógico, nunca DELETE físico", async () => {
    await store().execute(actor, "removeVersion", { id, number: 1 });
    const statements = query.mock.calls.map((c) => c[1] as string);
    expect(statements.some((s) => s.includes("deleted_at=@now"))).toBe(true);
    expect(statements.some((s) => /\bDELETE\s+FROM\b/i.test(s))).toBe(false);
  });
  it("CA-37 un fallo de auditoría revierte cambios en vez de confirmar parcialmente", async () => {
    audit.mockRejectedValue(new Error("Fallo de auditoría"));
    await expect(store().execute(actor, "saveVersion", { id, number: 1, input: { requiresEnvironment: false, points: [], rowVersion } })).rejects.toThrow("Fallo de auditoría");
    expect(events).toContain("query"); expect(events.at(-1)).toBe("rollback"); expect(events).not.toContain("commit");
  });
  it("API-22 la lectura real del repositorio bloquea primero la cabecera y usa solo tres consultas normalizadas", async () => {
    const execute = vi.fn().mockResolvedValueOnce([{ id, name: "Plantilla", created_at: new Date("2026-11-26T15:00:00Z") }])
      .mockResolvedValueOnce([{ id: versionId, number: 1, status: "editing", requires_environment: false, uses: 0, deleted_at: null, row_version: Buffer.from(rowVersion, "base64") }])
      .mockResolvedValueOnce([{ id: pointId, version_id: versionId, position: 1, title: "Punto", detail: null }]);
    const result = await readSqlChecklistTemplate(tx, id, true, execute as typeof checklistTemplateQuery);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[0][1]).toContain("implementation.checklist_templates t WITH (UPDLOCK,HOLDLOCK)");
    expect(execute.mock.calls[1][1]).toContain("c.deleted_at IS NULL");
    expect(execute.mock.calls[2][1]).toContain("p.deleted_at IS NULL");
    expect(result?.versions[0]).toMatchObject({ rowVersion, points: [{ id: pointId, position: 1 }] });
    expect(execute.mock.calls.every((c) => c[2].id === id)).toBe(true);
  });
  it("API-20 usa una consulta de resúmenes sin abrir cada agregado", async () => {
    const execute = vi.fn().mockResolvedValue([{ id, name: "Plantilla", current_version: null, uses: 0, created_at: new Date("2026-11-26T15:00:00Z") }]);
    expect(await listSqlChecklistTemplates(tx, execute as typeof checklistTemplateQuery)).toEqual([{ id, name: "Plantilla", currentVersion: null, uses: 0, createdAt: "2026-11-26T15:00:00.000Z" }]);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
