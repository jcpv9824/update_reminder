import { randomUUID } from "node:crypto";
import { runCatalogGeneration, getTaskGenerationMode } from "./catalogGenerationRuntime";
import { runCatalogTaskCutoffSweep } from "./catalogTaskCutoffWorker";
import { catalogRefreshEnabled, readCatalogRefreshConfiguration, publishClaimedCatalogSource } from "./catalogSourcePublication";
import { enqueueDueCatalogRefreshSources, claimCatalogRefreshJobs, completeCatalogRefreshClaim, type CatalogRefreshClaim } from "./catalogRefreshQueueSqlRepository";

const bogotaDay = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" });
const utcNextMidnightInBogota = (day: string) => Date.parse(day) + (24 + 5) * 60 * 60 * 1000;
const dependencies = {
  enqueueDue: enqueueDueCatalogRefreshSources, claim: claimCatalogRefreshJobs,
  publish: (claim: CatalogRefreshClaim, env: NodeJS.ProcessEnv) => publishClaimedCatalogSource(claim, undefined, env),
  complete: completeCatalogRefreshClaim,
  generate: (request: { trigger: "refresh"; body: { date: string } }, env: NodeJS.ProcessEnv) =>
    runCatalogGeneration(request, undefined, env),
  cutoff: (env: NodeJS.ProcessEnv) => runCatalogTaskCutoffSweep(undefined, env),
  now: () => new Date(),
};

/** Stateless, bounded dispatch. No secret, job token, request body or exception is included in telemetry. */
export async function runCatalogRefreshTick(io = dependencies, env: NodeJS.ProcessEnv = process.env) {
  if (!catalogRefreshEnabled(env)) return null;
  const config = readCatalogRefreshConfiguration(env);
  if (!config) return { configuration: "invalid" } as const;
  const stats = { enqueued: 0, claimed: 0, published: 0, superseded: 0, cancelled: 0, failed: 0, queueErrors: 0,
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
  try { stats.enqueued = await io.enqueueDue(config); } catch { stats.queueErrors++; }
  for (let wave = 0; wave < 2; wave++) {
    let claims: CatalogRefreshClaim[];
    try { claims = await io.claim(config, workerId, 2); } catch { stats.queueErrors++; break; }
    if (!claims.length) break;
    stats.claimed += claims.length;
    changedSinceReconciliation = true;
    await Promise.all(claims.map(async claim => {
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
