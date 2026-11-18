import { createHmac, timingSafeEqual } from "node:crypto";
import { parseCatalogSagLegacySqlTargetEvidence } from "./catalogSagLegacySqlTargetProjection";

const purpose = "portal-sag/company-location/v1";
const sourceUuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const zeroUuid = "00000000-0000-0000-0000-000000000000";
const lowerSha256 = /^[a-f0-9]{64}$/;

function ownData<const K extends string>(value: unknown, keys: readonly K[]): Record<K, unknown> | null {
  if (!value || typeof value !== "object" || Reflect.ownKeys(value).length !== keys.length) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const data = Object.create(null) as Record<K, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null;
    data[key] = descriptor.value;
  }
  return data;
}

/**
 * Reproduce the 055 observation digest exactly. Scope comes from the sealed
 * provenance and its pinned match-key version; a match is not network or
 * physical-target verification. This is not an HTTP boundary.
 */
export function deriveCatalogSagCompanyLocationToken(scope: unknown, key: unknown, evidence: unknown): string | null {
  try {
    const pins = ownData(scope, ["environment", "sourceId", "companyRecordId", "matchKeyVersion"]);
    if (!pins || !Buffer.isBuffer(key) || key.length !== 32) return null;
    const { environment, sourceId, companyRecordId, matchKeyVersion } = pins;
    if ((environment !== "qa" && environment !== "production") ||
      typeof sourceId !== "string" || sourceId.length !== 36 || !sourceUuid.test(sourceId) || sourceId === zeroUuid ||
      typeof companyRecordId !== "number" || !Number.isInteger(companyRecordId) ||
      companyRecordId < -2147483648 || companyRecordId > 2147483647 ||
      typeof matchKeyVersion !== "number" || !Number.isInteger(matchKeyVersion) || matchKeyVersion < 1 || matchKeyVersion > 32767) return null;
    const location = parseCatalogSagLegacySqlTargetEvidence(evidence);
    if (location?.status !== "candidate") return null;
    return createHmac("sha256", key).update(JSON.stringify([purpose, environment, sourceId.toLowerCase(),
      matchKeyVersion, companyRecordId, location.host, location.port, location.databaseName])).digest("hex");
  } catch { return null; }
}

/**
 * Compare a sealed observation with an independently approved current server
 * profile, projected to exactly {serverHost, serverPort, databaseName}.
 * The caller owns freshness and authorization. No DNS or inferred defaults.
 */
export function matchesCatalogSagCompanyLocation(scope: unknown, key: unknown, observationToken: unknown,
  approvedProfileLocation: unknown): boolean {
  try {
    const actual = Buffer.isBuffer(observationToken) && observationToken.length === 32 ? observationToken
      : typeof observationToken === "string" && observationToken.length === 64 && lowerSha256.test(observationToken)
        ? Buffer.from(observationToken, "hex") : null;
    if (!actual) return false;
    const approved = ownData(approvedProfileLocation, ["serverHost", "serverPort", "databaseName"]);
    if (!approved || typeof approved.serverHost !== "string" || !/^[A-Za-z0-9.-]{3,253}$/.test(approved.serverHost)) return false;
    // SQL's source projection lowercases the ASCII hostname. Do not rewrite
    // the catalog or turn whitespace, aliases, literals or instances into it.
    const expected = deriveCatalogSagCompanyLocationToken(scope, key, { status: "candidate",
      host: approved.serverHost.toLowerCase(), port: approved.serverPort, databaseName: approved.databaseName });
    return expected !== null && timingSafeEqual(actual, Buffer.from(expected, "hex"));
  } catch { return false; }
}
