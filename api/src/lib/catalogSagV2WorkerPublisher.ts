import sql from "mssql";
import type { CatalogSagCompanyDiscoveryRecord, CatalogSagCompanyTargetObservation, CatalogSagDatabaseObservation } from "./catalogExternalSourceQueries";
import type { CatalogMatchKeyEvidence } from "./catalogMatchKeyEvidence";
import type { CatalogRefreshClaim } from "./catalogRefreshQueueSqlRepository";
import { normalizeCatalogSagInventoryEvidence, type CatalogSagInventoryEvidence } from "./catalogSagInventoryEvidence";
import { CATALOG_SAG_V2_OWNER_PROCEDURES, type CatalogSagV2PublisherMode } from "./catalogSagV2PublisherMode";

export type CatalogSagV2ProtectedCustomer = Readonly<{
  sourceRecordId: number;
  issuer: string | null;
  documentType: string | null;
  token: Buffer | null;
  domainCandidate: string | null;
  environmentKind: CatalogSagInventoryEvidence["environment"];
  licenseCodes: readonly string[] | null;
  testStartedOn: string | null;
  productionStartedOn: string | null;
  demoStartedOn: string | null;
}>;

export type CatalogSagV2WorkerPublication = Readonly<{
  customerCount: number;
  companyCount: number;
  customers: readonly CatalogSagV2ProtectedCustomer[];
  companies: readonly Readonly<CatalogSagCompanyDiscoveryRecord>[];
}>;

export type CatalogSagV2Reservation = Readonly<{ attemptOrdinal: string; observedAt: Date }>;
type Superseded = Readonly<{ result: "superseded"; jobStatus: "succeeded" | "cancelled" }>;
export type CatalogSagV2PublishResult = Readonly<{ result: "published"; jobStatus: "succeeded" }> | Superseded;
export type CatalogSagV2FailureResult = Readonly<{ result: "failed"; jobStatus: "retry" | "failed" }> | Superseded;

const procedures = {
  reserve: "settings.reserve_catalog_sag_v2_attempt",
  publish: "settings.publish_catalog_sag_v2_revision",
  publishWithTargets: "settings.publish_catalog_sag_v2_with_targets",
  fail: "settings.fail_catalog_sag_v2_attempt",
} as const;
const maxRows = 100_000;
const maxPayloadBytes = 16 * 1024 * 1024;
const maxTargetsBytes = 24 * 1024 * 1024;
const maxDatabaseNamesBytes = 40 * 1024 * 1024;
const publishWithNamesProcedure = "settings.publish_catalog_sag_v2_owner_with_database_names";
const invalid = (): never => { throw new Error("invalid_catalog_sag_v2_publication"); };
const failed = (): never => { throw new Error("catalog_sag_v2_publication_failed"); };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const validUuid = (value: unknown): value is string => typeof value === "string" && uuid.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000";
const validPin = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{16}$/i.test(value);
const boundedInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const sqlInt = (value: unknown): value is number => boundedInt(value, -2147483648, 2147483647);
const ordinal = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) &&
  BigInt(value) <= 9223372036854775807n;

/** Do not invoke accessors or accept unknown/inherited fields at this boundary. */
function exact<const K extends string>(value: unknown, keys: readonly K[]): value is Record<K, unknown> {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Reflect.ownKeys(value).length !== keys.length) return false;
  return keys.every(key => {
    const item = Object.getOwnPropertyDescriptor(value, key);
    return item?.enumerable === true && Object.hasOwn(item, "value");
  });
}

function checkedPins(options: unknown) {
  if (!exact(options, ["claim", "keyProof"])) return invalid();
  const { claim, keyProof } = options;
  if (!exact(claim, ["environment", "sourceId", "jobId", "workerId", "leaseToken", "attempt",
    "bindingRevision", "profileRevision", "matchKeyVersion"]) ||
    (claim.environment !== "qa" && claim.environment !== "production") || !validUuid(claim.sourceId) ||
    !validUuid(claim.jobId) || !validUuid(claim.workerId) || !validUuid(claim.leaseToken) ||
    !boundedInt(claim.attempt, 1, 5) || !validPin(claim.bindingRevision) || !validPin(claim.profileRevision) ||
    !boundedInt(claim.matchKeyVersion, 1, 32767) || !exact(keyProof, ["vaultSecretVersion", "keyVerifier"]) ||
    !Buffer.isBuffer(keyProof.vaultSecretVersion) || keyProof.vaultSecretVersion.length !== 16 ||
    !Buffer.isBuffer(keyProof.keyVerifier) || keyProof.keyVerifier.length !== 32) return invalid();
  return { environment: claim.environment, sourceId: claim.sourceId, jobId: claim.jobId, workerId: claim.workerId,
    leaseToken: claim.leaseToken, attempt: claim.attempt, matchKeyVersion: claim.matchKeyVersion,
    bindingVersion: Buffer.from(claim.bindingRevision, "hex"), profileVersion: Buffer.from(claim.profileRevision, "hex"),
    vaultSecretVersion: Buffer.from(keyProof.vaultSecretVersion), keyVerifier: Buffer.from(keyProof.keyVerifier) };
}

function encodeCustomer(value: unknown) {
  if (!exact(value, ["sourceRecordId", "issuer", "documentType", "token", "domainCandidate", "environmentKind",
    "licenseCodes", "testStartedOn", "productionStartedOn", "demoStartedOn"]) || !sqlInt(value.sourceRecordId) ||
    (value.token !== null && (!Buffer.isBuffer(value.token) || value.token.length !== 32))) return invalid();
  if (value.issuer === null ? value.documentType !== null : typeof value.issuer !== "string" || !/^[A-Z]{2}$/.test(value.issuer) ||
    typeof value.documentType !== "string" || !/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(value.documentType) || value.token === null) return invalid();
  const suppliedCodes = value.licenseCodes;
  let codes: string[] | null = null;
  if (suppliedCodes !== null) {
    if (!Array.isArray(suppliedCodes) || suppliedCodes.length > 25 ||
      Reflect.ownKeys(suppliedCodes).length !== suppliedCodes.length + 1) return invalid();
    codes = [];
    for (let i = 0; i < suppliedCodes.length; i++) {
      const code = Object.getOwnPropertyDescriptor(suppliedCodes, i);
      if (!code || !Object.hasOwn(code, "value") || typeof code.value !== "string") return invalid();
      codes.push(code.value);
    }
  }
  // Dates must already be canonical. The SQL reserve stamp is authoritative for the actual cutoff.
  const evidence = normalizeCatalogSagInventoryEvidence({ domainCandidate: value.domainCandidate, environment: value.environmentKind,
    licenseCodes: codes, testStartedOn: value.testStartedOn,
    productionStartedOn: value.productionStartedOn, demoStartedOn: value.demoStartedOn }, "9999-12-31");
  if (value.domainCandidate !== evidence.domainCandidate || value.environmentKind !== evidence.environment ||
    value.testStartedOn !== evidence.testStartedOn || value.productionStartedOn !== evidence.productionStartedOn ||
    value.demoStartedOn !== evidence.demoStartedOn || (codes === null ? evidence.licenseCodes !== null :
      evidence.licenseCodes === null || codes.length !== evidence.licenseCodes.length ||
      codes.some((code, i) => code !== evidence.licenseCodes?.[i]))) return invalid();
  return { sourceRecordId: value.sourceRecordId, issuer: value.issuer, documentType: value.documentType,
    token: value.token === null ? null : Buffer.from(value.token).toString("hex"), domainCandidate: evidence.domainCandidate,
    environmentKind: evidence.environment, licenseCodes: evidence.licenseCodes?.join("") ?? null,
    testStartedOn: evidence.testStartedOn, productionStartedOn: evidence.productionStartedOn, demoStartedOn: evidence.demoStartedOn };
}

function encodeCompany(value: unknown) {
  if (!exact(value, ["companyRecordId", "customerRecordId", "displayName", "isAvailable"]) || !sqlInt(value.companyRecordId) ||
    (value.customerRecordId !== null && !sqlInt(value.customerRecordId)) ||
    (value.displayName !== null && (typeof value.displayName !== "string" || !value.displayName.length || value.displayName.length > 512 ||
      value.displayName !== value.displayName.trim() || /\p{C}/u.test(value.displayName))) ||
    (value.isAvailable !== null && typeof value.isAvailable !== "boolean")) return invalid();
  return { companyRecordId: value.companyRecordId, customerRecordId: value.customerRecordId,
    displayName: value.displayName, isAvailable: value.isAvailable };
}

function preparePayload(value: unknown) {
  try {
    if (!exact(value, ["customerCount", "companyCount", "customers", "companies"]) ||
      !boundedInt(value.customerCount, 0, maxRows) || !boundedInt(value.companyCount, 0, maxRows) ||
      value.customerCount + value.companyCount > maxRows || !Array.isArray(value.customers) || !Array.isArray(value.companies) ||
      value.customers.length !== value.customerCount || value.companies.length !== value.companyCount) return invalid();
    // nvarchar DATALENGTH is two bytes per UTF-16 code unit, combined over both arrays.
    let bytes = 8; // both opening/closing brackets
    function encodeRows<T>(rows: readonly unknown[], count: number, encode: (row: unknown) => T, id: (row: T) => number) {
      const entries: string[] = [];
      const seen = new Set<number>();
      for (let i = 0; i < count; i++) {
        const entry = Object.getOwnPropertyDescriptor(rows, i);
        if (!entry || !Object.hasOwn(entry, "value")) return invalid();
        const row = encode(entry.value);
        const key = id(row);
        if (seen.has(key)) return invalid();
        seen.add(key);
        const json = JSON.stringify(row);
        bytes += 2 * (json.length + (i === 0 ? 0 : 1));
        if (bytes > maxPayloadBytes) return invalid();
        entries.push(json);
      }
      return { json: `[${entries.join(",")}]`, ids: seen };
    }
    const customers = encodeRows(value.customers, value.customerCount, encodeCustomer, row => row.sourceRecordId);
    const companies = encodeRows(value.companies, value.companyCount, encodeCompany, row => row.companyRecordId);
    return { customerCount: value.customerCount, companyCount: value.companyCount,
      customers: customers.json, companies: companies.json, companyIds: companies.ids };
  } catch { return invalid(); }
}

function prepareTargets(value: unknown, companyIds: ReadonlySet<number>, collectCandidates: boolean) {
  try {
    if (!Array.isArray(value) || value.length !== companyIds.size ||
      Reflect.ownKeys(value).length !== value.length + 1) return invalid();
    const entries: string[] = [];
    const candidates = new Set<number>();
    let last = -Infinity, bytes = 4; // opening/closing brackets in nvarchar
    for (let index = 0; index < value.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(value, index);
      if (!entry?.enumerable || !Object.hasOwn(entry, "value")) return invalid();
      const row: unknown = entry.value;
      if (!exact(row, ["companyRecordId", "state", "locationToken"]) ||
        !sqlInt(row.companyRecordId) || row.companyRecordId <= last || !companyIds.has(row.companyRecordId)) return invalid();
      const { companyRecordId, state, locationToken } = row;
      if (state === "candidate" ? typeof locationToken !== "string" || locationToken.length !== 64 || !/^[a-f0-9]{64}$/.test(locationToken)
        : state !== "unverified" || locationToken !== null) return invalid();
      if (collectCandidates && state === "candidate") candidates.add(companyRecordId);
      last = companyRecordId;
      const json = JSON.stringify({ companyRecordId, state, locationToken });
      bytes += 2 * (json.length + (index === 0 ? 0 : 1));
      if (bytes > maxTargetsBytes) return invalid();
      entries.push(json);
    }
    return { json: `[${entries.join(",")}]`, candidates };
  } catch { return invalid(); }
}

function prepareDatabaseNames(value: unknown, candidates: ReadonlySet<number>): string {
  try {
    if (!Array.isArray(value) || value.length > candidates.size || Reflect.ownKeys(value).length !== value.length + 1) return invalid();
    const rows: CatalogSagDatabaseObservation[] = [];
    let last = -Infinity;
    for (let index = 0; index < value.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(value, index);
      if (!entry?.enumerable || !Object.hasOwn(entry, "value")) return invalid();
      const row: unknown = entry.value;
      if (!exact(row, ["companyRecordId", "databaseName"])) return invalid();
      const { companyRecordId, databaseName } = row;
      if (!sqlInt(companyRecordId) || companyRecordId <= last || !candidates.has(companyRecordId) ||
        typeof databaseName !== "string" || databaseName.length > 128 || databaseName !== databaseName.trim() ||
        !/^[A-Za-z0-9_. -]+$/.test(databaseName) || !/[A-Za-z0-9]/.test(databaseName)) return invalid();
      last = companyRecordId;
      rows.push({ companyRecordId, databaseName });
    }
    const json = JSON.stringify(rows);
    return Buffer.byteLength(json, "utf16le") <= maxDatabaseNamesBytes ? json : invalid();
  } catch { return invalid(); }
}

function decodePublication(row: unknown): CatalogSagV2PublishResult {
  if (!exact(row, ["result", "jobStatus"])) return failed();
  if (row.result === "published" && row.jobStatus === "succeeded") return { result: row.result, jobStatus: row.jobStatus };
  if (row.result === "superseded" && (row.jobStatus === "succeeded" || row.jobStatus === "cancelled")) {
    return { result: row.result, jobStatus: row.jobStatus };
  }
  return failed();
}

const bindPublication = (request: sql.Request, attemptOrdinal: string, payload: ReturnType<typeof preparePayload>) =>
  request.input("attemptOrdinal", sql.BigInt, BigInt(attemptOrdinal))
    .input("customerCount", sql.Int, payload.customerCount).input("companyCount", sql.Int, payload.companyCount)
    .input("customers", sql.NVarChar(sql.MAX), payload.customers).input("companies", sql.NVarChar(sql.MAX), payload.companies);

/** Caller supplies the readiness-checked isolated pool for the explicit mode;
 * no ordinary-Portal pool, SQL text or fallback is accepted. */
export function createCatalogSagV2WorkerPublisher(pool: Pick<sql.ConnectionPool, "request">,
  options: Readonly<{ claim: CatalogRefreshClaim; keyProof: CatalogMatchKeyEvidence }>, mode: CatalogSagV2PublisherMode = "dedicated") {
  const pins = (() => {
    try {
      if (typeof pool?.request !== "function" || (mode !== "dedicated" && mode !== "portal-owner")) return invalid();
      return checkedPins(options);
    } catch { return invalid(); }
  })();

  async function rpc<T>(operation: keyof typeof procedures, bind: (request: sql.Request) => sql.Request,
    decode: (row: unknown) => T, withNames = false): Promise<T> {
    try {
      if (mode === "portal-owner" && operation === "publish") return invalid();
      if (withNames && (operation !== "publishWithTargets" || mode !== "portal-owner")) return invalid();
      const procedure = withNames ? publishWithNamesProcedure :
        mode === "portal-owner" ? CATALOG_SAG_V2_OWNER_PROCEDURES[operation as keyof typeof CATALOG_SAG_V2_OWNER_PROCEDURES] : procedures[operation];
      const request = pool.request().input("environment", sql.VarChar(32), pins.environment)
        .input("sourceId", sql.UniqueIdentifier, pins.sourceId).input("jobId", sql.UniqueIdentifier, pins.jobId)
        .input("workerId", sql.UniqueIdentifier, pins.workerId).input("leaseToken", sql.UniqueIdentifier, pins.leaseToken)
        .input("attempt", sql.Int, pins.attempt).input("bindingVersion", sql.VarBinary(32), Buffer.from(pins.bindingVersion))
        .input("profileVersion", sql.VarBinary(32), Buffer.from(pins.profileVersion)).input("matchKeyVersion", sql.SmallInt, pins.matchKeyVersion)
        .input("vaultSecretVersion", sql.VarBinary(64), Buffer.from(pins.vaultSecretVersion))
        .input("keyVerifier", sql.VarBinary(64), Buffer.from(pins.keyVerifier));
      // The procedure owns its transaction; its only valid result is emitted after its SQL COMMIT.
      const result = await bind(request).execute<unknown>(procedure);
      if (!Array.isArray(result.recordsets) || result.recordsets.length !== 1 ||
        !Array.isArray(result.recordsets[0]) || result.recordsets[0].length !== 1) return failed();
      return decode(result.recordsets[0][0]);
    } catch { return failed(); }
  }

  return {
    reserveAttempt(): Promise<CatalogSagV2Reservation> {
      return rpc("reserve", request => request, row => {
        if (!exact(row, ["attemptOrdinal", "observedAt"]) || !ordinal(row.attemptOrdinal) || !(row.observedAt instanceof Date)) return failed();
        const ms = Date.prototype.getTime.call(row.observedAt);
        if (!Number.isFinite(ms)) return failed();
        return { attemptOrdinal: row.attemptOrdinal, observedAt: new Date(ms) };
      });
    },
    async publish(attemptOrdinal: string, publication: CatalogSagV2WorkerPublication): Promise<CatalogSagV2PublishResult> {
      if (mode === "portal-owner") return invalid();
      if (!ordinal(attemptOrdinal)) return invalid();
      const payload = preparePayload(publication);
      return rpc("publish", request => bindPublication(request, attemptOrdinal, payload), decodePublication);
    },
    async publishWithTargets(attemptOrdinal: string, publication: CatalogSagV2WorkerPublication,
      targets: readonly CatalogSagCompanyTargetObservation[],
      databaseNames?: readonly CatalogSagDatabaseObservation[]): Promise<CatalogSagV2PublishResult> {
      if (!ordinal(attemptOrdinal) || (databaseNames !== undefined && mode !== "portal-owner")) return invalid();
      const payload = preparePayload(publication);
      const targetRows = prepareTargets(targets, payload.companyIds, databaseNames !== undefined);
      const names = databaseNames === undefined ? undefined : prepareDatabaseNames(databaseNames, targetRows.candidates);
      return rpc("publishWithTargets", request => {
        const bound = bindPublication(request, attemptOrdinal, payload).input("targets", sql.NVarChar(sql.MAX), targetRows.json);
        return names === undefined ? bound : bound.input("databaseNames", sql.NVarChar(sql.MAX), names);
      }, decodePublication, names !== undefined);
    },
    async recordFailure(attemptOrdinal: string): Promise<CatalogSagV2FailureResult> {
      if (!ordinal(attemptOrdinal)) return invalid();
      return rpc("fail", request => request.input("attemptOrdinal", sql.BigInt, BigInt(attemptOrdinal)), row => {
        if (!exact(row, ["result", "jobStatus"])) return failed();
        const jobStatus = pins.attempt >= 5 ? "failed" : "retry";
        if (row.result === "failed" && row.jobStatus === jobStatus) return { result: row.result, jobStatus };
        if (row.result === "superseded" && (row.jobStatus === "succeeded" || row.jobStatus === "cancelled")) {
          return { result: row.result, jobStatus: row.jobStatus };
        }
        return failed();
      });
    },
  };
}
