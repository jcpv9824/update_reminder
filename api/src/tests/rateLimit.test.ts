import type { HttpRequest } from "@azure/functions";
import { beforeEach, describe, expect, it } from "vitest";
import {
  consumeRateLimit,
  getRequestIp,
  hashRateLimitKey,
  peekRateLimit,
  resetRateLimit,
  tooManyRequests,
  type RateLimitPolicy,
  type RateLimitRecord,
  type RateLimitStore,
} from "../lib/rateLimit";

class MemoryRateLimitStore implements RateLimitStore {
  private readonly records = new Map<string, RateLimitRecord>();
  private etag = 0;

  async read(id: string): Promise<RateLimitRecord | null> {
    const value = this.records.get(id);
    return value ? { ...value } : null;
  }

  async create(record: RateLimitRecord): Promise<void> {
    if (this.records.has(record.id)) throw Object.assign(new Error("conflict"), { statusCode: 409 });
    this.records.set(record.id, { ...record, _etag: String(++this.etag) });
  }

  async replace(record: RateLimitRecord, etag?: string): Promise<void> {
    const current = this.records.get(record.id);
    if (!current || (etag && current._etag !== etag)) {
      throw Object.assign(new Error("precondition"), { statusCode: 412 });
    }
    this.records.set(record.id, { ...record, _etag: String(++this.etag) });
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }
}

const requestPolicy: RateLimitPolicy = {
  maxAttempts: 2,
  windowSeconds: 60,
  blockSeconds: 120,
};

const failurePolicy: RateLimitPolicy = {
  maxAttempts: 2,
  windowSeconds: 60,
  blockSeconds: 120,
  blockOnLimitReached: true,
};

describe("rate limiting distribuido", () => {
  beforeEach(() => {
    process.env.RATE_LIMIT_HASH_SECRET = "secreto-rate-limit-para-pruebas";
  });

  it("permite el límite configurado y responde 429 en el intento siguiente", async () => {
    const store = new MemoryRateLimitStore();
    const common = { scope: "email_test", keyType: "ip" as const, key: "203.0.113.10", policy: requestPolicy, store };

    expect((await consumeRateLimit({ ...common, nowMs: 0 })).allowed).toBe(true);
    expect((await consumeRateLimit({ ...common, nowMs: 1_000 })).allowed).toBe(true);
    const blocked = await consumeRateLimit({ ...common, nowMs: 2_000 });

    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(120);
    expect(tooManyRequests(blocked.retryAfterSeconds)).toEqual({
      status: 429,
      headers: { "Retry-After": "120" },
      jsonBody: { error: "Demasiados intentos. Intente nuevamente más tarde." },
    });
  });

  it("activa lockout en el mismo intento que alcanza el umbral de fallos", async () => {
    const store = new MemoryRateLimitStore();
    const common = { scope: "auth_login_failure", keyType: "identity" as const, key: "usuario@empresa.com", policy: failurePolicy, store };

    expect((await consumeRateLimit({ ...common, nowMs: 0 })).allowed).toBe(true);
    const locked = await consumeRateLimit({ ...common, nowMs: 1_000 });

    expect(locked.allowed).toBe(false);
    expect(await peekRateLimit({ scope: common.scope, keyType: common.keyType, key: common.key, nowMs: 2_000, store }))
      .toEqual({ blocked: true, retryAfterSeconds: 119 });
  });

  it("libera el bloqueo y abre una ventana nueva al vencer los tiempos", async () => {
    const store = new MemoryRateLimitStore();
    const common = { scope: "auth_login_failure", keyType: "identity" as const, key: "usuario@empresa.com", policy: failurePolicy, store };

    await consumeRateLimit({ ...common, nowMs: 0 });
    await consumeRateLimit({ ...common, nowMs: 1_000 });
    const allowedAgain = await consumeRateLimit({ ...common, nowMs: 122_000 });

    expect(allowedAgain.allowed).toBe(true);
    expect(allowedAgain.record.count).toBe(1);
    expect(allowedAgain.record.blockedUntil).toBeNull();
  });

  it("mantiene contadores independientes por IP e identidad", async () => {
    const store = new MemoryRateLimitStore();
    await consumeRateLimit({ scope: "auth_login_request", keyType: "ip", key: "203.0.113.10", policy: requestPolicy, nowMs: 0, store });
    await consumeRateLimit({ scope: "auth_login_request", keyType: "ip", key: "203.0.113.10", policy: requestPolicy, nowMs: 1_000, store });

    const anotherIp = await consumeRateLimit({ scope: "auth_login_request", keyType: "ip", key: "203.0.113.11", policy: requestPolicy, nowMs: 2_000, store });
    const identity = await consumeRateLimit({ scope: "auth_login_request", keyType: "identity", key: "usuario@empresa.com", policy: requestPolicy, nowMs: 2_000, store });

    expect(anotherIp.allowed).toBe(true);
    expect(identity.allowed).toBe(true);
  });

  it("reinicia explícitamente el lockout de una cuenta tras autenticación válida", async () => {
    const store = new MemoryRateLimitStore();
    const scope = "auth_login_failure";
    const key = "usuario@empresa.com";
    await consumeRateLimit({ scope, keyType: "identity", key, policy: failurePolicy, nowMs: 0, store });
    await resetRateLimit(scope, "identity", key, store);

    expect(await peekRateLimit({ scope, keyType: "identity", key, nowMs: 1_000, store }))
      .toEqual({ blocked: false, retryAfterSeconds: 0 });
  });

  it("seudonimiza claves sin incluir IP, correo ni token en el id", () => {
    const rawValues = ["203.0.113.10", "usuario@empresa.com", "token-secreto-de-reset"];
    for (const value of rawValues) {
      const id = hashRateLimitKey("auth_test", "identity", value);
      expect(id).toMatch(/^rate_auth_test_identity_[a-f0-9]{64}$/);
      expect(id).not.toContain(value.toLowerCase());
    }
  });

  it("usa el salto de proxy más cercano y no un X-Forwarded-For antepuesto", () => {
    const req = { headers: new Headers({ "x-forwarded-for": "198.51.100.1, 10.0.0.5" }) } as HttpRequest;
    expect(getRequestIp(req)).toBe("10.0.0.5");
  });
});
