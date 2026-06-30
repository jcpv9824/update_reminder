import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { getContainer } from "../lib/cosmos";
import { verifyPassword, normalizeEmail } from "../lib/password";
import { signJwt } from "../lib/jwt";
import { writeAuditLog } from "../lib/audit";
import { ok } from "../lib/http";
import type { UserRecord } from "../types/models";
import {
  checkLoginLockout,
  clearLoginAccountFailures,
  enforceRequestRateLimit,
  RATE_LIMIT_POLICIES,
  recordLoginFailure,
} from "../lib/rateLimit";

const LoginSchema = z.object({
  email: z.string().min(1).max(254),
  password: z.string().min(1).max(200),
});

const MENSAJE_LOGIN_GENERICO = "Correo o contraseña incorrectos.";

function sanitize(u: UserRecord) {
  const { passwordHash, ...rest } = u;
  return rest;
}

app.http("authLogin", {
  route: "auth/login",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => {
    // Mensaje genérico para todos los fallos de credenciales: no debemos
    // revelar si el correo existe, si está inactivo o si la contraseña es
    // incorrecta. Esto evita enumeración de usuarios.
    try {
      const body = await req.json().catch(() => ({}));
      const parsed = LoginSchema.safeParse(body);
      const email = parsed.success ? normalizeEmail(parsed.data.email) : "";
      const requestLimited = await enforceRequestRateLimit(req, "auth_login_request", email || undefined, RATE_LIMIT_POLICIES.loginRequest);
      if (requestLimited) return requestLimited;
      const locked = await checkLoginLockout(req, email || "invalid");
      if (locked) return locked;
      if (!parsed.success) {
        const limited = await recordLoginFailure(req, "invalid");
        if (limited) return limited;
        return { status: 401, jsonBody: { error: MENSAJE_LOGIN_GENERICO } };
      }
      const { resources } = await getContainer("users")
        .items.query<UserRecord>({ query: "SELECT * FROM c WHERE LOWER(c.email) = @e", parameters: [{ name: "@e", value: email }] })
        .fetchAll();
      const user = resources[0];
      if (!user || !user.passwordHash || !user.active) {
        const limited = await recordLoginFailure(req, email);
        if (limited) return limited;
        return { status: 401, jsonBody: { error: MENSAJE_LOGIN_GENERICO } };
      }
      const okPwd = await verifyPassword(parsed.data.password, user.passwordHash);
      if (!okPwd) {
        const limited = await recordLoginFailure(req, email);
        if (limited) return limited;
        return { status: 401, jsonBody: { error: MENSAJE_LOGIN_GENERICO } };
      }

      await clearLoginAccountFailures(email);

      // Actualizar lastLoginAt sin tocar passwordHash.
      user.lastLoginAt = new Date().toISOString();
      await getContainer("users").item(user.id, user.id).replace(user);

      const token = signJwt({ id: user.id, email: user.email, displayName: user.displayName, roles: user.roles ?? [] });
      await writeAuditLog({
        entityType: "user",
        entityId: user.id,
        action: "user_logged_in",
        performedBy: user.id,
        performedByEmail: user.email,
      });
      return ok({ token, user: sanitize(user) });
    } catch (error: any) {
      if (error?.status === 503) return { status: 503, jsonBody: { error: "Servicio de seguridad temporalmente no disponible." } };
      // No filtrar stack traces ni mensajes detallados.
      return { status: 401, jsonBody: { error: MENSAJE_LOGIN_GENERICO } };
    }
  },
});

app.http("authLogout", {
  route: "auth/logout",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (): Promise<HttpResponseInit> => ({ status: 204 }),
});

const ForgotSchema = z.object({ email: z.string().min(1).max(254) });

const MENSAJE_FORGOT_GENERICO =
  "Si el correo existe y está activo, enviaremos instrucciones para restablecer la contraseña.";

// POST /api/auth/forgot-password
// Siempre responde el mismo mensaje genérico para no revelar enumeración.
app.http("authForgotPassword", {
  route: "auth/forgot-password",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const body = await req.json().catch(() => ({}));
      const parsed = ForgotSchema.safeParse(body);
      const identity = parsed.success ? normalizeEmail(parsed.data.email) : undefined;
      const limited = await enforceRequestRateLimit(req, "auth_forgot_password", identity, RATE_LIMIT_POLICIES.forgotPassword);
      if (limited) return limited;
      if (!parsed.success) return ok({ message: MENSAJE_FORGOT_GENERICO });
      const email = identity!;

      const { resources } = await getContainer("users")
        .items.query<UserRecord>({ query: "SELECT * FROM c WHERE LOWER(c.email) = @e", parameters: [{ name: "@e", value: email }] })
        .fetchAll();
      const user = resources[0];

      // Si existe y está activo, generamos token y enviamos email.
      if (user && user.active) {
        const { generateResetToken, resetExpirationIso } = await import("../lib/resetTokens");
        const { settingsService } = { settingsService: await import("../lib/settingsService") };
        const { renderResetPasswordEmail, sendEmail } = await import("../lib/emailService");
        const { writeAuditLog } = await import("../lib/audit");
        const { token, tokenHash } = generateResetToken();
        user.passwordResetTokenHash = tokenHash;
        user.passwordResetExpiresAt = resetExpirationIso(30);
        user.passwordResetUsedAt = null;
        await getContainer("users").item(user.id, user.id).replace(user);

        const settings = await settingsService.loadEmailAlertsSettings();
        const baseUrl = settings.frontendBaseUrl?.replace(/\/$/, "") ?? "";
        const resetUrl = baseUrl
          ? `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`
          : `/reset-password?token=${encodeURIComponent(token)}`;
        const tpl = renderResetPasswordEmail({
          displayName: user.displayName,
          email: user.email,
          resetUrl,
          expiresInMinutes: 30,
        });
        // El token aparece SOLO en el email (no en logs ni respuesta).
        await sendEmail({ to: user.email, subject: tpl.subject, html: tpl.html, text: tpl.text }, settings);
        await writeAuditLog({
          entityType: "user",
          entityId: user.id,
          action: "password_reset_requested",
          performedBy: user.id,
          performedByEmail: user.email,
          metadata: { expiresAt: user.passwordResetExpiresAt },
        });
      }
      // Respuesta única, idéntica para todos los casos.
      return ok({ message: MENSAJE_FORGOT_GENERICO });
    } catch (error: any) {
      if (error?.status === 503) return { status: 503, jsonBody: { error: "Servicio de seguridad temporalmente no disponible." } };
      return ok({ message: MENSAJE_FORGOT_GENERICO });
    }
  },
});

const ResetSchema = z.object({
  token: z.string().min(16).max(256),
  password: z.string().min(6).max(200),
});

const MENSAJE_RESET_INVALIDO = "El enlace no es válido o ya expiró. Solicita uno nuevo.";

// POST /api/auth/reset-password
app.http("authResetPassword", {
  route: "auth/reset-password",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const body = await req.json().catch(() => ({}));
      const parsed = ResetSchema.safeParse(body);
      const limited = await enforceRequestRateLimit(
        req,
        "auth_reset_password",
        parsed.success ? parsed.data.token : undefined,
        RATE_LIMIT_POLICIES.resetPassword
      );
      if (limited) return limited;
      if (!parsed.success) {
        return { status: 400, jsonBody: { error: parsed.success === false ? "Datos no válidos." : MENSAJE_RESET_INVALIDO } };
      }
      const { hashResetToken, isResetTokenExpired } = await import("../lib/resetTokens");
      const { hashPassword } = await import("../lib/password");
      const { writeAuditLog } = await import("../lib/audit");
      const tokenHash = hashResetToken(parsed.data.token);
      const { resources } = await getContainer("users")
        .items.query<UserRecord>({ query: "SELECT * FROM c WHERE c.passwordResetTokenHash = @h", parameters: [{ name: "@h", value: tokenHash }] })
        .fetchAll();
      const user = resources[0];
      if (!user || !user.active) {
        return { status: 400, jsonBody: { error: MENSAJE_RESET_INVALIDO } };
      }
      if (user.passwordResetUsedAt) {
        return { status: 400, jsonBody: { error: MENSAJE_RESET_INVALIDO } };
      }
      if (isResetTokenExpired(user.passwordResetExpiresAt)) {
        return { status: 400, jsonBody: { error: MENSAJE_RESET_INVALIDO } };
      }
      const newHash = await hashPassword(parsed.data.password);
      const now = new Date().toISOString();
      user.passwordHash = newHash;
      user.passwordUpdatedAt = now;
      user.passwordResetUsedAt = now;
      user.passwordResetTokenHash = null;
      user.passwordResetExpiresAt = null;
      user.updatedAt = now;
      user.updatedBy = "system";
      await getContainer("users").item(user.id, user.id).replace(user);
      await writeAuditLog({
        entityType: "user",
        entityId: user.id,
        action: "password_reset_completed",
        performedBy: user.id,
        performedByEmail: user.email,
      });
      return ok({ message: "Tu contraseña fue actualizada correctamente. Ya puedes iniciar sesión." });
    } catch (error: any) {
      if (error?.status === 503) return { status: 503, jsonBody: { error: "Servicio de seguridad temporalmente no disponible." } };
      return { status: 400, jsonBody: { error: MENSAJE_RESET_INVALIDO } };
    }
  },
});
