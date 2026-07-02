import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateTemporaryPassword, hashPassword, isCompromisedPassword, normalizeEmail,
  passwordChangeRequired, validatePasswordLocally, validatePasswordPolicy, verifyPassword,
} from "../lib/password";

describe("politica de contraseñas", () => {
  beforeEach(() => { process.env.BCRYPT_COST = "4"; process.env.NODE_ENV = "test"; });
  afterEach(() => { delete process.env.PWNED_PASSWORDS_ENABLED; delete process.env.PWNED_PASSWORDS_FAIL_CLOSED; });

  it("acepta passphrases de 14 o más caracteres y genera hash verificable", async () => {
    const password = "Lluvia verde sobre Bogotá 2026";
    const hash = await hashPassword(password);
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword("otra contraseña segura", hash)).toBe(false);
  });

  it("rechaza menos de 14 caracteres, espacios de borde y más de 72 bytes", () => {
    expect(() => validatePasswordLocally("Secreto123")).toThrow(/14 caracteres/i);
    expect(() => validatePasswordLocally(" Frase muy segura 2026 ")).toThrow(/espacios/i);
    expect(() => validatePasswordLocally("á".repeat(40))).toThrow(/72 bytes/i);
  });

  it("rechaza contraseñas comunes o derivadas del correo/nombre", () => {
    expect(() => validatePasswordLocally("password123456")).toThrow(/común/i);
    expect(() => validatePasswordLocally("CamiloPalacio-segura-2026", { displayName: "Camilo Palacio" })).toThrow(/nombre/i);
    expect(() => validatePasswordLocally("usuario-empresa-segura", { email: "usuario@empresa.com" })).toThrow(/correo/i);
  });

  it("consulta HIBP solo con prefijo k-anonymity y detecta el sufijo", async () => {
    const password = "Frase filtrada para pruebas 2026";
    const sha1 = (await import("node:crypto")).createHash("sha1").update(password).digest("hex").toUpperCase();
    let requested = "";
    const fetcher = (async (url: string | URL | Request) => {
      requested = String(url);
      return new Response(`${sha1.slice(5)}:42\nOTRO:1`, { status: 200 });
    }) as typeof fetch;
    expect(await isCompromisedPassword(password, { enabled: true, fetcher })).toBe(true);
    expect(requested).toContain(sha1.slice(0, 5));
    expect(requested).not.toContain(sha1.slice(5));
    await expect(validatePasswordPolicy(password, {}, { enabled: true, fetcher })).rejects.toThrow(/filtraciones/i);
  });

  it("falla cerrado cuando el servicio de filtraciones no está disponible", async () => {
    const fetcher = (async () => { throw new Error("offline"); }) as typeof fetch;
    await expect(isCompromisedPassword("Frase segura fuera de línea", { enabled: true, failClosed: true, fetcher })).rejects.toMatchObject({ status: 503 });
  });

  it("calcula primer cambio y expiración", () => {
    expect(passwordChangeRequired({ mustChangePassword: true })).toBe(true);
    expect(passwordChangeRequired({ passwordExpiresAt: "2026-01-01T00:00:00.000Z" }, Date.parse("2026-02-01T00:00:00Z"))).toBe(true);
    expect(passwordChangeRequired({ passwordExpiresAt: "2027-01-01T00:00:00.000Z" }, Date.parse("2026-02-01T00:00:00Z"))).toBe(false);
  });

  it("genera contraseña temporal robusta de 18 caracteres", () => {
    const password = generateTemporaryPassword();
    expect(password).toHaveLength(18);
    expect(() => validatePasswordLocally(password)).not.toThrow();
  });

  it("normaliza el correo", () => expect(normalizeEmail("  Camilo.Palacio@PYA.com.co  ")).toBe("camilo.palacio@pya.com.co"));
});
