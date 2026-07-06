import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it } from "vitest";
import { signJwt, verifyJwt } from "../lib/jwt";

const user = { id: "u1", email: "u@x.com", displayName: "U", roles: ["admin"] };
const session = { id: "session_1", tokenVersion: 3 };

beforeEach(() => {
  process.env.JWT_SECRET = "secreto-de-pruebas-con-mas-de-32-bytes-seguros";
  process.env.JWT_ACCESS_EXPIRES_IN = "10m";
  process.env.JWT_ISSUER = "erp-update-scheduler-api";
  process.env.JWT_AUDIENCE = "erp-update-scheduler-web";
});

describe("jwt endurecido", () => {
  it("firma HS256 con issuer, audience, jti, sid y tokenVersion", () => {
    const token = signJwt(user, session);
    const header = jwt.decode(token, { complete: true })?.header;
    const payload = verifyJwt(token);

    expect(header?.alg).toBe("HS256");
    expect(payload).toMatchObject({
      sub: "u1",
      email: "u@x.com",
      roles: ["admin"],
      sid: "session_1",
      ver: 3,
      iss: "erp-update-scheduler-api",
      aud: "erp-update-scheduler-web",
      amr: ["pwd"],
    });
    expect(payload?.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect((payload?.exp ?? 0) - (payload?.iat ?? 0)).toBe(600);
  });

  it("rechaza issuer y audience diferentes", () => {
    const wrongIssuer = jwt.sign(
      { email: user.email, roles: user.roles, sid: session.id, ver: 3 },
      process.env.JWT_SECRET!,
      { algorithm: "HS256", subject: user.id, issuer: "otro", audience: process.env.JWT_AUDIENCE, jwtid: "jti", expiresIn: "10m" }
    );
    const wrongAudience = jwt.sign(
      { email: user.email, roles: user.roles, sid: session.id, ver: 3 },
      process.env.JWT_SECRET!,
      { algorithm: "HS256", subject: user.id, issuer: process.env.JWT_ISSUER, audience: "otra", jwtid: "jti", expiresIn: "10m" }
    );

    expect(verifyJwt(wrongIssuer)).toBeNull();
    expect(verifyJwt(wrongAudience)).toBeNull();
  });

  it("rechaza algoritmos distintos de HS256", () => {
    const token = jwt.sign(
      { email: user.email, roles: user.roles, sid: session.id, ver: 3 },
      process.env.JWT_SECRET!,
      { algorithm: "HS384", subject: user.id, issuer: process.env.JWT_ISSUER, audience: process.env.JWT_AUDIENCE, jwtid: "jti", expiresIn: "10m" }
    );
    expect(verifyJwt(token)).toBeNull();
  });

  it("rechaza secretos menores de 32 bytes", () => {
    process.env.JWT_SECRET = "demasiado-corto";
    expect(() => signJwt(user, session)).toThrow("al menos 32 bytes");
  });

  it("verifyJwt devuelve null para token inválido o sin claims de sesión", () => {
    expect(verifyJwt("token-malo")).toBeNull();
    const legacy = jwt.sign(
      { email: user.email, roles: user.roles },
      process.env.JWT_SECRET!,
      { algorithm: "HS256", subject: user.id, issuer: process.env.JWT_ISSUER, audience: process.env.JWT_AUDIENCE, expiresIn: "10m" }
    );
    expect(verifyJwt(legacy)).toBeNull();
  });
});
