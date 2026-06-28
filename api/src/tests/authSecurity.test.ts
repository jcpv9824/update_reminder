import type { HttpRequest } from "@azure/functions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCurrentUser, requireUser } from "../lib/auth";
import { signJwt } from "../lib/jwt";

function requestWithHeaders(headers: Record<string, string>): HttpRequest {
  return { headers: new Headers(headers) } as HttpRequest;
}

describe("auth security", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "secreto-suficientemente-largo-para-tests";
    process.env.JWT_EXPIRES_IN = "1h";
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

  it("conserva autenticacion por JWT valido", async () => {
    const token = signJwt({
      id: "user_1",
      email: "usuario@empresa.com",
      displayName: "Usuario",
      roles: ["client_manager"],
    });

    const user = await getCurrentUser(requestWithHeaders({
      authorization: `Bearer ${token}`,
    }));

    expect(user).toEqual({
      id: "user_1",
      email: "usuario@empresa.com",
      displayName: "usuario@empresa.com",
      roles: ["client_manager"],
    });
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
      roles: ["admin"],
    });
  });
});
