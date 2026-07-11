import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
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
import { hasDuplicateClientExternalId, hasDuplicateClientName } from "../lib/duplicateValidation";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { toPublicDatabase } from "../lib/publicDtos";
import type { ClientRecord, DatabaseRecord, DomainRecord, LicenseModuleRecord, UpdateSchedule, UpdateTask } from "../types/models";

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

function uniqueIds(ids?: string[]): string[] {
  return Array.from(new Set((ids ?? []).map((id) => id.trim()).filter(Boolean)));
}

async function resolveClientLicenses(ids?: string[], existingIds: string[] = []): Promise<{ ids: string[]; names: string[] } | HttpResponseInit> {
  const unique = uniqueIds(ids);
  if (unique.length === 0) return { ids: [], names: [] };
  const { resources } = await getContainer("licenseModules").items.readAll<LicenseModuleRecord>().fetchAll();
  const modulesById = new Map(resources.map((module) => [module.id, module]));
  const previous = new Set(existingIds);
  const names: string[] = [];
  for (const id of unique) {
    const module = modulesById.get(id);
    if (!module || module.status === "deleted" || module.deletedAt) return badRequest("Una de las licencias seleccionadas no existe.");
    if ((module.status !== "active" || module.active === false) && !previous.has(id)) {
      return badRequest("Solo puede asignar licencias activas al cliente.");
    }
    names.push(module.name);
  }
  return { ids: unique, names };
}

function isHttpResponse(value: { ids: string[]; names: string[] } | HttpResponseInit): value is HttpResponseInit {
  return typeof (value as HttpResponseInit).status === "number";
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
      const container = getContainer("clients");
      const { resources } = await container.items.readAll<ClientRecord>().fetchAll();
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
      const container = getContainer("clients");
      const { resources: existingClients } = await container.items.readAll<ClientRecord>().fetchAll();
      if (hasDuplicateClientName(existingClients, parsed.data.name)) return conflict("Ya existe un cliente con este nombre.");
      if (hasDuplicateClientExternalId(existingClients, parsed.data.externalId)) return conflict("Ya existe un cliente con este ID.");
      const licenses = await resolveClientLicenses(parsed.data.licenseModuleIds);
      if (isHttpResponse(licenses)) return licenses;
      const now = new Date().toISOString();
      const record: ClientRecord = {
        id: `client_${randomUUID()}`,
        externalId: parsed.data.externalId?.trim() || undefined,
        name: parsed.data.name.trim(),
        status: "active",
        notes: parsed.data.notes?.trim(),
        licenseModuleIds: licenses.ids,
        licenseModuleNames: licenses.names,
        createdAt: now,
        createdBy: user.id,
        updatedAt: now,
        updatedBy: user.id,
      };
      await container.items.create(record);
      await writeAuditLog({
        entityType: "client",
        entityId: record.id,
        clientId: record.id,
        clientName: record.name,
        action: "client_created",
        performedBy: user.id,
        performedByEmail: user.email,
        after: record,
      });
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
      const { resource } = await getContainer("clients").item(id, id).read<ClientRecord>();
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
      const { resource: client } = await getContainer("clients").item(id, id).read<ClientRecord>();
      if (!client || client.status === "deleted") return notFound("Cliente no encontrado.");
      const [{ resources: domains }, { resources: databases }] = await Promise.all([
        getContainer("domains").items.query<DomainRecord>({
          query: "SELECT * FROM c WHERE c.clientId = @c AND c.status != 'deleted'",
          parameters: [{ name: "@c", value: id }],
        }).fetchAll(),
        getContainer("databases").items.query<DatabaseRecord>({
          query: "SELECT * FROM c WHERE c.clientId = @c AND c.status != 'deleted'",
          parameters: [{ name: "@c", value: id }],
        }).fetchAll(),
      ]);
      return ok({
        client,
        domains: domains.map((domain) => ({
          domain,
          databases: databases.filter((db) => db.domainId === domain.id).map(toPublicDatabase),
        })),
      });
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
      const container = getContainer("clients");
      const { resource } = await container.item(id, id).read<ClientRecord>();
      if (!resource) return notFound("Cliente no encontrado.");
      if (parsed.data.status === "inactive" && resource.status !== "inactive" && !canDeactivateClient(user, roleDefinitions)) return forbidden();
      if (parsed.data.status === "active" && resource.status !== "active" && !canReactivateClient(user, roleDefinitions)) return forbidden();
      if (parsed.data.status === "deleted" && resource.status !== "deleted" && !canDeleteClient(user, roleDefinitions)) return forbidden();
      if (typeof parsed.data.name === "string") {
        const { resources: existingClients } = await container.items.readAll<ClientRecord>().fetchAll();
        if (hasDuplicateClientName(existingClients, parsed.data.name, id)) return conflict("Ya existe un cliente con este nombre.");
      }
      if (typeof parsed.data.externalId === "string") {
        const { resources: existingClients } = await container.items.readAll<ClientRecord>().fetchAll();
        if (hasDuplicateClientExternalId(existingClients, parsed.data.externalId, id)) return conflict("Ya existe un cliente con este ID.");
      }
      const before = { ...resource };
      const licenses = parsed.data.licenseModuleIds !== undefined
        ? await resolveClientLicenses(parsed.data.licenseModuleIds, resource.licenseModuleIds ?? [])
        : null;
      if (licenses && isHttpResponse(licenses)) return licenses;
      const updated: ClientRecord = {
        ...resource,
        ...(parsed.data.externalId !== undefined ? { externalId: parsed.data.externalId.trim() || undefined } : {}),
        ...(parsed.data.name !== undefined ? { name: parsed.data.name.trim() } : {}),
        ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes.trim() } : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        ...(licenses ? { licenseModuleIds: licenses.ids, licenseModuleNames: licenses.names } : {}),
        updatedAt: new Date().toISOString(),
        updatedBy: user.id,
      };
      await container.item(id, id).replace(updated);
      await writeAuditLog({
        entityType: "client",
        entityId: id,
        clientId: id,
        clientName: updated.name,
        action: "client_updated",
        performedBy: user.id,
        performedByEmail: user.email,
        before,
        after: updated,
      });
      return ok(updated);
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
      const container = getContainer("clients");
      const { resource } = await container.item(id, id).read<ClientRecord>();
      if (!resource) return notFound("Cliente no encontrado.");
      resource.status = "inactive";
      resource.updatedAt = new Date().toISOString();
      resource.updatedBy = user.id;
      await container.item(id, id).replace(resource);
      await writeAuditLog({
        entityType: "client",
        entityId: id,
        clientId: id,
        clientName: resource.name,
        action: "client_deactivated",
        performedBy: user.id,
        performedByEmail: user.email,
        after: resource,
      });
      return ok(resource);
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
      const container = getContainer("clients");
      const { resource } = await container.item(id, id).read<ClientRecord>();
      if (!resource) return notFound("Cliente no encontrado.");
      resource.status = "active";
      resource.updatedAt = new Date().toISOString();
      resource.updatedBy = user.id;
      await container.item(id, id).replace(resource);
      await writeAuditLog({
        entityType: "client",
        entityId: id,
        clientId: id,
        clientName: resource.name,
        action: "client_reactivated",
        performedBy: user.id,
        performedByEmail: user.email,
        after: resource,
      });
      return ok(resource);
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
      const container = getContainer("clients");
      const { resource } = await container.item(id, id).read<ClientRecord>();
      if (!resource) return notFound("Cliente no encontrado.");

      const [{ resources: domains }, { resources: databases }, { resources: schedules }, { resources: tasks }] = await Promise.all([
        getContainer("domains").items.query<DomainRecord>({ query: "SELECT * FROM c WHERE c.clientId = @c AND c.status != 'deleted'", parameters: [{ name: "@c", value: id }] }).fetchAll(),
        getContainer("databases").items.query<DatabaseRecord>({ query: "SELECT * FROM c WHERE c.clientId = @c AND c.status != 'deleted'", parameters: [{ name: "@c", value: id }] }).fetchAll(),
        getContainer("updateSchedules").items.query<UpdateSchedule>({ query: "SELECT * FROM c WHERE c.clientId = @c", parameters: [{ name: "@c", value: id }] }).fetchAll(),
        getContainer("updateTasks").items.query<UpdateTask>({ query: "SELECT * FROM c WHERE c.clientId = @c AND c.status NOT IN ('completed', 'cancelled')", parameters: [{ name: "@c", value: id }] }).fetchAll(),
      ]);
      const dependencies = { domains: domains.length, databases: databases.length, schedules: schedules.length, pendingTasks: tasks.length };
      if (!cascade && (dependencies.domains > 0 || dependencies.databases > 0 || dependencies.schedules > 0 || dependencies.pendingTasks > 0)) {
        return conflict("El cliente tiene dependencias. Confirme eliminación en cascada.", { dependencies });
      }

      const now = new Date().toISOString();
      for (const schedule of schedules) {
        await getContainer("updateSchedules").item(schedule.id, schedule.clientId).delete();
        await writeAuditLog({
          entityType: "schedule", entityId: schedule.id, clientId: id, clientName: resource.name,
          action: "schedule_deleted_cascade", performedBy: user.id, performedByEmail: user.email,
          metadata: { cascadeFromClient: id }, before: schedule,
        });
      }
      for (const task of tasks) {
        const before = { ...task };
        task.status = "cancelled";
        task.result = "obsolete";
        task.notes = task.notes ? `${task.notes}\nCancelada por eliminación en cascada del cliente.` : "Cancelada por eliminación en cascada del cliente.";
        task.updatedAt = now;
        task.updatedBy = user.id;
        await getContainer("updateTasks").item(task.id, task.taskBucket).replace(task);
        await writeAuditLog({
          entityType: "task", entityId: task.id, clientId: id, clientName: resource.name,
          action: "task_cancelled", performedBy: user.id, performedByEmail: user.email,
          metadata: { cascadeFromClient: id }, before, after: { status: task.status, result: task.result },
        });
      }
      for (const db of databases) {
        const before = { ...db };
        const deleted = { ...db, status: "deleted" as const, deletedAt: now, deletedBy: user.id, updatedAt: now, updatedBy: user.id };
        await getContainer("databases").item(db.id, db.clientId).replace(deleted);
        await writeAuditLog({
          entityType: "database", entityId: db.id, clientId: id, clientName: resource.name,
          domainId: db.domainId, domainName: db.domainName, companyName: db.companyName,
          action: "database_deleted_cascade", performedBy: user.id, performedByEmail: user.email,
          metadata: { cascadeFromClient: id }, before: { ...before, dbAccess: { ...before.dbAccess, passwordSecretName: undefined } },
          after: { status: "deleted" },
        });
      }
      for (const domain of domains) {
        const before = { ...domain };
        const deleted = { ...domain, status: "deleted" as const, deletedAt: now, deletedBy: user.id, updatedAt: now, updatedBy: user.id };
        await getContainer("domains").item(domain.id, domain.clientId).replace(deleted);
        await writeAuditLog({
          entityType: "domain", entityId: domain.id, clientId: id, clientName: resource.name,
          domainId: domain.id, domainName: domain.domainName,
          action: "domain_deleted_cascade", performedBy: user.id, performedByEmail: user.email,
          metadata: { cascadeFromClient: id }, before, after: { status: "deleted" },
        });
      }
      const beforeClient = { ...resource };
      const deletedClient = { ...resource, status: "deleted" as const, deletedAt: now, deletedBy: user.id, updatedAt: now, updatedBy: user.id };
      await container.item(id, id).replace(deletedClient);
      await writeAuditLog({
        entityType: "client",
        entityId: id,
        clientId: id,
        clientName: resource.name,
        action: "client_deleted_cascade",
        performedBy: user.id,
        performedByEmail: user.email,
        metadata: dependencies,
        before: beforeClient,
        after: { status: "deleted" },
      });
      return ok({ ok: true, deleted: dependencies });
    } catch (e) {
      return serverError(e);
    }
  },
});
