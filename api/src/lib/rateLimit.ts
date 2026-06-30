import { createHmac } from "node:crypto";
import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { getContainer } from "./cosmos";
import { writeAuditLog } from "./audit";

export type RateLimitPolicy = {
  maxAttempts: number;
  windowSeconds: number;
  blockSeconds: number;
  blockOnLimitReached?: boolean;
};

export type RateLimitRecord = {
  id: string;
  scope: string;
  keyType: "ip" | "identity";
  count: number;
  windowStartedAt: string;
  blockedUntil?: string | null;
  updatedAt: string;
  ttl: number;
  _etag?: string;
};

export type RateLimitDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
  record: RateLimitRecord;
};

export interface RateLimitStore {
  read(id: string): Promise<RateLimitRecord | null>;
  create(record: RateLimitRecord): Promise<void>;
  replace(record: RateLimitRecord, etag?: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export const RATE_LIMIT_POLICIES = {
  loginRequest: { maxAttempts: 10, windowSeconds: 300, blockSeconds: 900 },
  loginFailure: { maxAttempts: 5, windowSeconds: 900, blockSeconds: 900, blockOnLimitReached: true },
  refreshSession: { maxAttempts: 30, windowSeconds: 300, blockSeconds: 900 },
  forgotPassword: { maxAttempts: 5, windowSeconds: 3600, blockSeconds: 3600 },
  resetPassword: { maxAttempts: 10, windowSeconds: 3600, blockSeconds: 3600 },
  setup: { maxAttempts: 5, windowSeconds: 3600, blockSeconds: 3600 },
  testEmail: { maxAttempts: 10, windowSeconds: 600, blockSeconds: 1800 },
  mastersReport: { maxAttempts: 5, windowSeconds: 3600, blockSeconds: 3600 },
  userEmail: { maxAttempts: 10, windowSeconds: 3600, blockSeconds: 3600 },
} satisfies Record<string, RateLimitPolicy>;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function retryAfter(blockedUntil: string | null | undefined, nowMs: number): number {
  if (!blockedUntil) return 0;
  return Math.max(1, Math.ceil((Date.parse(blockedUntil) - nowMs) / 1000));
}

export function hashRateLimitKey(scope: string, keyType: "ip" | "identity", rawKey: string): string {
  const normalized = rawKey.trim().toLowerCase() || "unknown";
  const secret = process.env.RATE_LIMIT_HASH_SECRET || process.env.JWT_SECRET || "local-rate-limit-key";
  const digest = createHmac("sha256", secret).update(`${scope}\0${keyType}\0${normalized}`).digest("hex");
  return `rate_${scope}_${keyType}_${digest}`;
}

export function getRequestIp(req: HttpRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    // Los proxies agregan saltos a la derecha. Usar el último evita confiar en
    // valores antepuestos por el cliente a X-Forwarded-For.
    const parts = forwarded.split(",").map((part) => part.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return req.headers.get("x-client-ip")?.trim() || "unknown";
}

export function evaluateRateLimit(
  existing: RateLimitRecord | null,
  args: {
    id: string;
    scope: string;
    keyType: "ip" | "identity";
    policy: RateLimitPolicy;
    nowMs: number;
  }
): RateLimitDecision {
  const { id, scope, keyType, policy, nowMs } = args;
  if (existing?.blockedUntil && Date.parse(existing.blockedUntil) > nowMs) {
    return { allowed: false, retryAfterSeconds: retryAfter(existing.blockedUntil, nowMs), record: existing };
  }

  const existingWindow = existing ? Date.parse(existing.windowStartedAt) : Number.NaN;
  const windowExpired = !Number.isFinite(existingWindow)
    || nowMs - existingWindow >= policy.windowSeconds * 1000;
  const count = (windowExpired ? 0 : existing?.count ?? 0) + 1;
  const shouldBlock = policy.blockOnLimitReached
    ? count >= policy.maxAttempts
    : count > policy.maxAttempts;
  const blockedUntil = shouldBlock ? iso(nowMs + policy.blockSeconds * 1000) : null;
  const record: RateLimitRecord = {
    id,
    scope,
    keyType,
    count,
    windowStartedAt: windowExpired ? iso(nowMs) : existing!.windowStartedAt,
    blockedUntil,
    updatedAt: iso(nowMs),
    ttl: policy.windowSeconds + policy.blockSeconds + 86400,
    _etag: existing?._etag,
  };
  return {
    allowed: !shouldBlock,
    retryAfterSeconds: shouldBlock ? policy.blockSeconds : 0,
    record,
  };
}

class CosmosRateLimitStore implements RateLimitStore {
  async read(id: string): Promise<RateLimitRecord | null> {
    try {
      const { resource } = await getContainer("securityRateLimits").item(id, id).read<RateLimitRecord>();
      return resource ?? null;
    } catch (error: any) {
      if (error?.code === 404 || error?.statusCode === 404) return null;
      throw error;
    }
  }

  async create(record: RateLimitRecord): Promise<void> {
    const { _etag: _ignored, ...body } = record;
    await getContainer("securityRateLimits").items.create(body);
  }

  async replace(record: RateLimitRecord, etag?: string): Promise<void> {
    const { _etag: _ignored, ...body } = record;
    await getContainer("securityRateLimits").item(record.id, record.id).replace(body, etag ? {
      accessCondition: { type: "IfMatch", condition: etag },
    } : undefined);
  }

  async delete(id: string): Promise<void> {
    try {
      await getContainer("securityRateLimits").item(id, id).delete();
    } catch (error: any) {
      if (error?.code !== 404 && error?.statusCode !== 404) throw error;
    }
  }
}

const cosmosStore = new CosmosRateLimitStore();

function isConflict(error: any): boolean {
  return error?.code === 409 || error?.statusCode === 409 || error?.code === 412 || error?.statusCode === 412;
}

export async function consumeRateLimit(args: {
  scope: string;
  keyType: "ip" | "identity";
  key: string;
  policy: RateLimitPolicy;
  nowMs?: number;
  store?: RateLimitStore;
}): Promise<RateLimitDecision> {
  const store = args.store ?? cosmosStore;
  const id = hashRateLimitKey(args.scope, args.keyType, args.key);
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await store.read(id);
    const decision = evaluateRateLimit(existing, {
      id,
      scope: args.scope,
      keyType: args.keyType,
      policy: args.policy,
      nowMs: args.nowMs ?? Date.now(),
    });
    if (!decision.allowed && decision.record === existing) return decision;
    try {
      if (existing) await store.replace(decision.record, existing._etag);
      else await store.create(decision.record);
      return decision;
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }
  throw Object.assign(new Error("No se pudo validar el límite de solicitudes."), { status: 503 });
}

export async function peekRateLimit(args: {
  scope: string;
  keyType: "ip" | "identity";
  key: string;
  nowMs?: number;
  store?: RateLimitStore;
}): Promise<{ blocked: boolean; retryAfterSeconds: number }> {
  const id = hashRateLimitKey(args.scope, args.keyType, args.key);
  const record = await (args.store ?? cosmosStore).read(id);
  const nowMs = args.nowMs ?? Date.now();
  const retry = retryAfter(record?.blockedUntil, nowMs);
  return { blocked: retry > 0, retryAfterSeconds: retry };
}

export async function resetRateLimit(scope: string, keyType: "ip" | "identity", key: string, store?: RateLimitStore): Promise<void> {
  await (store ?? cosmosStore).delete(hashRateLimitKey(scope, keyType, key));
}

export function tooManyRequests(retryAfterSeconds: number): HttpResponseInit {
  return {
    status: 429,
    headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) },
    jsonBody: { error: "Demasiados intentos. Intente nuevamente más tarde." },
  };
}

async function auditBlocked(scope: string, keyType: "ip" | "identity", recordId: string, retry: number): Promise<void> {
  console.warn(JSON.stringify({ event: "rate_limit_exceeded", scope, keyType, recordId, retryAfterSeconds: retry }));
  await writeAuditLog({
    entityType: "security",
    entityId: recordId,
    action: scope.includes("login_failure") ? "account_lockout_triggered" : "rate_limit_exceeded",
    performedBy: "system",
    performedByEmail: "system",
    metadata: { scope, keyType, retryAfterSeconds: retry },
  }).catch(() => undefined);
}

export async function enforceRequestRateLimit(
  req: HttpRequest,
  scope: string,
  identity: string | undefined,
  policy: RateLimitPolicy
): Promise<HttpResponseInit | null> {
  const keys: Array<{ keyType: "ip" | "identity"; key: string }> = [
    { keyType: "ip", key: getRequestIp(req) },
  ];
  if (identity?.trim()) keys.push({ keyType: "identity", key: identity });
  for (const item of keys) {
    const decision = await consumeRateLimit({ scope, ...item, policy });
    if (!decision.allowed) {
      await auditBlocked(scope, item.keyType, decision.record.id, decision.retryAfterSeconds);
      return tooManyRequests(decision.retryAfterSeconds);
    }
  }
  return null;
}

export async function checkLoginLockout(req: HttpRequest, email: string): Promise<HttpResponseInit | null> {
  const keys: Array<{ keyType: "ip" | "identity"; key: string }> = [
    { keyType: "ip", key: getRequestIp(req) },
    { keyType: "identity", key: email },
  ];
  for (const item of keys) {
    const state = await peekRateLimit({ scope: "auth_login_failure", ...item });
    if (state.blocked) return tooManyRequests(state.retryAfterSeconds);
  }
  return null;
}

export async function recordLoginFailure(req: HttpRequest, email: string): Promise<HttpResponseInit | null> {
  const keys: Array<{ keyType: "ip" | "identity"; key: string }> = [
    { keyType: "ip", key: getRequestIp(req) },
    { keyType: "identity", key: email },
  ];
  for (const item of keys) {
    const decision = await consumeRateLimit({
      scope: "auth_login_failure",
      ...item,
      policy: RATE_LIMIT_POLICIES.loginFailure,
    });
    if (!decision.allowed) {
      await auditBlocked("auth_login_failure", item.keyType, decision.record.id, decision.retryAfterSeconds);
      return tooManyRequests(decision.retryAfterSeconds);
    }
  }
  return null;
}

export async function clearLoginAccountFailures(email: string): Promise<void> {
  await resetRateLimit("auth_login_failure", "identity", email);
}
