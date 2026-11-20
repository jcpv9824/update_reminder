import type sql from "mssql";
import type { CatalogExternalSourceTransport } from "./catalogExternalSourceQueries";
import type { CatalogRefreshClaim } from "./catalogRefreshQueueSqlRepository";
import { runCatalogSagV2Refresh, type CatalogSagV2RefreshOutcome } from "./catalogSagV2RefreshOrchestrator";
import { createCatalogSagV2WorkerPublisher } from "./catalogSagV2WorkerPublisher";
import type { SqlCatalogSourceBinding } from "./catalogSourceBindingsSqlRepository";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { parseCatalogSagPolicy, readCatalogRefreshConfiguration } from "./catalogSourcePublication";
import { readCatalogSagV2PublisherMode } from "./catalogSagV2PublisherMode";

export type CatalogSagV2ClaimedPublicationIO = Readonly<{
  /** Safe Portal metadata only. Implementations can use the supplied exact source filter. */
  readBindings(environment: CatalogEnvironment, signal: AbortSignal, sourceId: string): Promise<readonly SqlCatalogSourceBinding[]>;
  /** No unversioned or latest-secret call is allowed. */
  getSecret(name: string, signal: AbortSignal, exactVersion: string): Promise<string>;
  /** Historical method name: isolated, readiness-checked pool for the explicit
   * publisher mode. Never the ordinary Portal pool or the external SAG pool. */
  getDedicatedPool(environment: CatalogEnvironment): Promise<Pick<sql.ConnectionPool, "request">>;
  loadTransport(binding: SqlCatalogSourceBinding, signal: AbortSignal): Promise<CatalogExternalSourceTransport>;
}>;

const ineligible = Object.freeze({ outcome: "ineligible", queue: "untouched" } as const);
const cancelled = Object.freeze({ outcome: "cancelled", queue: "untouched" } as const);
const stale = Object.freeze({ outcome: "stale", queue: "fenced-stale" } as const);
const unconfirmed = Object.freeze({ outcome: "unconfirmed", queue: "lease-recovery" } as const);
const unavailable = () => new Error("catalog_sag_v2_service_unavailable");
const claimKeys = ["jobId", "workerId", "leaseToken", "attempt", "sourceId", "environment", "bindingRevision",
  "profileRevision", "matchKeyVersion"] as const;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const validUuid = (x: unknown): x is string => typeof x === "string" && x.length === 36 && uuid.test(x) &&
  x !== "00000000-0000-0000-0000-000000000000";
const rowVersion = (x: unknown): x is string => typeof x === "string" && x.length === 16 && /^[a-f0-9]{16}$/i.test(x);

function frozenClaim(value: CatalogRefreshClaim): CatalogRefreshClaim | null {
  if (!value || typeof value !== "object" || Reflect.ownKeys(value).length !== claimKeys.length) return null;
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || !claimKeys.every(name => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return !!descriptor?.enumerable && Object.hasOwn(descriptor, "value");
  })) return null;
  const { jobId, workerId, leaseToken, attempt, sourceId, environment, bindingRevision, profileRevision, matchKeyVersion } = value;
  if (!validUuid(jobId) || !validUuid(workerId) || !validUuid(leaseToken) || !validUuid(sourceId) ||
    (environment !== "qa" && environment !== "production") || !rowVersion(bindingRevision) || !rowVersion(profileRevision) ||
    !Number.isInteger(attempt) || attempt < 1 || attempt > 5 ||
    !Number.isInteger(matchKeyVersion) || matchKeyVersion < 1 || matchKeyVersion > 32767) return null;
  return Object.freeze({ jobId, workerId, leaseToken, attempt, sourceId, environment, bindingRevision,
    profileRevision, matchKeyVersion });
}

function readConfiguration(environment: NodeJS.ProcessEnv) {
  if (environment.PORTAL_CATALOG_SAG_V2_ENABLED?.trim() !== "true") return null;
  const mode = readCatalogSagV2PublisherMode(environment);
  if (!mode) return null;
  const values = Object.freeze({
    PORTAL_CATALOG_READ_ENABLED: environment.PORTAL_CATALOG_READ_ENABLED,
    PORTAL_CATALOG_CLIENTS_READ_ENABLED: environment.PORTAL_CATALOG_CLIENTS_READ_ENABLED,
    PORTAL_CATALOG_AUTOMATION_ENABLED: environment.PORTAL_CATALOG_AUTOMATION_ENABLED,
    PORTAL_SAG_ENVIRONMENT: environment.PORTAL_SAG_ENVIRONMENT,
    PORTAL_CATALOG_MATCH_KEY_VERSION: environment.PORTAL_CATALOG_MATCH_KEY_VERSION,
    PORTAL_CATALOG_MATCH_KEY_SECRET_NAME: environment.PORTAL_CATALOG_MATCH_KEY_SECRET_NAME,
    PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION: environment.PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION,
    PORTAL_CATALOG_SAG_ISSUER_MAP: environment.PORTAL_CATALOG_SAG_ISSUER_MAP,
  });
  const configuration = readCatalogRefreshConfiguration(values);
  const name = values.PORTAL_CATALOG_MATCH_KEY_SECRET_NAME?.trim();
  const version = values.PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION?.trim();
  if (!configuration?.includeSag || !name || !version) return null;
  const policy = parseCatalogSagPolicy(values.PORTAL_CATALOG_SAG_ISSUER_MAP);
  if (policy === null) return null;
  const scopes = new Map<number, Readonly<{ issuer: string; documentType: string }>>();
  for (const [countryId, scope] of policy.scopesByCountry) {
    const [issuer, documentType] = scope.split(":");
    scopes.set(countryId, Object.freeze({ issuer, documentType }));
  }
  const includeDatabaseNames = mode === "portal-owner" && environment.PORTAL_CATALOG_SAG_DATABASE_NAMES_ENABLED === "true";
  const includeDirectory = includeDatabaseNames && environment.PORTAL_CATALOG_SAG_DIRECTORY_ENABLED === "true";
  return Object.freeze({ environment: configuration.environment, keyVersion: configuration.matchKeyVersion, name, version, scopes,
    mode, includeDatabaseNames, includeDirectory });
}

/** Bound read-side work even when an injected provider ignores cancellation. Never race an RPC write. */
function within<T>(ms: number, parent: AbortSignal, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(ms)]);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(unavailable());
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve().then(() => {
      if (signal.aborted) throw unavailable();
      return read(signal);
    }).then(value => {
      if (signal.aborted) abort();
      else resolve(value);
    }, abort).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function readCurrentBinding(claim: CatalogRefreshClaim, io: CatalogSagV2ClaimedPublicationIO, signal: AbortSignal,
  profileId?: string): Promise<SqlCatalogSourceBinding | null> {
  const rows = await io.readBindings(claim.environment, signal, claim.sourceId);
  if (signal.aborted || !Array.isArray(rows) || rows.length > 250) throw unavailable();
  let chosen: SqlCatalogSourceBinding | undefined;
  for (const row of rows) {
    if (!row || !validUuid(row.id)) throw unavailable();
    if (row.id.toLowerCase() !== claim.sourceId.toLowerCase()) continue;
    if (chosen) throw unavailable();
    chosen = row;
  }
  if (!chosen || chosen.environment !== claim.environment || chosen.role !== "sag-admin" ||
    chosen.contractVersion !== "sag_admin_v2" || chosen.state !== "active" || chosen.canReadCurrentProfile !== true) return null;
  if (!rowVersion(chosen.bindingVersion) || !rowVersion(chosen.profileRevision) ||
    typeof chosen.profileId !== "string" || !chosen.profileId.length || chosen.profileId.length > 150 ||
    chosen.profileId !== chosen.profileId.trim() || /\p{C}/u.test(chosen.profileId) ||
    typeof chosen.label !== "string") throw unavailable();
  if (chosen.bindingVersion.toLowerCase() !== claim.bindingRevision.toLowerCase() ||
    chosen.profileRevision.toLowerCase() !== claim.profileRevision.toLowerCase() ||
    (profileId !== undefined && chosen.profileId !== profileId)) return null;
  return Object.freeze({ id: chosen.id, environment: chosen.environment, role: chosen.role, contractVersion: chosen.contractVersion,
    state: chosen.state, canReadCurrentProfile: true, profileId: chosen.profileId, label: chosen.label,
    bindingVersion: chosen.bindingVersion, profileRevision: chosen.profileRevision });
}

/** Internal composition for explicitly v2-routed server claims; no HTTP or timer registration. */
export async function publishClaimedCatalogSagV2(serverClaim: CatalogRefreshClaim, io: CatalogSagV2ClaimedPublicationIO,
  environment: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<CatalogSagV2RefreshOutcome> {
  let claim: ReturnType<typeof frozenClaim>;
  let config: ReturnType<typeof readConfiguration>;
  try {
    config = readConfiguration(environment);
    claim = frozenClaim(serverClaim);
  } catch { return ineligible; }
  if (!config || !claim) return ineligible;
  if (claim.environment !== config.environment || claim.matchKeyVersion !== config.keyVersion) return stale;
  if (signal?.aborted) return cancelled;

  const budget = AbortSignal.timeout(40_000);
  const deadline = signal ? AbortSignal.any([signal, budget]) : budget;
  let matchKey: Buffer | undefined;
  try {
    const initial = await within(4_000, deadline, lookupSignal => readCurrentBinding(claim, io, lookupSignal));
    if (deadline.aborted) throw unavailable();
    if (initial === null) return stale;
    const profileId = initial.profileId;

    const secret = await within(5_000, deadline, keySignal => io.getSecret(config.name, keySignal, config.version));
    if (deadline.aborted || typeof secret !== "string" || secret.length !== 64 || !/^[a-f0-9]{64}$/i.test(secret)) throw unavailable();
    matchKey = Buffer.from(secret, "hex");

    const pool = await within(8_000, deadline, () => io.getDedicatedPool(config.environment));
    if (deadline.aborted) throw unavailable();

    // The actual orchestrator copies and wipes its own key. It rereads the SQL authority before
    // reserving, before and during SNAPSHOT, and before mutation. SQL owns the lease and commit.
    return await runCatalogSagV2Refresh({ claim, matchKey, vaultSecretVersion: config.version, scopesByCountry: config.scopes,
      ...(config.includeDatabaseNames ? { includeDatabaseNames: true as const } : {}),
      ...(config.includeDirectory ? { includeDirectory: true as const } : {}), signal: deadline }, {
      readPinnedSource: (pinned, phaseSignal) => readCurrentBinding(pinned, io, phaseSignal, profileId),
      loadTransport: (binding, phaseSignal) => io.loadTransport(binding, phaseSignal),
      publisherFor: (pinned, keyProof) => createCatalogSagV2WorkerPublisher(pool, { claim: pinned, keyProof }, config.mode),
    });
  } catch { return signal?.aborted ? cancelled : unconfirmed; }
  finally { matchKey?.fill(0); }
}
