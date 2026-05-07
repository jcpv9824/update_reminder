import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { canManageUsers } from "../lib/permissions";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { hashPassword, normalizeEmail } from "../lib/password";
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
  id: z.string().optional(),
  displayName: z.string().min(1, "El nombre es obligatorio."),
  email: z.string().email("Correo electrónico no válido."),
  roles: z.array(z.enum(VALID_ROLES)).default([]),
  active: z.boolean().default(true),
  password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres."),
});

const UserUpdateSchema = z.object({
  displayName: z.string().min(1).optional(),
  roles: z.array(z.enum(VALID_ROLES)).optional(),
  active: z.boolean().optional(),
});

const ResetPasswordSchema = z.object({
  password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres."),
});

function sanitize(u: UserRecord) {
  const { passwordHash, ...rest } = u;
  return rest;
}

app.http("usersList", {
  route: "users",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const u = await getUserOrFail(req);
      if (!canManageUsers(u)) return forbidden();
      const { resources } = await getContainer("users").items.readAll<UserRecord>().fetchAll();
      return ok(resources.map(sanitize));
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
      const email = normalizeEmail(parsed.data.email);
      const id = parsed.data.id?.trim() || email;
      const now = new Date().toISOString();
      const passwordHash = await hashPassword(parsed.data.password);
      const record: UserRecord = {
        id,
        displayName: parsed.data.displayName,
        email,
        roles: parsed.data.roles,
        active: parsed.data.active,
        createdAt: now,
        createdBy: u.id,
        updatedAt: now,
        updatedBy: u.id,
        lastLoginAt: null,
        passwordHash,
        passwordUpdatedAt: now,
      };
      await getContainer("users").items.create(record);
      await writeAuditLog({
        entityType: "user",
        entityId: record.id,
        action: "user_created",
        performedBy: u.id,
        performedByEmail: u.email,
        after: sanitize(record),
      });
      return created(sanitize(record));
    } catch (e: any) {
      if (e?.code === 409) return badRequest("Ya existe un usuario con ese identificador.");
      return serverError(e);
    }
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
      const body = await req.json();
      const parsed = UserUpdateSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const before = { ...resource };
      const rolesChanged = parsed.data.roles && JSON.stringify(parsed.data.roles) !== JSON.stringify(resource.roles);
      const updated: UserRecord = {
        ...resource,
        ...(parsed.data.displayName !== undefined ? { displayName: parsed.data.displayName } : {}),
        ...(parsed.data.roles !== undefined ? { roles: parsed.data.roles } : {}),
        ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
        updatedAt: new Date().toISOString(),
        updatedBy: u.id,
      };
      await container.item(id, id).replace(updated);
      await writeAuditLog({
        entityType: "user",
        entityId: id,
        action: rolesChanged ? "roles_updated" : "user_updated",
        performedBy: u.id,
        performedByEmail: u.email,
        before: sanitize(before),
        after: sanitize(updated),
      });
      return ok(sanitize(updated));
    } catch (e) { return serverError(e); }
  },
});

app.http("usersResetPassword", {
  route: "users/{id}/reset-password",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const u = await getUserOrFail(req);
      if (!canManageUsers(u)) return forbidden();
      const id = req.params.id;
      const body = await req.json();
      const parsed = ResetPasswordSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const container = getContainer("users");
      const { resource } = await container.item(id, id).read<UserRecord>();
      if (!resource) return notFound("Usuario no encontrado.");
      const now = new Date().toISOString();
      resource.passwordHash = await hashPassword(parsed.data.password);
      resource.passwordUpdatedAt = now;
      resource.updatedAt = now;
      resource.updatedBy = u.id;
      await container.item(id, id).replace(resource);
      await writeAuditLog({
        entityType: "user",
        entityId: id,
        action: "user_password_reset",
        performedBy: u.id,
        performedByEmail: u.email,
      });
      return ok(sanitize(resource));
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
  return ok(sanitize(resource));
}

app.http("usersDeactivate", { route: "users/{id}/deactivate", methods: ["POST"], authLevel: "anonymous", handler: (req) => setUserActive(req, false, "user_deactivated").catch(serverError) });
app.http("usersReactivate", { route: "users/{id}/reactivate", methods: ["POST"], authLevel: "anonymous", handler: (req) => setUserActive(req, true, "user_updated").catch(serverError) });
