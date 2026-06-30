import { randomUUID } from "node:crypto";
import jwt, { type SignOptions } from "jsonwebtoken";
import type { CurrentUser } from "../types/models";

const JWT_ALGORITHM = "HS256" as const;

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("JWT_SECRET debe tener al menos 32 bytes.");
  }
  return secret;
}

function issuer(): string {
  return process.env.JWT_ISSUER?.trim() || "erp-update-scheduler-api";
}

function audience(): string {
  return process.env.JWT_AUDIENCE?.trim() || "erp-update-scheduler-web";
}

export type JwtPayload = {
  sub: string;
  email: string;
  roles: string[];
  sid: string;
  ver: number;
  jti: string;
  iss: string;
  aud: string | string[];
  iat?: number;
  exp?: number;
};

export function signJwt(user: CurrentUser, session: { id: string; tokenVersion: number }): string {
  const expiresIn = (process.env.JWT_ACCESS_EXPIRES_IN || "10m") as SignOptions["expiresIn"];
  return jwt.sign(
    {
      email: user.email,
      roles: user.roles,
      sid: session.id,
      ver: session.tokenVersion,
    },
    getSecret(),
    {
      algorithm: JWT_ALGORITHM,
      subject: user.id,
      issuer: issuer(),
      audience: audience(),
      jwtid: randomUUID(),
      expiresIn,
    }
  );
}

export function verifyJwt(token: string): JwtPayload | null {
  try {
    const payload = jwt.verify(token, getSecret(), {
      algorithms: [JWT_ALGORITHM],
      issuer: issuer(),
      audience: audience(),
    });
    if (typeof payload === "string") return null;
    if (
      typeof payload.sub !== "string"
      || typeof payload.email !== "string"
      || !Array.isArray(payload.roles)
      || typeof payload.sid !== "string"
      || typeof payload.ver !== "number"
      || typeof payload.jti !== "string"
    ) return null;
    return payload as JwtPayload;
  } catch {
    return null;
  }
}

export const jwtSecurityConfig = {
  algorithm: JWT_ALGORITHM,
  issuer,
  audience,
};
