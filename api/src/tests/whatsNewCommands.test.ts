import { describe, expect, it } from "vitest";
import { decideCreate, decideTake, decideRelease, decideMarkTested, decideMarkFailed, decidePublish, decideSaveDraft, DraftInSchema,
  type CommandContext, type EntryState } from "../lib/whatsNewCommands";
import { PERMISSIONS } from "../lib/whatsNewModel";

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
  it("requires both author permission and Desarrollo area", () => {
    const ctx = context(); ctx.actor.areas = new Set(["soporte"]);
    expect(() => decideCreate(ctx)).toThrow("Desarrollo");
    ctx.actor.areas = new Set(["desarrollo"]); ctx.actor.permissions = new Set([PERMISSIONS.view]);
    expect(() => decideCreate(ctx)).toThrow("permisos");
  });
  it("rejects author assignment from the body", () => { expect(DraftInSchema.safeParse({ developerId: "other" }).success).toBe(false); });
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
