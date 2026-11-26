import { CreateTemplateSchema, SaveTemplateVersionSchema, TemplateIdParamsSchema, TemplateVersionNumberSchema, type CreateTemplateInput, type SaveTemplateVersionInput } from "./checklistTemplateSchemas";
import { ChecklistTemplateError, type TemplatePoint, type TemplateState, type TemplateVersionState } from "./checklistTemplateDomain";
export type ChecklistTemplateActor = { id: string; email: string; canManageTemplates: boolean; isSuperAdmin: boolean };
export type StoredTemplate = TemplateState & { createdAt: string };
export type StoredTemplateSummary = { id: string; name: string; currentVersion: number | null; uses: number; createdAt: string };
export type TemplateOperation = "create" | "remove" | "createVersion" | "saveVersion" | "publishVersion" | "removeVersion";
export type TemplateOperationInput = { id?: string; number?: number; input?: CreateTemplateInput | SaveTemplateVersionInput };
export interface ChecklistTemplateStore {
  list(): Promise<StoredTemplateSummary[]>;
  read(id: string): Promise<StoredTemplate | null>;
  execute(actor: ChecklistTemplateActor, operation: TemplateOperation, args: TemplateOperationInput): Promise<StoredTemplate>;
}
export type TemplateSummaryDto = StoredTemplateSummary & { canDelete: boolean };
export type VersionSummaryDto = Pick<TemplateVersionState, "id" | "number" | "status" | "requiresEnvironment" | "uses"> & { rowVersion: string };
export type TemplateDetailDto = TemplateSummaryDto & { versions: VersionSummaryDto[] };
export type VersionDetailDto = VersionSummaryDto & { templateId: string; templateName: string; points: TemplatePoint[] };
export interface ChecklistTemplateService {
  list(actor: ChecklistTemplateActor): Promise<TemplateSummaryDto[]>;
  create(actor: ChecklistTemplateActor, input: unknown): Promise<TemplateDetailDto>;
  get(actor: ChecklistTemplateActor, id: string): Promise<TemplateDetailDto>;
  remove(actor: ChecklistTemplateActor, id: string): Promise<void>;
  createVersion(actor: ChecklistTemplateActor, id: string): Promise<VersionDetailDto>;
  getVersion(actor: ChecklistTemplateActor, id: string, number: number): Promise<VersionDetailDto>;
  saveVersion(actor: ChecklistTemplateActor, id: string, number: number, input: unknown): Promise<VersionDetailDto>;
  publishVersion(actor: ChecklistTemplateActor, id: string, number: number): Promise<VersionDetailDto>;
  removeVersion(actor: ChecklistTemplateActor, id: string, number: number): Promise<void>;
}
function requireAccess(actor: ChecklistTemplateActor): void {
  if (!actor.canManageTemplates && !actor.isSuperAdmin) throw new ChecklistTemplateError(403, "forbidden", "No tiene permiso para administrar plantillas de checklist.");
}
function versionDto(version: TemplateVersionState): VersionSummaryDto {
  if (!version.rowVersion) throw new Error("The repository must return a persisted ROWVERSION.");
  return { id: version.id, number: version.number, status: version.status, requiresEnvironment: version.requiresEnvironment, uses: version.uses, rowVersion: version.rowVersion };
}
function templateDto(actor: ChecklistTemplateActor, record: StoredTemplate): TemplateDetailDto {
  const versions = record.versions.filter((v) => !v.deleted);
  const uses = record.versions.reduce((sum, version) => sum + version.uses, 0);
  return { id: record.id, name: record.name, currentVersion: versions.find((v) => v.status === "current")?.number ?? null,
    uses, createdAt: record.createdAt, canDelete: actor.isSuperAdmin && uses === 0, versions: versions.map(versionDto) };
}
function versionDetail(record: StoredTemplate, number: number): VersionDetailDto {
  const version = record.versions.find((v) => !v.deleted && v.number === number);
  if (!version) throw new ChecklistTemplateError(404, "not_found", "No se encontró la versión.");
  return { ...versionDto(version), templateId: record.id, templateName: record.name,
    points: [...version.points].sort((a, b) => a.position - b.position).map((p) => ({ id: p.id, position: p.position, title: p.title, detail: p.detail })) };
}
export function createChecklistTemplateService(store: ChecklistTemplateStore): ChecklistTemplateService {
  const validateId = (id: string) => TemplateIdParamsSchema.parse({ id }).id;
  async function read(actor: ChecklistTemplateActor, id: string) {
    requireAccess(actor);
    const record = await store.read(validateId(id));
    if (!record || record.deleted) throw new ChecklistTemplateError(404, "not_found", "No se encontró la plantilla.");
    return record;
  }
  async function write(actor: ChecklistTemplateActor, operation: TemplateOperation, args: TemplateOperationInput) {
    requireAccess(actor);
    return store.execute(actor, operation, args);
  }
  return {
    async list(actor) {
      requireAccess(actor);
      return (await store.list()).map((r) => ({ id: r.id, name: r.name, currentVersion: r.currentVersion, uses: r.uses, createdAt: r.createdAt, canDelete: actor.isSuperAdmin && r.uses === 0 }));
    },
    async create(actor, input) {
      requireAccess(actor);
      const parsed = CreateTemplateSchema.parse(input);
      return templateDto(actor, await write(actor, "create", { input: parsed }));
    },
    async get(actor, id) { return templateDto(actor, await read(actor, id)); },
    async remove(actor, id) {
      if (!actor.isSuperAdmin) throw new ChecklistTemplateError(403, "forbidden", "Solo un superadministrador puede eliminar plantillas.");
      await write(actor, "remove", { id: validateId(id) });
    },
    async createVersion(actor, id) {
      requireAccess(actor);
      const record = await write(actor, "createVersion", { id: validateId(id) });
      const editing = record.versions.find((v) => !v.deleted && v.status === "editing");
      if (!editing) throw new Error("The repository did not return the new editing version.");
      return versionDetail(record, editing.number);
    },
    async getVersion(actor, id, number) { return versionDetail(await read(actor, id), TemplateVersionNumberSchema.parse(number)); },
    async saveVersion(actor, id, number, input) {
      requireAccess(actor);
      const body = SaveTemplateVersionSchema.parse(input);
      return versionDetail(await write(actor, "saveVersion", { id: validateId(id), number: TemplateVersionNumberSchema.parse(number), input: body }), number);
    },
    async publishVersion(actor, id, number) {
      requireAccess(actor);
      return versionDetail(await write(actor, "publishVersion", { id: validateId(id), number: TemplateVersionNumberSchema.parse(number) }), number);
    },
    async removeVersion(actor, id, number) { requireAccess(actor); await write(actor, "removeVersion", { id: validateId(id), number: TemplateVersionNumberSchema.parse(number) }); },
  };
}
