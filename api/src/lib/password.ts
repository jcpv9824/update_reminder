import bcrypt from "bcryptjs";

const COSTO = 10;

export async function hashPassword(plain: string): Promise<string> {
  if (!plain || plain.length < 6) {
    throw new Error("La contraseña debe tener al menos 6 caracteres.");
  }
  return bcrypt.hash(plain, COSTO);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!plain || !hash) return false;
  return bcrypt.compare(plain, hash);
}

export function normalizeEmail(email: string): string {
  return (email ?? "").trim().toLowerCase();
}
