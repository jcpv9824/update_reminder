import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { generateTemporaryPassword, hashPassword, normalizeEmail, passwordExpirationIso, validatePasswordPolicy } from "../lib/password";
import { badRequest, created, forbidden, notFound, ok, serverError } from "../lib/http";
import { getPagination } from "../lib/pagination";
import { loadEmailAlertsSettings } from "../lib/settingsService";
import { enforceRequestRateLimit, RATE_LIMIT_POLICIES } from "../lib/rateLimit";
import { migrateLegacyRoleIds } from "../lib/permissionModel";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { validateAssignableRoleIds } from "../lib/roleDefinitions";
import {
  canCreateUser,
  canDeactivateUser,
  canListUsers,
  canReactivateUser,
  canResendUserCredentials,
  canResetUserPassword,
  canUpdateUser,
} from "../lib/managementAccess";
import type { UserRecord } from "../types/models";
import { readSqlPublicUsers } from "../lib/securityUsersSqlRepository";
import {
  createSqlUser,
  findSqlUserById,
  findSqlUserByEmail,
  requestSqlPasswordReset,
  setSqlUserPassword,
  updateSqlUser,
} from "../lib/securityManagementSqlWriteRepository";

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
  const user = await findSqlUserByEmail(args.email);
  if (user) {
    await requestSqlPasswordReset(user, { id: args.performedBy, email: args.performedByEmail });
  }
}

async function getUserOrFail(req: HttpRequest) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  return profile;
}

const RoleIdSchema = z.string()
  .trim()
  .min(1, "El rol no puede estar vacío.")
  .max(80, "El rol no puede superar 80 caracteres.")
  .regex(/^[a-z0-9_.-]+$/, "El rol solo puede contener minúsculas, números, guiones, puntos y guiones bajos.");

const RolesSchema = z.array(RoleIdSchema).transform((roles) => migrateLegacyRoleIds(roles));

const UserCreateSchema = z.object({
  id: z.string().optional(),
  displayName: z.string().min(1, "El nombre es obligatorio."),
  email: z.string().email("Correo electrónico no válido."),
  roles: RolesSchema.default([]),
  active: z.boolean().default(true),
  password: z.string().min(14, "La contraseña debe tener al menos 14 caracteres."),
});

const UserUpdateSchema = z.object({
  displayName: z.string().min(1).optional(),
  roles: RolesSchema.optional(),
  active: z.boolean().optional(),
});

const ResetPasswordSchema = z.object({
  password: z.string().min(14, "La contraseña debe tener al menos 14 caracteres."),
});

function sanitize(u: UserRecord) {
  const { passwordHash, passwordResetTokenHash, passwordResetExpiresAt, passwordResetUsedAt, tokenVersion,
    mfaEnabled, mfaSecretName, mfaEnrolledAt, mfaLastTimeStep, mfaRecoveryCodeHashes, ...rest } = u;
  return { ...rest, roles: migrateLegacyRoleIds(rest.roles ?? []) };
}

app.http("usersList", {
  route: "users",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const u = await getUserOrFail(req);
      if (!canListUsers(u, await loadRoleDefinitions())) return forbidden();
      const pagination = getPagination(req);
      return ok(await readSqlPublicUsers(pagination));
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
      const roleDefinitions = await loadRoleDefinitions();
      if (!canCreateUser(u, roleDefinitions)) return forbidden();
      const body = await req.json();
      const parsed = UserCreateSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const roleError = validateAssignableRoleIds(parsed.data.roles, roleDefinitions);
      if (roleError) return badRequest(roleError);
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
      const sqlRecord = await createSqlUser({
        id: record.id,
        displayName: record.displayName,
        email: record.email,
        roles: record.roles,
        active: record.active,
        passwordHash,
        mustChangePassword: true,
      }, { id: u.id, email: u.email });
      try { await notificarContrasena({ email: sqlRecord.email, displayName: sqlRecord.displayName, password: parsed.data.password, roles: sqlRecord.roles, kind: "welcome", performedBy: u.id, performedByEmail: u.email }); } catch {/* no bloquear creación */}
      return created(sanitize(sqlRecord));
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
      const id = req.params.id;
      const resource = await findSqlUserById(id);
      if (!resource) return notFound("Usuario no encontrado.");
      const body = await req.json();
      const parsed = UserUpdateSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const rolesChanged = parsed.data.roles && JSON.stringify(parsed.data.roles) !== JSON.stringify(resource.roles);
      const deactivated = resource.active !== false && parsed.data.active === false;
      const roleDefinitions = await loadRoleDefinitions();
      if (!canUpdateUser(u, { rolesChanged: !!rolesChanged, deactivating: deactivated }, roleDefinitions)) {
        return forbidden();
      }
      if (parsed.data.roles) {
        const roleError = validateAssignableRoleIds(parsed.data.roles, roleDefinitions);
        if (roleError) return badRequest(roleError);
      }
      const sqlUpdated = await updateSqlUser(id, parsed.data, { id: u.id, email: u.email });
      return sqlUpdated ? ok(sanitize(sqlUpdated)) : notFound("Usuario no encontrado.");
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
      if (!canResetUserPassword(u, await loadRoleDefinitions())) return forbidden();
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
      const resource = await findSqlUserById(id);
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
      const sqlUpdated = await setSqlUserPassword(id, resource.passwordHash, { id: u.id, email: u.email }, "user_password_reset", {
        mustChangePassword: true,
        expiresAt: null,
      });
      if (!sqlUpdated) return notFound("Usuario no encontrado.");
      try { await notificarContrasena({ email: sqlUpdated.email, displayName: sqlUpdated.displayName, password: parsed.data.password, roles: sqlUpdated.roles, kind: "reset", performedBy: u.id, performedByEmail: u.email }); } catch {/* no bloquear reset */}
      return ok(sanitize(sqlUpdated));
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
      if (!canResendUserCredentials(u, await loadRoleDefinitions())) return forbidden();
      const id = req.params.id;
      const limited = await enforceRequestRateLimit(
        req,
        "email_user_credentials_resend",
        `${u.id}:${id}`,
        RATE_LIMIT_POLICIES.userEmail
      );
      if (limited) return limited;
      const resource = await findSqlUserById(id);
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
      const sqlUpdated = await setSqlUserPassword(id, resource.passwordHash, { id: u.id, email: u.email }, "user_credentials_resent", {
        mustChangePassword: true,
        expiresAt: null,
      });
      if (!sqlUpdated) return notFound("Usuario no encontrado.");
      await notificarContrasena({ email: sqlUpdated.email, displayName: sqlUpdated.displayName, password: temporal, roles: sqlUpdated.roles, kind: "resend", performedBy: u.id, performedByEmail: u.email });
      return ok({ ...sanitize(sqlUpdated), emailSent: true });
    } catch (e) { return serverError(e); }
  },
});

async function setUserActive(req: HttpRequest, active: boolean, action: string): Promise<HttpResponseInit> {
  const u = await getUserOrFail(req);
  const roleDefinitions = await loadRoleDefinitions();
  if (active ? !canReactivateUser(u, roleDefinitions) : !canDeactivateUser(u, roleDefinitions)) return forbidden();
  const id = req.params.id;
  const resource = await findSqlUserById(id);
  if (!resource) return notFound("Usuario no encontrado.");
  resource.active = active;
  if (!active) resource.tokenVersion = (resource.tokenVersion ?? 0) + 1;
  resource.updatedAt = new Date().toISOString();
  resource.updatedBy = u.id;
  const sqlUpdated = await updateSqlUser(id, { active }, { id: u.id, email: u.email });
  return sqlUpdated ? ok(sanitize(sqlUpdated)) : notFound("Usuario no encontrado.");
}

app.http("usersDeactivate", { route: "users/{id}/deactivate", methods: ["POST"], authLevel: "anonymous", handler: (req) => setUserActive(req, false, "user_deactivated").catch(serverError) });
app.http("usersReactivate", { route: "users/{id}/reactivate", methods: ["POST"], authLevel: "anonymous", handler: (req) => setUserActive(req, true, "user_updated").catch(serverError) });
