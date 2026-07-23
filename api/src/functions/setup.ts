import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { hashPassword, normalizeEmail, passwordExpirationIso, validatePasswordPolicy } from "../lib/password";
import { badRequest, conflict, created, forbidden, ok, serverError } from "../lib/http";
import type { EmailAlertsSettings, UpdateSchedule, UpdateTask, UserRecord } from "../types/models";
import { enforceRequestRateLimit, RATE_LIMIT_POLICIES } from "../lib/rateLimit";
import { revokeAllUserSessions } from "../lib/authSessions";
import { LEGACY_COMPATIBILITY_MIGRATION_ROLES, migrateLegacyRoleIds, RETIRED_COMPATIBILITY_ROLE_IDS } from "../lib/permissionModel";
import { roleUsageMessage, roleUsageSummary } from "../lib/roleLifecycle";
import { getDataBackend } from "../lib/dataBackend";
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

      const container = getContainer("users");
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
      if (getDataBackend() === "sql") {
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
      }
      try {
        await container.items.create(record);
      } catch (e: any) {
        if (e?.code === 409) {
          const { resource } = await container.item(record.id, record.id).read<UserRecord>();
          if (resource) {
            const roles = Array.from(new Set([...migrateLegacyRoleIds(resource.roles ?? []), "super_admin"]));
            const updated: UserRecord = {
              ...resource,
              roles,
              active: true,
              email,
              displayName: parsed.data.displayName,
              passwordHash,
              passwordUpdatedAt: now,
              passwordExpiresAt: passwordExpirationIso(),
              mustChangePassword: false,
              tokenVersion: (resource.tokenVersion ?? 0) + 1,
              updatedAt: now,
              updatedBy: "system",
            };
            await container.item(record.id, record.id).replace(updated);
            await revokeAllUserSessions(updated.id, "setup_password_changed");
            return ok(sanitize(updated));
          }
        }
        throw e;
      }
      await writeAuditLog({
        entityType: "user",
        entityId: record.id,
        action: "user_created",
        performedBy: "system",
        performedByEmail: "system",
        after: sanitize(record),
        metadata: { firstAdmin: true },
      });
      return created(sanitize(record));
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

const LEGACY_ROLE_DEFINITION_IDS = new Set([
  "admin",
  "formatos_impresion.admin",
  ...RETIRED_COMPATIBILITY_ROLE_IDS,
]);

function migrateRecipientRoles(settings: EmailAlertsSettings): EmailAlertsSettings {
  return {
    ...settings,
    overdueAlertRecipientRoleIds: migrateLegacyRoleIds(settings.overdueAlertRecipientRoleIds ?? []),
    blockedAlertRecipientRoleIds: migrateLegacyRoleIds(settings.blockedAlertRecipientRoleIds ?? []),
  };
}

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

      if (getDataBackend() === "sql") {
        return ok({
          migratedUsers: 0,
          deletedRoleDefinitions: [],
          migratedSettings: false,
          message: "Los roles SQL ya están normalizados; la migración de IDs heredados no aplica.",
        });
      }

      const [usersResult, schedulesResult, tasksResult, rolesResult, settingsResult] = await Promise.all([
        getContainer("users").items.readAll<UserRecord>().fetchAll(),
        getContainer("updateSchedules").items.readAll<UpdateSchedule>().fetchAll(),
        getContainer("updateTasks").items.readAll<UpdateTask>().fetchAll(),
        getContainer("roles").items.readAll<{ id: string }>().fetchAll(),
        getContainer("appSettings").item("email-alerts", "email-alerts").read<EmailAlertsSettings>().catch(() => ({ resource: undefined })),
      ]);

      for (const roleId of RETIRED_COMPATIBILITY_ROLE_IDS) {
        const usage = roleUsageSummary(roleId, usersResult.resources, schedulesResult.resources, tasksResult.resources);
        if (usage.activeSchedules > 0 || usage.openTasks > 0) return conflict(roleUsageMessage(usage), { roleId, ...usage });
      }

      const now = new Date().toISOString();
      const migrationRoles = LEGACY_COMPATIBILITY_MIGRATION_ROLES.filter((role) =>
        usersResult.resources.some((user) => migrateLegacyRoleIds(user.roles ?? []).includes(role.id))
      );
      for (const role of migrationRoles) {
        if (rolesResult.resources.some((stored) => stored.id === role.id)) continue;
        await getContainer("roles").items.create({ ...role, active: true, createdAt: now, createdBy: "system", updatedAt: now, updatedBy: "system" });
      }
      let migratedUsers = 0;
      for (const user of usersResult.resources) {
        const roles = migrateLegacyRoleIds(user.roles ?? []);
        if (JSON.stringify(roles) === JSON.stringify(user.roles ?? [])) continue;
        const updated = { ...user, roles, updatedAt: now, updatedBy: "system" };
        await getContainer("users").item(user.id, user.id).replace(updated);
        await revokeAllUserSessions(user.id, "role_compatibility_migrated");
        migratedUsers += 1;
      }

      const rolesToDelete = rolesResult.resources.filter((role) => LEGACY_ROLE_DEFINITION_IDS.has(role.id));
      for (const role of rolesToDelete) {
        await getContainer("roles").item(role.id, role.id).delete();
      }

      let migratedSettings = false;
      if (settingsResult.resource) {
        const migrated = migrateRecipientRoles(settingsResult.resource);
        if (JSON.stringify(migrated) !== JSON.stringify(settingsResult.resource)) {
          await getContainer("appSettings").items.upsert({ ...migrated, updatedAt: now, updatedBy: "system" });
          migratedSettings = true;
        }
      }

      await writeAuditLog({
        entityType: "role",
        entityId: "compatibility-migration",
        action: "role_compatibility_migrated",
        performedBy: "system",
        performedByEmail: "system",
        metadata: { migratedUsers, deletedRoleDefinitions: rolesToDelete.map((role) => role.id), migratedSettings },
      });
      return ok({ migratedUsers, deletedRoleDefinitions: rolesToDelete.map((role) => role.id), migratedSettings });
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
      if (getDataBackend() === "sql") {
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
      }
      const container = getContainer("users");
      const { resources } = await container.items
        .query<UserRecord>({ query: "SELECT * FROM c WHERE LOWER(c.email) = @e", parameters: [{ name: "@e", value: email }] })
        .fetchAll();
      const user = resources[0];
      if (!user) return badRequest("Usuario no encontrado.");
      try {
        await validatePasswordPolicy(parsed.data.password, { email: user.email, displayName: user.displayName });
      } catch (error: any) {
        return error?.status === 503 ? { status: 503, jsonBody: { error: error.message } } : badRequest(error.message);
      }
      const now = new Date().toISOString();
      user.passwordHash = await hashPassword(parsed.data.password);
      user.passwordUpdatedAt = now;
      user.passwordExpiresAt = passwordExpirationIso();
      user.mustChangePassword = false;
      user.roles = migrateLegacyRoleIds(user.roles ?? []);
      user.tokenVersion = (user.tokenVersion ?? 0) + 1;
      user.updatedAt = now;
      user.updatedBy = "system";
      await container.item(user.id, user.id).replace(user);
      await revokeAllUserSessions(user.id, "setup_password_changed");
      await writeAuditLog({
        entityType: "user",
        entityId: user.id,
        action: "user_password_reset",
        performedBy: "system",
        performedByEmail: "system",
        metadata: { setup: true },
      });
      return ok(sanitize(user));
    } catch (e) {
      return serverError(e);
    }
  },
});
