import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getCurrentUser, loadUserProfileDetailed } from "../lib/auth";
import { ok, serverError, unauthorized } from "../lib/http";

app.http("me", {
  route: "me",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> => {
    try {
      const u = await getCurrentUser(req);
      if (!u) return unauthorized();
      const r = await loadUserProfileDetailed(u);
      if (r.status === "ok") {
        return ok({ authenticated: true, registered: true, active: true, user: r.user });
      }
      if (r.status === "inactive") {
        return ok({
          authenticated: true,
          registered: true,
          active: false,
          user: u,
          message: "Tu usuario está inactivo. Contacta al administrador.",
        });
      }
      return ok({
        authenticated: true,
        registered: false,
        user: u,
        message: "No tienes acceso a esta aplicación. Solicita a un administrador que registre tu usuario.",
      });
    } catch (e) {
      return serverError(e);
    }
  },
});
