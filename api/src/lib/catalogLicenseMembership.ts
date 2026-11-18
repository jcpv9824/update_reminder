import type { CatalogSagInventoryEvidence } from "./catalogSagInventoryEvidence";

export type CertifiedCatalogLicenseModule = Readonly<{ code: string; moduleId: string; name: string; description: string | null }>;
export type CatalogLicenseEvidence = Readonly<{
  state: "verified" | "stale" | "unavailable";
  items: readonly CatalogSagInventoryEvidence[];
  licenseModules?: readonly CertifiedCatalogLicenseModule[];
}>;

/** Internal schedule input. A missing or unmapped claim is unknown, not an empty license set. */
export function resolveCatalogLicenseModuleIds(source: CatalogLicenseEvidence,
  scope: { environment: Exclude<CatalogSagInventoryEvidence["environment"], "unknown">; domain: string }): string[] | null {
  if (source.state !== "verified" || source.items.some(row => row.environment === "unknown" ||
      (row.environment === scope.environment && !row.domainCandidate))) return null;
  const claims = source.items.filter(row => row.environment === scope.environment && row.domainCandidate === scope.domain);
  if (!claims.length) return null;
  const mappings = new Map((source.licenseModules ?? []).map(module => [module.code, module.moduleId]));
  let previous: string[] | null = null;
  for (const claim of claims) {
    if (!claim.licenseCodes) return null;
    const ids = new Set<string>();
    for (const code of claim.licenseCodes) {
      const moduleId = mappings.get(code);
      if (!moduleId) return null;
      ids.add(moduleId);
    }
    const exact = [...ids].sort();
    if (previous && (previous.length !== exact.length || previous.some((id, index) => id !== exact[index]))) return null;
    previous = exact;
  }
  return previous;
}
