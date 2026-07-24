import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { badRequest, conflict, created, forbidden, notFound, ok, serverError } from "../lib/http";
import {
  canAssignClientLicenses,
  canCreateClient,
  canDeactivateClient,
  canDeleteClient,
  canEditClient,
  canReactivateClient,
  canViewClientRelated,
  canViewClients,
} from "../lib/managementAccess";
import { getPagination, paginateArray } from "../lib/pagination";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { readSqlClients, readSqlClientTree } from "../lib/clientsSqlRepository";
import { createSqlClient, updateSqlClient } from "../lib/clientsSqlWriteRepository";
import { deleteSqlCoreCascade } from "../lib/coreCascadeSqlRepository";
import type { ClientRecord } from "../types/models";

const ClientSchema = z.object({
  externalId: z.string().max(100).optional(),
  name: z.string().min(1, "El nombre del cliente es obligatorio.").max(200),
  notes: z.string().max(2000).optional(),
  status: z.enum(["active", "inactive", "deleted"]).optional(),
  licenseModuleIds: z.array(z.string()).optional(),
});

async function getUserOrFail(req: HttpRequest) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  return profile;
}

async function readClients(): Promise<ClientRecord[]> {
  return readSqlClients();
}

async function readClient(id: string): Promise<ClientRecord | null> {
  return (await readSqlClients(id))[0] ?? null;
}

app.http("clientsList", {
  route: "clients",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canViewClients(user, roleDefinitions)) return forbidden();
      const resources = await readClients();
      const search = req.query.get("search")?.trim().toLowerCase();
      const status = req.query.get("status");
      const includeDeleted = req.query.get("includeDeleted") === "true";
      let items = resources;
      if (!canDeleteClient(user, roleDefinitions) && !canReactivateClient(user, roleDefinitions)) items = items.filter((client) => client.status !== "deleted");
      if (!includeDeleted && !status) items = items.filter((c) => c.status !== "deleted");
      if (search) items = items.filter((c) => `${c.externalId ?? ""} ${c.name} ${c.status} ${c.notes ?? ""}`.toLowerCase().includes(search));
      if (status) items = items.filter((c) => c.status === status);
      const pagination = getPagination(req);
      if (pagination.enabled) return ok(paginateArray(items, pagination.page, pagination.pageSize));
      return ok(items);
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("clientsCreate", {
  route: "clients",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canCreateClient(user, roleDefinitions)) return forbidden();
      const body = await req.json();
      const parsed = ClientSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      if ((parsed.data.licenseModuleIds ?? []).length > 0 && !canAssignClientLicenses(user, roleDefinitions)) return forbidden();
      const record = await createSqlClient(`client_${randomUUID()}`, {
        externalId: parsed.data.externalId?.trim() || undefined,
        name: parsed.data.name,
        notes: parsed.data.notes,
        licenseModuleIds: parsed.data.licenseModuleIds,
      }, { id: user.id, email: user.email });
      return created(record);
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("clientsGet", {
  route: "clients/{id}",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canViewClients(user, roleDefinitions)) return forbidden();
      const id = req.params.id;
      const resource = await readClient(id);
      if (!resource) return notFound("Cliente no encontrado.");
      if (resource.status === "deleted" && !canDeleteClient(user, roleDefinitions) && !canReactivateClient(user, roleDefinitions)) return forbidden("No tiene permisos para consultar este cliente.");
      return ok(resource);
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("clientsTree", {
  route: "clients/{id}/tree",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canViewClientRelated(user, roleDefinitions)) return forbidden();
      const id = req.params.id;
      const tree = await readSqlClientTree(id);
      return tree ? ok(tree) : notFound("Cliente no encontrado.");
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("clientsUpdate", {
  route: "clients/{id}",
  methods: ["PUT"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canEditClient(user, roleDefinitions)) return forbidden();
      const id = req.params.id;
      const body = await req.json();
      const parsed = ClientSchema.partial().safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      if (parsed.data.licenseModuleIds !== undefined && !canAssignClientLicenses(user, roleDefinitions)) return forbidden();
      const resource = await readClient(id);
      if (!resource) return notFound("Cliente no encontrado.");
      if (parsed.data.status === "inactive" && resource.status !== "inactive" && !canDeactivateClient(user, roleDefinitions)) return forbidden();
      if (parsed.data.status === "active" && resource.status !== "active" && !canReactivateClient(user, roleDefinitions)) return forbidden();
      if (parsed.data.status === "deleted" && resource.status !== "deleted" && !canDeleteClient(user, roleDefinitions)) return forbidden();
      const updated = await updateSqlClient(id, parsed.data, { id: user.id, email: user.email });
      return updated ? ok(updated) : notFound("Cliente no encontrado.");
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("clientsDeactivate", {
  route: "clients/{id}/deactivate",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canDeactivateClient(user, roleDefinitions)) return forbidden();
      const id = req.params.id;
      const resource = await updateSqlClient(id, { status: "inactive" }, { id: user.id, email: user.email }, "client_deactivated");
      return resource ? ok(resource) : notFound("Cliente no encontrado.");
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("clientsReactivate", {
  route: "clients/{id}/reactivate",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canReactivateClient(user, roleDefinitions)) return forbidden();
      const id = req.params.id;
      const resource = await updateSqlClient(id, { status: "active" }, { id: user.id, email: user.email }, "client_reactivated");
      return resource ? ok(resource) : notFound("Cliente no encontrado.");
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("clientsDelete", {
  route: "clients/{id}",
  methods: ["DELETE"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canDeleteClient(user, roleDefinitions)) return forbidden();
      const id = req.params.id;
      const cascade = req.query.get("cascade") === "true";
      const result = await deleteSqlCoreCascade("client", id, cascade, { id: user.id, email: user.email });
      if (!result.found) return notFound("Cliente no encontrado.");
      if (result.requiresCascade) return conflict("El cliente tiene dependencias. Confirme eliminación en cascada.", { dependencies: result.dependencies });
      return ok({ ok: true, deleted: { ...result.dependencies, obsoletedTasks: result.obsoletedTasks, cascadeSchedules: result.cascadeSchedules } });
    } catch (e) {
      return serverError(e);
    }
  },
});
