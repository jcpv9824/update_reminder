import type { HttpRequest } from "@azure/functions";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearRefreshCookie,
  createAuthSession,
  getRefreshTokenFromRequest,
  isTrustedSessionMutation,
  refreshCookie,
  revokeAllUserSessions,
  revokeRefreshSession,
  rotateAuthSession,
  validateAccessSession,
  type AuthSessionStore,
} from "../lib/authSessions";
import type { AuthSessionRecord, UserRecord } from "../types/models";

class MemorySessionStore implements AuthSessionStore {
  readonly records = new Map<string, AuthSessionRecord>();
  private etag = 0;

  async read(id: string): Promise<AuthSessionRecord | null> {
    const value = this.records.get(id);
    return value ? { ...value } : null;
  }

  async create(record: AuthSessionRecord): Promise<void> {
    this.records.set(record.id, { ...record, _etag: String(++this.etag) });
  }

  async replace(record: AuthSessionRecord, etag?: string): Promise<void> {
    const current = this.records.get(record.id);
    if (!current || (etag && current._etag !== etag)) throw Object.assign(new Error("precondition"), { statusCode: 412 });
    this.records.set(record.id, { ...record, _etag: String(++this.etag) });
  }

  async listByUser(userId: string): Promise<AuthSessionRecord[]> {
    return [...this.records.values()].filter((record) => record.userId === userId).map((record) => ({ ...record }));
  }
}

function user(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: "user_1",
    displayName: "Usuario Uno",
    email: "usuario@empresa.com",
    roles: ["admin"],
    active: true,
    tokenVersion: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "system",
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "system",
    ...overrides,
  };
}

describe("sesiones refresh rotatorias", () => {
  beforeEach(() => {
    process.env.REFRESH_TOKEN_DAYS = "30";
    process.env.AUTH_COOKIE_SECURE = "true";
  });

  it("guarda solo el hash del refresh token", async () => {
    const store = new MemorySessionStore();
    const created = await createAuthSession(user(), { store, nowMs: 0 });
    const persisted = await store.read(created.session.id);

    expect(created.refreshToken).toMatch(new RegExp(`^${created.session.id}\\.`));
    expect(persisted?.refreshTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(persisted)).not.toContain(created.refreshToken);
  });

  it("rota el token, revoca la sesión anterior y conserva la versión", async () => {
    const store = new MemorySessionStore();
    const currentUser = user();
    const created = await createAuthSession(currentUser, { store, nowMs: 0 });
    const rotated = await rotateAuthSession(created.refreshToken, {
      store,
      nowMs: 1_000,
      loadUser: async () => currentUser,
    });

    expect(rotated).not.toBeNull();
    expect(rotated?.refreshToken).not.toBe(created.refreshToken);
    expect(rotated?.session.tokenVersion).toBe(2);
    expect((await store.read(created.session.id))?.revokedReason).toBe("rotated");
  });

  it("detecta reutilización del refresh anterior y revoca su descendiente", async () => {
    const store = new MemorySessionStore();
    const currentUser = user();
    const created = await createAuthSession(currentUser, { store, nowMs: 0 });
    const rotated = await rotateAuthSession(created.refreshToken, { store, nowMs: 1_000, loadUser: async () => currentUser });

    expect(await rotateAuthSession(created.refreshToken, { store, nowMs: 2_000, loadUser: async () => currentUser })).toBeNull();
    expect((await store.read(rotated!.session.id))?.revokedReason).toBe("refresh_token_reuse_detected");
  });

  it("refresca una sesión de rol sensible sin pedir un segundo factor", async () => {
    const store = new MemorySessionStore();
    const currentUser = user({ roles: ["client_manager"] });
    const created = await createAuthSession(currentUser, { store, nowMs: 0 });
    expect(await rotateAuthSession(created.refreshToken, { store, nowMs: 1_000, loadUser: async () => currentUser })).not.toBeNull();
  });

  it("rechaza access token si la sesión fue revocada o cambió tokenVersion", async () => {
    const store = new MemorySessionStore();
    const currentUser = user();
    const created = await createAuthSession(currentUser, { store, nowMs: 0 });
    const payload = {
      sub: currentUser.id,
      email: currentUser.email,
      roles: currentUser.roles,
      sid: created.session.id,
      ver: 2,
      amr: ["pwd"],
      jti: "jti",
      iss: "issuer",
      aud: "audience",
    };

    expect(await validateAccessSession(payload, { store, nowMs: 1_000, loadUser: async () => currentUser })).toMatchObject({ user: { id: currentUser.id } });
    expect(await validateAccessSession({ ...payload, ver: 1 }, { store, nowMs: 1_000, loadUser: async () => currentUser })).toBeNull();
    await revokeRefreshSession(created.refreshToken, "logout", { store, nowMs: 2_000 });
    expect(await validateAccessSession(payload, { store, nowMs: 3_000, loadUser: async () => currentUser })).toBeNull();
  });

  it("revoca todas las sesiones de un usuario tras cambio de contraseña o desactivación", async () => {
    const store = new MemorySessionStore();
    await createAuthSession(user(), { store, nowMs: 0 });
    await createAuthSession(user(), { store, nowMs: 1_000 });
    await createAuthSession(user({ id: "user_2" }), { store, nowMs: 2_000 });

    expect(await revokeAllUserSessions("user_1", "password_changed", { store, nowMs: 3_000 })).toBe(2);
    expect([...store.records.values()].filter((record) => record.userId === "user_1").every((record) => record.revokedAt)).toBe(true);
    expect([...store.records.values()].find((record) => record.userId === "user_2")?.revokedAt).toBeNull();
  });

  it("crea cookie HttpOnly, Secure y SameSite=None y permite limpiarla", () => {
    expect(refreshCookie("session.token")).toContain("HttpOnly");
    expect(refreshCookie("session.token")).toContain("Secure");
    expect(refreshCookie("session.token")).toContain("SameSite=None");
    expect(refreshCookie("session.token")).toContain("Path=/api/auth");
    expect(clearRefreshCookie()).toContain("Max-Age=0");
  });

  it("lee la cookie y exige encabezado anti-CSRF en refresh/logout", () => {
    const req = { headers: new Headers({ cookie: "otro=x; erp_refresh_token=session.token", "x-requested-with": "XMLHttpRequest" }) } as HttpRequest;
    expect(getRefreshTokenFromRequest(req)).toBe("session.token");
    expect(isTrustedSessionMutation(req)).toBe(true);
    expect(isTrustedSessionMutation({ headers: new Headers() } as HttpRequest)).toBe(false);
  });
});
