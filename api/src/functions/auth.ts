import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { getContainer } from "../lib/cosmos";
import { verifyPassword, normalizeEmail } from "../lib/password";
import { signJwt } from "../lib/jwt";
import { writeAuditLog } from "../lib/audit";
import { badRequest, forbidden, ok, serverError, unauthorized } from "../lib/http";
import type { UserRecord } from "../types/models";

const LoginSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

function sanitize(u: UserRecord) {
  const { passwordHash, ...rest } = u;
  return rest;
}

app.http("authLogin", {
  route: "auth/login",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => {
    try {
      const body = await req.json().catch(() => ({}));
      const parsed = LoginSchema.safeParse(body);
      if (!parsed.success) return badRequest("Debe ingresar correo electrónico y contraseña.");
      const email = normalizeEmail(parsed.data.email);
      const { resources } = await getContainer("users")
        .items.query<UserRecord>({ query: "SELECT * FROM c WHERE LOWER(c.email) = @e", parameters: [{ name: "@e", value: email }] })
        .fetchAll();
      const user = resources[0];
      if (!user || !user.passwordHash) return unauthorized();
      const okPwd = await verifyPassword(parsed.data.password, user.passwordHash);
      if (!okPwd) {
        // Mensaje específico requerido en 401.
        return { status: 401, jsonBody: { error: "Correo o contraseña incorrectos." } };
      }
      if (!user.active) return forbidden("Tu usuario está inactivo. Contacta al administrador.");

      // Actualizar lastLoginAt sin tocar passwordHash en logs.
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
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("authLogout", {
  route: "auth/logout",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (): Promise<HttpResponseInit> => ({ status: 204 }),
});
