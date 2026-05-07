import { describe, it, expect, beforeEach } from "vitest";
import { signJwt, verifyJwt } from "../lib/jwt";

beforeEach(() => {
  process.env.JWT_SECRET = "secreto-suficientemente-largo-para-tests";
  process.env.JWT_EXPIRES_IN = "1h";
});

describe("jwt", () => {
  it("firma y verifica token con id, email y roles", () => {
    const token = signJwt({ id: "u1", email: "u@x.com", displayName: "U", roles: ["admin"] });
    const payload = verifyJwt(token);
    expect(payload?.sub).toBe("u1");
    expect(payload?.email).toBe("u@x.com");
    expect(payload?.roles).toEqual(["admin"]);
  });

  it("verifyJwt devuelve null para token inválido", () => {
    expect(verifyJwt("token-malo")).toBeNull();
  });
});
