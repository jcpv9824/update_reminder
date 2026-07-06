import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { hashPassword, normalizeEmail, passwordExpirationIso, validatePasswordPolicy } from "../lib/password";
import { badRequest, created, forbidden, ok, serverError } from "../lib/http";
import type { UserRecord } from "../types/models";
import { enforceRequestRateLimit, RATE_LIMIT_POLICIES } from "../lib/rateLimit";
import { revokeAllUserSessions } from "../lib/authSessions";

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
        roles: ["admin"],
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
      try {
        await container.items.create(record);
      } catch (e: any) {
        if (e?.code === 409) {
          const { resource } = await container.item(record.id, record.id).read<UserRecord>();
          if (resource) {
            const roles = Array.from(new Set([...(resource.roles ?? []), "admin"]));
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

// Endpoint temporal para asignar/cambiar la contraseña de un usuario existente
// (típicamente el admin original creado sin contraseña). Después de usarlo se
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
