import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), pool: {}, getPool: vi.fn(), readEntry: vi.fn() }));
vi.mock("../lib/sql", () => ({ getSqlPool: mocks.getPool }));
vi.mock("../lib/whatsNewSqlRepository", async (original) => ({ ...await original<typeof import("../lib/whatsNewSqlRepository")>(), query: mocks.query, readEntry: mocks.readEntry }));
import { ListSchema, PublicFilters, ReportSendInput, getEntry, listEntries, lookups, me, pendingStorage, publicDateRange, publicProjection, renderReport } from "../lib/whatsNewService";
import { requestFingerprint, assertIdempotencyKey } from "../lib/whatsNewSqlWriteRepository";
import { requireEtag } from "../lib/whatsNewSqlRepository";
import { context, entry } from "./whatsNewCommands.test";
import { canSeeEntry } from "../lib/whatsNewAccess";

describe("Qué hay de nuevo service contracts", () => {
  beforeEach(() => { mocks.query.mockReset(); mocks.readEntry.mockReset(); mocks.getPool.mockReset().mockResolvedValue(mocks.pool); });
  it("gives only the actual responsible actor the withdrawal control and guards retired history", async () => {
    const actor = context().actor;
    const state = { ...entry(), initialTesterId: actor.id };
    const details = { id: state.id, status: state.status };
    mocks.readEntry.mockResolvedValueOnce({ state, detail: details })
      .mockResolvedValueOnce({ state: { ...state, initialTesterId: "unrelated" }, detail: details })
      .mockResolvedValue({ state: { ...state, status: "eliminada" }, detail: { ...details, status: "eliminada" } });
    await expect(getEntry(actor, state.id)).resolves.toMatchObject({ canDelete: true });
    await expect(getEntry(actor, state.id)).resolves.toMatchObject({ canDelete: false });
    await expect(getEntry(actor, state.id)).rejects.toMatchObject({ status: 404 });
    await expect(getEntry({ ...actor, superAdmin: true }, state.id)).resolves.toMatchObject({ canDelete: false, status: "eliminada" });
  });
  it.each([
    { permissions: ["updates.whats_new.view"], areas: ["desarrollo"] as const },
    { permissions: ["updates.whats_new.view", "updates.whats_new.author"], areas: [] as const },
    { permissions: ["updates.whats_new.view", "updates.whats_new.test"], areas: [] as const },
  ])("rejects an actor without an effective view before list reads: %j", async ({ permissions, areas }) => {
    const actor = context().actor; actor.permissions = new Set(permissions); actor.areas = new Set(areas);
    for (const scope of ["mine", "all"]) await expect(listEntries(actor, { scope })).rejects.toMatchObject({ status: 403 });
    expect(mocks.getPool).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.readEntry).not.toHaveBeenCalled();
    expect(canSeeEntry(actor, { status: "borrador", developerId: actor.id })).toBe(false);
  });
  it.each(["updates.whats_new.view_all", "updates.whats_new.report", "updates.whats_new.test"])("retains %s reading without exposing own drafts after author/area loss", async (permission) => {
    const actor = context().actor; actor.permissions = new Set(["updates.whats_new.view", permission]); actor.areas = new Set(["soporte"]);
    mocks.query.mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);
    await listEntries(actor, { scope: "all" });
    expect(mocks.query.mock.calls[1][1]).toContain("AND e.status<>'borrador'");
    expect(mocks.query.mock.calls[1][1]).not.toContain("OR d.source_id=@actor");
    expect(canSeeEntry(actor, { status: "borrador", developerId: actor.id })).toBe(false);
    expect(canSeeEntry(actor, { status: "sin_probar", developerId: "other" })).toBe(true);
  });
  it("requires current Desarrollo even if another view remains available", async () => {
    const actor = context().actor; actor.permissions = new Set(["updates.whats_new.view", "updates.whats_new.author", "updates.whats_new.view_all"]); actor.areas = new Set();
    mocks.query.mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);
    await listEntries(actor, { scope: "all" });
    expect(mocks.query.mock.calls[1][1]).toContain("AND e.status<>'borrador'");
    expect(canSeeEntry(actor, { status: "borrador", developerId: actor.id })).toBe(false);
  });
  it("preserves manager draft visibility", async () => {
    const actor = context().actor; actor.areas = new Set();
    mocks.query.mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);
    await listEntries(actor, { scope: "all" });
    expect(mocks.query.mock.calls[1][1]).not.toContain("e.status<>'borrador'");
    expect(canSeeEntry(actor, { status: "borrador", developerId: "other" })).toBe(true);
  });
  it("includes the existing support classification only when no explicit module area exists", async () => {
    mocks.query.mockResolvedValue([{ id: "support-user", displayName: "Soporte" }]);
    await expect(lookups(context().actor, "support-users")).resolves.toEqual([{ id: "support-user", displayName: "Soporte", active: true }]);
    const supportSql = mocks.query.mock.calls[0][1] as string;
    expect(supportSql).toContain("a.area_code='soporte'");
    expect(supportSql).toContain("u.area='support' AND NOT EXISTS");
    expect(supportSql).toContain("u.active=1");
  });
  it.each(["configuration.whats_new.view", "configuration.whats_new.manage"])("allows configuration-only %s self capabilities, not entry access", async (permission) => {
    mocks.query.mockResolvedValue([{ public_enabled: false }]);
    const actor = context().actor; actor.permissions = new Set([permission]);
    expect(await me(actor)).toMatchObject({ views: [], defaultView: null, permissions: [permission], publicEnabled: false });
    await expect(listEntries(actor, {})).rejects.toMatchObject({ status: 403 });
  });
  it("uses exactly two bounded SQL queries for a list, with filtering before pagination", async () => {
    mocks.query.mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);
    const result = await listEntries(context().actor, { tab: "probadas", result: "fallidas", month: "2026-11", q: "Factura", page: 2, pageSize: 10 }, true);
    expect(result.items).toEqual([]); expect(mocks.query).toHaveBeenCalledTimes(2); expect(mocks.readEntry).not.toHaveBeenCalled();
    const statement = mocks.query.mock.calls[1][1] as string;
    expect(statement).toContain("e.status='fallida'"); expect(statement).toContain("e.result_at>=@from");
    expect(statement.indexOf("WHERE e.status")).toBeLessThan(statement.indexOf("OFFSET @offset"));
    expect(mocks.query.mock.calls[1][2]).toMatchObject({ offset: 10, size: 10, from: new Date("2026-11-01T05:00:00Z"), until: new Date("2026-12-01T05:00:00Z") });
  });
  it("filters creation in Bogotá and current holder distinctly from initial assignee", async () => {
    mocks.query.mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);
    await listEntries(context().actor, { tab: "en_pruebas", createdMonth: "2026-11", assignedToMe: "true", testingByMe: "true" }, true);
    for (const [, statement, parameters] of mocks.query.mock.calls) {
      expect(statement).toContain("e.created_at>=@createdFrom");
      expect(statement).toContain("t.source_id=@actor");
      expect(statement).toContain("r.status='tomada' AND u.source_id=@actor");
      expect(parameters).toMatchObject({ createdFrom: new Date("2026-11-01T05:00:00Z"), createdUntil: new Date("2026-12-01T05:00:00Z") });
    }
  });
  it("projects names and approved visibility in the same bounded page, without leaking client text", async () => {
    mocks.query.mockResolvedValueOnce([{ total: 1 }]).mockResolvedValueOnce([{
      entry_number: 1, initial_assignee_name: "Asignada", last_tester_name: "Probadora", show_to_clients: true,
      row_version: Buffer.alloc(8), created_at: new Date(), updated_at: new Date(), title: "PRIVATE_TEXT",
    }]);
    await expect(listEntries(context().actor, { tab: "probadas" }, true)).resolves.toMatchObject({
      items: [{ initialAssigneeName: "Asignada", lastTesterName: "Probadora", showToClients: true }],
    });
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[1][1]).toContain("client_text.show_to_clients=1");
    expect(mocks.query.mock.calls[1][1]).not.toContain("client_text.title");
    expect(mocks.query.mock.calls[1][1]).not.toContain("client_text.body_json");
  });
  it("counts all developer tabs in the authorized filtered scope before applying the tab and offset", async () => {
    mocks.query.mockResolvedValueOnce([{ total: 9, borradores: 3, publicadas: 6 }]).mockResolvedValueOnce([]);
    const result = await listEntries(context().actor, { tab: "borradores", q: "Ventas", page: 2, pageSize: 2 });
    expect(result).toMatchObject({ total: 3, page: 2, tabCounts: { todas: 9, borradores: 3, publicadas: 6 } });
    const [counts, page] = mocks.query.mock.calls.map((call) => call[1] as string);
    expect(counts).toContain("d.source_id=@actor");
    expect(counts).toContain("LIKE @search");
    expect(counts).not.toContain(" AND e.status='borrador'");
    expect(page.indexOf(" AND e.status='borrador'")).toBeLessThan(page.indexOf("OFFSET @offset"));
  });
  it("rejects developer tabs in the support queue", async () => {
    await expect(listEntries(context().actor, { tab: "borradores" }, true)).rejects.toMatchObject({ status: 400 });
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("keeps foreign drafts invisible in SQL itself", async () => {
    mocks.query.mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);
    const actor = context().actor; actor.permissions = new Set(["updates.whats_new.view", "updates.whats_new.author"]);
    await listEntries(actor, { scope: "all" });
    expect(mocks.query.mock.calls[1][1]).toContain("(e.status<>'borrador' OR d.source_id=@actor)");
    expect(mocks.query.mock.calls[1][1]).toContain("d.source_id=@actor");
    expect(canSeeEntry(actor, { status: "borrador", developerId: actor.id })).toBe(true);
    expect(canSeeEntry(actor, { status: "borrador", developerId: "other" })).toBe(false);
  });
  it("bounds filters and rejects a fourth queue tab", () => {
    expect(ListSchema.safeParse({ tab: "fallidas" }).success).toBe(false);
    expect(ListSchema.safeParse({ pageSize: 10000 }).success).toBe(false);
  });
  it("validates recipients, not arbitrary email addresses or duplicates", () => {
    expect(ReportSendInput.safeParse({ include: "todas", recipientIds: [] }).success).toBe(false);
    expect(ReportSendInput.safeParse({ include: "todas", recipientIds: Array(31).fill("x") }).success).toBe(false);
    expect(ReportSendInput.safeParse({ include: "todas", recipientIds: ["x", "x"] }).success).toBe(false);
    expect(ReportSendInput.safeParse({ include: "todas", recipientEmails: ["x@example.invalid"] }).success).toBe(false);
    expect(ReportSendInput.safeParse({ include: "fallidas", recipientIds: ["sales-user"] }).success).toBe(true);
  });
  it("storage boundary fails closed without SQL or mail effects", () => {
    expect(pendingStorage).toThrow("todavía no está conectado"); expect(mocks.query).not.toHaveBeenCalled();
  });
  it("fingerprints ignore property order but include target and payload", () => {
    expect(requestFingerprint("take", "a", { a: 1, b: 2 })).toEqual(requestFingerprint("take", "a", { b: 2, a: 1 }));
    expect(requestFingerprint("take", "a", {})).not.toEqual(requestFingerprint("take", "b", {}));
    expect(requestFingerprint("take", "a", { a: 1 })).not.toEqual(requestFingerprint("take", "a", { a: 2 }));
    expect(() => assertIdempotencyKey(null)).toThrow("Idempotency-Key");
  });
  it("requires current ETag and rejects wildcard and weak match", () => {
    expect(() => requireEtag(null, '"a"')).toThrow("If-Match");
    expect(() => requireEtag("*", '"a"')).toThrow("Recargue");
    expect(() => requireEtag('W/"a"', '"a"')).toThrow("Recargue");
    expect(() => requireEtag('"a"', '"a"')).not.toThrow();
  });
  it.each([["mes_actual", "2026-11-01T05:00:00.000Z"], ["ultimos_3_meses", "2026-09-01T05:00:00.000Z"], ["ultimo_ano", "2025-12-01T05:00:00.000Z"]])("uses Bogotá dates for %s", (periodo, start) => {
    const range = publicDateRange(PublicFilters.parse({ periodo }), new Date("2026-12-01T04:59:59Z"));
    expect(range.from?.toISOString()).toBe(start); expect(range.until?.toISOString()).toBe("2026-12-01T05:00:00.000Z");
  });
  it("uses inclusive calendar date ranges and rejects impossible days", () => {
    const range = publicDateRange(PublicFilters.parse({ periodo: "rango", desde: "2026-11-01", hasta: "2026-11-02" }));
    expect(range.until?.toISOString()).toBe("2026-11-03T05:00:00.000Z");
    expect(PublicFilters.safeParse({ periodo: "rango", desde: "2026-02-30", hasta: "2026-03-01" }).success).toBe(false);
  });
  it("public projection never spreads internal sentinels", () => {
    const result = publicProjection({ public_id: "public", entry_type: "regla_negocio", release_month: "2026-11", title: "Público", primary_route_text: "Ruta",
      body_json: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Público" }] }] }),
      clientName: "PRIVATE_CLIENT", developer: "PRIVATE_DEV", findings: "PRIVATE_FINDINGS", video: "PRIVATE_VIDEO", source_id: "PRIVATE_ID" }, true);
    expect(Object.keys(result).sort()).toEqual(["body", "category", "publicId", "releaseMonth", "summary", "title", "whereToFind"]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("escapes hostile report text instead of rendering user HTML", () => {
    const input = { number: "<script>", primaryRoute: "<img src=x>", developer: { displayName: "<iframe>" }, participants: [], requiredActions: [], findings: [], rounds: [], log: [], whatChanged: null };
    const html = renderReport([input as any]);
    expect(html).not.toContain("<script>"); expect(html).not.toContain("<iframe>"); expect(html).toContain("&lt;script&gt;");
  });
});
