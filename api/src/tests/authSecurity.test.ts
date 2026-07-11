import type { HttpRequest } from "@azure/functions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCurrentUser, requireUser } from "../lib/auth";
import { signJwt } from "../lib/jwt";
import type { AuthSessionRecord, UserRecord } from "../types/models";

function requestWithHeaders(headers: Record<string, string>): HttpRequest {
  return { headers: new Headers(headers) } as HttpRequest;
}

describe("auth security", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "secreto-suficientemente-largo-para-tests";
    process.env.JWT_ACCESS_EXPIRES_IN = "10m";
    process.env.JWT_ISSUER = "erp-update-scheduler-api";
    process.env.JWT_AUDIENCE = "erp-update-scheduler-web";
    process.env.DEV_AUTH_ENABLED = "false";
  });

  afterEach(() => {
    delete process.env.DEV_AUTH_ENABLED;
  });

  it("rechaza x-ms-client-principal fabricado aunque declare rol administrador", async () => {
    const fakePrincipal = Buffer.from(JSON.stringify({
      userId: "admin_1",
      userDetails: "admin@empresa.com",
      userRoles: ["authenticated", "admin"],
    })).toString("base64");

    const user = await getCurrentUser(requestWithHeaders({
      "x-ms-client-principal": fakePrincipal,
    }));

    expect(user).toBeNull();
  });

  it("requireUser responde como no autenticado ante un principal fabricado", async () => {
    const fakePrincipal = Buffer.from(JSON.stringify({
      userDetails: "usuario@empresa.com",
      userRoles: ["admin"],
    })).toString("base64");

    await expect(requireUser(requestWithHeaders({
      "x-ms-client-principal": fakePrincipal,
    }))).rejects.toMatchObject({ message: "No autenticado.", status: 401 });
  });

  it("removes retired compatibility roles from a valid JWT session", async () => {
    const token = signJwt({
      id: "user_1",
      email: "usuario@empresa.com",
      displayName: "Usuario",
      roles: ["client_manager"],
    }, { id: "session_1", tokenVersion: 0 });

    const persistedUser: UserRecord = {
      id: "user_1",
      email: "usuario@empresa.com",
      displayName: "Usuario",
      roles: ["client_manager"],
      active: true,
      tokenVersion: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "system",
      updatedAt: "2026-01-01T00:00:00.000Z",
      updatedBy: "system",
    };
    const session: AuthSessionRecord = {
      id: "session_1",
      userId: "user_1",
      refreshTokenHash: "hash",
      tokenVersion: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      ttl: 3600,
    };

    const user = await getCurrentUser(requestWithHeaders({
      authorization: `Bearer ${token}`,
    }), {
      store: {
        read: async () => session,
        create: async () => undefined,
        replace: async () => undefined,
        listByUser: async () => [session],
      },
      loadUser: async () => persistedUser,
    });

    expect(user).toEqual({
      id: "user_1",
      email: "usuario@empresa.com",
      displayName: "Usuario",
      roles: [],
    });
  });

  it("acepta sesión válida de administrador sin pedir un segundo factor", async () => {
    const token = signJwt({ id: "user_1", email: "u@x.com", displayName: "U", roles: ["viewer"] }, { id: "session_1", tokenVersion: 0 });
    const persisted: UserRecord = { id: "user_1", email: "u@x.com", displayName: "U", roles: ["admin"], active: true, tokenVersion: 0, createdAt: "2026-01-01T00:00:00Z", createdBy: "system", updatedAt: "2026-01-01T00:00:00Z", updatedBy: "system" };
    const session: AuthSessionRecord = { id: "session_1", userId: "user_1", refreshTokenHash: "hash", tokenVersion: 0, createdAt: "2026-01-01T00:00:00Z", lastUsedAt: "2026-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", ttl: 3600 };
    const store = { read: async () => session, create: async () => undefined, replace: async () => undefined, listByUser: async () => [session] };
    expect(await getCurrentUser(requestWithHeaders({ authorization: `Bearer ${token}` }), { store, loadUser: async () => persisted })).toMatchObject({ id: "user_1", roles: ["super_admin"] });
  });

  it("solo acepta headers de desarrollo cuando DEV_AUTH_ENABLED=true", async () => {
    const req = requestWithHeaders({
      "x-dev-user-id": "dev_1",
      "x-dev-user-email": "dev@local",
      "x-dev-user-roles": "admin",
    });

    expect(await getCurrentUser(req)).toBeNull();

    process.env.DEV_AUTH_ENABLED = "true";
    expect(await getCurrentUser(req)).toMatchObject({
      id: "dev_1",
      email: "dev@local",
      roles: ["super_admin"],
    });
  });
});
