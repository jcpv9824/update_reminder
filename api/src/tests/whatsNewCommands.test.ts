import { describe, expect, it } from "vitest";
import { decideCreate, decideDelete, decideTake, decideRelease, decideMarkTested, decideMarkFailed, decidePublish, decideSaveDraft, DraftInSchema,
  type CommandContext, type EntryState } from "../lib/whatsNewCommands";
import { buildActor, canSeeEntry } from "../lib/whatsNewAccess";
import { PERMISSIONS } from "../lib/whatsNewModel";
import { DEFAULT_ROLE_DEFINITIONS } from "../lib/permissionModel";

export const doc = { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text: "Cambio" }] }] };
export const context = (): CommandContext => ({
  actor: { id: "tester", email: "test@example.invalid", displayName: "Prueba", permissions: new Set(Object.values(PERMISSIONS)), areas: new Set(["desarrollo", "soporte"]) },
  now: new Date("2026-12-01T04:00:00Z"), newId: () => "11111111-1111-4111-8111-111111111111",
  catalog: [{ code: "probar", label: "Probar", active: true, isOther: false }], users: new Map(), files: new Map(),
});
export const entry = (): EntryState => ({
  key: 1, id: "22222222-2222-4222-8222-222222222222", number: 1, status: "sin_probar", type: "mejora", system: "sag_web",
  whatChanged: doc, clientName: null, initialTesterId: null, developerId: "developer", currentRevisionNo: 1, currentRoundNo: 0,
  lastFindingNo: 0, openFindingsCount: 0, etag: '"AAAAAAAAAAE="', routes: [{ via: "barra_lateral", submenus: ["Ventas"], option: "Facturas" }],
  actions: [{ code: "probar", label: "Probar", detail: doc }], attachments: [], contributorIds: ["developer"], asesorParticipantIds: [],
  openRound: null, findings: [], clientText: null, lastLog: null,
});
function held(): EntryState { return { ...entry(), status: "en_pruebas", currentRoundNo: 1, openRound: { id: "round", roundNo: 1, revisionNo: 1, holderId: "tester", checklist: [{ itemNo: 1, label: "Probar", checked: false }] } }; }

describe("Qué hay de nuevo domain gates", () => {
  it("lets the developer retire an owned approved entry without rewriting its approval history", () => {
    const ctx = context(); ctx.actor.id = "developer";
    ctx.actor.areas = new Set(["desarrollo"]);
    ctx.actor.permissions = new Set([PERMISSIONS.view, PERMISSIONS.author]);
    const result = decideDelete(ctx, { ...entry(), status: "probado" });
    expect(result.status).toBe("eliminada");
    expect(result.effects).toEqual([
      { kind: "entry.patch", patch: { status: "eliminada", deletedAt: ctx.now } },
      expect.objectContaining({ kind: "log.insert", action: "eliminar", from: "probado", to: "eliminada" }),
      expect.objectContaining({ kind: "audit", action: "whats_new_entry_deleted" }),
    ]);
  });
  it("lets the active support holder retire the entry and closes only the open round", () => {
    const ctx = context();
    ctx.actor.areas = new Set(["soporte"]);
    ctx.actor.permissions = new Set([PERMISSIONS.view, PERMISSIONS.test]);
    const state = { ...held(), initialTesterId: "somebody-else" };
    const result = decideDelete(ctx, state);
    expect(result.effects).toContainEqual({ kind: "round.close", roundNo: 1, status: "soltada", forcedReason: null });
    expect(result.effects).toContainEqual(expect.objectContaining({ kind: "log.insert", action: "eliminar", roundNo: 1 }));
    expect(state.openRound?.checklist).toHaveLength(1);
    expect(() => decideDelete(ctx, { ...state, initialTesterId: ctx.actor.id, openRound: { ...state.openRound!, holderId: "other-holder" } }))
      .toThrow("permiso");
  });
  it("lets only assigned support retire an unclaimed publication, never another person's draft", () => {
    const ctx = context();
    ctx.actor.areas = new Set(["soporte"]);
    ctx.actor.permissions = new Set([PERMISSIONS.view, PERMISSIONS.test]);
    const state = { ...entry(), initialTesterId: ctx.actor.id };
    expect(decideDelete(ctx, state).status).toBe("eliminada");
    expect(() => decideDelete(ctx, { ...state, status: "borrador" })).toThrow("permiso");
    expect(() => decideDelete(ctx, { ...state, initialTesterId: null })).toThrow("permiso");
    ctx.actor.areas = new Set();
    expect(() => decideDelete(ctx, state)).toThrow("permiso");
  });
  it("does not treat manage or view_all as super_admin and limits withdrawn history to the real role", () => {
    const ctx = context(); ctx.actor.areas = new Set();
    const state = { ...entry(), status: "archivada" as const };
    const removed = { ...state, status: "eliminada" as const };
    expect(() => decideDelete(ctx, state)).toThrow("permiso");
    expect(canSeeEntry(ctx.actor, removed)).toBe(false);
    ctx.actor = buildActor({ id: "owner", displayName: "Owner", email: "owner@example.invalid", roles: ["super_admin"] }, DEFAULT_ROLE_DEFINITIONS, []);
    expect(decideDelete(ctx, state).status).toBe("eliminada");
    expect(canSeeEntry(ctx.actor, removed)).toBe(true);
    expect(() => decideDelete(ctx, removed)).toThrow("no permite");
  });
  it("requires both author permission and Desarrollo area", () => {
    const ctx = context(); ctx.actor.areas = new Set(["soporte"]);
    expect(() => decideCreate(ctx)).toThrow("Desarrollo");
    ctx.actor.areas = new Set(["desarrollo"]); ctx.actor.permissions = new Set([PERMISSIONS.view]);
    expect(() => decideCreate(ctx)).toThrow("permisos");
  });
  it("rejects author assignment from the body", () => { expect(DraftInSchema.safeParse({ developerId: "other" }).success).toBe(false); });
  it("prevents an old editor from dropping an existing image-side layout while allowing intentional removal", () => {
    const ctx = context(); ctx.actor.id = "developer";
    const state: EntryState = { ...entry(), status: "borrador", whatChanged: { type: "doc", content: [
      { type: "imageWithText", content: [{ type: "image", attrs: { fileId: ctx.newId() } }, ...doc.content] },
    ] } };
    expect(() => decideSaveDraft(ctx, state, { whatChanged: doc })).toThrow(expect.objectContaining({ status: 409, code: "editor_desactualizado" }));
    expect(decideSaveDraft(ctx, state, { whatChanged: doc, editorLayoutVersion: 1 }).effects[0])
      .toMatchObject({ kind: "entry.patch", patch: { whatChanged: doc } });
    expect(decideSaveDraft(ctx, state, { system: "sag_clasico" }).effects[0])
      .toMatchObject({ kind: "entry.patch", patch: { system: "sag_clasico" } });
  });
  it("accepts only opaque ERP selection IDs, never a free client name", () => {
    expect(DraftInSchema.safeParse({ clientName: "Empresa según el navegador" }).success).toBe(false);
    expect(DraftInSchema.safeParse({ clientId: "123456789" }).success).toBe(false);
    expect(DraftInSchema.parse({ clientId: "80235E8A-1234-FABC-FABC-230E54234A23" }).clientId)
      .toBe("80235e8a-1234-fabc-fabc-230e54234a23");
    expect(DraftInSchema.parse({ clientId: null }).clientId).toBeNull();
  });
  it("preserves a prior client snapshot unless a new selection is saved or it is cleared", () => {
    const ctx = context();
    const state = { ...entry(), type: "nuevo" as const, status: "borrador" as const, developerId: ctx.actor.id, clientName: "Histórico" };
    const patch = (input: Parameters<typeof decideSaveDraft>[2]) =>
      decideSaveDraft(ctx, state, input).effects.find((e) => e.kind === "entry.patch")?.patch;
    expect(patch({})).not.toHaveProperty("clientName");
    expect(patch({ clientName: null })).toHaveProperty("clientName", null);
    expect(patch({ clientName: "Canónico ERP" })).toHaveProperty("clientName", "Canónico ERP");
  });
  it("does not publish a Nuevo entry without a resolved client snapshot", () => {
    const ctx = context();
    const state = { ...entry(), type: "nuevo" as const, status: "borrador" as const,
      developerId: ctx.actor.id, initialTesterId: "support-user" };
    ctx.users.set("support-user", { id: "support-user", displayName: "Soporte", email: "support@example.invalid", active: true, areas: ["soporte"] });
    expect(() => decidePublish(ctx, state)).toThrow(expect.objectContaining({ status: 422, details: { fields: ["clientId"] } }));
    expect(decidePublish(ctx, { ...state, clientName: "Canónico ERP" }).status).toBe("sin_probar");
  });
  it("promotes only same-entry verified media from the exact target when committing a draft", () => {
    const ctx = context();
    ctx.mediaAvailable = true;
    const fileId = "11111111-1111-4111-8111-111111111111";
    const whatChanged = { type: "doc", content: [{ type: "image", attrs: { fileId } }] };
    const state = { ...entry(), status: "borrador" as const, developerId: ctx.actor.id };
    expect(() => decideSaveDraft(ctx, state, { whatChanged })).toThrow(expect.objectContaining({ status: 400 }));
    ctx.files.set(fileId, { fileId, status: "verificada", kind: "imagen", target: "reglas_negocio" });
    expect(() => decideSaveDraft(ctx, state, { whatChanged })).toThrow(expect.objectContaining({ status: 400 }));
    ctx.files.set(fileId, { fileId, status: "verificada", kind: "imagen", target: "que_cambio" });
    expect(decideSaveDraft(ctx, state, { whatChanged }).effects[0]).toEqual({ kind: "files.promote", fileIds: [fileId] });
  });
  it("uses verified names and sizes for private rich-text attachments", () => {
    const ctx = context();
    ctx.mediaAvailable = true;
    const fileId = "11111111-1111-4111-8111-111111111111";
    const whatChanged = { type: "doc", content: [{ type: "paragraph", content: [
      { type: "adjuntoArchivo", attrs: { fileId, nombre: "wrong.html", tamano: 1 } },
    ] }] };
    const state = { ...entry(), status: "borrador" as const, developerId: ctx.actor.id };
    ctx.files.set(fileId, { fileId, status: "en_entrada", kind: "documento", target: "que_cambio", name: "correcto.pdf", bytes: 50 });
    const patch = decideSaveDraft(ctx, state, { whatChanged }).effects.find((effect) => effect.kind === "entry.patch");
    expect(JSON.stringify(patch)).toContain("correcto.pdf");
    expect(JSON.stringify(patch)).not.toContain("wrong.html");
  });
  it("a partial draft edit does not default or erase omitted fields", () => {
    const ctx = context(); const state = { ...entry(), status: "borrador" as const, developerId: ctx.actor.id };
    const result = decideSaveDraft(ctx, state, DraftInSchema.parse({ whatChanged: doc }));
    const patch = result.effects.find((e) => e.kind === "entry.patch");
    expect(patch?.kind === "entry.patch" && patch.patch).not.toHaveProperty("type");
    expect(patch?.kind === "entry.patch" && patch.patch).not.toHaveProperty("system");
    expect(result.effects.some((e) => e.kind === "routes.replace" || e.kind === "actions.replace")).toBe(false);
    expect(state.type).toBe("mejora"); expect(state.actions).toHaveLength(1);
  });
  it("forbids contributors from testing their own changes", () => { const state = entry(); state.contributorIds.push("tester"); expect(() => decideTake(context(), state)).toThrow("no puede probarla"); });
  it("takes only an untested entry and records participant", () => {
    const result = decideTake(context(), entry()); expect(result.status).toBe("en_pruebas");
    expect(result.effects.some((e) => e.kind === "participant.add")).toBe(true);
    expect(() => decideTake(context(), held())).toThrow();
  });
  it("releases without deleting history or enqueueing email", () => {
    const state = held(); const result = decideRelease(context(), state);
    expect(result.status).toBe("sin_probar"); expect(result.effects.some((e) => e.kind === "round.close" && e.status === "soltada")).toBe(true);
    expect(state.openRound?.checklist).toHaveLength(1);
    expect(result.effects.map((e) => e.kind)).toEqual(["entry.patch", "round.close", "log.insert", "audit"]);
  });
  it("requires complete checklist and sets Bogotá approval month", () => {
    const state = held(); expect(() => decideMarkTested(context(), state)).toThrow("checklist");
    state.openRound!.checklist[0].checked = true;
    expect(decideMarkTested(context(), state).result.releaseMonth).toBe("2026-11");
  });
  it("requires a current, nonannulled finding to fail", () => {
    const state = held(); state.findings = [{ id: "x", number: 1, roundNo: 0, createdById: "tester", annulled: false }];
    expect(() => decideMarkFailed(context(), state)).toThrow("hallazgo");
    state.findings[0].roundNo = 1; state.findings[0].annulled = true;
    expect(() => decideMarkFailed(context(), state)).toThrow("hallazgo");
    state.findings[0].annulled = false; expect(decideMarkFailed(context(), state).status).toBe("fallida");
  });
  it("publishes nonempty rich text after validation", () => {
    const state = { ...entry(), developerId: "tester", status: "borrador" as const };
    expect(decidePublish(context(), state).status).toBe("sin_probar");
  });
});
