import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { canManageClients } from "../lib/permissions";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { badRequest, created, forbidden, noContent, notFound, ok, serverError } from "../lib/http";
import type { ClientRecord } from "../types/models";

const ClientSchema = z.object({
  name: z.string().min(1, "El nombre del cliente es obligatorio."),
  notes: z.string().optional(),
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
      const container = getContainer("clients");
      const { resource } = await container.item(id, id).read<ClientRecord>();
      if (!resource) return notFound("Cliente no encontrado.");

      // Verificación de integridad: no permitir eliminar si tiene dominios o BDs vivas.
      const domsQ = await getContainer("domains")
        .items.query({ query: "SELECT VALUE COUNT(1) FROM c WHERE c.clientId = @c AND c.status != 'deleted'", parameters: [{ name: "@c", value: id }] })
        .fetchAll();
      const dbsQ = await getContainer("databases")
        .items.query({ query: "SELECT VALUE COUNT(1) FROM c WHERE c.clientId = @c AND c.status != 'deleted'", parameters: [{ name: "@c", value: id }] })
        .fetchAll();
      const dominios = (domsQ.resources[0] as any) ?? 0;
      const bds = (dbsQ.resources[0] as any) ?? 0;
      if (dominios > 0 || bds > 0) {
        return badRequest(`No se puede eliminar el cliente porque tiene ${dominios} dominio(s) y ${bds} base(s) de datos asociadas. Elimine o desactive esos registros primero.`);
      }

      // Eliminación física.
      await container.item(id, id).delete();
      await writeAuditLog({
        entityType: "client",
        entityId: id,
        clientId: id,
        clientName: resource.name,
        action: "client_deleted",
        performedBy: user.id,
        performedByEmail: user.email,
        before: resource,
      });
      return noContent();
    } catch (e) {
      return serverError(e);
    }
  },
});
