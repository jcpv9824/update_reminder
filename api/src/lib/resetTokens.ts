import { randomBytes, createHash } from "crypto";

// Genera un token de reseteo de contraseña: 32 bytes aleatorios codificados
// como hex (64 caracteres). El backend solo guarda el hash SHA-256.
export function generateResetToken(): { token: string; tokenHash: string } {
  const buf = randomBytes(32);
  const token = buf.toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  return { token, tokenHash };
}

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isResetTokenExpired(expiresAtIso?: string | null): boolean {
  if (!expiresAtIso) return true;
  return Date.now() > Date.parse(expiresAtIso);
}

// 30 minutos por defecto.
export function resetExpirationIso(minutes = 30): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}
