import { CreateTemplateSchema, SaveTemplateVersionSchema, TemplateVersionNumberSchema } from "./checklistTemplateSchemas";

export type TemplatePoint = { id: string; position: number; title: string; detail: string | null };
export type TemplateVersionState = {
  id: string; number: number; status: "editing" | "current" | "frozen"; requiresEnvironment: boolean;
  uses: number; deleted: boolean; rowVersion: string | null; points: TemplatePoint[];
};
export type TemplateState = { id: string; name: string; deleted: boolean; versions: TemplateVersionState[] };
export type TemplateContext = { canManageTemplates: boolean; isSuperAdmin: boolean; newId(): string };

export type TemplateErrorCode = "forbidden" | "not_found" | "invalid_request" | "name_taken" | "editing_exists" | "version_locked" | "in_use" | "stale" | "no_points";
export class ChecklistTemplateError extends Error {
  constructor(readonly status: number, readonly error: TemplateErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message); this.name = "ChecklistTemplateError";
  }
}

/** Pure transition plans, not persisted resources. A write repository must own
 * locking, current authorization/uses, row-version comparison, audit and commit,
 * then re-read SQL-generated ROWVERSION for the response. No HTTP/SQL/I/O here. */
const clone = (state: TemplateState): TemplateState => ({ ...state, versions: state.versions.map((v) => ({ ...v, points: v.points.map((p) => ({ ...p })) })) });
const active = (state: TemplateState) => state.versions.filter((v) => !v.deleted);
export function normalizeTemplateName(name: string): string {
  return name.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
function requireAccess(ctx: TemplateContext): void {
  if (!ctx.isSuperAdmin && !ctx.canManageTemplates) throw new ChecklistTemplateError(403, "forbidden", "No tiene permiso para administrar plantillas de checklist.");
}
function requireTemplate(ctx: TemplateContext, state: TemplateState): void {
  requireAccess(ctx);
  if (state.deleted) throw new ChecklistTemplateError(404, "not_found", "No se encontró la plantilla.");
}
function getVersion(state: TemplateState, number: number): TemplateVersionState {
  TemplateVersionNumberSchema.parse(number);
  const version = active(state).find((v) => v.number === number);
  if (!version) throw new ChecklistTemplateError(404, "not_found", "No se encontró la versión.");
  return version;
}
function requireEditing(version: TemplateVersionState): void {
  if (version.status !== "editing") throw new ChecklistTemplateError(409, "version_locked", "Esta versión está publicada y no se puede editar ni eliminar.");
}

/** CA-33 / RN-30,31: uniqueness uses only nondeleted templates, no ownership. */
export function createTemplate(ctx: TemplateContext, input: unknown, existing: TemplateState[]): TemplateState {
  requireAccess(ctx);
  const { name } = CreateTemplateSchema.parse(input);
  if (existing.some((t) => !t.deleted && normalizeTemplateName(t.name) === normalizeTemplateName(name))) {
    throw new ChecklistTemplateError(409, "name_taken", "Ya existe una plantilla con ese nombre.");
  }
  return { id: ctx.newId(), name, deleted: false, versions: [{ id: ctx.newId(), number: 1, status: "editing", requiresEnvironment: false,
    uses: 0, deleted: false, rowVersion: null, points: [] }] };
}

/** CA-22,26,32 / RN-23,25,28: deleted numbers can be reused; point IDs cannot. */
export function createTemplateVersion(ctx: TemplateContext, state: TemplateState): TemplateState {
  requireTemplate(ctx, state);
  const versions = active(state);
  if (versions.some((v) => v.status === "editing")) throw new ChecklistTemplateError(409, "editing_exists", "Ya hay una versión en edición. Publíquela o descártela antes de crear otra.");
  const number = Math.max(0, ...versions.map((v) => v.number)) + 1;
  TemplateVersionNumberSchema.parse(number);
  const current = versions.find((v) => v.status === "current");
  const points = [...(current?.points ?? [])].sort((a, b) => a.position - b.position)
    .map((p, index) => ({ ...p, id: ctx.newId(), position: index + 1 }));
  const result = clone(state);
  result.versions.push({ id: ctx.newId(), number, status: "editing", requiresEnvironment: current?.requiresEnvironment ?? false,
    uses: 0, deleted: false, rowVersion: null, points });
  return result;
}

/** CA-24,37 / RN-37–39: strict full-form request, own point IDs, no partial mutation. */
export function saveTemplateVersion(ctx: TemplateContext, state: TemplateState, number: number, input: unknown): TemplateState {
  requireTemplate(ctx, state);
  const current = getVersion(state, number);
  requireEditing(current);
  const body = SaveTemplateVersionSchema.parse(input);
  if (body.rowVersion !== current.rowVersion) throw new ChecklistTemplateError(409, "stale", "Alguien cambió esta versión mientras usted la editaba. Copie lo que necesite y recargue.");
  const owns = new Set(current.points.map((p) => p.id.toLowerCase()));
  if (body.points.some((p) => p.id && !owns.has(p.id))) throw new ChecklistTemplateError(400, "invalid_request", "Los puntos deben pertenecer a esta versión.");
  const points = body.points.map((p, index) => ({ id: p.id ?? ctx.newId(), position: index + 1, title: p.title, detail: p.detail }));
  const result = clone(state);
  const target = result.versions.find((v) => !v.deleted && v.id === current.id)!;
  target.requiresEnvironment = body.requiresEnvironment;
  target.points = points;
  return result;
}

/** CA-23,27 / RN-24: only status of old published version changes, not its points/uses. */
export function publishTemplateVersion(ctx: TemplateContext, state: TemplateState, number: number): TemplateState {
  requireTemplate(ctx, state);
  const current = getVersion(state, number);
  requireEditing(current);
  if (current.points.length === 0) throw new ChecklistTemplateError(422, "no_points", "Agregue al menos un punto antes de publicar.");
  const result = clone(state);
  for (const version of result.versions.filter((v) => !v.deleted)) {
    if (version.status === "current") version.status = "frozen";
    if (version.id === current.id) version.status = "current";
  }
  return result;
}

/** CA-24–26 / RN-25,26. "Last" includes any nondeleted editing version. */
export function removeTemplateVersion(ctx: TemplateContext, state: TemplateState, number: number): TemplateState {
  requireTemplate(ctx, state);
  const target = getVersion(state, number);
  if (target.status === "frozen") throw new ChecklistTemplateError(409, "version_locked", "Una versión congelada no se puede eliminar.");
  if (target.uses > 0) throw new ChecklistTemplateError(409, "in_use", "Esta versión está en uso y no se puede eliminar.");
  const versions = active(state);
  if (target.number !== Math.max(...versions.map((v) => v.number))) throw new ChecklistTemplateError(409, "version_locked", "Solo se puede eliminar la última versión.");
  const result = clone(state);
  result.versions.find((v) => !v.deleted && v.id === target.id)!.deleted = true;
  if (target.status === "current") {
    const previous = active(result).filter((v) => v.status === "frozen").sort((a, b) => b.number - a.number)[0];
    if (previous) previous.status = "current";
  }
  return result;
}

/** CA-30,31 / RN-34,35: no template creator/owner exemption. */
export function deleteTemplate(ctx: TemplateContext, state: TemplateState): TemplateState {
  if (!ctx.isSuperAdmin) throw new ChecklistTemplateError(403, "forbidden", "Solo un superadministrador puede eliminar plantillas.");
  requireTemplate(ctx, state);
  if (state.versions.some((v) => v.uses > 0)) throw new ChecklistTemplateError(409, "in_use", "La plantilla está en uso y no se puede eliminar.");
  return { ...clone(state), deleted: true };
}
