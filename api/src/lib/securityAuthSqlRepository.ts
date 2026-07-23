import { timingSafeEqual } from "node:crypto";
import sql from "mssql";
import { getSqlPool } from "./sql";
import type { AtomicSessionRotation, AuthSessionStore } from "./authSessions";
import type { AuthSessionRecord, UserRecord } from "../types/models";

export type SqlCredentialUserRow = {
  source_id: string;
  display_name: string;
  email: string;
  active: boolean;
  password_hash: string | null;
  password_updated_at: Date | null;
  password_expires_at: Date | null;
  must_change_password: boolean;
  token_version: number;
  last_login_at: Date | null;
  password_reset_token_hash: string | null;
  password_reset_expires_at: Date | null;
  password_reset_used_at: Date | null;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
  roles_json: string | null;
};

export type SqlAuthSessionRow = {
  session_key: number;
  source_id: string;
  user_source_id: string;
  refresh_token_hash: Buffer;
  token_version: number;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: string | null;
  replaced_by_source_id: string | null;
  row_version: Buffer;
};

const iso = (value: Date | null): string | null => value ? value.toISOString() : null;

function parseRoles(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as Array<{ value?: unknown }>;
    return parsed.map((entry) => entry.value).filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

export function mapSqlCredentialUser(row: SqlCredentialUserRow): UserRecord {
  return {
    id: row.source_id,
    displayName: row.display_name,
    email: row.email,
    roles: parseRoles(row.roles_json),
    active: row.active,
    passwordHash: row.password_hash ?? undefined,
    passwordUpdatedAt: iso(row.password_updated_at),
    passwordExpiresAt: iso(row.password_expires_at),
    mustChangePassword: row.must_change_password,
    tokenVersion: row.token_version,
    lastLoginAt: iso(row.last_login_at),
    passwordResetTokenHash: row.password_reset_token_hash,
    passwordResetExpiresAt: iso(row.password_reset_expires_at),
    passwordResetUsedAt: iso(row.password_reset_used_at),
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
  };
}

export function mapSqlAuthSession(row: SqlAuthSessionRow): AuthSessionRecord {
  return {
    id: row.source_id,
    userId: row.user_source_id,
    refreshTokenHash: row.refresh_token_hash.toString("hex"),
    tokenVersion: row.token_version,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: (row.last_used_at ?? row.created_at).toISOString(),
    expiresAt: row.expires_at.toISOString(),
    revokedAt: iso(row.revoked_at),
    revokedReason: row.revoked_reason,
    replacedBySessionId: row.replaced_by_source_id,
    ttl: Math.max(0, Math.ceil((row.expires_at.getTime() - row.created_at.getTime()) / 1000)) + 86400,
    _etag: row.row_version.toString("base64"),
  };
}

const USER_PROJECTION = `
  users.source_id,users.display_name,users.email,users.active,users.password_hash,
  users.password_updated_at,users.password_expires_at,users.must_change_password,
  users.token_version,users.last_login_at,users.password_reset_token_hash,
  users.password_reset_expires_at,users.password_reset_used_at,
  users.created_at,users.created_by,users.updated_at,users.updated_by,
  COALESCE((SELECT user_role.role_id AS value FROM security.user_roles user_role
    WHERE user_role.user_key=users.user_key ORDER BY user_role.role_id FOR JSON PATH),N'[]') AS roles_json`;

const SESSION_PROJECTION = `
  sessions.session_key,sessions.source_id,users.source_id AS user_source_id,
  sessions.refresh_token_hash,sessions.token_version,sessions.created_at,sessions.last_used_at,
  sessions.expires_at,sessions.revoked_at,sessions.revoked_reason,
  replacement.source_id AS replaced_by_source_id,sessions.row_version`;

function tokenHashBuffer(value: string): Buffer {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("Hash de sesión no válido.");
  return Buffer.from(value, "hex");
}

function rowVersionBuffer(value: string | undefined): Buffer | null {
  if (!value) return null;
  const buffer = Buffer.from(value, "base64");
  if (buffer.length !== 8) throw new Error("Versión de sesión no válida.");
  return buffer;
}

function hashesMatch(left: Buffer, rightHex: string): boolean {
  const right = tokenHashBuffer(rightHex);
  return left.length === right.length && timingSafeEqual(left, right);
}

class SqlAuthSessionStore implements AuthSessionStore {
  constructor(private readonly transaction?: sql.Transaction) {}

  private async request(): Promise<sql.Request> {
    if (this.transaction) return new sql.Request(this.transaction);
    return (await getSqlPool()).request();
  }

  async loadUser(id: string): Promise<UserRecord | null> {
    const request = await this.request();
    request.input("sourceId", sql.NVarChar(150), id);
    const result = await request.query<SqlCredentialUserRow>(`
      SELECT ${USER_PROJECTION}
      FROM security.users users
      WHERE users.source_id=@sourceId;
    `);
    return result.recordset[0] ? mapSqlCredentialUser(result.recordset[0]) : null;
  }

  async read(id: string): Promise<AuthSessionRecord | null> {
    const request = await this.request();
    request.input("sourceId", sql.NVarChar(150), id);
    const result = await request.query<SqlAuthSessionRow>(`
      SELECT ${SESSION_PROJECTION}
      FROM security.auth_sessions sessions
      INNER JOIN security.users users ON users.user_key=sessions.user_key
      LEFT JOIN security.auth_sessions replacement ON replacement.session_key=sessions.replaced_by_session_key
      WHERE sessions.source_id=@sourceId;
    `);
    return result.recordset[0] ? mapSqlAuthSession(result.recordset[0]) : null;
  }

  async create(record: AuthSessionRecord): Promise<void> {
    const request = await this.request();
    request.input("sourceId", sql.NVarChar(150), record.id);
    request.input("userSourceId", sql.NVarChar(150), record.userId);
    request.input("tokenHash", sql.VarBinary(32), tokenHashBuffer(record.refreshTokenHash));
    request.input("tokenVersion", sql.Int, record.tokenVersion);
    request.input("createdAt", sql.DateTime2(3), new Date(record.createdAt));
    request.input("lastUsedAt", sql.DateTime2(3), new Date(record.lastUsedAt));
    request.input("expiresAt", sql.DateTime2(3), new Date(record.expiresAt));
    const result = await request.query(`
      INSERT security.auth_sessions
        (source_id,user_key,refresh_token_hash,token_version,created_at,last_used_at,expires_at)
      SELECT @sourceId,users.user_key,@tokenHash,@tokenVersion,@createdAt,@lastUsedAt,@expiresAt
      FROM security.users users WHERE users.source_id=@userSourceId;
      SELECT @@ROWCOUNT AS inserted_count;
    `);
    if (Number(result.recordset[0]?.inserted_count ?? 0) !== 1) {
      throw Object.assign(new Error("No se pudo vincular la sesión con el usuario SQL."), { status: 503 });
    }
  }

  async replace(record: AuthSessionRecord, etag?: string): Promise<void> {
    const request = await this.request();
    request.input("sourceId", sql.NVarChar(150), record.id);
    request.input("lastUsedAt", sql.DateTime2(3), new Date(record.lastUsedAt));
    request.input("revokedAt", sql.DateTime2(3), record.revokedAt ? new Date(record.revokedAt) : null);
    request.input("revokedReason", sql.NVarChar(300), record.revokedReason ?? null);
    request.input("replacementSourceId", sql.NVarChar(150), record.replacedBySessionId ?? null);
    request.input("rowVersion", sql.VarBinary(8), rowVersionBuffer(etag));
    const result = await request.query(`
      UPDATE sessions SET
        last_used_at=@lastUsedAt,
        revoked_at=@revokedAt,
        revoked_reason=@revokedReason,
        replaced_by_session_key=CASE WHEN @replacementSourceId IS NULL THEN NULL ELSE replacement.session_key END
      FROM security.auth_sessions sessions
      OUTER APPLY (SELECT session_key FROM security.auth_sessions WHERE source_id=@replacementSourceId) replacement
      WHERE sessions.source_id=@sourceId AND (@rowVersion IS NULL OR sessions.row_version=@rowVersion);
      SELECT @@ROWCOUNT AS updated_count;
    `);
    if (Number(result.recordset[0]?.updated_count ?? 0) !== 1) {
      throw Object.assign(new Error("La sesión cambió durante la operación."), { statusCode: 412 });
    }
  }

  async listByUser(userId: string): Promise<AuthSessionRecord[]> {
    const request = await this.request();
    request.input("userSourceId", sql.NVarChar(150), userId);
    const result = await request.query<SqlAuthSessionRow>(`
      SELECT ${SESSION_PROJECTION}
      FROM security.auth_sessions sessions
      INNER JOIN security.users users ON users.user_key=sessions.user_key
      LEFT JOIN security.auth_sessions replacement ON replacement.session_key=sessions.replaced_by_session_key
      WHERE users.source_id=@userSourceId
      ORDER BY sessions.session_key;
    `);
    return result.recordset.map(mapSqlAuthSession);
  }

  async rotateAtomic(args: AtomicSessionRotation): Promise<{ session: AuthSessionRecord; refreshToken: string; user: UserRecord } | null> {
    if (this.transaction) throw new Error("La rotación SQL no puede anidarse.");
    const pool = await getSqlPool();
    const transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const currentRequest = new sql.Request(transaction);
      currentRequest.input("sourceId", sql.NVarChar(150), args.sessionId);
      const currentResult = await currentRequest.query<SqlAuthSessionRow>(`
        SELECT ${SESSION_PROJECTION}
        FROM security.auth_sessions sessions WITH (UPDLOCK,HOLDLOCK)
        INNER JOIN security.users users ON users.user_key=sessions.user_key
        LEFT JOIN security.auth_sessions replacement ON replacement.session_key=sessions.replaced_by_session_key
        WHERE sessions.source_id=@sourceId;
      `);
      const row = currentResult.recordset[0];
      if (!row || !hashesMatch(row.refresh_token_hash, args.presentedTokenHash)) {
        await transaction.commit();
        return null;
      }

      const now = new Date(args.nowMs);
      if (row.revoked_at) {
        if (row.replaced_by_source_id) {
          const replayRequest = new sql.Request(transaction);
          replayRequest.input("replacementSourceId", sql.NVarChar(150), row.replaced_by_source_id);
          replayRequest.input("revokedAt", sql.DateTime2(3), now);
          await replayRequest.query(`
            UPDATE security.auth_sessions SET revoked_at=@revokedAt,revoked_reason=N'refresh_token_reuse_detected'
            WHERE source_id=@replacementSourceId AND revoked_at IS NULL;
          `);
        }
        await transaction.commit();
        return null;
      }

      const userRequest = new sql.Request(transaction);
      userRequest.input("userSourceId", sql.NVarChar(150), row.user_source_id);
      const userResult = await userRequest.query<SqlCredentialUserRow>(`
        SELECT ${USER_PROJECTION}
        FROM security.users users WITH (UPDLOCK,HOLDLOCK)
        WHERE users.source_id=@userSourceId;
      `);
      const userRow = userResult.recordset[0];
      if (!userRow) {
        await transaction.commit();
        return null;
      }
      const user = mapSqlCredentialUser(userRow);
      if (row.expires_at.getTime() <= args.nowMs || !user.active || (user.tokenVersion ?? 0) !== row.token_version) {
        await transaction.commit();
        return null;
      }

      const next = args.createNext(user);
      const insertRequest = new sql.Request(transaction);
      insertRequest.input("sourceId", sql.NVarChar(150), next.record.id);
      insertRequest.input("userSourceId", sql.NVarChar(150), user.id);
      insertRequest.input("tokenHash", sql.VarBinary(32), tokenHashBuffer(next.record.refreshTokenHash));
      insertRequest.input("tokenVersion", sql.Int, next.record.tokenVersion);
      insertRequest.input("createdAt", sql.DateTime2(3), new Date(next.record.createdAt));
      insertRequest.input("lastUsedAt", sql.DateTime2(3), new Date(next.record.lastUsedAt));
      insertRequest.input("expiresAt", sql.DateTime2(3), new Date(next.record.expiresAt));
      const inserted = await insertRequest.query<{ session_key: number; row_version: Buffer }>(`
        INSERT security.auth_sessions
          (source_id,user_key,refresh_token_hash,token_version,created_at,last_used_at,expires_at)
        OUTPUT INSERTED.session_key,INSERTED.row_version
        SELECT @sourceId,users.user_key,@tokenHash,@tokenVersion,@createdAt,@lastUsedAt,@expiresAt
        FROM security.users users WHERE users.source_id=@userSourceId;
      `);
      const insertedRow = inserted.recordset[0];
      if (!insertedRow) throw new Error("No se pudo crear la sesión rotada.");

      const revokeRequest = new sql.Request(transaction);
      revokeRequest.input("sessionKey", sql.BigInt, row.session_key);
      revokeRequest.input("replacementKey", sql.BigInt, insertedRow.session_key);
      revokeRequest.input("revokedAt", sql.DateTime2(3), now);
      const revoked = await revokeRequest.query(`
        UPDATE security.auth_sessions SET
          revoked_at=@revokedAt,revoked_reason=N'rotated',last_used_at=@revokedAt,
          replaced_by_session_key=@replacementKey
        WHERE session_key=@sessionKey AND revoked_at IS NULL;
        SELECT @@ROWCOUNT AS updated_count;
      `);
      if (Number(revoked.recordset[0]?.updated_count ?? 0) !== 1) throw new Error("La sesión cambió durante la rotación.");

      await transaction.commit();
      return {
        session: { ...next.record, _etag: insertedRow.row_version.toString("base64") },
        refreshToken: next.refreshToken,
        user,
      };
    } catch (error) {
      await transaction.rollback().catch(() => undefined);
      throw error;
    }
  }
}

export const sqlAuthSessionStore: AuthSessionStore = new SqlAuthSessionStore();
