import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentTotpForTests, generateRecoveryCodes, mfaSecretName, requireVerifiedMfa,
  requiresMfaForRoles, verifyMfaCode,
} from "../lib/mfa";
import { generateSecret } from "otplib";

describe("MFA", () => {
  beforeEach(() => { process.env.MFA_RECOVERY_PEPPER = "pepper-de-pruebas-con-mas-de-treinta-y-dos-bytes"; });
  afterEach(() => { delete process.env.MFA_RECOVERY_PEPPER; });

  it("es obligatorio para admin, client_manager y database_updater", () => {
    expect(requiresMfaForRoles(["admin"])).toBe(true);
    expect(requiresMfaForRoles(["client_manager"])).toBe(true);
    expect(requiresMfaForRoles(["database_updater"])).toBe(true);
    expect(requiresMfaForRoles(["domain_updater"])).toBe(false);
    expect(requiresMfaForRoles(["viewer"])).toBe(false);
  });

  it("verifica TOTP y rechaza replay del mismo time step", async () => {
    const secret = generateSecret();
    const nowMs = Date.parse("2026-07-02T15:00:00.000Z");
    const token = await currentTotpForTests(secret, nowMs);
    const first = await verifyMfaCode({ user: baseUser(), code: token, secret, nowMs });
    expect(first).toMatchObject({ valid: true, method: "totp" });
    const replay = await verifyMfaCode({ user: { ...baseUser(), mfaLastTimeStep: first.timeStep }, code: token, secret, nowMs });
    expect(replay.valid).toBe(false);
  });

  it("consume un código de recuperación una sola vez", async () => {
    const recovery = generateRecoveryCodes(2);
    const user = { ...baseUser(), mfaRecoveryCodeHashes: recovery.hashes };
    const first = await verifyMfaCode({ user, code: recovery.plain[0], secret: "unused" });
    expect(first.valid).toBe(true);
    expect(first.recoveryCodeHashes).toHaveLength(1);
    expect((await verifyMfaCode({ user: { ...user, mfaRecoveryCodeHashes: first.recoveryCodeHashes }, code: recovery.plain[0], secret: "unused" })).valid).toBe(false);
  });

  it("no revela el id del usuario en el nombre de secreto y exige MFA en secretos", () => {
    expect(mfaSecretName("correo@empresa.com")).not.toContain("correo");
    expect(() => requireVerifiedMfa({ ...baseUser(), mfaVerified: false })).toThrow(/MFA/i);
    expect(() => requireVerifiedMfa({ ...baseUser(), mfaVerified: true })).not.toThrow();
  });
});

function baseUser() {
  return {
    id: "u1", email: "u@x.com", displayName: "U", roles: ["admin"], active: true,
    createdAt: "2026-01-01T00:00:00Z", createdBy: "system", updatedAt: "2026-01-01T00:00:00Z", updatedBy: "system",
  };
}
