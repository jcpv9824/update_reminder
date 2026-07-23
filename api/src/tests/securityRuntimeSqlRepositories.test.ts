import { describe, expect, it } from "vitest";
import { mapSqlAuthSession, mapSqlCredentialUser } from "../lib/securityAuthSqlRepository";
import { extractRateLimitDigest, mapSqlRateLimitRecord } from "../lib/securityRateLimitSqlRepository";

const at = new Date("2026-07-21T12:00:00.000Z");

describe("SQL security runtime mappings", () => {
  it("keeps credential material internal while reconstructing the authenticated user", () => {
    const user = mapSqlCredentialUser({
      source_id: "user-1", display_name: "Usuario", email: "user@example.test", active: true,
      password_hash: "bcrypt-hash-only", password_updated_at: at, password_expires_at: null,
      must_change_password: false, token_version: 4, last_login_at: at,
      password_reset_token_hash: null, password_reset_expires_at: null, password_reset_used_at: null,
      created_at: at, created_by: "migration", updated_at: at, updated_by: "migration",
      roles_json: '[{"value":"super_admin"}]',
    });
    expect(user).toMatchObject({ id: "user-1", tokenVersion: 4, roles: ["super_admin"] });
    expect(user.passwordHash).toBe("bcrypt-hash-only");
  });

  it("maps binary session hashes and row versions without raw refresh tokens", () => {
    const session = mapSqlAuthSession({
      session_key: 1, source_id: "session-1", user_source_id: "user-1",
      refresh_token_hash: Buffer.alloc(32, 7), token_version: 4, created_at: at,
      last_used_at: at, expires_at: new Date(at.getTime() + 86_400_000), revoked_at: null,
      revoked_reason: null, replaced_by_source_id: null, row_version: Buffer.alloc(8, 1),
    });
    expect(session.refreshTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(session)).not.toContain("session-1.");
    expect(session._etag).toBe(Buffer.alloc(8, 1).toString("base64"));
  });

  it("maps pseudonymous rate-limit state and validates its binary digest", () => {
    const digest = "ab".repeat(32);
    const id = `rate_auth_login_identity_${digest}`;
    expect(extractRateLimitDigest(id)).toEqual(Buffer.from(digest, "hex"));
    const record = mapSqlRateLimitRecord({
      source_id: id, scope: "auth_login", key_type: "identity", attempt_count: 2,
      window_started_at: at, blocked_until: null, expires_at: new Date(at.getTime() + 60_000),
      updated_at: at, row_version: Buffer.alloc(8, 2),
    });
    expect(record).toMatchObject({ id, keyType: "identity", count: 2, ttl: 60 });
    expect(() => extractRateLimitDigest(`rate_${"x".repeat(151)}`)).toThrow(/no válido/);
  });
});
