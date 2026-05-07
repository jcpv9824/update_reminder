import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { canManageUsers } from "../lib/permissions";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { badRequest, created, forbidden, notFound, ok, serverError } from "../lib/http";
import type { UserRecord } from "../types/models";

async function getUserOrFail(req: HttpRequest) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  return profile;
}

const VALID_ROLES = ["admin", "client_manager", "database_updater", "domain_updater", "viewer"] as const;

const UserCreateSchema = z.object({
  id: z.string().min(1, "El identificador es obligatorio."),
  displayName: z.string().min(1, "El nombre es obligatorio."),
  email: z.string().email("Correo electrónico no válido."),
  roles: z.array(z.enum(VALID_ROLES)).default([]),
  active: z.boolean().default(true),
});

app.http("usersList", {
  route: "users",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const u = await getUserOrFail(req);
      if (!canManageUsers(u)) return forbidden();
      const { resources } = await getContainer("users").items.readAll<UserRecord>().fetchAll();
      return ok(resources);
    } catch (e) { return serverError(e); }
  },
});

app.http("usersCreate", {
  route: "users",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const u = await getUserOrFail(req);
      if (!canManageUsers(u)) return forbidden();
      const body = await req.json();
      const parsed = UserCreateSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const now = new Date().toISOString();
      const record: UserRecord = {
        ...parsed.data,
        createdAt: now,
        createdBy: u.id,
        updatedAt: now,
        updatedBy: u.id,
        lastLoginAt: null,
      };
      await getContainer("users").items.create(record);
      await writeAuditLog({ entityType: "user", entityId: record.id, action: "user_created", performedBy: u.id, performedByEmail: u.email, after: record });
      return created(record);
    } catch (e) { return serverError(e); }
  },
});

app.http("usersUpdate", {
  route: "users/{id}",
  methods: ["PUT"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const u = await getUserOrFail(req);
      if (!canManageUsers(u)) return forbidden();
      const id = req.params.id;
      const container = getContainer("users");
      const { resource } = await container.item(id, id).read<UserRecord>();
      if (!resource) return notFound("Usuario no encontrado.");
      const body = await req.json() as any;
      const before = { ...resource };
      const rolesChanged = Array.isArray(body.roles) && JSON.stringify(body.roles) !== JSON.stringify(resource.roles);
      const updated: UserRecord = {
        ...resource,
        ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
        ...(typeof body.email === "string" ? { email: body.email } : {}),
        ...(Array.isArray(body.roles) ? { roles: body.roles } : {}),
        ...(typeof body.active === "boolean" ? { active: body.active } : {}),
        updatedAt: new Date().toISOString(),
        updatedBy: u.id,
      };
      await container.item(id, id).replace(updated);
      await writeAuditLog({ entityType: "user", entityId: id, action: rolesChanged ? "roles_updated" : "user_updated", performedBy: u.id, performedByEmail: u.email, before, after: updated });
      return ok(updated);
    } catch (e) { return serverError(e); }
  },
});

async function setUserActive(req: HttpRequest, active: boolean, action: string): Promise<HttpResponseInit> {
  const u = await getUserOrFail(req);
  if (!canManageUsers(u)) return forbidden();
  const id = req.params.id;
  const container = getContainer("users");
  const { resource } = await container.item(id, id).read<UserRecord>();
  if (!resource) return notFound("Usuario no encontrado.");
  resource.active = active;
  resource.updatedAt = new Date().toISOString();
  resource.updatedBy = u.id;
  await container.item(id, id).replace(resource);
  await writeAuditLog({ entityType: "user", entityId: id, action, performedBy: u.id, performedByEmail: u.email, after: { active } });
  return ok(resource);
}

app.http("usersDeactivate", { route: "users/{id}/deactivate", methods: ["POST"], authLevel: "anonymous", handler: (req) => setUserActive(req, false, "user_deactivated").catch(serverError) });
app.http("usersReactivate", { route: "users/{id}/reactivate", methods: ["POST"], authLevel: "anonymous", handler: (req) => setUserActive(req, true, "user_updated").catch(serverError) });
