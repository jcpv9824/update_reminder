import sql from "mssql";
import { getSqlPool } from "./sql";
import type { RateLimitDecision, RateLimitRecord, RateLimitStore } from "./rateLimit";

export type SqlRateLimitRow = {
  source_id: string;
  scope: string;
  key_type: "ip" | "identity";
  attempt_count: number;
  window_started_at: Date;
  blocked_until: Date | null;
  expires_at: Date;
  updated_at: Date;
  row_version: Buffer;
};

export function mapSqlRateLimitRecord(row: SqlRateLimitRow): RateLimitRecord {
  return {
    id: row.source_id,
    scope: row.scope,
    keyType: row.key_type,
    count: row.attempt_count,
    windowStartedAt: row.window_started_at.toISOString(),
    blockedUntil: row.blocked_until?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
    ttl: Math.max(0, Math.ceil((row.expires_at.getTime() - row.updated_at.getTime()) / 1000)),
    _etag: row.row_version.toString("base64"),
  };
}

export function extractRateLimitDigest(sourceId: string): Buffer {
  const match = sourceId.match(/([a-f0-9]{64})$/i);
  if (!match || sourceId.length > 150) throw new Error("Identificador de rate limit no válido.");
  return Buffer.from(match[1], "hex");
}

const PROJECTION = `source_id,scope,key_type,attempt_count,window_started_at,blocked_until,expires_at,updated_at,row_version`;
const expiresAt = (record: RateLimitRecord): Date => new Date(Date.parse(record.updatedAt) + record.ttl * 1000);

class SqlRateLimitStore implements RateLimitStore {
  async read(id: string): Promise<RateLimitRecord | null> {
    const pool = await getSqlPool();
    const request = pool.request();
    request.input("sourceId", sql.NVarChar(150), id);
    const result = await request.query<SqlRateLimitRow>(`
      SELECT ${PROJECTION} FROM security.rate_limits WHERE source_id=@sourceId;
    `);
    return result.recordset[0] ? mapSqlRateLimitRecord(result.recordset[0]) : null;
  }

  async create(record: RateLimitRecord): Promise<void> {
    const pool = await getSqlPool();
    const request = pool.request();
    this.bindRecord(request, record);
    await request.query(`
      INSERT security.rate_limits
        (source_id,scope,key_type,key_hash,attempt_count,window_started_at,blocked_until,expires_at,updated_at)
      VALUES (@sourceId,@scope,@keyType,@keyHash,@count,@windowStartedAt,@blockedUntil,@expiresAt,@updatedAt);
    `);
  }

  async replace(record: RateLimitRecord, etag?: string): Promise<void> {
    const pool = await getSqlPool();
    const request = pool.request();
    this.bindRecord(request, record);
    request.input("rowVersion", sql.VarBinary(8), etag ? Buffer.from(etag, "base64") : null);
    const result = await request.query(`
      UPDATE security.rate_limits SET attempt_count=@count,window_started_at=@windowStartedAt,
        blocked_until=@blockedUntil,expires_at=@expiresAt,updated_at=@updatedAt
      WHERE source_id=@sourceId AND (@rowVersion IS NULL OR row_version=@rowVersion);
      SELECT @@ROWCOUNT AS updated_count;
    `);
    if (Number(result.recordset[0]?.updated_count ?? 0) !== 1) {
      throw Object.assign(new Error("El límite cambió durante la operación."), { statusCode: 412 });
    }
  }

  async delete(id: string): Promise<void> {
    const pool = await getSqlPool();
    const request = pool.request();
    request.input("sourceId", sql.NVarChar(150), id);
    await request.query(`DELETE security.rate_limits WHERE source_id=@sourceId;`);
  }

  async consumeAtomic(args: {
    id: string;
    scope: string;
    keyType: "ip" | "identity";
    evaluate: (existing: RateLimitRecord | null) => RateLimitDecision;
  }): Promise<RateLimitDecision> {
    const keyHash = extractRateLimitDigest(args.id);
    const pool = await getSqlPool();
    const transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const read = new sql.Request(transaction);
      read.input("scope", sql.NVarChar(80), args.scope);
      read.input("keyType", sql.NVarChar(80), args.keyType);
      read.input("keyHash", sql.VarBinary(32), keyHash);
      const existingResult = await read.query<SqlRateLimitRow>(`
        SELECT ${PROJECTION} FROM security.rate_limits WITH (UPDLOCK,HOLDLOCK)
        WHERE scope=@scope AND key_type=@keyType AND key_hash=@keyHash;
      `);
      const existing = existingResult.recordset[0] ? mapSqlRateLimitRecord(existingResult.recordset[0]) : null;
      const decision = args.evaluate(existing);
      if (!decision.allowed && decision.record === existing) {
        await transaction.commit();
        return decision;
      }

      const write = new sql.Request(transaction);
      this.bindRecord(write, decision.record);
      if (existing) {
        await write.query(`
          UPDATE security.rate_limits SET attempt_count=@count,window_started_at=@windowStartedAt,
            blocked_until=@blockedUntil,expires_at=@expiresAt,updated_at=@updatedAt
          WHERE source_id=@sourceId;
        `);
      } else {
        await write.query(`
          INSERT security.rate_limits
            (source_id,scope,key_type,key_hash,attempt_count,window_started_at,blocked_until,expires_at,updated_at)
          VALUES (@sourceId,@scope,@keyType,@keyHash,@count,@windowStartedAt,@blockedUntil,@expiresAt,@updatedAt);
        `);
      }
      await transaction.commit();
      return decision;
    } catch (error) {
      await transaction.rollback().catch(() => undefined);
      throw error;
    }
  }

  private bindRecord(request: sql.Request, record: RateLimitRecord): void {
    request.input("sourceId", sql.NVarChar(150), record.id);
    request.input("scope", sql.NVarChar(80), record.scope);
    request.input("keyType", sql.NVarChar(80), record.keyType);
    request.input("keyHash", sql.VarBinary(32), extractRateLimitDigest(record.id));
    request.input("count", sql.Int, record.count);
    request.input("windowStartedAt", sql.DateTime2(3), new Date(record.windowStartedAt));
    request.input("blockedUntil", sql.DateTime2(3), record.blockedUntil ? new Date(record.blockedUntil) : null);
    request.input("expiresAt", sql.DateTime2(3), expiresAt(record));
    request.input("updatedAt", sql.DateTime2(3), new Date(record.updatedAt));
  }
}

export const sqlRateLimitStore: RateLimitStore = new SqlRateLimitStore();
