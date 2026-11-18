import type { CatalogInventoryProofScope } from "./catalogScheduleInventory";
import type { CatalogOperationalLink } from "./catalogOperationalLinksSqlRepository";
import { readSqlCatalogSagCustomerEvidence, type CatalogSagCustomerEvidence } from "./catalogSagCustomerEvidenceSqlRepository";
import { resolveCatalogLicenseModuleIds } from "./catalogLicenseMembership";
import { normalizeCatalogSagInventoryEvidence } from "./catalogSagInventoryEvidence";

/** Planning limits, not a claim that these links cover the complete population. */
export const catalogScheduleLicenseProofLimits = Object.freeze({ links: 5000, customerSources: 500, concurrency: 4 });

export type CatalogScheduleLicenseProofScope = CatalogInventoryProofScope & Readonly<{
  /** Explicit server-trusted registry version. Never default it or accept browser input. */
  matchKeyVersion: number;
}>;
type Dependencies = { readEvidence: typeof readSqlCatalogSagCustomerEvidence };
const defaultIo: Dependencies = { readEvidence: readSqlCatalogSagCustomerEvidence };
const uuid = (value: unknown): value is string => typeof value === "string" && value.length === 36
  && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const version = (value: unknown): value is string => typeof value === "string" && value.length === 16 && /^[0-9a-f]{16}$/.test(value);
const safeText = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 150 && value === value.trim() && !/\p{C}/u.test(value);
const fail = (): never => { throw new Error("catalog_schedule_license_scope_unavailable"); };

function verifiedSource(link: CatalogOperationalLink, checkedAt: number): string | null {
  const proof = link.evidence;
  if (!uuid(link.catalogCustomerId) || !proof || proof.state !== "verified" || !uuid(proof.sourceId)
    || typeof proof.revisionId !== "string" || proof.revisionId !== proof.revisionId.trim() || !/^[1-9][0-9]{0,18}$/.test(proof.revisionId)
    || BigInt(proof.revisionId) > 9223372036854775807n || !version(proof.bindingVersion) || !version(proof.profileVersion)
    || typeof proof.verifiedUntil !== "string" || !Number.isFinite(Date.parse(proof.verifiedUntil))
    || Date.parse(proof.verifiedUntil) <= Math.max(checkedAt, Date.now())) return null;
  return proof.sourceId;
}

/**
 * Only an explicit HTTPS DNS authority/root has an unambiguous hostname scope.
 * Do not reuse display-format helpers that silently remove credentials, ports,
 * arbitrary paths or malformed bytes. No network/DNS resolution is performed.
 */
function domainHostname(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500 || value !== value.trim() || /\s|\p{C}/u.test(value)) return null;
  const match = /^https:\/\/([A-Za-z0-9.-]+)\/?$/.exec(value);
  if (!match) return null;
  const candidate = normalizeCatalogSagInventoryEvidence({ domainCandidate: match[1], environment: "production",
    licenseCodes: [], testStartedOn: null, productionStartedOn: null, demoStartedOn: null }, "9999-12-31").domainCandidate;
  if (!candidate) return null;
  try { return new URL(value).hostname === candidate ? candidate : null; } catch { return null; }
}

/** Defensive checks retain the SQL reader's bounded, canonical contract. */
function verifiedEvidence(evidence: CatalogSagCustomerEvidence | null): evidence is CatalogSagCustomerEvidence {
  if (!evidence || evidence.state !== "verified" || typeof evidence.verifiedAt !== "string"
    || !Number.isFinite(Date.parse(evidence.verifiedAt)) || Date.parse(evidence.verifiedAt) > Date.now()
    || !Array.isArray(evidence.items) || evidence.items.length > 128) return false;
  const scopes = new Set<string>();
  for (const item of evidence.items) {
    if (!item || typeof item !== "object") return false;
    const normalized = normalizeCatalogSagInventoryEvidence(item, "9999-12-31");
    if (normalized.domainCandidate !== item.domainCandidate || normalized.environment !== item.environment
      || normalized.testStartedOn !== item.testStartedOn || normalized.productionStartedOn !== item.productionStartedOn
      || normalized.demoStartedOn !== item.demoStartedOn
      || JSON.stringify(normalized.licenseCodes) !== JSON.stringify(item.licenseCodes)) return false;
    // Multiple equal claims are still ambiguous; never deduplicate them into a grant.
    const key = JSON.stringify([item.environment, item.domainCandidate]);
    if (scopes.has(key)) return false;
    scopes.add(key);
  }
  if (evidence.licenseModules !== undefined && (!Array.isArray(evidence.licenseModules) || evidence.licenseModules.length > 25)) return false;
  const codes = new Set<string>();
  for (const module of evidence.licenseModules ?? []) {
    if (!module || typeof module.code !== "string" || module.code.length !== 1 || !/^[A-SU-Z]$/.test(module.code)
      || codes.has(module.code) || !safeText(module.moduleId)) return false;
    codes.add(module.code);
  }
  return true;
}

/**
 * Internal planning-only license adapter. Each call reads at most 500 unique
 * opaque-customer/verified-ERP-source pairs with at most four concurrent SQL
 * reads, caching both success and failure only for this invocation. It never
 * widens allowedSourceIds beyond the one source proven by the exact 042 link.
 *
 * null means held/unknown; [] is reserved for a single exact verified claim with
 * explicitly empty licenseCodes. Missing, stale, duplicate, malformed, expired,
 * unmapped or failed observations never become []. Group overflow holds ALL
 * links without reads; invalid scope/duplicate IDs/link-count overflow throws a
 * sanitized error before reads (callers must abort/hold, never replace it by []).
 *
 * NOT sufficient for real task registration: the existing SAG evidence DTO has
 * no ERP/SAG revision/version/expiry or mapping witness. A final SQL mutation
 * must independently recheck exact customer+ERP record, 042/physical evidence,
 * both current source heads, match-key enrollment, the single hostname/env SAG
 * row and every version-bound module approval under its transaction. No endpoint,
 * timer, coverage certification, SQL mutation or persistent cache is wired here.
 */
export async function readCatalogScheduleLicenseProof(
  scope: CatalogScheduleLicenseProofScope,
  io: Dependencies = defaultIo,
): Promise<ReadonlyMap<string, readonly string[] | null>> {
  if (!scope || (scope.portalEnvironment !== "qa" && scope.portalEnvironment !== "production")
    || !Number.isInteger(scope.matchKeyVersion) || scope.matchKeyVersion < 1 || scope.matchKeyVersion > 32767
    || !(scope.checkedAt instanceof Date) || !Number.isFinite(scope.checkedAt.valueOf())
    || !Array.isArray(scope.links) || scope.links.length > catalogScheduleLicenseProofLimits.links) return fail();
  const result = new Map<string, readonly string[] | null>();
  type Entry = { link: CatalogOperationalLink; hostname: string; sourceId: string };
  type Group = { customerId: string; sourceId: string; entries: Entry[]; evidence: CatalogSagCustomerEvidence | null };
  const groups = new Map<string, Group>();
  for (const link of scope.links) {
    if (!link || !uuid(link.linkId) || result.has(link.linkId)) return fail();
    result.set(link.linkId, null);
    const sourceId = verifiedSource(link, scope.checkedAt.valueOf());
    const hostname = domainHostname(link.domainName);
    if (!sourceId || !hostname || !["production", "test", "demo"].includes(link.environment)
      || (link.kind !== "domain" && link.kind !== "database")) continue;
    const key = JSON.stringify([link.catalogCustomerId, sourceId]);
    let group = groups.get(key);
    if (!group) {
      group = { customerId: link.catalogCustomerId, sourceId, entries: [], evidence: null };
      groups.set(key, group);
    }
    group.entries.push({ link, hostname, sourceId });
  }
  if (groups.size > catalogScheduleLicenseProofLimits.customerSources) return result;
  const work = [...groups.values()];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(catalogScheduleLicenseProofLimits.concurrency, work.length) }, async () => {
    while (next < work.length) {
      const group = work[next++];
      // A queued group can lose its 042 proof while earlier reads are in flight.
      if (!group.entries.some(({ link, sourceId }) => verifiedSource(link, scope.checkedAt.valueOf()) === sourceId)) continue;
      try {
        const evidence = await io.readEvidence({ customerId: group.customerId, environment: scope.portalEnvironment,
          matchKeyVersion: scope.matchKeyVersion, allowedSourceIds: new Set([group.sourceId]) });
        group.evidence = verifiedEvidence(evidence) ? evidence : null;
      } catch {
        // Do not log provider messages, customer identity or evidence payloads.
        group.evidence = null;
      }
    }
  }));
  for (const group of work) {
    if (!group.evidence) continue;
    for (const { link, hostname, sourceId } of group.entries) {
      // Recheck after ALL awaited reads: cached planning evidence must not revive
      // an operational approval that expired while another group was queried.
      if (verifiedSource(link, scope.checkedAt.valueOf()) !== sourceId) continue;
      const modules = resolveCatalogLicenseModuleIds(group.evidence, { domain: hostname, environment: link.environment });
      result.set(link.linkId, modules === null ? null : [...modules]);
    }
  }
  return result;
}
