import bcrypt from "bcryptjs";
import { createHash, randomInt } from "node:crypto";

export const PASSWORD_MIN_LENGTH = 14;
export const PASSWORD_MAX_BYTES = 72;

const COMMON_PASSWORDS = new Set([
  "12345678901234", "passwordpassword", "password123456", "contraseña123456",
  "qwertyuiop12345", "administrador123", "administrator123", "bienvenido123456",
  "letmeinletmein", "changeme123456", "empresa12345678", "sagerp123456789",
]);

export type PasswordIdentity = { email?: string; displayName?: string };

function bcryptCost(): number {
  const configured = Number(process.env.BCRYPT_COST || 12);
  const minimum = process.env.NODE_ENV === "test" ? 4 : 12;
  return Number.isInteger(configured) ? Math.min(15, Math.max(minimum, configured)) : 12;
}

function normalizeComparable(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function validatePasswordLocally(plain: string, identity: PasswordIdentity = {}): void {
  if (!plain || plain.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`);
  }
  if (Buffer.byteLength(plain, "utf8") > PASSWORD_MAX_BYTES) {
    throw new Error(`La contraseña no puede superar ${PASSWORD_MAX_BYTES} bytes.`);
  }
  if (plain !== plain.trim()) {
    throw new Error("La contraseña no puede comenzar ni terminar con espacios.");
  }
  const comparable = normalizeComparable(plain);
  if (COMMON_PASSWORDS.has(plain.toLowerCase()) || COMMON_PASSWORDS.has(comparable)) {
    throw new Error("Esta contraseña es demasiado común. Elija una frase de contraseña diferente.");
  }
  const emailLocal = normalizeComparable((identity.email || "").split("@")[0] || "");
  const displayName = normalizeComparable(identity.displayName || "");
  if ((emailLocal.length >= 4 && comparable.includes(emailLocal)) || (displayName.length >= 4 && comparable.includes(displayName))) {
    throw new Error("La contraseña no puede contener su correo ni su nombre.");
  }
}

export async function isCompromisedPassword(
  plain: string,
  options: { fetcher?: typeof fetch; enabled?: boolean; failClosed?: boolean } = {}
): Promise<boolean> {
  const enabled = options.enabled ?? process.env.PWNED_PASSWORDS_ENABLED === "true";
  if (!enabled) return false;
  const sha1 = createHash("sha1").update(plain, "utf8").digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const response = await (options.fetcher ?? fetch)(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { "Add-Padding": "true", "User-Agent": "erp-update-scheduler-security" },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error(`pwned_passwords_${response.status}`);
    const matches = (await response.text()).split(/\r?\n/).some((line) => line.split(":", 1)[0]?.trim().toUpperCase() === suffix);
    return matches;
  } catch (error) {
    const failClosed = options.failClosed ?? process.env.PWNED_PASSWORDS_FAIL_CLOSED === "true";
    if (failClosed) throw Object.assign(new Error("No fue posible validar la seguridad de la contraseña. Intente nuevamente."), { status: 503, cause: error });
    return false;
  }
}

export async function validatePasswordPolicy(
  plain: string,
  identity: PasswordIdentity = {},
  options: Parameters<typeof isCompromisedPassword>[1] = {}
): Promise<void> {
  validatePasswordLocally(plain, identity);
  if (await isCompromisedPassword(plain, options)) {
    throw new Error("Esta contraseña aparece en filtraciones conocidas. Elija una contraseña diferente.");
  }
}

export async function hashPassword(plain: string): Promise<string> {
  validatePasswordLocally(plain);
  return bcrypt.hash(plain, bcryptCost());
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!plain || !hash) return false;
  return bcrypt.compare(plain, hash);
}

export function normalizeEmail(email: string): string {
  return (email ?? "").trim().toLowerCase();
}

export function passwordExpirationIso(nowMs = Date.now()): string {
  const configured = Number(process.env.PASSWORD_MAX_AGE_DAYS || 180);
  const days = Number.isFinite(configured) ? Math.min(365, Math.max(30, configured)) : 180;
  return new Date(nowMs + days * 86400_000).toISOString();
}

export function passwordChangeRequired(user: { mustChangePassword?: boolean; passwordExpiresAt?: string | null; passwordUpdatedAt?: string | null }, nowMs = Date.now()): boolean {
  if (user.mustChangePassword) return true;
  if (user.passwordExpiresAt) return Date.parse(user.passwordExpiresAt) <= nowMs;
  if (!user.passwordUpdatedAt) return true;
  const configured = Number(process.env.PASSWORD_MAX_AGE_DAYS || 180);
  const days = Number.isFinite(configured) ? Math.min(365, Math.max(30, configured)) : 180;
  return Date.parse(user.passwordUpdatedAt) + days * 86400_000 <= nowMs;
}

// Se entrega solo como credencial temporal y obliga cambio en el primer acceso.
export function generateTemporaryPassword(longitud = 18): string {
  const mayus = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const minus = "abcdefghijkmnpqrstuvwxyz";
  const nums = "23456789";
  const simbolos = "!@#$%*?";
  const todos = mayus + minus + nums + simbolos;
  const pick = (set: string) => set[randomInt(set.length)];
  const base = [pick(mayus), pick(minus), pick(nums), pick(simbolos)];
  for (let i = base.length; i < Math.max(longitud, PASSWORD_MIN_LENGTH); i++) base.push(pick(todos));
  for (let i = base.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [base[i], base[j]] = [base[j], base[i]];
  }
  return base.join("");
}
