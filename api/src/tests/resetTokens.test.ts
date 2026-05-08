import { describe, it, expect } from "vitest";
import { generateResetToken, hashResetToken, isResetTokenExpired, resetExpirationIso } from "../lib/resetTokens";

describe("resetTokens", () => {
  it("genera token aleatorio y un hash distinto del token", () => {
    const { token, tokenHash } = generateResetToken();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(tokenHash.length).toBe(64); // SHA-256 hex
    expect(token).not.toBe(tokenHash);
  });

  it("hashResetToken es determinista", () => {
    const t = "abc123";
    expect(hashResetToken(t)).toBe(hashResetToken(t));
  });

  it("dos generaciones consecutivas producen tokens distintos", () => {
    const a = generateResetToken();
    const b = generateResetToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });

  it("isResetTokenExpired detecta tokens vencidos", () => {
    expect(isResetTokenExpired(new Date(Date.now() - 60_000).toISOString())).toBe(true);
    expect(isResetTokenExpired(new Date(Date.now() + 60_000).toISOString())).toBe(false);
    expect(isResetTokenExpired(null)).toBe(true);
    expect(isResetTokenExpired(undefined)).toBe(true);
  });

  it("resetExpirationIso devuelve fecha ISO en el futuro", () => {
    const iso = resetExpirationIso(30);
    expect(Date.parse(iso)).toBeGreaterThan(Date.now());
  });
});
