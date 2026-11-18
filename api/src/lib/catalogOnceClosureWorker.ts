import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { completeSqlCatalogOnceSchedule, reserveSqlCatalogOnceClosureCandidates } from "./catalogOnceClosureSqlRepository";

export type CatalogOnceClosureSummary = Readonly<{ checked: number; completed: number; skipped: number; failed: number }>;
const dependencies = { reserve: reserveSqlCatalogOnceClosureCandidates, complete: completeSqlCatalogOnceSchedule };

/** Internal catalog-mode worker; no browser dates/identities and no legacy fallback. */
export async function runCatalogOnceClosureSweep(portalEnvironment: CatalogEnvironment,
  io = dependencies): Promise<CatalogOnceClosureSummary> {
  if (portalEnvironment !== "qa" && portalEnvironment !== "production") throw new Error("catalog_once_candidates_invalid");
  const candidates = await io.reserve(portalEnvironment, 50);
  const seen = new Set<string>();
  if (!Array.isArray(candidates) || candidates.length > 50 || candidates.some(candidate => {
    if (!candidate || candidate.portalEnvironment !== portalEnvironment || typeof candidate.taskDate !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(candidate.taskDate) || !Number.isFinite(Date.parse(candidate.taskDate)) ||
        new Date(candidate.taskDate).toISOString().slice(0, 10) !== candidate.taskDate ||
        typeof candidate.observationKey !== "string" || !/^[1-9][0-9]{0,18}$/.test(candidate.observationKey) ||
        BigInt(candidate.observationKey) > 9223372036854775807n || seen.has(candidate.observationKey)) return true;
    seen.add(candidate.observationKey);
    return false;
  })) throw new Error("catalog_once_candidates_invalid");
  let completed = 0, skipped = 0, failed = 0;
  for (const candidate of candidates) {
    try { if (await io.complete(candidate)) completed++; else skipped++; }
    catch { failed++; }
  }
  return { checked: candidates.length, completed, skipped, failed };
}
