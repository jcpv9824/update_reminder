import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { HttpRequest } from "@azure/functions";
import { getContainer } from "./cosmos";
import type { AuthSessionRecord, UserRecord } from "../types/models";
import type { JwtPayload } from "./jwt";
import { sqlSecurityRuntimeEnabled } from "./dataBackend";

export type AuthSessionCreation = { record: AuthSessionRecord; refreshToken: string };
export type AtomicSessionRotation = {
  sessionId: string;
  presentedTokenHash: string;
  nowMs: number;
  createNext: (user: UserRecord) => AuthSessionCreation;
};

export interface AuthSessionStore {
  read(id: string): Promise<AuthSessionRecord | null>;
  create(record: AuthSessionRecord): Promise<void>;
  replace(record: AuthSessionRecord, etag?: string): Promise<void>;
  listByUser(userId: string): Promise<AuthSessionRecord[]>;
  loadUser?(id: string): Promise<UserRecord | null>;
  rotateAtomic?(request: AtomicSessionRotation): Promise<{ session: AuthSessionRecord; refreshToken: string; user: UserRecord } | null>;
}

export type UserLoader = (id: string) => Promise<UserRecord | null>;

const COOKIE_NAME = "erp_refresh_token";

function refreshLifetimeSeconds(): number {
  const configured = Number(process.env.REFRESH_TOKEN_DAYS || 30);
  const days = Number.isFinite(configured) ? Math.min(90, Math.max(1, configured)) : 30;
  return Math.floor(days * 86400);
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseRefreshToken(token: string | null | undefined): { sessionId: string; raw: string } | null {
  if (!token) return null;
  const separator = token.indexOf(".");
  if (separator <= 0 || separator === token.length - 1) return null;
  return { sessionId: token.slice(0, separator), raw: token };
}

class CosmosAuthSessionStore implements AuthSessionStore {
  async read(id: string): Promise<AuthSessionRecord | null> {
    try {
      const { resource } = await getContainer("authSessions").item(id, id).read<AuthSessionRecord>();
      return resource ?? null;
    } catch (error: any) {
      if (error?.code === 404 || error?.statusCode === 404) return null;
      throw error;
    }
  }

  async create(record: AuthSessionRecord): Promise<void> {
    const { _etag: _ignored, ...body } = record;
    await getContainer("authSessions").items.create(body);
  }

  async replace(record: AuthSessionRecord, etag?: string): Promise<void> {
    const { _etag: _ignored, ...body } = record;
    await getContainer("authSessions").item(record.id, record.id).replace(body, etag ? {
      accessCondition: { type: "IfMatch", condition: etag },
    } : undefined);
  }

  async listByUser(userId: string): Promise<AuthSessionRecord[]> {
    const { resources } = await getContainer("authSessions").items.query<AuthSessionRecord>({
      query: "SELECT * FROM c WHERE c.userId = @userId",
      parameters: [{ name: "@userId", value: userId }],
    }).fetchAll();
    return resources;
  }
}

const cosmosStore = new CosmosAuthSessionStore();

async function defaultLoadUser(id: string): Promise<UserRecord | null> {
  try {
    const { resource } = await getContainer("users").item(id, id).read<UserRecord>();
    return resource ?? null;
  } catch (error: any) {
    if (error?.code === 404 || error?.statusCode === 404) return null;
    throw error;
  }
}

export function makeAuthSession(user: UserRecord, nowMs: number): AuthSessionCreation {
  const id = randomUUID();
  const refreshToken = `${id}.${randomBytes(32).toString("base64url")}`;
  const lifetime = refreshLifetimeSeconds();
  const now = new Date(nowMs).toISOString();
  return {
    refreshToken,
    record: {
      id,
      userId: user.id,
      refreshTokenHash: hashRefreshToken(refreshToken),
      tokenVersion: user.tokenVersion ?? 0,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: new Date(nowMs + lifetime * 1000).toISOString(),
      revokedAt: null,
      revokedReason: null,
      replacedBySessionId: null,
      ttl: lifetime + 86400,
    },
  };
}

async function resolveSessionStore(explicit?: AuthSessionStore): Promise<AuthSessionStore> {
  if (explicit) return explicit;
  if (sqlSecurityRuntimeEnabled()) {
    const { sqlAuthSessionStore } = await import("./securityAuthSqlRepository");
    return sqlAuthSessionStore;
  }
  return cosmosStore;
}

export async function createAuthSession(
  user: UserRecord,
  options: { store?: AuthSessionStore; nowMs?: number } = {}
): Promise<{ session: AuthSessionRecord; refreshToken: string }> {
  const store = await resolveSessionStore(options.store);
  const created = makeAuthSession(user, options.nowMs ?? Date.now());
  await store.create(created.record);
  return { session: created.record, refreshToken: created.refreshToken };
}

export async function rotateAuthSession(
  refreshToken: string,
  options: { store?: AuthSessionStore; loadUser?: UserLoader; nowMs?: number } = {}
): Promise<{ session: AuthSessionRecord; refreshToken: string; user: UserRecord } | null> {
  const parsed = parseRefreshToken(refreshToken);
  if (!parsed) return null;
  const store = await resolveSessionStore(options.store);
  const nowMs = options.nowMs ?? Date.now();
  const presentedTokenHash = hashRefreshToken(parsed.raw);
  if (store.rotateAtomic) {
    return store.rotateAtomic({
      sessionId: parsed.sessionId,
      presentedTokenHash,
      nowMs,
      createNext: (user) => makeAuthSession(user, nowMs),
    });
  }
  const loadUser = options.loadUser ?? store.loadUser?.bind(store) ?? defaultLoadUser;
  const current = await store.read(parsed.sessionId);
  if (!current) return null;
  if (!hashesMatch(current.refreshTokenHash, presentedTokenHash)) return null;

  if (current.revokedAt) {
    if (current.replacedBySessionId) {
      const descendant = await store.read(current.replacedBySessionId);
      if (descendant && !descendant.revokedAt) {
        descendant.revokedAt = new Date(nowMs).toISOString();
        descendant.revokedReason = "refresh_token_reuse_detected";
        await store.replace(descendant, descendant._etag);
      }
    }
    return null;
  }
  if (Date.parse(current.expiresAt) <= nowMs) {
    return null;
  }

  const user = await loadUser(current.userId);
  if (!user || !user.active || (user.tokenVersion ?? 0) !== current.tokenVersion) return null;
  const next = makeAuthSession(user, nowMs);
  current.revokedAt = new Date(nowMs).toISOString();
  current.revokedReason = "rotated";
  current.replacedBySessionId = next.record.id;
  current.lastUsedAt = new Date(nowMs).toISOString();
  await store.replace(current, current._etag);
  await store.create(next.record);
  return { session: next.record, refreshToken: next.refreshToken, user };
}

export async function validateAccessSession(
  payload: JwtPayload,
  options: { store?: AuthSessionStore; loadUser?: UserLoader; nowMs?: number } = {}
): Promise<{ user: UserRecord; session: AuthSessionRecord } | null> {
  const store = await resolveSessionStore(options.store);
  const loadUser = options.loadUser ?? store.loadUser?.bind(store) ?? defaultLoadUser;
  const nowMs = options.nowMs ?? Date.now();
  const [session, user] = await Promise.all([store.read(payload.sid), loadUser(payload.sub)]);
  if (!session || !user || !user.active || session.revokedAt) return null;
  if (session.userId !== user.id || Date.parse(session.expiresAt) <= nowMs) return null;
  const version = user.tokenVersion ?? 0;
  if (payload.ver !== version || session.tokenVersion !== version) return null;
  return { user, session };
}

export async function revokeRefreshSession(
  refreshToken: string | null | undefined,
  reason: string,
  options: { store?: AuthSessionStore; nowMs?: number } = {}
): Promise<void> {
  const parsed = parseRefreshToken(refreshToken);
  if (!parsed) return;
  const store = await resolveSessionStore(options.store);
  const session = await store.read(parsed.sessionId);
  if (!session || session.revokedAt || !hashesMatch(session.refreshTokenHash, hashRefreshToken(parsed.raw))) return;
  session.revokedAt = new Date(options.nowMs ?? Date.now()).toISOString();
  session.revokedReason = reason;
  await store.replace(session, session._etag);
}

export async function revokeAllUserSessions(
  userId: string,
  reason: string,
  options: { store?: AuthSessionStore; nowMs?: number } = {}
): Promise<number> {
  const store = await resolveSessionStore(options.store);
  const now = new Date(options.nowMs ?? Date.now()).toISOString();
  const sessions = await store.listByUser(userId);
  let revoked = 0;
  for (const session of sessions) {
    if (session.revokedAt) continue;
    session.revokedAt = now;
    session.revokedReason = reason;
    await store.replace(session, session._etag);
    revoked++;
  }
  return revoked;
}

export function getRefreshTokenFromRequest(req: HttpRequest): string | null {
  const cookie = req.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE_NAME) return decodeURIComponent(value.join("="));
  }
  return null;
}

export function refreshCookie(refreshToken: string): string {
  const secure = process.env.AUTH_COOKIE_SECURE !== "false";
  const attributes = [
    `${COOKIE_NAME}=${encodeURIComponent(refreshToken)}`,
    "Path=/api/auth",
    "HttpOnly",
    `Max-Age=${refreshLifetimeSeconds()}`,
    secure ? "Secure" : "",
    secure ? "SameSite=None" : "SameSite=Lax",
  ].filter(Boolean);
  return attributes.join("; ");
}

export function clearRefreshCookie(): string {
  const secure = process.env.AUTH_COOKIE_SECURE !== "false";
  return [
    `${COOKIE_NAME}=`,
    "Path=/api/auth",
    "HttpOnly",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    secure ? "Secure" : "",
    secure ? "SameSite=None" : "SameSite=Lax",
  ].filter(Boolean).join("; ");
}

export function isTrustedSessionMutation(req: HttpRequest): boolean {
  return req.headers.get("x-requested-with") === "XMLHttpRequest";
}
