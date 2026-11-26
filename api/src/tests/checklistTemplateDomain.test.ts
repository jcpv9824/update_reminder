import { describe, expect, it } from "vitest";
import { createTemplate, createTemplateVersion, saveTemplateVersion, publishTemplateVersion, removeTemplateVersion, deleteTemplate,
  type TemplateContext, type TemplateState, type TemplateVersionState } from "../lib/checklistTemplateDomain";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rv = "AAAAAAAAAAE=";
function context(superAdmin = false): TemplateContext {
  let n = 100;
  return { canManageTemplates: true, isSuperAdmin: superAdmin, newId: () => uuid(n++) };
}
function version(number: number, status: TemplateVersionState["status"], extra: Partial<TemplateVersionState> = {}): TemplateVersionState {
  return { id: uuid(number), number, status, requiresEnvironment: false, uses: 0, deleted: false, rowVersion: rv,
    points: [{ id: uuid(number + 20), position: 1, title: `Punto ${number}`, detail: "Detalle" }], ...extra };
}
function template(versions: TemplateVersionState[] = []): TemplateState { return { id: uuid(1), name: "Migración", deleted: false, versions }; }
function rejects(action: () => unknown, status: number, error: string) { expect(action).toThrow(expect.objectContaining({ status, error })); }

describe("Plantillas · reglas puras (no prueba endpoints, SQL ni interfaz)", () => {
  it("CA-33 / RN-30–31 crea plantilla y 1.0 vacía y bloquea nombres equivalentes activos", () => {
    const result = createTemplate(context(), { name: "Nueva" }, []);
    expect(result.versions).toMatchObject([{ number: 1, status: "editing", points: [] }]);
    rejects(() => createTemplate(context(), { name: "migracion" }, [template()]), 409, "name_taken");
    expect(createTemplate(context(), { name: "Migración" }, [{ ...template(), deleted: true }]).name).toBe("Migración");
  });
  it("CA-22 bloquea otra versión si ya hay una en edición", () => {
    rejects(() => createTemplateVersion(context(), template([version(2, "current"), version(3, "editing")])), 409, "editing_exists");
  });
  it("CA-32 / RN-23 copia la vigente con IDs nuevos, orden, detalle y ambiente, sin criterio de dueño", () => {
    const source = template([version(2, "current", { requiresEnvironment: true, points: [
      { id: uuid(21), position: 1, title: "Primero", detail: null }, { id: uuid(22), position: 2, title: "Segundo", detail: "Ayuda" },
    ] })]);
    const before = structuredClone(source);
    const result = createTemplateVersion(context(), source);
    expect(result.versions.at(-1)).toMatchObject({ number: 3, status: "editing", requiresEnvironment: true,
      points: [{ position: 1, title: "Primero", detail: null }, { position: 2, title: "Segundo", detail: "Ayuda" }] });
    expect(result.versions.at(-1)!.points.map((p) => p.id)).not.toEqual(source.versions[0].points.map((p) => p.id));
    expect(source).toEqual(before);
  });
  it("CA-23 publica 3.0, congela 2.0 y no modifica el estado de entrada", () => {
    const state = template([version(2, "current", { uses: 2 }), version(3, "editing")]); const before = structuredClone(state);
    const result = publishTemplateVersion(context(), state, 3);
    expect(result.versions.map((v) => v.status)).toEqual(["frozen", "current"]);
    expect(result.versions[0].uses).toBe(2); expect(state).toEqual(before);
  });
  it.each(["current", "frozen"] as const)("CA-24 no permite editar una versión %s publicada", (status) => {
    rejects(() => saveTemplateVersion(context(), template([version(2, status)]), 2, { requiresEnvironment: true, points: [], rowVersion: rv }), 409, "version_locked");
  });
  it("CA-24 nunca elimina una congelada aunque tenga cero usos", () => {
    rejects(() => removeTemplateVersion(context(), template([version(2, "frozen")]), 2), 409, "version_locked");
  });
  it("CA-25 retira la última vigente sin uso y reactiva la publicada anterior", () => {
    const result = removeTemplateVersion(context(), template([version(2, "frozen"), version(3, "current")]), 3);
    expect(result.versions[0]).toMatchObject({ status: "current", deleted: false });
    expect(result.versions[1].deleted).toBe(true);
  });
  it("CA-25 / RN-26 bloquea vigente usada o que no sea la última incluyendo edición", () => {
    rejects(() => removeTemplateVersion(context(), template([version(3, "current", { uses: 1 })]), 3), 409, "in_use");
    rejects(() => removeTemplateVersion(context(), template([version(2, "frozen"), version(3, "current"), version(4, "editing")]), 3), 409, "version_locked");
  });
  it("CA-26 descarta 3.0 lógicamente y reutiliza el número al crear otra", () => {
    const discarded = removeTemplateVersion(context(), template([version(2, "current"), version(3, "editing")]), 3);
    const recreated = createTemplateVersion(context(), discarded);
    expect(discarded.versions[1].deleted).toBe(true);
    expect(recreated.versions.filter((v) => !v.deleted).map((v) => v.number)).toEqual([2, 3]);
    expect(recreated.versions.at(-1)!.id).not.toBe(discarded.versions[1].id);
  });
  it("CA-27 exige al menos un punto para publicar, sin cambiar el estado", () => {
    const state = template([version(1, "editing", { points: [] })]);
    rejects(() => publishTemplateVersion(context(), state, 1), 422, "no_points");
    expect(state.versions[0].status).toBe("editing");
  });
  it("CA-30 el permiso de plantillas no basta para eliminarlas", () => {
    rejects(() => deleteTemplate(context(), template()), 403, "forbidden");
  });
  it("CA-31 solo elimina un superadministrador y cuando ninguna versión tiene usos", () => {
    rejects(() => deleteTemplate(context(true), template([version(1, "frozen", { uses: 1 }), version(2, "current")])), 409, "in_use");
    expect(deleteTemplate(context(true), template([version(1, "editing")])).deleted).toBe(true);
  });
  it("CA-32 cualquier actor con acceso administra sin propiedad; sin acceso no puede mutar", () => {
    const state = template([version(1, "editing")]);
    expect(publishTemplateVersion(context(), state, 1).versions[0].status).toBe("current");
    const denied = { ...context(), canManageTemplates: false };
    rejects(() => createTemplate(denied, { name: "Otra" }, []), 403, "forbidden");
    rejects(() => createTemplateVersion(denied, state), 403, "forbidden");
    rejects(() => publishTemplateVersion(denied, state, 1), 403, "forbidden");
    rejects(() => removeTemplateVersion(denied, state, 1), 403, "forbidden");
    rejects(() => saveTemplateVersion(denied, state, 1, { requiresEnvironment: false, points: [], rowVersion: rv }), 403, "forbidden");
  });
  it("CA-37 rechaza una ROWVERSION desactualizada y no cambia puntos ni ambiente", () => {
    const state = template([version(1, "editing", { rowVersion: "AAAAAAAAAAI=" })]); const before = structuredClone(state);
    rejects(() => saveTemplateVersion(context(), state, 1, { requiresEnvironment: true, points: [], rowVersion: rv }), 409, "stale");
    expect(state).toEqual(before);
  });
  it("CA-37 / API-26 conserva IDs propios, rechaza IDs ajenos y genera posiciones consecutivas", () => {
    const state = template([version(1, "editing")]); const point = state.versions[0].points[0];
    rejects(() => saveTemplateVersion(context(), state, 1, { requiresEnvironment: false, points: [{ id: uuid(99), title: "Ajeno" }], rowVersion: rv }), 400, "invalid_request");
    const result = saveTemplateVersion(context(), state, 1, { requiresEnvironment: true, points: [{ title: "Nuevo" }, { id: point.id, title: "Existente", detail: " " }], rowVersion: rv });
    expect(result.versions[0].points.map((p) => p.position)).toEqual([1, 2]);
    expect(result.versions[0].points[1]).toMatchObject({ id: point.id, detail: null });
  });
});
