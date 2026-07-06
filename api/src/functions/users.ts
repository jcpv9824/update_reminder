import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { canManageUsers } from "../lib/permissions";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { generateTemporaryPassword, hashPassword, normalizeEmail, passwordExpirationIso, validatePasswordPolicy } from "../lib/password";
import { badRequest, created, forbidden, notFound, ok, serverError } from "../lib/http";
import { getPagination, paginateArray } from "../lib/pagination";
import { loadEmailAlertsSettings } from "../lib/settingsService";
import { sendEmail } from "../lib/emailService";
import { buildWelcomeUserEmail, buildResendCredentialsEmail } from "../lib/emailTemplates";
import { enforceRequestRateLimit, RATE_LIMIT_POLICIES } from "../lib/rateLimit";
import { revokeAllUserSessions } from "../lib/authSessions";
import type { UserRecord } from "../types/models";

// Envía el correo de credenciales (bienvenida, restablecimiento o reenvío).
// `kind` decide la plantilla responsiva. Estos correos incluyen la contraseña
// temporal porque se generan como credenciales de acceso; el maestro
// `passwordNotificationEnabled` desactiva todo el envío si el negocio lo pide.
async function notificarContrasena(args: {
  email: string;
  displayName: string;
  password: string;
  roles: string[];
  kind: "welcome" | "reset" | "resend";
  performedBy: string;
  performedByEmail: string;
}): Promise<void> {
  const settings = await loadEmailAlertsSettings();
  if (!settings.passwordNotificationEnabled) return;
  const tpl = args.kind === "welcome"
    ? buildWelcomeUserEmail({
        displayName: args.displayName,
        email: args.email,
        temporaryPassword: args.password,
        roles: args.roles,
        frontendBaseUrl: settings.frontendBaseUrl,
      })
    : buildResendCredentialsEmail({
        displayName: args.displayName,
        email: args.email,
        temporaryPassword: args.password,
        roles: args.roles,
        frontendBaseUrl: settings.frontendBaseUrl,
      });
  const r = await sendEmail({ to: args.email, subject: tpl.subject, html: tpl.html, text: tpl.text }, settings);
  await writeAuditLog({
    entityType: "user",
    entityId: args.email,
    action: r.ok ? "password_notification_sent" : "password_notification_failed",
    performedBy: args.performedBy,
    performedByEmail: args.performedByEmail,
    metadata: { kind: args.kind, includedPassword: true, error: r.ok ? undefined : r.error },
  });
}

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
  password: z.string().min(14, "La contraseña debe tener al menos 14 caracteres."),
});

const UserUpdateSchema = z.object({
  displayName: z.string().min(1).optional(),
  roles: z.array(z.enum(VALID_ROLES)).optional(),
  active: z.boolean().optional(),
});

const ResetPasswordSchema = z.object({
  password: z.string().min(14, "La contraseña debe tener al menos 14 caracteres."),
});

function sanitize(u: UserRecord) {
  const { passwordHash, passwordResetTokenHash, passwordResetExpiresAt, passwordResetUsedAt, tokenVersion,
    mfaEnabled, mfaSecretName, mfaEnrolledAt, mfaLastTimeStep, mfaRecoveryCodeHashes, ...rest } = u;
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
      const items = resources.map(sanitize);
      const pagination = getPagination(req);
      if (pagination.enabled) return ok(paginateArray(items, pagination.page, pagination.pageSize));
      return ok(items);
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
      const limited = await enforceRequestRateLimit(
        req,
        "email_user_welcome",
        `${u.id}:${email}`,
        RATE_LIMIT_POLICIES.userEmail
      );
      if (limited) return limited;
      const id = parsed.data.id?.trim() || email;
      const now = new Date().toISOString();
      try {
        await validatePasswordPolicy(parsed.data.password, { email, displayName: parsed.data.displayName });
      } catch (error: any) {
        return error?.status === 503 ? { status: 503, jsonBody: { error: error.message } } : badRequest(error.message);
      }
      const passwordHash = await hashPassword(parsed.data.password);
      const record: UserRecord = {
        id,
        displayName: parsed.data.displayName.trim(),
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
        passwordExpiresAt: null,
        mustChangePassword: true,
        tokenVersion: 0,
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
      // Correo de bienvenida (responsivo) con credenciales y rol.
      try { await notificarContrasena({ email: record.email, displayName: record.displayName, password: parsed.data.password, roles: record.roles, kind: "welcome", performedBy: u.id, performedByEmail: u.email }); } catch {/* no bloquear creación */}
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
      const deactivated = resource.active !== false && parsed.data.active === false;
      const updated: UserRecord = {
        ...resource,
        ...(parsed.data.displayName !== undefined ? { displayName: parsed.data.displayName.trim() } : {}),
        ...(parsed.data.roles !== undefined ? { roles: parsed.data.roles } : {}),
        ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
        ...(deactivated ? { tokenVersion: (resource.tokenVersion ?? 0) + 1 } : {}),
        updatedAt: new Date().toISOString(),
        updatedBy: u.id,
      };
      await container.item(id, id).replace(updated);
      if (deactivated) await revokeAllUserSessions(id, "user_deactivated");
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
      const limited = await enforceRequestRateLimit(
        req,
        "email_user_password_reset",
        `${u.id}:${id}`,
        RATE_LIMIT_POLICIES.userEmail
      );
      if (limited) return limited;
      const container = getContainer("users");
      const { resource } = await container.item(id, id).read<UserRecord>();
      if (!resource) return notFound("Usuario no encontrado.");
      const now = new Date().toISOString();
      try {
        await validatePasswordPolicy(parsed.data.password, { email: resource.email, displayName: resource.displayName });
      } catch (error: any) {
        return error?.status === 503 ? { status: 503, jsonBody: { error: error.message } } : badRequest(error.message);
      }
      resource.passwordHash = await hashPassword(parsed.data.password);
      resource.passwordUpdatedAt = now;
      resource.passwordExpiresAt = null;
      resource.mustChangePassword = true;
      resource.tokenVersion = (resource.tokenVersion ?? 0) + 1;
      resource.updatedAt = now;
      resource.updatedBy = u.id;
      await container.item(id, id).replace(resource);
      await revokeAllUserSessions(id, "admin_password_reset");
      await writeAuditLog({
        entityType: "user",
        entityId: id,
        action: "user_password_reset",
        performedBy: u.id,
        performedByEmail: u.email,
      });
      try { await notificarContrasena({ email: resource.email, displayName: resource.displayName, password: parsed.data.password, roles: resource.roles, kind: "reset", performedBy: u.id, performedByEmail: u.email }); } catch {/* no bloquear reset */}
      return ok(sanitize(resource));
    } catch (e) { return serverError(e); }
  },
});

// Reenviar contraseña: como las contraseñas se guardan cifradas y no se pueden
// recuperar, se genera una NUEVA contraseña temporal, se guarda su hash y se
// envía por correo (plantilla responsiva). Solo administradores.
app.http("usersResendCredentials", {
  route: "users/{id}/resend-credentials",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const u = await getUserOrFail(req);
      if (!canManageUsers(u)) return forbidden();
      const id = req.params.id;
      const limited = await enforceRequestRateLimit(
        req,
        "email_user_credentials_resend",
        `${u.id}:${id}`,
        RATE_LIMIT_POLICIES.userEmail
      );
      if (limited) return limited;
      const container = getContainer("users");
      const { resource } = await container.item(id, id).read<UserRecord>();
      if (!resource) return notFound("Usuario no encontrado.");
      const settings = await loadEmailAlertsSettings();
      if (!settings.passwordNotificationEnabled) {
        return badRequest("El envío de credenciales por correo está deshabilitado en Alertas y correos.");
      }
      const temporal = generateTemporaryPassword();
      const now = new Date().toISOString();
      resource.passwordHash = await hashPassword(temporal);
      resource.passwordUpdatedAt = now;
      resource.passwordExpiresAt = null;
      resource.mustChangePassword = true;
      resource.tokenVersion = (resource.tokenVersion ?? 0) + 1;
      resource.updatedAt = now;
      resource.updatedBy = u.id;
      await container.item(id, id).replace(resource);
      await revokeAllUserSessions(id, "credentials_resent");
      await writeAuditLog({
        entityType: "user",
        entityId: id,
        action: "user_credentials_resent",
        performedBy: u.id,
        performedByEmail: u.email,
      });
      await notificarContrasena({ email: resource.email, displayName: resource.displayName, password: temporal, roles: resource.roles, kind: "resend", performedBy: u.id, performedByEmail: u.email });
      return ok({ ...sanitize(resource), emailSent: true });
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
  if (!active) resource.tokenVersion = (resource.tokenVersion ?? 0) + 1;
  resource.updatedAt = new Date().toISOString();
  resource.updatedBy = u.id;
  await container.item(id, id).replace(resource);
  if (!active) await revokeAllUserSessions(id, "user_deactivated");
  await writeAuditLog({ entityType: "user", entityId: id, action, performedBy: u.id, performedByEmail: u.email, after: { active } });
  return ok(sanitize(resource));
}

app.http("usersDeactivate", { route: "users/{id}/deactivate", methods: ["POST"], authLevel: "anonymous", handler: (req) => setUserActive(req, false, "user_deactivated").catch(serverError) });
app.http("usersReactivate", { route: "users/{id}/reactivate", methods: ["POST"], authLevel: "anonymous", handler: (req) => setUserActive(req, true, "user_updated").catch(serverError) });
