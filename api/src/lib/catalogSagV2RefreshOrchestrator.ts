import { catalogDocumentNumberToken } from "./catalogCustomerRefresh";
import { buildCatalogMatchKeyEvidence, type CatalogMatchKeyEvidence } from "./catalogMatchKeyEvidence";
import { readCatalogSagDiscoveryV2, type CatalogExternalSourceTransport, type CatalogSagDiscoveryV2Result } from "./catalogExternalSourceQueries";
import type { CatalogRefreshClaim } from "./catalogRefreshQueueSqlRepository";
import { normalizeCatalogSagInventoryEvidence } from "./catalogSagInventoryEvidence";
import type { CatalogSagV2WorkerPublication, createCatalogSagV2WorkerPublisher } from "./catalogSagV2WorkerPublisher";
import type { SqlCatalogSourceBinding } from "./catalogSourceBindingsSqlRepository";

type Scope = Readonly<{ issuer: string; documentType: string }>;
type Publisher = Pick<ReturnType<typeof createCatalogSagV2WorkerPublisher>, "reserveAttempt" | "publish" | "recordFailure">;
export type CatalogSagV2RefreshInput = Readonly<{
  claim: CatalogRefreshClaim;
  matchKey: Buffer;
  /** Exact immutable Vault version from which the caller obtained matchKey. */
  vaultSecretVersion: string;
  scopesByCountry: ReadonlyMap<number, Scope>;
  signal?: AbortSignal;
}>;
export type CatalogSagV2RefreshIO = Readonly<{
  /** Null is a positive observation that the pinned source is no longer eligible. Throw if the check is unavailable. */
  readPinnedSource(claim: CatalogRefreshClaim, signal: AbortSignal): Promise<SqlCatalogSourceBinding | null>;
  loadTransport(source: SqlCatalogSourceBinding, signal: AbortSignal): Promise<CatalogExternalSourceTransport>;
  /** Synchronous binder for an already acquired dedicated publisher pool; no network or general-purpose fallback. */
  publisherFor(claim: CatalogRefreshClaim, keyProof: CatalogMatchKeyEvidence): Publisher;
}>;

/** A settled result already changed the lease in SQL. An unconfirmed result must not trigger any new write. */
export type CatalogSagV2RefreshOutcome =
  | { outcome: "ineligible" | "cancelled"; queue: "untouched" }
  | { outcome: "stale"; queue: "fenced-stale" }
  | { outcome: "unconfirmed"; queue: "lease-recovery" }
  | { outcome: "published"; queue: "settled"; jobStatus: "succeeded" }
  | { outcome: "superseded"; queue: "settled"; jobStatus: "succeeded" | "cancelled" }
  | { outcome: "failed-recorded"; queue: "settled"; jobStatus: "retry" | "failed" };

const ineligible = Object.freeze({ outcome: "ineligible", queue: "untouched" } as const);
const cancelled = Object.freeze({ outcome: "cancelled", queue: "untouched" } as const);
const stale = Object.freeze({ outcome: "stale", queue: "fenced-stale" } as const);
const unconfirmed = Object.freeze({ outcome: "unconfirmed", queue: "lease-recovery" } as const);
const unavailable = () => new Error("catalog_sag_v2_read_unavailable");
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const pin = /^[a-f0-9]{16}$/i;
const claimKeys = ["jobId", "workerId", "leaseToken", "attempt", "sourceId", "environment",
  "bindingRevision", "profileRevision", "matchKeyVersion"] as const;
const bogotaDay = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit",
});

function exact<const K extends string>(value: unknown, keys: readonly K[]): value is Record<K, unknown> {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).length === keys.length &&
    keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !!descriptor?.enumerable && Object.hasOwn(descriptor, "value");
    });
}
const integer = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const validUuid = (v: unknown): v is string => typeof v === "string" && uuid.test(v) &&
  v !== "00000000-0000-0000-0000-000000000000";

function copyInput(input: CatalogSagV2RefreshInput) {
  const required = ["claim", "matchKey", "vaultSecretVersion", "scopesByCountry"] as const;
  if (!exact(input, Object.hasOwn(input, "signal") ? [...required, "signal"] : required)) return null;
  const { claim, matchKey, vaultSecretVersion, scopesByCountry, signal } = input;
  if (!exact(claim, claimKeys) || !validUuid(claim.jobId) || !validUuid(claim.workerId) ||
    !validUuid(claim.leaseToken) || !validUuid(claim.sourceId) || !integer(claim.attempt, 1, 5) ||
    (claim.environment !== "qa" && claim.environment !== "production") ||
    typeof claim.bindingRevision !== "string" || !pin.test(claim.bindingRevision) ||
    typeof claim.profileRevision !== "string" || !pin.test(claim.profileRevision) ||
    !integer(claim.matchKeyVersion, 1, 32767) ||
    !Buffer.isBuffer(matchKey) || matchKey.length !== 32 ||
    typeof vaultSecretVersion !== "string" || vaultSecretVersion.length !== 32 || !/^[a-f0-9]{32}$/i.test(vaultSecretVersion) ||
    (signal !== undefined && !(signal instanceof AbortSignal))) return null;

  const scopes = new Map<number, Scope>();
  // Bypass any instance-level iterator override, bound the actual map and copy each data-only value.
  for (const [name, scope] of Map.prototype.entries.call(scopesByCountry) as MapIterator<[unknown, unknown]>) {
    if (scopes.size >= 250 || !integer(name, 1, 2147483647) || !exact(scope, ["issuer", "documentType"]) ||
      typeof scope.issuer !== "string" || !/^[A-Z]{2}$/.test(scope.issuer) ||
      typeof scope.documentType !== "string" || !/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(scope.documentType)) return null;
    scopes.set(name, { issuer: scope.issuer, documentType: scope.documentType });
  }
  return { claim: Object.freeze({ ...claim } as CatalogRefreshClaim), scopes, privateKey: Buffer.from(matchKey),
    vaultSecretVersion, signal };
}

/** Only read-side work can use this race. The caller of a write must await its result even on abort. */
function boundedRead<T>(ms: number, parent: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeout = AbortSignal.timeout(ms);
  const signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(unavailable());
    if (signal.aborted) { stop(); return; }
    signal.addEventListener("abort", stop, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw unavailable();
      return work(signal);
    }).then(value => {
      if (signal.aborted) stop();
      else resolve(value);
    }, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

function reservableStamp(stamp: unknown) {
  if (!exact(stamp, ["attemptOrdinal", "observedAt"]) || typeof stamp.attemptOrdinal !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(stamp.attemptOrdinal) || BigInt(stamp.attemptOrdinal) > 9223372036854775807n ||
    !(stamp.observedAt instanceof Date)) return null;
  const observedAt = new Date(Date.prototype.getTime.call(stamp.observedAt));
  if (!Number.isFinite(observedAt.valueOf()) || observedAt.getUTCFullYear() < 2 || observedAt.getUTCFullYear() > 9999) return null;
  return { attemptOrdinal: stamp.attemptOrdinal, businessDay: bogotaDay.format(observedAt) };
}

function protectedPublication(result: Extract<CatalogSagDiscoveryV2Result, { status: "complete" }>,
  input: NonNullable<ReturnType<typeof copyInput>>, businessDay: string): CatalogSagV2WorkerPublication {
  return {
    customerCount: result.customers.length,
    companyCount: result.companies.length,
    customers: result.customers.map(row => {
      const token = row.documentNumber === null ? null : catalogDocumentNumberToken(input.privateKey, input.claim.environment, row.documentNumber);
      const scope = token !== null && row.reportedCountryId !== null ? input.scopes.get(row.reportedCountryId) : undefined;
      const p = normalizeCatalogSagInventoryEvidence(row, businessDay);
      return { sourceRecordId: row.sourceRecordId, issuer: scope?.issuer ?? null, documentType: scope?.documentType ?? null, token,
        domainCandidate: p.domainCandidate, environmentKind: p.environment, licenseCodes: p.licenseCodes,
        testStartedOn: p.testStartedOn, productionStartedOn: p.productionStartedOn, demoStartedOn: p.demoStartedOn };
    }),
    companies: result.companies.map(row => ({ companyRecordId: row.companyRecordId, customerRecordId: row.customerRecordId,
      displayName: row.displayName, isAvailable: row.isAvailable })),
  };
}

type Authority = { status: "current"; source: SqlCatalogSourceBinding } | { status: "stale" | "unconfirmed" | "cancelled" };

/** Not registered with the timer yet. Only a claim already routed to a dedicated v2 worker enters here. */
export async function runCatalogSagV2Refresh(args: CatalogSagV2RefreshInput, io: CatalogSagV2RefreshIO): Promise<CatalogSagV2RefreshOutcome> {
  let input: ReturnType<typeof copyInput>;
  try { input = copyInput(args); }
  catch { return ineligible; }
  if (!input) return ineligible;
  const { claim, signal } = input;
  let profileId: string | undefined;
  async function authority(phaseSignal?: AbortSignal): Promise<Authority> {
    try {
      if (phaseSignal?.aborted) return { status: "cancelled" };
      const source = await boundedRead(4_000, phaseSignal, checkSignal => io.readPinnedSource(claim, checkSignal));
      if (phaseSignal?.aborted) return { status: "cancelled" };
      if (source === null) return { status: "stale" };
      if (!source || typeof source.id !== "string" || typeof source.profileId !== "string" ||
        !source.profileId || source.profileId !== source.profileId.trim() || /\p{C}/u.test(source.profileId) ||
        typeof source.profileRevision !== "string" || typeof source.bindingVersion !== "string") return { status: "unconfirmed" };
      if (source.id.toLowerCase() !== claim.sourceId.toLowerCase() || source.contractVersion !== "sag_admin_v2" ||
        source.role !== "sag-admin" || source.environment !== claim.environment || source.state !== "active" ||
        source.bindingVersion.toLowerCase() !== claim.bindingRevision.toLowerCase() ||
        source.profileRevision.toLowerCase() !== claim.profileRevision.toLowerCase() ||
        source.canReadCurrentProfile !== true || (profileId !== undefined && source.profileId !== profileId)) return { status: "stale" };
      return { status: "current", source: Object.freeze({ id: source.id, profileId: source.profileId, label: source.label,
        role: source.role, environment: source.environment, state: source.state, profileRevision: source.profileRevision,
        contractVersion: source.contractVersion, bindingVersion: source.bindingVersion, canReadCurrentProfile: true }) };
    } catch { return { status: phaseSignal?.aborted ? "cancelled" : "unconfirmed" }; }
  }

  try {
    if (signal?.aborted) return cancelled;
    const initial = await authority(signal);
    if (initial.status !== "current") return initial.status === "stale" ? stale : initial.status === "cancelled" ? cancelled : unconfirmed;
    profileId = initial.source.profileId;
    // Bind the publisher to the same private key that will produce customer tokens.
    // SQL still owns the enrollment and lease entitlement checks; this proof never grants access by itself.
    const keyProof = buildCatalogMatchKeyEvidence(claim.environment, claim.matchKeyVersion, input.vaultSecretVersion, input.privateKey);
    const publisher = io.publisherFor(claim, keyProof);
    if (signal?.aborted) return cancelled;
    const stamp = reservableStamp(await publisher.reserveAttempt());
    if (!stamp) return unconfirmed;
    const { attemptOrdinal, businessDay } = stamp;
    async function fencedFailure(): Promise<CatalogSagV2RefreshOutcome> {
      // Caller cancellation stops external work, not the one authorized cleanup. Use a fresh bounded recheck.
      const check = await authority();
      if (check.status !== "current") return check.status === "stale" ? stale : unconfirmed;
      const response: unknown = await publisher.recordFailure(attemptOrdinal);
      if (!exact(response, ["result", "jobStatus"])) return unconfirmed;
      if (response.result === "superseded" && (response.jobStatus === "succeeded" || response.jobStatus === "cancelled"))
        return { outcome: "superseded", queue: "settled", jobStatus: response.jobStatus };
      const expectedFailure = claim.attempt < 5 ? "retry" : "failed";
      if (response.result === "failed" && response.jobStatus === expectedFailure)
        return { outcome: "failed-recorded", queue: "settled", jobStatus: expectedFailure };
      return unconfirmed;
    }
    const beforeLoad = await authority(signal);
    if (beforeLoad.status !== "current") return beforeLoad.status === "stale" ? stale :
      beforeLoad.status === "cancelled" ? await fencedFailure() : unconfirmed;
    let transport: CatalogExternalSourceTransport;
    try {
      transport = await boundedRead(8_000, signal, transportSignal => io.loadTransport(beforeLoad.source, transportSignal));
    } catch { return await fencedFailure(); }
    const readState: { denied?: "stale" | "unconfirmed" } = {};
    async function checkRead(readSignal: AbortSignal) {
      const status = (await authority(readSignal)).status;
      if (status === "stale" || status === "unconfirmed") readState.denied = status;
      if (status !== "current" || readSignal.aborted || signal?.aborted) throw unavailable();
    }
    const guarded: CatalogExternalSourceTransport = {
      async withConsistentRead(request, read) {
        await checkRead(request.signal);
        if (request.contract !== "sag_admin_v2" || request.signal.aborted || signal?.aborted) throw unavailable();
        return transport.withConsistentRead(request, session => read({
          consistency: session.consistency,
          async select(statement) {
            await checkRead(statement.signal);
            if (statement.signal.aborted || request.signal.aborted || signal?.aborted) throw unavailable();
            return session.select(statement);
          },
        }));
      },
    };
    const discovery = await readCatalogSagDiscoveryV2(guarded, { signal });
    if (readState.denied) return readState.denied === "stale" ? stale : unconfirmed;
    if (discovery.status !== "complete" || signal?.aborted) return await fencedFailure();

    const afterRead = await authority(signal);
    if (afterRead.status !== "current") return afterRead.status === "stale" ? stale :
      afterRead.status === "cancelled" ? await fencedFailure() : unconfirmed;
    const body = protectedPublication(discovery, input, businessDay);
    const beforePublish = await authority(signal);
    if (beforePublish.status !== "current") return beforePublish.status === "stale" ? stale :
      beforePublish.status === "cancelled" ? await fencedFailure() : unconfirmed;
    if (signal?.aborted) return await fencedFailure();

    // This RPC can commit even if its response is lost or the caller cancels. Nothing may compensate or retry here.
    const response: unknown = await publisher.publish(attemptOrdinal, body);
    if (!exact(response, ["result", "jobStatus"])) return unconfirmed;
    if (response.result === "published" && response.jobStatus === "succeeded")
      return { outcome: "published", queue: "settled", jobStatus: "succeeded" };
    if (response.result === "superseded" && (response.jobStatus === "succeeded" || response.jobStatus === "cancelled"))
      return { outcome: "superseded", queue: "settled", jobStatus: response.jobStatus };
    return unconfirmed;
  } catch {
    return unconfirmed;
  } finally {
    input.privateKey.fill(0);
  }
}
