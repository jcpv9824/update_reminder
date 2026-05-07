import type { HttpRequest } from "@azure/functions";
import type { CurrentUser } from "../types/models";

// Encabezados aceptados en modo desarrollo (DEV_AUTH_ENABLED=true).
// En producción se debe leer el principal autenticado de Static Web Apps:
//   "x-ms-client-principal" (Base64 JSON con userId, userDetails, userRoles).
export async function getCurrentUser(
  req: HttpRequest
): Promise<CurrentUser | null> {
  // 1) Static Web Apps / Entra ID
  const principalHeader = req.headers.get("x-ms-client-principal");
  if (principalHeader) {
    try {
      const decoded = Buffer.from(principalHeader, "base64").toString("utf8");
      const p = JSON.parse(decoded);
      return {
        id: p.userId ?? p.userDetails ?? "unknown",
        email: p.userDetails ?? "",
        displayName: p.userDetails ?? "",
        roles: Array.isArray(p.userRoles)
          ? p.userRoles.filter((r: string) => r !== "anonymous" && r !== "authenticated")
          : [],
      };
    } catch {
      // continúa
    }
  }

  // 2) Modo desarrollo
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

// Resultado detallado del intento de cargar perfil. Permite distinguir entre
// "no registrado" y "registrado pero inactivo".
export type ProfileLoadResult =
  | { status: "ok"; user: CurrentUser }
  | { status: "not_registered" }
  | { status: "inactive" };

// Carga el perfil persistido del usuario en Cosmos DB.
// Busca primero por id; si no existe, intenta por email (caso Microsoft 365
// donde el id local de la app es el email corporativo).
export async function loadUserProfileDetailed(user: CurrentUser): Promise<ProfileLoadResult> {
  try {
    const { getContainer } = await import("./cosmos");
    const container = getContainer("users");
    let resource: any = null;
    try {
      const r = await container.item(user.id, user.id).read<any>();
      resource = r.resource;
    } catch {/* sigue */}
    if (!resource && user.email) {
      const { resources } = await container.items
        .query<any>({ query: "SELECT * FROM c WHERE LOWER(c.email) = LOWER(@e)", parameters: [{ name: "@e", value: user.email }] })
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

// Compatibilidad hacia atrás con el resto del código existente.
export async function loadUserProfile(user: CurrentUser): Promise<CurrentUser | null> {
  const r = await loadUserProfileDetailed(user);
  return r.status === "ok" ? r.user : null;
}
