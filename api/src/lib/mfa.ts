import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { generate, generateSecret, generateURI, verify } from "otplib";
import type { CurrentUser, UserRecord } from "../types/models";
import * as keyVault from "./keyVault";

export const MFA_ROLES = ["admin", "client_manager", "database_updater"] as const;

export function requiresMfaForRoles(roles: string[] = []): boolean {
  return MFA_ROLES.some((role) => roles.includes(role));
}

export function requireVerifiedMfa(user: CurrentUser): void {
  if (!user.mfaVerified) {
    throw Object.assign(new Error("Debe verificar MFA para realizar esta acción."), { status: 403 });
  }
}

export function mfaSecretName(userId: string): string {
  return `mfa-${createHash("sha256").update(userId).digest("hex").slice(0, 40)}`;
}

function issuer(): string {
  return process.env.MFA_ISSUER?.trim() || "Programador de Actualizaciones ERP";
}

function recoveryPepper(): string {
  const pepper = process.env.MFA_RECOVERY_PEPPER || process.env.JWT_SECRET;
  if (!pepper || Buffer.byteLength(pepper, "utf8") < 32) {
    throw new Error("MFA_RECOVERY_PEPPER debe tener al menos 32 bytes.");
  }
  return pepper;
}

export function normalizeMfaCode(code: string): string {
  return (code || "").trim().replace(/[\s-]/g, "").toUpperCase();
}

export function hashRecoveryCode(code: string): string {
  return createHmac("sha256", recoveryPepper()).update(normalizeMfaCode(code)).digest("hex");
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function generateRecoveryCodes(count = 10): { plain: string[]; hashes: string[] } {
  const plain = Array.from({ length: count }, () => {
    const raw = randomBytes(8).toString("hex").toUpperCase();
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
  });
  return { plain, hashes: plain.map(hashRecoveryCode) };
}

export async function prepareMfaEnrollment(user: UserRecord): Promise<{ secretName: string; secret: string; otpauthUri: string }> {
  const secretName = user.mfaSecretName || mfaSecretName(user.id);
  let secret = "";
  if (user.mfaSecretName) {
    try { secret = await keyVault.getSecret(secretName); } catch { /* crear uno nuevo */ }
  }
  if (!secret) {
    secret = generateSecret();
    await keyVault.setSecret(secretName, secret);
  }
  return {
    secretName,
    secret,
    otpauthUri: generateURI({ issuer: issuer(), label: user.email, secret }),
  };
}

export async function verifyMfaCode(args: {
  user: UserRecord;
  code: string;
  secret?: string;
  nowMs?: number;
}): Promise<{ valid: boolean; timeStep?: number; recoveryCodeHashes?: string[]; method?: "totp" | "recovery" }> {
  const normalized = normalizeMfaCode(args.code);
  const recoveryHash = hashRecoveryCode(normalized);
  const recoveryCodes = args.user.mfaRecoveryCodeHashes ?? [];
  const recoveryIndex = recoveryCodes.findIndex((hash) => sameHash(hash, recoveryHash));
  if (recoveryIndex >= 0) {
    return {
      valid: true,
      method: "recovery",
      recoveryCodeHashes: recoveryCodes.filter((_, index) => index !== recoveryIndex),
    };
  }
  if (!/^\d{6}$/.test(normalized)) return { valid: false };
  const secret = args.secret || (args.user.mfaSecretName ? await keyVault.getSecret(args.user.mfaSecretName) : "");
  if (!secret) return { valid: false };
  const result = await verify({
    strategy: "totp",
    secret,
    token: normalized,
    epoch: args.nowMs === undefined ? undefined : Math.floor(args.nowMs / 1000),
    epochTolerance: 30,
    afterTimeStep: args.user.mfaLastTimeStep ?? undefined,
  });
  return result.valid && "timeStep" in result
    ? { valid: true, method: "totp", timeStep: result.timeStep }
    : { valid: false };
}

export async function currentTotpForTests(secret: string, nowMs?: number): Promise<string> {
  return generate({ strategy: "totp", secret, epoch: nowMs === undefined ? undefined : Math.floor(nowMs / 1000) });
}
