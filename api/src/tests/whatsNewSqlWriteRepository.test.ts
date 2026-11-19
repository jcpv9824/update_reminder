import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ query: vi.fn(), readEntry: vi.fn(), contextFor: vi.fn(), audit: vi.fn(), committed: false, rolledBack: false }));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: async (fn: (db: object) => Promise<unknown>) => {
  try { const value = await fn({}); f.committed = true; return value; } catch (error) { f.rolledBack = true; throw error; }
} }));
vi.mock("../lib/auditSqlWriter", () => ({ writeSqlAuditLog: f.audit }));
vi.mock("../lib/whatsNewSqlRepository", async (original) => ({ ...await original<typeof import("../lib/whatsNewSqlRepository")>(), query: f.query, readEntry: f.readEntry, contextFor: f.contextFor }));
import { mutate, requestFingerprint } from "../lib/whatsNewSqlWriteRepository";
import { PERMISSIONS } from "../lib/whatsNewModel";
import { context, entry } from "./whatsNewCommands.test";

describe("Qué hay de nuevo transactional write boundary", () => {
  beforeEach(() => { f.query.mockReset(); f.readEntry.mockReset(); f.contextFor.mockReset(); f.audit.mockReset(); f.committed = false; f.rolledBack = false; });
  it("projects participants from older idempotency snapshots without internal SQL keys", async () => {
    const snapshot = { id: "original", participants: [{ id: "tester", displayName: "Prueba", role: "asesor", entry_key: 17, private_sentinel: "PRIVATE" }] };
    f.query.mockResolvedValueOnce([{ request_sha256: requestFingerprint("take", "entry", {}), response_json: JSON.stringify(snapshot) }])
      .mockResolvedValueOnce([{ status: "en_pruebas", developerId: "author" }]);
    const result = await mutate({ actor: context().actor, operation: "take", id: "entry", body: {}, etag: '"stale"', idempotencyKey: "same-key-123" });
    expect(result.detail.participants).toEqual([{ id: "tester", displayName: "Prueba", role: "asesor" }]);
    expect(f.readEntry).not.toHaveBeenCalled(); expect(f.query).toHaveBeenCalledTimes(2);
  });
  const mention = { type: "doc", content: [{ type: "paragraph", content: [{ type: "mencion", attrs: { id: "mentioned", etiqueta: "Etiqueta recibida" } }] }] };
  function prepareNoteDraft() {
    const ctx = context(); const state = { ...entry(), status: "en_pruebas" as const,
      openRound: { id: "round", roundNo: 1, revisionNo: 1, holderId: ctx.actor.id, checklist: [] } };
    f.query.mockResolvedValue([{ source_id: state.id }]);
    f.readEntry.mockResolvedValue({ state, detail: { rounds: [{ id: "round", etag: state.etag }] } });
    f.contextFor.mockResolvedValue(ctx);
    return { ctx, args: { actor: ctx.actor, operation: "note-draft" as const, id: "round", body: { body: mention as unknown }, etag: state.etag, idempotencyKey: null } };
  }
  it("rejects an unknown mention before saving a note draft", async () => {
    const { args } = prepareNoteDraft();
    await expect(mutate(args)).rejects.toMatchObject({ status: 400, code: "texto_enriquecido_invalido" });
    expect(f.contextFor.mock.calls[0][4]).toContain("mentioned");
    expect(f.query.mock.calls.some((c) => c[1].startsWith("UPDATE"))).toBe(false);
    expect(f.rolledBack).toBe(true); expect(f.committed).toBe(false); expect(f.audit).not.toHaveBeenCalled();
  });
  it("saves a note draft mention with its current canonical directory label", async () => {
    const { ctx, args } = prepareNoteDraft();
    ctx.users.set("mentioned", { id: "mentioned", displayName: "Nombre vigente", email: "user@example.invalid", active: true, areas: [] });
    await mutate(args);
    const write = f.query.mock.calls.find((c) => c[1].startsWith("UPDATE whats_new.test_rounds SET note_draft_json"));
    expect(JSON.parse(write![2].body)).toEqual({ type: "doc", content: [{ type: "paragraph", content: [{ type: "mencion", attrs: { id: "mentioned", etiqueta: "Nombre vigente" } }] }] });
    expect(mention.content[0].content[0].attrs.etiqueta).toBe("Etiqueta recibida");
    expect(f.committed).toBe(true); expect(f.audit).not.toHaveBeenCalled();
  });
  it.each([null, { type: "doc", content: [] }])("preserves empty note-draft clearing/autosave %j", async (body) => {
    const { args } = prepareNoteDraft(); args.body.body = body;
    await mutate(args);
    const write = f.query.mock.calls.find((c) => c[1].startsWith("UPDATE whats_new.test_rounds SET note_draft_json"));
    expect(JSON.parse(write![2].body)).toEqual(body === null ? null : { type: "doc" }); expect(f.committed).toBe(true);
  });
  it("keeps note-draft files unavailable without any write", async () => {
    const { args } = prepareNoteDraft();
    args.body.body = { type: "doc", content: [{ type: "image", attrs: { fileId: "11111111-1111-4111-8111-111111111111" } }] };
    await expect(mutate(args)).rejects.toMatchObject({ status: 503, code: "almacenamiento_no_disponible" });
    expect(f.query.mock.calls.some((c) => c[1].startsWith("UPDATE"))).toBe(false); expect(f.rolledBack).toBe(true);
  });
  it("replays the original snapshot before checking the stale ETag", async () => {
    const snapshot = { id: "original", etag: '"original"' };
    f.query.mockResolvedValueOnce([{ request_sha256: requestFingerprint("take", "entry", {}), response_json: JSON.stringify(snapshot) }])
      .mockResolvedValueOnce([{ status: "en_pruebas", developerId: "author" }]);
    const result = await mutate({ actor: context().actor, operation: "take", id: "entry", body: {}, etag: '"stale"', idempotencyKey: "same-key-123" });
    expect(result).toEqual({ detail: snapshot, replayed: true }); expect(f.readEntry).not.toHaveBeenCalled(); expect(f.audit).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenCalledTimes(2);
  });
  it("does not replay an internal snapshot once the resource is no longer visible", async () => {
    const snapshot = { id: "entry", etag: '"original"' };
    const actor = { ...context().actor, permissions: new Set([PERMISSIONS.view, PERMISSIONS.test]) };
    f.query.mockResolvedValueOnce([{ request_sha256: requestFingerprint("take", "entry", {}), response_json: JSON.stringify(snapshot) }])
      .mockResolvedValueOnce([{ status: "eliminada", developerId: "author" }]);
    await expect(mutate({ actor, operation: "take", id: "entry", body: {}, etag: '"stale"', idempotencyKey: "same-key-123" }))
      .rejects.toMatchObject({ status: 404, code: "no_encontrado" });
    expect(f.readEntry).not.toHaveBeenCalled(); expect(f.audit).not.toHaveBeenCalled();
  });
  it("rejects key reuse with a different payload and rolls back", async () => {
    f.query.mockResolvedValue([{ request_sha256: requestFingerprint("create", null, { type: "mejora" }), response_json: "{}" }]);
    await expect(mutate({ actor: context().actor, operation: "create", id: null, body: { type: "nuevo" }, etag: null, idempotencyKey: "same-key-123" })).rejects.toMatchObject({ status: 409, code: "llave_idempotencia_reutilizada" });
    expect(f.rolledBack).toBe(true); expect(f.audit).not.toHaveBeenCalled();
  });
  it("does not replay an authorized snapshot after the actor loses their current area", async () => {
    const actor = context().actor; actor.areas = new Set(["desarrollo"]);
    await expect(mutate({ actor, operation: "take", id: "entry", body: {}, etag: '"stale"', idempotencyKey: "same-key-123" })).rejects.toMatchObject({ status: 403, code: "area_requerida" });
    expect(f.query).not.toHaveBeenCalled();
  });
  it("rejects a stale write before applying effects", async () => {
    f.query.mockResolvedValue([]); f.readEntry.mockResolvedValue({ state: entry(), detail: { rounds: [] } }); f.contextFor.mockResolvedValue(context());
    await expect(mutate({ actor: context().actor, operation: "take", id: "entry", body: {}, etag: '"stale"', idempotencyKey: "same-key-123" })).rejects.toMatchObject({ status: 409, code: "version_desactualizada" });
    expect(f.query.mock.calls.some((c) => c[1].startsWith("UPDATE whats_new.entries"))).toBe(false); expect(f.rolledBack).toBe(true);
  });
  it.each(["draft", "client-text", "checklist", "note-draft"] as const)("%s PUT/PATCH requires ETag, not an idempotency key", async (operation) => {
    f.query.mockResolvedValue([{ source_id: "entry" }]);
    f.readEntry.mockResolvedValue({ state: entry(), detail: { rounds: [{ id: "resource", etag: '"current"' }] } });
    f.contextFor.mockResolvedValue(context());
    await expect(mutate({ actor: context().actor, operation, id: "resource", body: {}, etag: '"stale"', idempotencyKey: null }))
      .rejects.toMatchObject({ status: 409, code: "version_desactualizada" });
    expect(f.query.mock.calls.some((c) => c[1].includes("whats_new.idempotency_keys"))).toBe(false);
  });
  it("state effects, round, participants and audit have one transaction owner; audit failure rolls back", async () => {
    const state = entry();
    f.query.mockImplementation(async (_db, statement) => statement.includes("OUTPUT inserted.round_key") ? [{ roundKey: 1 }] : []);
    f.readEntry.mockResolvedValue({ state, detail: { rounds: [] } }); f.contextFor.mockResolvedValue(context()); f.audit.mockRejectedValue(new Error("audit failure"));
    await expect(mutate({ actor: context().actor, operation: "take", id: state.id, body: {}, etag: state.etag, idempotencyKey: "same-key-123" })).rejects.toThrow("audit failure");
    expect(f.rolledBack).toBe(true); expect(f.committed).toBe(false);
    const statements = f.query.mock.calls.map((c) => c[1] as string);
    expect(statements.some((s) => s.includes("INSERT whats_new.test_rounds"))).toBe(true);
    expect(statements.some((s) => s.includes("INSERT whats_new.entry_participants"))).toBe(true);
    expect(new Set(f.query.mock.calls.map((c) => c[0])).size).toBe(1);
  });
});
