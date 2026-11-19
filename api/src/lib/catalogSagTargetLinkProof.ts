import sql, { type ISqlType, type ISqlTypeFactory } from "mssql";
import { deriveCatalogSagCompanyLocationToken } from "./catalogSagCompanyLocationProof";

type PinName = "environment" | "purpose" | "operationalLinkId" | "physicalLinkId" | "physicalTargetId" |
  "accessProfileVersion" | "sagSourceId" | "sagRevisionKey" | "sagCompanyRecordId" | "matchKeyVersion" |
  "locationToken" | "reportInstanceId";
type BoundPin = Readonly<{ name: PinName; type: ISqlType | ISqlTypeFactory; value: string | number | bigint | Buffer | null }>;
type BoundExpiry = Readonly<{ name: "validUntil"; type: ISqlType }>;
type VerifiedTarget = Readonly<{ targetId: string; validUntil: Date }>;

export interface CatalogSagTargetLinkProofTransport {
  /** Bind only for the authorized wrapper in its existing transaction; resolve `{ validUntil }` after consuming the inputs. */
  verify(inputs: readonly BoundPin[], output: BoundExpiry): Promise<unknown>;
}

const pins = ["environment", "purpose", "operationalLinkId", "physicalLinkId", "physicalTargetId", "accessProfileVersion",
  "sagSourceId", "sagRevisionKey", "sagCompanyRecordId", "matchKeyVersion", "reportInstanceId"] as const;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const uuidPin = (value: unknown): value is string => typeof value === "string" && value.length === 36 &&
  uuid.test(value) && value !== "00000000-0000-0000-0000-000000000000";
const integer = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;

function ownData<const Key extends string>(value: unknown, keys: readonly Key[]): Record<Key, unknown> | null {
  if (!value || typeof value !== "object" || Reflect.ownKeys(value).length !== keys.length) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const result = Object.create(null) as Record<Key, unknown>;
  for (const key of keys) {
    const item = Object.getOwnPropertyDescriptor(value, key);
    if (!item?.enumerable || !Object.hasOwn(item, "value")) return null;
    result[key] = item.value;
  }
  return result;
}

/**
 * Application-side parameter adapter only. Scope and minimal locator must come
 * from the server's already authorized, version-pinned operational profile.
 * The wrapper owns authorization, the SERIALIZABLE transaction and its expiry
 * fence; a positive response here is not reusable authorization.
 */
export async function verifyCatalogSagTargetLinkProof(scope: unknown, approvedProfile: unknown, matchKey: unknown,
  transport: CatalogSagTargetLinkProofTransport): Promise<VerifiedTarget | null> {
  let locationToken: Buffer | undefined;
  try {
    const checkedScope = ownData(scope, pins);
    const profile = ownData(approvedProfile, ["server_host_port", "initial_catalog"]);
    if (!checkedScope || !profile) return null;
    const { environment, purpose, operationalLinkId, physicalLinkId, physicalTargetId, accessProfileVersion,
      sagSourceId, sagRevisionKey, sagCompanyRecordId, matchKeyVersion, reportInstanceId } = checkedScope;
    if ((environment !== "qa" && environment !== "production") ||
      !((purpose === "task" && reportInstanceId === null) || (purpose === "report" && uuidPin(reportInstanceId))) ||
      !uuidPin(operationalLinkId) || !uuidPin(physicalLinkId) || !uuidPin(physicalTargetId) || !uuidPin(sagSourceId) ||
      typeof accessProfileVersion !== "string" || accessProfileVersion.length !== 16 || !/^[a-f0-9]{16}$/i.test(accessProfileVersion) ||
      typeof sagRevisionKey !== "string" || !/^[1-9][0-9]{0,18}(?![\s\S])/.test(sagRevisionKey) ||
      !integer(sagCompanyRecordId, -2147483648, 2147483647) || !integer(matchKeyVersion, 1, 32767)) return null;
    const revision = BigInt(sagRevisionKey);
    if (revision > 9223372036854775807n) return null;

    // Only explicit ASCII DNS,decimal-port. Do not infer a default, resolve
    // aliases, or trim ambiguous profile text. 055 validates DNS labels, port
    // range, and exact catalog spelling again as part of digest derivation.
    const address = profile.server_host_port;
    if (typeof address !== "string" || address.length > 259) return null;
    const parts = /^([A-Za-z0-9.-]{3,253}),([0-9]{1,5})(?![\s\S])/.exec(address);
    if (!parts) return null;
    const digest = deriveCatalogSagCompanyLocationToken({ environment, sourceId: sagSourceId,
      companyRecordId: sagCompanyRecordId, matchKeyVersion }, matchKey, {
      status: "candidate", host: parts[1].toLowerCase(), port: Number(parts[2]), databaseName: profile.initial_catalog,
    });
    if (digest === null) return null;
    locationToken = Buffer.from(digest, "hex");
    const result = await transport.verify([
      { name: "environment", type: sql.VarChar(32), value: environment },
      { name: "purpose", type: sql.VarChar(16), value: purpose },
      { name: "operationalLinkId", type: sql.UniqueIdentifier, value: operationalLinkId },
      { name: "physicalLinkId", type: sql.UniqueIdentifier, value: physicalLinkId },
      { name: "physicalTargetId", type: sql.UniqueIdentifier, value: physicalTargetId },
      { name: "accessProfileVersion", type: sql.VarBinary(32), value: Buffer.from(accessProfileVersion, "hex") },
      { name: "sagSourceId", type: sql.UniqueIdentifier, value: sagSourceId },
      { name: "sagRevisionKey", type: sql.BigInt, value: revision },
      { name: "sagCompanyRecordId", type: sql.Int, value: sagCompanyRecordId },
      { name: "matchKeyVersion", type: sql.SmallInt, value: matchKeyVersion },
      { name: "locationToken", type: sql.VarBinary(64), value: locationToken },
      { name: "reportInstanceId", type: sql.UniqueIdentifier, value: reportInstanceId },
    ], { name: "validUntil", type: sql.DateTime2(3) });
    const proof = ownData(result, ["validUntil"]);
    if (!(proof?.validUntil instanceof Date)) return null;
    const expiry = Date.prototype.getTime.call(proof.validUntil) as number;
    return Number.isFinite(expiry) && expiry > Date.now() ? { targetId: physicalTargetId, validUntil: new Date(expiry) } : null;
  } catch {
    return null;
  } finally {
    locationToken?.fill(0);
  }
}
