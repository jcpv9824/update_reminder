import bcrypt from "bcryptjs";
import { randomInt } from "crypto";

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

// Genera una contraseña temporal legible y razonablemente fuerte. Se usa al
// reenviar credenciales (las contraseñas se guardan cifradas y no se pueden
// recuperar, así que se entrega una NUEVA). Evita caracteres ambiguos.
export function generateTemporaryPassword(longitud = 12): string {
  const mayus = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // sin I, O
  const minus = "abcdefghijkmnpqrstuvwxyz"; // sin l, o
  const nums = "23456789"; // sin 0, 1
  const simbolos = "!@#$%*?";
  const todos = mayus + minus + nums + simbolos;
  const pick = (set: string) => set[randomInt(set.length)];
  // Garantiza al menos uno de cada categoría.
  const base = [pick(mayus), pick(minus), pick(nums), pick(simbolos)];
  for (let i = base.length; i < Math.max(longitud, 8); i++) base.push(pick(todos));
  // Mezcla (Fisher-Yates).
  for (let i = base.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [base[i], base[j]] = [base[j], base[i]];
  }
  return base.join("");
}
