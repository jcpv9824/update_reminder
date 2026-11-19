import sql from "mssql";
import { verifyCatalogSagTargetLinkProof } from "./catalogSagTargetLinkProof";

const procedures = {
  read: "settings.read_catalog_sag_target_link_candidates",
  verify: "settings.verify_catalog_sag_target_link",
} as const;
const callerPins = ["environment", "purpose", "operationalLinkId", "physicalLinkId",
  "physicalTargetId", "matchKeyVersion", "reportInstanceId"] as const;
const candidatePins = ["server_host_port", "initial_catalog", "accessProfileVersion", "sagSourceId",
  "sagRevisionKey", "sagCompanyRecordId"] as const;
const maxCandidates = 8;
const invalid = (): never => { throw new Error("invalid_sag_target_runtime_proof"); };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const uuidPin = (value: unknown): value is string => typeof value === "string" && value.length === 36 &&
  uuid.test(value) && value !== "00000000-0000-0000-0000-000000000000";
const integer = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;

function ownData<const Key extends string>(value: unknown, keys: readonly Key[]): Record<Key, unknown> {
  if (!value || typeof value !== "object" || Reflect.ownKeys(value).length !== keys.length) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const result = Object.create(null) as Record<Key, unknown>;
  for (const key of keys) {
    const item = Object.getOwnPropertyDescriptor(value, key);
    if (!item?.enumerable || !Object.hasOwn(item, "value")) return invalid();
    result[key] = item.value;
  }
  return result;
}

function readRpc(value: unknown) {
  const decoded = ownData(value, ["recordsets", "recordset", "returnValue", "rowsAffected", "output"]);
  if (decoded.returnValue !== 0 || !Array.isArray(decoded.recordsets) ||
    !Array.isArray(decoded.rowsAffected) || decoded.rowsAffected.length !== 0) return invalid();
  return { ...decoded, recordsets: decoded.recordsets as unknown[] };
}

function decodeCandidate(value: unknown) {
  const row = ownData(value, candidatePins);
  const { server_host_port, initial_catalog, accessProfileVersion, sagSourceId, sagCompanyRecordId } = row;
  // Tedious returns BIGINT columns as strings. A lossless bigint from an
  // alternate driver representation is safe; even small JS numbers are not.
  const sagRevisionKey = typeof row.sagRevisionKey === "bigint" ? row.sagRevisionKey.toString() : row.sagRevisionKey;
  if (typeof server_host_port !== "string" || server_host_port.length < 1 || server_host_port.length > 500 ||
    typeof initial_catalog !== "string" || initial_catalog.length < 1 || initial_catalog.length > 256 ||
    !Buffer.isBuffer(accessProfileVersion) || accessProfileVersion.length !== 8 || !uuidPin(sagSourceId) ||
    typeof sagRevisionKey !== "string" || !/^[1-9][0-9]{0,18}(?![\s\S])/.test(sagRevisionKey) ||
    BigInt(sagRevisionKey) > 9223372036854775807n || !integer(sagCompanyRecordId, -2147483648, 2147483647)) return invalid();
  return { profile: { server_host_port, initial_catalog }, accessProfileVersion: accessProfileVersion.toString("hex"),
    sagSourceId: sagSourceId.toLowerCase(), sagRevisionKey, sagCompanyRecordId };
}

function candidateRows(raw: unknown) {
  const { recordsets, recordset, output } = readRpc(raw);
  ownData(output, []);
  if (recordsets.length !== 1 || recordsets[0] !== recordset ||
    !Array.isArray(recordset) || recordset.length > maxCandidates) return invalid();
  const candidates: ReturnType<typeof decodeCandidate>[] = [];
  for (let index = 0; index < recordset.length; index++) {
    const item = Object.getOwnPropertyDescriptor(recordset, index);
    if (!item?.enumerable || !Object.hasOwn(item, "value")) return invalid();
    const row = decodeCandidate(item.value);
    const previous = candidates.at(-1);
    // SQL scopes all candidates to one current active SAG source and one
    // locked profile. Ascending Company IDs reject duplicate/ambiguous rows.
    if (previous && (previous.sagCompanyRecordId >= row.sagCompanyRecordId ||
      previous.accessProfileVersion !== row.accessProfileVersion || previous.sagSourceId !== row.sagSourceId ||
      previous.sagRevisionKey !== row.sagRevisionKey ||
      previous.profile.server_host_port !== row.profile.server_host_port ||
      previous.profile.initial_catalog !== row.profile.initial_catalog)) return invalid();
    candidates.push(row);
  }
  return candidates;
}

/**
 * Internal SQL bridge for an already authorized caller. It does not create,
 * commit or roll back a transaction. Both procedures require caller-owned
 * SERIALIZABLE; the caller must consume/fence this result in that same
 * transaction. It is not authority to access credentials or run a report.
 */
export async function verifyCatalogSagTargetRuntimeProof(transaction: sql.Transaction, scope: unknown, matchKey: unknown):
  Promise<Readonly<{ targetId: string; validUntil: Date }> | null> {
  let localKey: Buffer | undefined;
  try {
    const fixed = ownData(scope, callerPins);
    const { environment, purpose, operationalLinkId, physicalLinkId, physicalTargetId, matchKeyVersion, reportInstanceId } = fixed;
    if ((environment !== "qa" && environment !== "production") ||
      !((purpose === "task" && reportInstanceId === null) || (purpose === "report" && uuidPin(reportInstanceId))) ||
      !uuidPin(operationalLinkId) || !uuidPin(physicalLinkId) || !uuidPin(physicalTargetId) ||
      !integer(matchKeyVersion, 1, 32767) || !Buffer.isBuffer(matchKey) || matchKey.length !== 32) return null;
    localKey = Buffer.from(matchKey);
    const raw = await transaction.request().input("environment", sql.VarChar(32), environment)
      .input("purpose", sql.VarChar(16), purpose).input("operationalLinkId", sql.UniqueIdentifier, operationalLinkId)
      .input("physicalLinkId", sql.UniqueIdentifier, physicalLinkId).input("physicalTargetId", sql.UniqueIdentifier, physicalTargetId)
      .input("matchKeyVersion", sql.SmallInt, matchKeyVersion).input("reportInstanceId", sql.UniqueIdentifier, reportInstanceId)
      .execute(procedures.read);

    let confirmed: Awaited<ReturnType<typeof verifyCatalogSagTargetLinkProof>> = null;
    for (const { profile, ...pins } of candidateRows(raw)) {
      let checked = false;
      let expectedPositive = false;
      const proof = await verifyCatalogSagTargetLinkProof({ ...fixed, ...pins }, profile, localKey, {
        async verify(inputs, output) {
          const request = transaction.request();
          // The adapter supplies only mssql type instances or callable
          // factories; @types/mssql's base factory interface is non-callable.
          for (const pin of inputs) request.input(pin.name, pin.type as Parameters<sql.Request["input"]>[1], pin.value);
          request.output(output.name, output.type);
          const result = readRpc(await request.execute(procedures.verify));
          if (result.recordsets.length !== 0 || result.recordset !== undefined) return invalid();
          const { validUntil } = ownData(result.output, ["validUntil"]);
          if (validUntil !== null) {
            if (!(validUntil instanceof Date) || !(Date.prototype.getTime.call(validUntil) > Date.now())) return invalid();
            expectedPositive = true;
          }
          checked = true;
          return { validUntil };
        },
      });
      // The lower adapter returns null for both negative proofs and errors.
      // Only a well-formed, explicitly negative SQL result permits another
      // candidate; a later match must never hide a transport/expiry failure.
      if (!checked || (expectedPositive && !proof)) return null;
      if (proof) {
        if (confirmed) return null;
        confirmed = proof;
      }
    }
    return confirmed && confirmed.validUntil.getTime() > Date.now() ? confirmed : null;
  } catch {
    return null;
  } finally {
    localKey?.fill(0);
  }
}
