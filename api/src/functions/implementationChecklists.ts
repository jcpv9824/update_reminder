import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { hasPermissionWithRoleDefinitions, resolveRoleDefinitionsForUser } from "../lib/taskAccess";
import { ChecklistError } from "../lib/checklistDomain";
import { CreateChecklistSchema, SaveChecklistSchema } from "../lib/checklistRequestSchemas";
import { TemplateEntityIdSchema } from "../lib/checklistTemplateSchemas";
import { listChecklists, readChecklist, type ChecklistActor } from "../lib/checklistSqlRepository";
import { changeChecklistStatus, createChecklist, saveChecklist } from "../lib/checklistSqlWriteRepository";
import { findChecklistErpClients } from "../lib/checklistErpClients";

type Handler = (req: HttpRequest, actor: ChecklistActor) => Promise<unknown>;
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const filters = z.object({
  status: z.enum(["in_progress", "completed"]).optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
}).strict();

export async function authenticateChecklistRequest(req: HttpRequest): Promise<ChecklistActor | null> {
  const profile = await loadUserProfile(await requireUser(req));
  if (!profile) return null;
  const definitions = await loadRoleDefinitions();
  return {
    id: profile.id, email: profile.email,
    isSuperAdmin: resolveRoleDefinitionsForUser(profile, definitions).some(({ id }) => id === "super_admin"),
    canView: hasPermissionWithRoleDefinitions(profile, "implementation.checklists.view", definitions),
    canCreate: hasPermissionWithRoleDefinitions(profile, "implementation.checklists.create", definitions),
  };
}

async function json(req: HttpRequest): Promise<unknown> {
  const limit = 2_100_000;
  if (Number(req.headers.get("content-length") ?? 0) > limit) throw new ChecklistError(413, "too_large", "El cuerpo supera el tamaño permitido.");
  const text = await req.text();
  if (Buffer.byteLength(text) > limit) throw new ChecklistError(413, "too_large", "El cuerpo supera el tamaño permitido.");
  try { return JSON.parse(text); } catch { throw new ChecklistError(400, "invalid_request", "El cuerpo JSON no es válido."); }
}

const deps = {
  authenticate: authenticateChecklistRequest, list: listChecklists, read: readChecklist,
  create: createChecklist, save: saveChecklist, status: changeChecklistStatus, search: findChecklistErpClients,
};
export function createChecklistHandlers(io = deps) {
  const wrap = (permission: "view" | "create", work: Handler, status = 200) =>
    async (req: HttpRequest): Promise<HttpResponseInit> => {
      try {
        const actor = await io.authenticate(req);
        if (!actor) throw new ChecklistError(401, "unauthenticated", "No autenticado.");
        if (!actor.isSuperAdmin && !(permission === "create" ? actor.canCreate : actor.canView)) {
          throw new ChecklistError(403, "forbidden", "No tiene permiso para esta acción.");
        }
        const data = await work(req, actor);
        return { status, headers, ...(status === 204 ? {} : { jsonBody: data }) };
      } catch (error) {
        if (error instanceof ChecklistError) return { status: error.status, headers, jsonBody: { error: error.error, message: error.message, details: error.details } };
        if (error instanceof z.ZodError) return { status: 400, headers, jsonBody: { error: "invalid_request", message: "Los datos no son válidos." } };
        if (typeof error === "object" && error && "status" in error && error.status === 401) {
          return { status: 401, headers, jsonBody: { error: "unauthenticated", message: "No autenticado." } };
        }
        return { status: 500, headers, jsonBody: { error: "internal_error", message: "No se pudo completar la operación." } };
      }
    };
  const id = (req: HttpRequest) => TemplateEntityIdSchema.parse(req.params.id);
  return {
    list: wrap("view", (req, actor) => io.list(actor, filters.parse(Object.fromEntries(req.query)))),
    search: wrap("create", async (req, actor) => ({ items: await io.search(actor, Object.fromEntries(req.query)) })),
    create: wrap("create", async (req, actor) => io.create(actor, CreateChecklistSchema.parse(await json(req))), 201),
    read: wrap("view", (req, actor) => io.read(actor, id(req))),
    save: wrap("view", async (req, actor) => io.save(actor, id(req), SaveChecklistSchema.parse(await json(req)), false)),
    complete: wrap("view", async (req, actor) => io.save(actor, id(req), SaveChecklistSchema.parse(await json(req)), true)),
    reopen: wrap("view", (req, actor) => io.status(actor, id(req), "reopen")),
    remove: wrap("view", (req, actor) => io.status(actor, id(req), "delete"), 204),
  };
}

export function registerImplementationChecklistRoutes() {
  const h = createChecklistHandlers();
  const root = "implementation/checklists";
  app.http("implementationChecklists", { route: root, authLevel: "anonymous", methods: ["GET","POST"],
    handler: (req) => req.method === "GET" ? h.list(req) : h.create(req) });
  app.http("implementationChecklistClientSearch", { route: `${root}/client-search`, authLevel: "anonymous", methods: ["GET"], handler: h.search });
  app.http("implementationChecklistResource", { route: `${root}/{id}`, authLevel: "anonymous", methods: ["GET","PUT","DELETE"],
    handler: (req) => req.method === "GET" ? h.read(req) : req.method === "PUT" ? h.save(req) : h.remove(req) });
  app.http("implementationChecklistComplete", { route: `${root}/{id}/complete`, authLevel: "anonymous", methods: ["POST"], handler: h.complete });
  app.http("implementationChecklistReopen", { route: `${root}/{id}/reopen`, authLevel: "anonymous", methods: ["POST"], handler: h.reopen });
}
