import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import sql from "mssql";
import { fingerprintCatalogSqlTarget } from "./catalogPhysicalTargetIdentity";

const procedure = "settings.enroll_catalog_sql_target_instance_internal";
const maxProofLifetimeMs = 300_000;
const topLevel = ["environment", "actorId", "physicalLinkId", "physicalTargetId", "operationalProfileVersion",
  "reportConnectionId", "reportProfileVersion", "reportRoute", "trustedInstanceId", "expectedIdentityFingerprint", "proof"] as const;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const fqdn = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?![\s\S])/i;

export class CatalogSqlTargetInstanceEnrollmentRollbackRequired extends Error {
  constructor() {
    super("catalog_sql_target_instance_enrollment_rollback_required");
  }
}

function fail(): never {
  throw new CatalogSqlTargetInstanceEnrollmentRollbackRequired();
}

function ownData<const Key extends string>(value: unknown, keys: readonly Key[]): Record<Key, unknown> {
  if (!value || typeof value !== "object" || Reflect.ownKeys(value).length !== keys.length) return fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail();
  const data = Object.create(null) as Record<Key, unknown>;
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) return fail();
    data[key] = field.value;
  }
  return data;
}

function uuidPin(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && uuid.test(value) &&
    value !== "00000000-0000-0000-0000-000000000000";
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && value.trim().length > 0 && !/\p{C}/u.test(value);
}

function opaqueId(value: unknown): value is string {
  return text(value, 150) && value === value.trim();
}

function rowVersion(value: unknown): value is Buffer {
  return Buffer.isBuffer(value) && value.length === 8 && value.some(byte => byte !== 0);
}

function milliseconds(value: unknown): number {
  if (!(value instanceof Date)) return fail();
  const ms = Date.prototype.getTime.call(value) as number;
  const year = Date.prototype.getUTCFullYear.call(value) as number;
  if (!Number.isFinite(ms) || year < 1 || year > 9999) return fail();
  return ms;
}

/** Byte-exact match for SQL 058; this never parses or opens a connection. */
function reportRouteFingerprint(value: unknown): Buffer {
  const { serverHost, serverPort, databaseName } = ownData(value, ["serverHost", "serverPort", "databaseName"]);
  if (typeof serverHost !== "string" || serverHost.length > 253 || !fqdn.test(serverHost) || isIP(serverHost) ||
    typeof serverPort !== "number" || !Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535 ||
    !text(databaseName, 128)) return fail();
  const host = Buffer.from(serverHost, "utf16le");
  const database = Buffer.from(databaseName, "utf16le");
  const frame = Buffer.alloc(12);
  try {
    frame.writeUInt32BE(host.length, 0);
    frame.writeUInt32BE(serverPort, 4);
    frame.writeUInt32BE(database.length, 8);
    return createHash("sha256").update("portal-sag:report-enrollment-route:v1|", "utf16le")
      .update(frame.subarray(0, 4)).update(host).update(frame.subarray(4, 12)).update(database).digest();
  } finally {
    frame.fill(0);
    host.fill(0);
    database.fill(0);
  }
}

/**
 * Internal only. Input is the exact server-selected, version-pinned operator
 * scope and saved reporting route which the guarded read-only probe used.
 * The independently stored 036 fingerprint/namespace must not come from the
 * probe or a browser. The caller supplies its authorized SERIALIZABLE SQL
 * transaction, must rollback on any throw and must fence SQL time at commit.
 */
export async function enrollCatalogSqlTargetInstanceInTransaction(operatorTransaction: sql.Transaction, input: unknown):
  Promise<"enrolled" | "already-enrolled"> {
  let identity: Buffer | undefined;
  let route: Buffer | undefined;
  let operationalVersion: Buffer | undefined;
  let reportVersion: Buffer | undefined;
  try {
    const { environment, actorId, physicalLinkId, physicalTargetId, operationalProfileVersion, reportConnectionId,
      reportProfileVersion, reportRoute, trustedInstanceId, expectedIdentityFingerprint, proof } = ownData(input, topLevel);
    const { proofId, databaseGuid, verifiedAt, validUntil } = ownData(proof, ["proofId", "databaseGuid", "verifiedAt", "validUntil"]);
    if ((environment !== "qa" && environment !== "production") || !opaqueId(actorId) || !opaqueId(reportConnectionId) ||
      !uuidPin(physicalLinkId) || !uuidPin(physicalTargetId) || !uuidPin(trustedInstanceId) || !uuidPin(databaseGuid) ||
      databaseGuid !== databaseGuid.toLowerCase() ||
      !uuidPin(proofId) || !rowVersion(operationalProfileVersion) || !rowVersion(reportProfileVersion) ||
      !Buffer.isBuffer(expectedIdentityFingerprint) || expectedIdentityFingerprint.length !== 32) return fail();
    const checkedAtMs = milliseconds(verifiedAt);
    const expiresAtMs = milliseconds(validUntil);
    const now = Date.now();
    if (checkedAtMs > now || now - checkedAtMs >= maxProofLifetimeMs || expiresAtMs <= now ||
      expiresAtMs - checkedAtMs > maxProofLifetimeMs) return fail();
    identity = fingerprintCatalogSqlTarget({ instanceId: trustedInstanceId, databaseGuid });
    if (!timingSafeEqual(identity, expectedIdentityFingerprint)) return fail();
    route = reportRouteFingerprint(reportRoute);
    operationalVersion = Buffer.from(operationalProfileVersion);
    reportVersion = Buffer.from(reportProfileVersion);
    const request = operatorTransaction.request();
    request.input("environment", sql.VarChar(32), environment);
    request.input("actorId", sql.NVarChar(150), actorId);
    request.input("physicalLinkId", sql.UniqueIdentifier, physicalLinkId);
    request.input("physicalTargetId", sql.UniqueIdentifier, physicalTargetId);
    request.input("operationalProfileVersion", sql.VarBinary(32), operationalVersion);
    request.input("reportConnectionId", sql.NVarChar(150), reportConnectionId);
    request.input("reportProfileVersion", sql.VarBinary(32), reportVersion);
    request.input("reportRouteFingerprint", sql.VarBinary(64), route);
    request.input("trustedInstanceId", sql.UniqueIdentifier, trustedInstanceId);
    request.input("verifiedDatabaseGuid", sql.UniqueIdentifier, databaseGuid);
    request.input("identityFingerprint", sql.VarBinary(64), identity);
    request.input("proofId", sql.UniqueIdentifier, proofId);
    request.input("verifiedAt", sql.DateTime2(3), new Date(checkedAtMs));
    request.input("validUntil", sql.DateTime2(3), new Date(expiresAtMs));
    request.output("result", sql.VarChar(32));
    const rpc = ownData(await request.execute(procedure), ["recordsets", "recordset", "rowsAffected", "returnValue", "output"]);
    if (rpc.recordset !== undefined || !Array.isArray(rpc.recordsets) || rpc.recordsets.length !== 0 ||
      !Array.isArray(rpc.rowsAffected) || rpc.rowsAffected.length !== 0 || rpc.returnValue !== 0) return fail();
    const { result } = ownData(rpc.output, ["result"]);
    if ((result !== "enrolled" && result !== "already-enrolled") || Date.now() >= expiresAtMs) return fail();
    return result;
  } catch {
    return fail();
  } finally {
    identity?.fill(0);
    route?.fill(0);
    operationalVersion?.fill(0);
    reportVersion?.fill(0);
  }
}
