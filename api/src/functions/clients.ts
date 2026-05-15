import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { canManageClients } from "../lib/permissions";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { badRequest, conflict, created, forbidden, notFound, ok, serverError } from "../lib/http";
import type { ClientRecord, DatabaseRecord, DomainRecord, UpdateSchedule, UpdateTask } from "../types/models";

const ClientSchema = z.object({
  name: z.string().min(1, "El nombre del cliente es obligatorio.").max(200),
  notes: z.string().max(2000).optional(),
  status: z.enum(["active", "inactive", "deleted"]).optional(),
});

async function getUserOrFail(req: HttpRequest) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  return profile;
}

app.http("clientsList", {
  route: "clients",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      await getUserOrFail(req);
      const container = getContainer("clients");
      const { resources } = await container.items.readAll<ClientRecord>().fetchAll();
      const search = req.query.get("search")?.toLowerCase();
      const status = req.query.get("status");
      const includeDeleted = req.query.get("includeDeleted") === "true";
      let items = resources;
      if (!includeDeleted && !status) items = items.filter((c) => c.status !== "deleted");
      if (search) items = items.filter((c) => c.name.toLowerCase().includes(search));
      if (status) items = items.filter((c) => c.status === status);
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
      if (!canManageClients(user)) return forbidden();
      const body = await req.json();
      const parsed = ClientSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const now = new Date().toISOString();
      const record: ClientRecord = {
        id: `client_${uuid()}`,
        name: parsed.data.name.trim(),
        status: "active",
        notes: parsed.data.notes,
        createdAt: now,
        createdBy: user.id,
        updatedAt: now,
        updatedBy: user.id,
      };
      const container = getContainer("clients");
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
      await getUserOrFail(req);
      const id = req.params.id;
      const { resource } = await getContainer("clients").item(id, id).read<ClientRecord>();
      if (!resource) return notFound("Cliente no encontrado.");
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
      await getUserOrFail(req);
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
          databases: databases.filter((db) => db.domainId === domain.id),
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
      if (!canManageClients(user)) return forbidden();
      const id = req.params.id;
      const body = await req.json();
      const parsed = ClientSchema.partial().safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const container = getContainer("clients");
      const { resource } = await container.item(id, id).read<ClientRecord>();
      if (!resource) return notFound("Cliente no encontrado.");
      const before = { ...resource };
      const updated: ClientRecord = {
        ...resource,
        ...(parsed.data.name !== undefined ? { name: parsed.data.name.trim() } : {}),
        ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
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
      if (!canManageClients(user)) return forbidden();
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
      if (!canManageClients(user)) return forbidden();
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
      if (!canManageClients(user)) return forbidden();
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
