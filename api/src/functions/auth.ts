import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { hashPassword, normalizeEmail, passwordChangeRequired, passwordExpirationIso, validatePasswordPolicy, verifyPassword } from "../lib/password";
import { signJwt } from "../lib/jwt";
import { ok } from "../lib/http";
import type { UserRecord } from "../types/models";
import { migrateLegacyRoleIds } from "../lib/permissionModel";
import {
  clearRefreshCookie,
  getRefreshTokenFromRequest,
  isTrustedSessionMutation,
  refreshCookie,
  revokeRefreshSession,
  rotateAuthSession,
  makeAuthSession,
} from "../lib/authSessions";
import {
  checkLoginLockout,
  clearLoginAccountFailures,
  enforceRequestRateLimit,
  RATE_LIMIT_POLICIES,
  recordLoginFailure,
} from "../lib/rateLimit";
import {
  completeSqlLogin,
  findSqlUserByEmail,
  findSqlUserByResetTokenHash,
  requestSqlPasswordReset,
  resetSqlPasswordByToken,
  setSqlUserPassword,
} from "../lib/securityManagementSqlWriteRepository";

const LoginSchema = z.object({
  email: z.string().min(1).max(254),
  password: z.string().min(1).max(200),
  newPassword: z.string().max(200).optional(),
});

const MENSAJE_LOGIN_GENERICO = "Correo o contraseña incorrectos.";

function sanitize(u: UserRecord) {
  const { passwordHash, passwordResetTokenHash, passwordResetExpiresAt, passwordResetUsedAt, tokenVersion,
    mfaEnabled, mfaSecretName, mfaEnrolledAt, mfaLastTimeStep, mfaRecoveryCodeHashes, ...rest } = u;
  return { ...rest, roles: migrateLegacyRoleIds(rest.roles ?? []) };
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
      const user = await findSqlUserByEmail(email);
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

      if (passwordChangeRequired(user)) {
        if (!parsed.data.newPassword) {
          return { status: 200, headers: { "Cache-Control": "no-store" }, jsonBody: { passwordChangeRequired: true } };
        }
        try {
          await validatePasswordPolicy(parsed.data.newPassword, { email: user.email, displayName: user.displayName });
          if (await verifyPassword(parsed.data.newPassword, user.passwordHash)) {
            return { status: 400, jsonBody: { error: "La nueva contraseña debe ser diferente de la contraseña temporal o vencida." } };
          }
        } catch (error: any) {
          return { status: error?.status === 503 ? 503 : 400, jsonBody: { error: error?.message || "La contraseña no cumple la política de seguridad." } };
        }
        const changedAt = new Date().toISOString();
        user.passwordHash = await hashPassword(parsed.data.newPassword);
        user.passwordUpdatedAt = changedAt;
        user.passwordExpiresAt = passwordExpirationIso();
        user.mustChangePassword = false;
        user.tokenVersion = (user.tokenVersion ?? 0) + 1;
        user.updatedAt = changedAt;
        user.updatedBy = user.id;
        const changed = await setSqlUserPassword(user.id, user.passwordHash, { id: user.id, email: user.email }, "mandatory_password_changed", {
          mustChangePassword: false,
          expiresAt: user.passwordExpiresAt ? new Date(user.passwordExpiresAt) : null,
          updatedBy: user.id,
        });
        if (!changed) throw Object.assign(new Error("Usuario no disponible."), { status: 503 });
        return { status: 200, headers: { "Cache-Control": "no-store" }, jsonBody: { passwordChanged: true, message: "Contraseña actualizada. Inicie sesión nuevamente." } };
      }

      const prepared = makeAuthSession(user, Date.now());
      const persisted = await completeSqlLogin(user.id, prepared.record);
      if (!persisted) throw Object.assign(new Error("No se pudo crear la sesión segura."), { status: 503 });
      Object.assign(user, persisted);
      const createdSession = { session: prepared.record, refreshToken: prepared.refreshToken };
      const { session, refreshToken } = createdSession;
      const token = signJwt(
        { id: user.id, email: user.email, displayName: user.displayName, roles: migrateLegacyRoleIds(user.roles ?? []) },
        { id: session.id, tokenVersion: session.tokenVersion }
      );
      return {
        status: 200,
        headers: { "Set-Cookie": refreshCookie(refreshToken), "Cache-Control": "no-store" },
        jsonBody: { token, user: sanitize(user) },
      };
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
  handler: async (req): Promise<HttpResponseInit> => {
    if (!isTrustedSessionMutation(req)) return { status: 403, jsonBody: { error: "Solicitud de sesión no válida." } };
    try {
      await revokeRefreshSession(getRefreshTokenFromRequest(req), "logout");
    } catch {
      return { status: 503, jsonBody: { error: "No se pudo cerrar la sesión de forma segura. Intente nuevamente." } };
    }
    return { status: 204, headers: { "Set-Cookie": clearRefreshCookie(), "Cache-Control": "no-store" } };
  },
});

app.http("authRefresh", {
  route: "auth/refresh",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    if (!isTrustedSessionMutation(req)) return { status: 403, jsonBody: { error: "Solicitud de sesión no válida." } };
    try {
      const currentToken = getRefreshTokenFromRequest(req);
      const limited = await enforceRequestRateLimit(req, "auth_refresh", currentToken || undefined, RATE_LIMIT_POLICIES.refreshSession);
      if (limited) return limited;
      if (!currentToken) throw new Error("missing_refresh_token");
      const rotated = await rotateAuthSession(currentToken);
      if (!rotated) throw new Error("invalid_refresh_token");
      const token = signJwt(
        { id: rotated.user.id, email: rotated.user.email, displayName: rotated.user.displayName, roles: migrateLegacyRoleIds(rotated.user.roles ?? []) },
        { id: rotated.session.id, tokenVersion: rotated.session.tokenVersion }
      );
      return {
        status: 200,
        headers: { "Set-Cookie": refreshCookie(rotated.refreshToken), "Cache-Control": "no-store" },
        jsonBody: { token },
      };
    } catch (error: any) {
      if (error?.status === 503 || Number(error?.statusCode) >= 500) {
        return { status: 503, jsonBody: { error: "Servicio de seguridad temporalmente no disponible." } };
      }
      return {
        status: 401,
        headers: { "Set-Cookie": clearRefreshCookie(), "Cache-Control": "no-store" },
        jsonBody: { error: "Sesión expirada. Inicie sesión nuevamente." },
      };
    }
  },
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

      const user = await findSqlUserByEmail(email);

      // Si existe y está activo, generamos token y enviamos email.
      if (user && user.active) {
        await requestSqlPasswordReset(user);
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
  password: z.string().min(14).max(200),
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
      const tokenHash = hashResetToken(parsed.data.token);
      const user = await findSqlUserByResetTokenHash(tokenHash);
      if (!user || !user.active) {
        return { status: 400, jsonBody: { error: MENSAJE_RESET_INVALIDO } };
      }
      if (user.passwordResetUsedAt) {
        return { status: 400, jsonBody: { error: MENSAJE_RESET_INVALIDO } };
      }
      if (isResetTokenExpired(user.passwordResetExpiresAt)) {
        return { status: 400, jsonBody: { error: MENSAJE_RESET_INVALIDO } };
      }
      try {
        await validatePasswordPolicy(parsed.data.password, { email: user.email, displayName: user.displayName });
      } catch (error: any) {
        return { status: error?.status === 503 ? 503 : 400, jsonBody: { error: error?.message || "La contraseña no cumple la política de seguridad." } };
      }
      const newHash = await hashPassword(parsed.data.password);
      const now = new Date().toISOString();
      user.passwordHash = newHash;
      user.passwordUpdatedAt = now;
      user.passwordExpiresAt = passwordExpirationIso();
      user.mustChangePassword = false;
      user.tokenVersion = (user.tokenVersion ?? 0) + 1;
      user.passwordResetUsedAt = now;
      user.passwordResetTokenHash = null;
      user.passwordResetExpiresAt = null;
      user.updatedAt = now;
      user.updatedBy = "system";
      const reset = await resetSqlPasswordByToken(tokenHash, newHash, new Date(user.passwordExpiresAt!));
      if (!reset) return { status: 400, jsonBody: { error: MENSAJE_RESET_INVALIDO } };
      return ok({ message: "Tu contraseña fue actualizada correctamente. Ya puedes iniciar sesión." });
    } catch (error: any) {
      if (error?.status === 503) return { status: 503, jsonBody: { error: "Servicio de seguridad temporalmente no disponible." } };
      return { status: 400, jsonBody: { error: MENSAJE_RESET_INVALIDO } };
    }
  },
});
