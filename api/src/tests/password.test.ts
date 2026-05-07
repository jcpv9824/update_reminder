import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, normalizeEmail } from "../lib/password";

describe("password helpers", () => {
  it("hashPassword genera un hash que verifica con verifyPassword", async () => {
    const hash = await hashPassword("Secreto123");
    expect(hash).not.toBe("Secreto123");
    expect(hash.startsWith("$2")).toBe(true);
    expect(await verifyPassword("Secreto123", hash)).toBe(true);
    expect(await verifyPassword("otro", hash)).toBe(false);
  });

  it("hashPassword rechaza contraseñas demasiado cortas", async () => {
    await expect(hashPassword("123")).rejects.toThrow(/al menos 6/i);
  });

  it("normalizeEmail trim + lowercase", () => {
    expect(normalizeEmail("  Camilo.Palacio@PYA.com.co  ")).toBe("camilo.palacio@pya.com.co");
  });
});
