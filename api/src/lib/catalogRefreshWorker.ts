import { randomUUID } from "node:crypto";
import { runCatalogGeneration, getTaskGenerationMode } from "./catalogGenerationRuntime";
import { runCatalogTaskCutoffSweep } from "./catalogTaskCutoffWorker";
import { catalogRefreshEnabled, readCatalogRefreshConfiguration, publishClaimedCatalogSource } from "./catalogSourcePublication";
import { enqueueDueCatalogRefreshSources, claimCatalogRefreshJobs, completeCatalogRefreshClaim,
  type CatalogRefreshClaim, type CatalogRefreshWork } from "./catalogRefreshQueueSqlRepository";
import { prepareCatalogSagV2Publication, type PreparedCatalogSagV2Publication } from "./catalogSagV2PublicationRuntime";

const bogotaDay = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" });
const utcNextMidnightInBogota = (day: string) => Date.parse(day) + (24 + 5) * 60 * 60 * 1000;
const claimKeys = ["jobId", "workerId", "leaseToken", "sourceId", "attempt", "environment", "bindingRevision",
  "profileRevision", "matchKeyVersion"] as const;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const version = /^[0-9a-f]{16}$/i;

function readDataFields<const K extends string>(input: unknown, keys: readonly K[]): Record<K, unknown> | null {
  if (!input || typeof input !== "object" || Reflect.ownKeys(input).length !== keys.length) return null;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const fields = Object.create(null) as Record<K, unknown>;
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (!property?.enumerable || !Object.hasOwn(property, "value")) return null;
    fields[key] = property.value;
  }
  return fields;
}

function readWork(value: unknown): CatalogRefreshWork | null {
  try {
    const work = readDataFields(value, ["kind", "claim"]);
    if (work?.kind !== "legacy" && work?.kind !== "sag-v2") return null;
    const claim = readDataFields(work.claim, claimKeys);
    if (!claim || ![claim.jobId, claim.workerId, claim.leaseToken, claim.sourceId].every(id =>
      typeof id === "string" && uuid.test(id) && id !== "00000000-0000-0000-0000-000000000000") ||
      claim.environment !== "qa" && claim.environment !== "production" ||
      typeof claim.attempt !== "number" || !Number.isInteger(claim.attempt) || claim.attempt < 1 || claim.attempt > 5 ||
      typeof claim.matchKeyVersion !== "number" || !Number.isInteger(claim.matchKeyVersion) || claim.matchKeyVersion < 1 || claim.matchKeyVersion > 32767 ||
      typeof claim.bindingRevision !== "string" || !version.test(claim.bindingRevision) ||
      typeof claim.profileRevision !== "string" || !version.test(claim.profileRevision)) return null;
    return { kind: work.kind, claim: Object.freeze(claim as CatalogRefreshClaim) };
  } catch { return null; }
}
const dependencies = {
  enqueueDue: enqueueDueCatalogRefreshSources, claim: claimCatalogRefreshJobs,
  publish: (claim: CatalogRefreshClaim, env: NodeJS.ProcessEnv) => publishClaimedCatalogSource(claim, undefined, env),
  prepareSagV2: prepareCatalogSagV2Publication,
  complete: completeCatalogRefreshClaim,
  generate: (request: { trigger: "refresh"; body: { date: string } }, env: NodeJS.ProcessEnv) =>
    runCatalogGeneration(request, undefined, env),
  cutoff: (env: NodeJS.ProcessEnv) => runCatalogTaskCutoffSweep(undefined, env),
  now: () => new Date(),
};

type CatalogRefreshWorkerIO = Omit<typeof dependencies, "prepareSagV2"> & Partial<Pick<typeof dependencies, "prepareSagV2">>;

/** Stateless, bounded dispatch. No secret, job token, request body or exception is included in telemetry. */
export async function runCatalogRefreshTick(io: CatalogRefreshWorkerIO = dependencies, env: NodeJS.ProcessEnv = process.env) {
  if (!catalogRefreshEnabled(env)) return null;
  const config = readCatalogRefreshConfiguration(env);
  if (!config) return { configuration: "invalid" } as const;
  let ready: PreparedCatalogSagV2Publication | null = null;
  if (config.includeSagV2 && io.prepareSagV2) {
    try { ready = await io.prepareSagV2(env); } catch { /* ERP remains independent */ }
  }
  const readyForCurrentConfig = () => {
    try { return !!ready && env.PORTAL_CATALOG_SAG_V2_ENABLED?.trim() === "true" && ready.isCurrent(env); }
    catch { return false; }
  };
  const admission = () => ({ ...config, includeSagV2: readyForCurrentConfig() });
  const stats = { enqueued: 0, claimed: 0, published: 0, superseded: 0, cancelled: 0, failed: 0, deferred: 0, queueErrors: 0,
    generation: "skipped" as "skipped" | "evaluated" | "unverified" | "cutoff" | "failed",
    cutoff: "skipped" as "skipped" | "evaluated" | "failed", generationErrors: 0, unverifiedDays: 0, cutoffErrors: 0, closureErrors: 0 };
  let catalogGeneration = false;
  try { catalogGeneration = getTaskGenerationMode(env) === "catalog"; }
  catch { stats.generation = "failed"; stats.generationErrors++; }
  async function reconcileDay(date: string) {
    try {
      const generation = await io.generate({ trigger: "refresh", body: { date } }, env);
      stats.generation = generation.status;
      stats.closureErrors += generation.onceClosure?.failed ?? 0;
      if (stats.generation === "unverified" || stats.generation === "cutoff") stats.unverifiedDays++;
    } catch { stats.generation = "failed"; stats.generationErrors++; }
    try {
      const result = await io.cutoff(env);
      if (result) {
        stats.cutoff = result.failed ? "failed" : "evaluated";
        stats.cutoffErrors += result.failed;
      }
    } catch { stats.cutoff = "failed"; stats.cutoffErrors++; }
  }

  let earlyDay: string | undefined;
  let changedSinceReconciliation = false;
  const workerId = randomUUID();
  try { stats.enqueued = await io.enqueueDue(admission()); } catch { stats.queueErrors++; }
  for (let wave = 0; wave < 2; wave++) {
    let claims: CatalogRefreshWork[];
    try { claims = await io.claim(admission(), workerId, 2); } catch { stats.queueErrors++; break; }
    if (!claims.length) break;
    stats.claimed += claims.length;
    changedSinceReconciliation = true;
    await Promise.all(claims.map(async receipt => {
      const work = readWork(receipt);
      if (!work || work.claim.environment !== config.environment || work.claim.matchKeyVersion !== config.matchKeyVersion) {
        stats.deferred++;
        return;
      }
      if (work.kind === "sag-v2") {
        try {
          const result = ready && readyForCurrentConfig() ? await ready.publish(work.claim, env) : null;
          if (result?.queue === "settled") {
            if (result.outcome === "published" && result.jobStatus === "succeeded") { stats.published++; return; }
            if (result.outcome === "superseded" && result.jobStatus === "succeeded") { stats.superseded++; return; }
            if (result.outcome === "superseded" && result.jobStatus === "cancelled") { stats.cancelled++; return; }
            if (result.outcome === "failed-recorded" && (result.jobStatus === "retry" || result.jobStatus === "failed")) {
              stats.failed++;
              return;
            }
          }
        } catch { /* SQL could already have committed; defer to its recovery fence. */ }
        // No generic completion, retries, or fallback on *any* v2 outcome.
        stats.deferred++;
        return;
      }
      const { claim } = work;
      let outcome;
      try { outcome = await io.publish(claim, env); } catch { /* the failure is bounded and isolated to this claim */ }
      if (outcome === "published" || outcome === "superseded") {
        // The worker publisher closed the job in its own commit with the revision and audit.
        stats[outcome]++;
        return;
      }
      const stale = outcome === "stale" || outcome === "ineligible";
      stats[stale ? "cancelled" : "failed"]++;
      try { if (!await io.complete(claim, stale ? "stale" : "retry")) stats.queueErrors++; }
      catch { stats.queueErrors++; /* expiry/recovery remains durable */ }
    }));

    // Avoid losing today's post-publication observation to the second external wave at midnight.
    if (wave === 0 && catalogGeneration) {
      const now = io.now();
      const day = bogotaDay.format(now);
      if (utcNextMidnightInBogota(day) - now.valueOf() <= 45_000) {
        earlyDay = day;
        await reconcileDay(day);
        changedSinceReconciliation = false;
      }
    }
  }

  // Read Bogotá's day after publishing. A tick straddling midnight may never request a past date.
  if (catalogGeneration) {
    const today = bogotaDay.format(io.now());
    if (earlyDay !== today || changedSinceReconciliation) await reconcileDay(today);
  }
  return stats;
}
