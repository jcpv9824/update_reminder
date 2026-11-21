import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { completeCatalogFrozenOnceCandidate, completeSqlCatalogOnceSchedule, reserveCatalogFrozenOnceCandidates,
  reserveSqlCatalogOnceClosureCandidates } from "./catalogOnceClosureSqlRepository";

export type CatalogOnceClosureSummary = Readonly<{ checked: number; completed: number; skipped: number; failed: number }>;
const dependencies = { reserve: reserveSqlCatalogOnceClosureCandidates, complete: completeSqlCatalogOnceSchedule,
  frozen: { reserve: reserveCatalogFrozenOnceCandidates, complete: completeCatalogFrozenOnceCandidate,
    cursors: new Map<CatalogEnvironment,string>() } };

/** Internal catalog-mode worker; no browser dates/identities and no legacy fallback. */
export async function runCatalogOnceClosureSweep(portalEnvironment: CatalogEnvironment,
  io: Omit<typeof dependencies,"frozen"> & Partial<Pick<typeof dependencies,"frozen">> = dependencies): Promise<CatalogOnceClosureSummary> {
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
  let checked = candidates.length;
  if (io.frozen && process.env.PORTAL_CATALOG_SCHEDULE_LIFECYCLE_ENABLED === "true") {
    const phase = io.frozen;
    try {
      const selected = await phase.reserve(portalEnvironment, phase.cursors.get(portalEnvironment) ?? "0");
      checked += selected.length;
      for (const candidate of selected) {
        try { if (await phase.complete(portalEnvironment, candidate)) completed++; else skipped++; }
        catch { failed++; }
      }
      if (selected.length < 50) phase.cursors.delete(portalEnvironment);
      else phase.cursors.set(portalEnvironment, selected[selected.length-1].scheduleKey);
    } catch { failed++; }
  }
  return { checked, completed, skipped, failed };
}
