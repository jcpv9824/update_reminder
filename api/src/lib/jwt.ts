import jwt, { SignOptions } from "jsonwebtoken";
import type { CurrentUser } from "../types/models";

function getSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    throw new Error("JWT_SECRET no está configurado o es demasiado corto.");
  }
  return s;
}

export type JwtPayload = {
  sub: string;
  email: string;
  roles: string[];
  iat?: number;
  exp?: number;
};

export function signJwt(user: CurrentUser): string {
  const expiresIn = (process.env.JWT_EXPIRES_IN ?? "8h") as SignOptions["expiresIn"];
  return jwt.sign(
    { sub: user.id, email: user.email, roles: user.roles } as JwtPayload,
    getSecret(),
    { expiresIn }
  );
}

export function verifyJwt(token: string): JwtPayload | null {
  try {
    const r = jwt.verify(token, getSecret());
    return r as JwtPayload;
  } catch {
    return null;
  }
}
