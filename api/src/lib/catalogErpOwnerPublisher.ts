import sql from "mssql";
import type { CatalogRefreshSink } from "./catalogCustomerRefresh";
import { validateAndSerializeCatalogPublication, type CatalogPublicationOperator } from "./catalogCustomerSnapshotPublishSqlRepository";

export type CatalogErpOwnerOperator = Extract<CatalogPublicationOperator, { kind: "worker" }>;
export const CATALOG_ERP_OWNER_PROCEDURES = Object.freeze({
  reserve: "settings.reserve_catalog_erp_owner_attempt",
  publish: "settings.publish_catalog_erp_owner",
  fail: "settings.fail_catalog_erp_owner_attempt",
} as const);

type Stamp = Parameters<CatalogRefreshSink["recordFailure"]>[0];
const invalid = (): never => { throw new Error("invalid_catalog_erp_owner_publication"); };
const failed = (): never => { throw new Error("catalog_erp_owner_publication_failed"); };
const guid = (value: unknown): boolean => typeof value === "string" && value.length === 36 &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value) && value !== "00000000-0000-0000-0000-000000000000";
const rowVersion = (value: unknown): boolean => typeof value === "string" && value.length === 16 && /^[a-f0-9]{16}$/i.test(value);
const ordinal = (value: unknown): value is string => typeof value === "string" &&
  /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;

function exactColumn(row: unknown, column: string): unknown {
  if (!row || typeof row !== "object" || Reflect.ownKeys(row).length !== 1) return failed();
  const field = Object.getOwnPropertyDescriptor(row, column);
  if (!field?.enumerable || !Object.hasOwn(field, "value")) return failed();
  return field.value;
}

/** Same trusted Portal SQL pool, but with only the 065 typed ERP worker RPCs.
 * Each procedure owns the transaction and emits its result after commit. */
export function createSqlCatalogErpOwnerPublisher(pool: Pick<sql.ConnectionPool, "request">,
  operator: CatalogErpOwnerOperator): CatalogRefreshSink {
  if (typeof pool?.request !== "function" || !operator || operator.kind !== "worker" ||
      (operator.environment !== "qa" && operator.environment !== "production") ||
      ![operator.sourceId, operator.jobId, operator.workerId, operator.leaseToken].every(guid) ||
      !Number.isInteger(operator.attempt) || operator.attempt < 1 || operator.attempt > 5 ||
      !rowVersion(operator.bindingRevision) || !rowVersion(operator.profileRevision) ||
      !Number.isInteger(operator.matchKeyVersion) || operator.matchKeyVersion < 1 || operator.matchKeyVersion > 32767 ||
      !Buffer.isBuffer(operator.vaultSecretVersion) || operator.vaultSecretVersion.length !== 16 ||
      !Buffer.isBuffer(operator.keyVerifier) || operator.keyVerifier.length !== 32) return invalid();
  const pins = { ...operator, vaultSecretVersion: Buffer.from(operator.vaultSecretVersion), keyVerifier: Buffer.from(operator.keyVerifier) };
  const binding = Buffer.from(pins.bindingRevision, "hex"), profile = Buffer.from(pins.profileRevision, "hex");

  function checkStamp(stamp: Stamp): void {
    if (stamp.environment !== pins.environment || stamp.sourceId !== pins.sourceId ||
        stamp.bindingRevision !== pins.bindingRevision || stamp.profileRevision !== pins.profileRevision ||
        stamp.matchKeyVersion !== pins.matchKeyVersion || !ordinal(stamp.attemptOrdinal) ||
        !(stamp.observedAt instanceof Date) || !Number.isFinite(stamp.observedAt.valueOf())) return invalid();
  }
  function bindStamp(request: sql.Request, stamp: Stamp): sql.Request {
    return request.input("attemptOrdinal", sql.BigInt, BigInt(stamp.attemptOrdinal))
      .input("observedAt", sql.DateTime2(3), stamp.observedAt);
  }
  async function rpc(operation: keyof typeof CATALOG_ERP_OWNER_PROCEDURES,
    bind: (request: sql.Request) => sql.Request, column: "attemptOrdinal" | "result"): Promise<unknown> {
    try {
      const request = pool.request().input("environment", sql.VarChar(32), pins.environment)
        .input("sourceId", sql.UniqueIdentifier, pins.sourceId).input("jobId", sql.UniqueIdentifier, pins.jobId)
        .input("workerId", sql.UniqueIdentifier, pins.workerId).input("leaseToken", sql.UniqueIdentifier, pins.leaseToken)
        .input("attempt", sql.Int, pins.attempt).input("bindingVersion", sql.VarBinary(32), Buffer.from(binding))
        .input("profileVersion", sql.VarBinary(32), Buffer.from(profile)).input("matchKeyVersion", sql.SmallInt, pins.matchKeyVersion)
        .input("vaultSecretVersion", sql.VarBinary(64), Buffer.from(pins.vaultSecretVersion))
        .input("keyVerifier", sql.VarBinary(64), Buffer.from(pins.keyVerifier));
      const result = await bind(request).execute<unknown>(CATALOG_ERP_OWNER_PROCEDURES[operation]);
      if (!Array.isArray(result.recordsets) || result.recordsets.length !== 1 ||
          !Array.isArray(result.recordsets[0]) || result.recordsets[0].length !== 1) return failed();
      return exactColumn(result.recordsets[0][0], column);
    } catch { return failed(); }
  }
  return {
    async reserveAttempt() {
      const value = await rpc("reserve", request => request, "attemptOrdinal");
      return ordinal(value) ? value : failed();
    },
    async publish(revision) {
      checkStamp(revision);
      if (revision.role !== "erp-customers" || revision.includesSagInventory === true || revision.completeScopes.length !== 0) return invalid();
      const payload = validateAndSerializeCatalogPublication(revision);
      const value = await rpc("publish", request => bindStamp(request, revision)
        .input("rowCount", sql.Int, revision.rows.length).input("rows", sql.NVarChar(sql.MAX), payload.rows), "result");
      return value === "published" || value === "superseded" ? value : failed();
    },
    async recordFailure(attempt) {
      checkStamp(attempt);
      const value = await rpc("fail", request => bindStamp(request, attempt), "result");
      if (value !== "failed" && value !== "superseded") return failed();
      // As in the legacy worker, the caller performs the normal queue retry transition.
    },
  };
}
