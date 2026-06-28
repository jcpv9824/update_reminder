import type { HttpRequest } from "@azure/functions";
import type { CurrentUser } from "../types/models";
import { verifyJwt } from "./jwt";
import { normalizeEmail } from "./password";

// Extrae al usuario actual de la solicitud. En producción solo se acepta el
// JWT emitido por el login de la aplicación. No se confía en
// x-ms-client-principal porque la Function App también tiene URL pública y ese
// encabezado podría ser fabricado por un cliente directo.
export async function getCurrentUser(
  req: HttpRequest
): Promise<CurrentUser | null> {
  const auth = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    const payload = verifyJwt(token);
    if (payload) {
      return {
        id: payload.sub,
        email: payload.email,
        displayName: payload.email,
        roles: payload.roles ?? [],
      };
    }
  }

  // Modo desarrollo: solo si DEV_AUTH_ENABLED=true.
  if (process.env.DEV_AUTH_ENABLED === "true") {
    const id = req.headers.get("x-dev-user-id");
    if (id) {
      const rolesHeader = req.headers.get("x-dev-user-roles") ?? "admin";
      return {
        id,
        email: req.headers.get("x-dev-user-email") ?? "dev@local",
        displayName: req.headers.get("x-dev-user-name") ?? "Usuario Dev",
        roles: rolesHeader.split(",").map((r) => r.trim()).filter(Boolean),
      };
    }
  }

  return null;
}

export async function requireUser(req: HttpRequest): Promise<CurrentUser> {
  const u = await getCurrentUser(req);
  if (!u) {
    const err = new Error("No autenticado.");
    (err as any).status = 401;
    throw err;
  }
  return u;
}

export type ProfileLoadResult =
  | { status: "ok"; user: CurrentUser }
  | { status: "not_registered" }
  | { status: "inactive" };

// Carga el perfil persistido en Cosmos DB. Busca por id o por email
// case-insensitive. Devuelve estado detallado.
export async function loadUserProfileDetailed(user: CurrentUser): Promise<ProfileLoadResult> {
  try {
    const { getContainer } = await import("./cosmos");
    const container = getContainer("users");
    let resource: any = null;
    try {
      const r = await container.item(user.id, user.id).read<any>();
      resource = r.resource;
    } catch {/* */}
    const email = normalizeEmail(user.email);
    if (!resource && email) {
      const { resources } = await container.items
        .query<any>({ query: "SELECT * FROM c WHERE LOWER(c.email) = @e", parameters: [{ name: "@e", value: email }] })
        .fetchAll();
      resource = resources[0];
    }
    if (!resource) return { status: "not_registered" };
    if (resource.active === false) return { status: "inactive" };
    return {
      status: "ok",
      user: {
        id: resource.id,
        email: resource.email ?? user.email,
        displayName: resource.displayName ?? user.displayName,
        roles: resource.roles ?? [],
      },
    };
  } catch {
    return { status: "not_registered" };
  }
}

export async function loadUserProfile(user: CurrentUser): Promise<CurrentUser | null> {
  const r = await loadUserProfileDetailed(user);
  return r.status === "ok" ? r.user : null;
}
