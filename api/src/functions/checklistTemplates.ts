import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { ChecklistTemplateError } from "../lib/checklistTemplateDomain";
import { CreateTemplateSchema, SaveTemplateVersionSchema, TemplateIdParamsSchema, TemplateVersionParamsSchema } from "../lib/checklistTemplateSchemas";
import type { ChecklistTemplateActor, ChecklistTemplateService } from "../lib/checklistTemplateService";
import { createChecklistTemplateService } from "../lib/checklistTemplateService";
import { createChecklistTemplateSqlStore } from "../lib/checklistTemplateSqlWriteRepository";
import { requireUser, loadUserProfile } from "../lib/auth";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { hasPermissionWithRoleDefinitions, resolveRoleDefinitionsForUser } from "../lib/taskAccess";
export type ChecklistTemplateHandlerDependencies = {
  authenticate(req: HttpRequest): Promise<ChecklistTemplateActor | null>;
  service: ChecklistTemplateService;
};
export async function authenticateChecklistTemplateRequest(req: HttpRequest): Promise<ChecklistTemplateActor | null> {
  const authenticated = await requireUser(req);
  const profile = await loadUserProfile(authenticated);
  if (!profile) return null;
  const definitions = await loadRoleDefinitions();
  return { id: profile.id, email: profile.email,
    canManageTemplates: hasPermissionWithRoleDefinitions(profile, "configuration.checklist_templates.view", definitions),
    isSuperAdmin: resolveRoleDefinitionsForUser(profile, definitions).some((r) => r.id === "super_admin") };
}
async function json(req: HttpRequest): Promise<unknown> {
  const limit = 524_288;
  if (Number(req.headers.get("content-length") ?? 0) > limit) throw new ChecklistTemplateError(400, "invalid_request", "El cuerpo de la solicitud es demasiado grande.");
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > limit) throw new ChecklistTemplateError(400, "invalid_request", "El cuerpo de la solicitud es demasiado grande.");
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw new ChecklistTemplateError(400, "invalid_request", "El cuerpo JSON no es válido."); }
}

/** Explicit registration only. Root integration calls this once from index.ts;
 * importing this module in tests never registers handlers or opens SQL. */
export function registerChecklistTemplateRoutes(deps: ChecklistTemplateHandlerDependencies = {
  authenticate: authenticateChecklistTemplateRequest,
  service: createChecklistTemplateService(createChecklistTemplateSqlStore()),
}): void {
  const handlers = createChecklistTemplateHandlers(deps);
  app.http("checklistTemplatesCollection", { route: "configuration/checklist-templates", authLevel: "anonymous", methods: ["GET", "POST"],
    handler: (req) => req.method === "GET" ? handlers.list(req) : handlers.create(req) });
  app.http("checklistTemplatesResource", { route: "configuration/checklist-templates/{id}", authLevel: "anonymous", methods: ["GET", "DELETE"],
    handler: (req) => req.method === "GET" ? handlers.get(req) : handlers.remove(req) });
  app.http("checklistTemplateVersionsCreate", { route: "configuration/checklist-templates/{id}/versions", authLevel: "anonymous", methods: ["POST"], handler: handlers.createVersion });
  app.http("checklistTemplateVersionResource", { route: "configuration/checklist-templates/{id}/versions/{number}", authLevel: "anonymous", methods: ["GET", "PUT", "DELETE"],
    handler: (req) => req.method === "GET" ? handlers.getVersion(req) : req.method === "PUT" ? handlers.saveVersion(req) : handlers.removeVersion(req) });
  app.http("checklistTemplateVersionPublish", { route: "configuration/checklist-templates/{id}/versions/{number}/publish", authLevel: "anonymous", methods: ["POST"], handler: handlers.publishVersion });
}
export function createChecklistTemplateHandlers(deps: ChecklistTemplateHandlerDependencies) {
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  const wrap = (work: (req: HttpRequest, actor: ChecklistTemplateActor) => Promise<unknown>, status = 200, superOnly = false) => async (req: HttpRequest): Promise<HttpResponseInit> => {
    try {
      const actor = await deps.authenticate(req);
      if (!actor) return { status: 401, headers, jsonBody: { error: "unauthenticated", message: "No autenticado." } };
      if (superOnly ? !actor.isSuperAdmin : !actor.isSuperAdmin && !actor.canManageTemplates) throw new ChecklistTemplateError(403, "forbidden", "No tiene permiso para esta acción.");
      const result = await work(req, actor);
      return { status, headers, ...(status === 204 ? {} : { jsonBody: result }) };
    } catch (error) {
      if (error instanceof ChecklistTemplateError) return { status: error.status, headers, jsonBody: { error: error.error, message: error.message, ...(error.details ? { details: error.details } : {}) } };
      if (error instanceof z.ZodError) return { status: 400, headers, jsonBody: { error: "invalid_request", message: "Los parámetros o el cuerpo no son válidos." } };
      if (typeof error === "object" && error && "status" in error && error.status === 401) return { status: 401, headers, jsonBody: { error: "unauthenticated", message: "No autenticado." } };
      return { status: 500, headers, jsonBody: { error: "internal_error", message: "No se pudo completar la operación de plantillas." } };
    }
  };
  const id = (req: HttpRequest) => TemplateIdParamsSchema.parse({ id: req.params.id }).id;
  const version = (req: HttpRequest) => TemplateVersionParamsSchema.parse({ id: req.params.id, number: req.params.number });
  const noBody = async (req: HttpRequest) => z.object({}).strict().parse(await json(req));
  return {
    list: wrap(async (_req, actor) => ({ items: await deps.service.list(actor) })),
    create: wrap(async (req, actor) => deps.service.create(actor, CreateTemplateSchema.parse(await json(req))), 201),
    get: wrap(async (req, actor) => deps.service.get(actor, id(req))),
    remove: wrap(async (req, actor) => { await noBody(req); await deps.service.remove(actor, id(req)); }, 204, true),
    createVersion: wrap(async (req, actor) => { await noBody(req); return deps.service.createVersion(actor, id(req)); }, 201),
    getVersion: wrap(async (req, actor) => { const p = version(req); return deps.service.getVersion(actor, p.id, p.number); }),
    saveVersion: wrap(async (req, actor) => { const p = version(req); return deps.service.saveVersion(actor, p.id, p.number, SaveTemplateVersionSchema.parse(await json(req))); }),
    publishVersion: wrap(async (req, actor) => { const p = version(req); await noBody(req); return deps.service.publishVersion(actor, p.id, p.number); }),
    removeVersion: wrap(async (req, actor) => { const p = version(req); await noBody(req); await deps.service.removeVersion(actor, p.id, p.number); }, 204),
  };
}
