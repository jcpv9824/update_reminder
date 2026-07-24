import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { hashPassword, normalizeEmail, passwordExpirationIso, validatePasswordPolicy } from "../lib/password";
import { badRequest, created, forbidden, ok, serverError } from "../lib/http";
import type { UserRecord } from "../types/models";
import { enforceRequestRateLimit, RATE_LIMIT_POLICIES } from "../lib/rateLimit";
import { migrateLegacyRoleIds } from "../lib/permissionModel";
import {
  createSqlUser,
  findSqlUserByEmail,
  findSqlUserById,
  setSqlUserPassword,
  updateSqlUser,
} from "../lib/securityManagementSqlWriteRepository";

function sanitize(u: UserRecord) {
  const { passwordHash, passwordResetTokenHash, passwordResetExpiresAt, passwordResetUsedAt, tokenVersion,
    mfaEnabled, mfaSecretName, mfaEnrolledAt, mfaLastTimeStep, mfaRecoveryCodeHashes, ...rest } = u;
  return rest;
}

const SetupSchema = z.object({
  setupSecret: z.string().min(8),
  id: z.string().min(1),
  email: z.string().email(),
  displayName: z.string().min(1),
  password: z.string().min(14, "La contraseña debe tener al menos 14 caracteres."),
});

app.http("setupFirstAdmin", {
  route: "setup/first-admin",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => {
    try {
      const expected = process.env.SETUP_SECRET;
      if (!expected) return forbidden("La inicialización está deshabilitada.");
      const body = await req.json();
      const limited = await enforceRequestRateLimit(req, "setup_first_admin", String((body as any)?.email ?? (body as any)?.id ?? ""), RATE_LIMIT_POLICIES.setup);
      if (limited) return limited;
      const parsed = SetupSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      if (parsed.data.setupSecret !== expected) return forbidden("Clave de inicialización incorrecta.");

      const now = new Date().toISOString();
      try {
        await validatePasswordPolicy(parsed.data.password, { email: parsed.data.email, displayName: parsed.data.displayName });
      } catch (error: any) {
        return error?.status === 503 ? { status: 503, jsonBody: { error: error.message } } : badRequest(error.message);
      }
      const passwordHash = await hashPassword(parsed.data.password);
      const email = normalizeEmail(parsed.data.email);
      const record: UserRecord = {
        id: parsed.data.id,
        displayName: parsed.data.displayName,
        email,
        roles: ["super_admin"],
        active: true,
        createdAt: now,
        createdBy: "system",
        updatedAt: now,
        updatedBy: "system",
        lastLoginAt: null,
        passwordHash,
        passwordUpdatedAt: now,
        passwordExpiresAt: passwordExpirationIso(),
        mustChangePassword: false,
        tokenVersion: 0,
      };
      const existing = await findSqlUserById(record.id);
      let sqlUser: UserRecord;
      if (existing) {
        const updated = await updateSqlUser(record.id, {
          displayName: record.displayName,
          roles: Array.from(new Set([...migrateLegacyRoleIds(existing.roles ?? []), "super_admin"])),
          active: true,
        }, { id: "system", email: "system" });
        if (!updated) return badRequest("Usuario no encontrado.");
        sqlUser = updated;
      } else {
        sqlUser = await createSqlUser({
          id: record.id,
          displayName: record.displayName,
          email: record.email,
          roles: ["super_admin"],
          active: true,
          passwordHash,
          mustChangePassword: false,
        }, { id: "system", email: "system" });
      }
      const passwordUser = await setSqlUserPassword(sqlUser.id, passwordHash,
        { id: "system", email: "system" }, "user_password_reset",
        { mustChangePassword: false, expiresAt: new Date(passwordExpirationIso()), updatedBy: "system" });
      return existing ? ok(sanitize(passwordUser ?? sqlUser)) : created(sanitize(passwordUser ?? sqlUser));
    } catch (e) {
      return serverError(e);
    }
  },
});

const SetAdminPwdSchema = z.object({
  setupSecret: z.string().min(8),
  email: z.string().email(),
  password: z.string().min(14, "La contraseña debe tener al menos 14 caracteres."),
});

const RoleMigrationSchema = z.object({
  setupSecret: z.string().min(8),
});

app.http("setupMigrateRoleIds", {
  route: "setup/migrate-role-ids",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => {
    try {
      const expected = process.env.SETUP_SECRET;
      if (!expected) return forbidden("La inicialización está deshabilitada.");
      const parsed = RoleMigrationSchema.safeParse(await req.json());
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      if (parsed.data.setupSecret !== expected) return forbidden("Clave de inicialización incorrecta.");

      return ok({
        migratedUsers: 0,
        deletedRoleDefinitions: [],
        migratedSettings: false,
        message: "Los roles SQL ya están normalizados; la migración de IDs heredados no aplica.",
      });
    } catch (e) {
      return serverError(e);
    }
  },
});

// Endpoint temporal para asignar/cambiar la contraseña de un usuario existente
// (típicamente el super_admin original creado sin contraseña). Después de usarlo se
// debe vaciar SETUP_SECRET.
app.http("setupSetAdminPassword", {
  route: "setup/set-admin-password",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => {
    try {
      const expected = process.env.SETUP_SECRET;
      if (!expected) return forbidden("La inicialización está deshabilitada.");
      const body = await req.json();
      const limited = await enforceRequestRateLimit(req, "setup_set_admin_password", String((body as any)?.email ?? ""), RATE_LIMIT_POLICIES.setup);
      if (limited) return limited;
      const parsed = SetAdminPwdSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      if (parsed.data.setupSecret !== expected) return forbidden("Clave de inicialización incorrecta.");

      const email = normalizeEmail(parsed.data.email);
      const user = await findSqlUserByEmail(email);
      if (!user) return badRequest("Usuario no encontrado.");
      try {
        await validatePasswordPolicy(parsed.data.password, { email: user.email, displayName: user.displayName });
      } catch (error: any) {
        return error?.status === 503 ? { status: 503, jsonBody: { error: error.message } } : badRequest(error.message);
      }
      const passwordHash = await hashPassword(parsed.data.password);
      const updated = await setSqlUserPassword(user.id, passwordHash,
        { id: "system", email: "system" }, "user_password_reset",
        { mustChangePassword: false, expiresAt: new Date(passwordExpirationIso()), updatedBy: "system" });
      return updated ? ok(sanitize(updated)) : badRequest("Usuario no encontrado.");
    } catch (e) {
      return serverError(e);
    }
  },
});
