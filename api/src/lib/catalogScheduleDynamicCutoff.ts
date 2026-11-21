import type { UpdateSchedule } from "../types/models";
import { scheduleActivationAt, type ScheduledTargetEvidence } from "./catalogScheduleActivation";
import type { AuthoritativeCandidateSet } from "./catalogScheduleActivationSqlRepository";
import type { CatalogScheduleHistoricalLinkProof as Link } from "./catalogScheduleHistoricalLinkProofSqlRepository";
import { resolveCatalogScheduleAssignment } from "./catalogScheduleScopes";
import { catalogAssignedUsers } from "./catalogTaskTargetPlanning";

type HistoricalPopulation = Readonly<{
  /** Full set authenticated by the historical population certificate, not by a caller filter. */
  linkIds: readonly string[];
  asOf: Date;
  validUntil: Date;
  /** Exact cutoff rows, plus separately attested retirements for explicit manual selections. */
  links: readonly Link[];
  /**
   * Confirmed existence/retirement for scope groups with no links, including
   * owners removed between planning and cutoff. Unrecorded means unknown.
   */
  ownerStates: ReadonlyMap<string, "eligible" | "absent">;
  activeLicenseIds: ReadonlySet<string>;
}>;
const held = (): AuthoritativeCandidateSet => ({ previousMembers: [], labelsByLink: new Map(), responsibles: [] });
const kinds = (value: unknown): readonly Link["kind"][] => value === "domains_and_databases" ? ["domain", "database"]
  : value === "domains_only" ? ["domain"] : value === "databases_only" ? ["database"] : [];
const validEnvironment = (value: unknown) => value === "all" || value === "production" || value === "test" || value === "demo";
const ownerDomainKey = (id: string, domain: string) => JSON.stringify([id, domain]);

/**
 * Compile one persisted definition against an independently certified historical
 * population. The transaction caller still must prove operation and role
 * access at the cutoff and pass the result through the activation writer.
 */
export function resolveCatalogScheduleDynamicCutoff(schedule: UpdateSchedule, population: HistoricalPopulation,
  /** Only the historical writer may supply a SQL-verified same-day approval. */
  sameDayApproval?: Date): AuthoritativeCandidateSet {
  const { linkIds, links, ownerStates, activeLicenseIds } = population;
  const observedAt = population.asOf.valueOf();
  const validUntil = population.validUntil.valueOf();
  if (!schedule.active || schedule.timezone !== "America/Bogota" || !Number.isSafeInteger(observedAt) ||
      !Number.isSafeInteger(validUntil) || validUntil <= observedAt || links.length > 5000 || linkIds.length > 5000 ||
      (schedule.selectionMode !== undefined && schedule.selectionMode !== "manual" && schedule.selectionMode !== "licensing")) return held();
  const lastEdit = Date.parse(schedule.updatedAt);
  if (!Number.isFinite(lastEdit) || lastEdit > observedAt) return held();
  try {
    const createdAt = Date.parse(schedule.createdAt);
    const scheduled = scheduleActivationAt(schedule.startDate, createdAt);
    if (sameDayApproval === undefined ? observedAt !== scheduled :
        (observedAt !== sameDayApproval.valueOf() || observedAt < scheduled ||
          new Date(createdAt - 5 * 3_600_000).toISOString().slice(0, 10) !== schedule.startDate ||
          new Date(observedAt - 5 * 3_600_000).toISOString().slice(0, 10) !== schedule.startDate)) return held();
  } catch { return held(); }
  const expected = new Set(linkIds);
  const witnessed = new Set<string>();
  for (const link of links) {
    if (!link.linkId || witnessed.has(link.linkId) || !validEnvironment(link.environment) ||
        (link.kind !== "domain" && link.kind !== "database") ||
        !["eligible", "absent", "unverifiable"].includes(link.state) ||
        (link.state === "eligible" ? !link.verifiedTargetId || ownerStates.get(link.clientId) === "absent" : link.verifiedTargetId !== null) ||
        (!expected.has(link.linkId) && link.state !== "absent") ||
        (expected.has(link.linkId) && link.state === "absent")) return held();
    witnessed.add(link.linkId);
  }
  if (expected.size !== linkIds.length || linkIds.some(id => !witnessed.has(id))) return held();

  const licensing = schedule.licensingScope;
  if ((schedule.selectionMode === "licensing") !== Boolean(licensing) ||
      (licensing && (schedule.scopeGroups?.length || schedule.targetIds.length))) return held();
  const groups = schedule.scopeGroups ?? [];
  const scoped = Boolean(licensing || groups.length);
  const selectedKinds = licensing ? kinds(licensing.targetTypes)
    : scoped ? kinds(schedule.manualTargetTypes ?? "domains_and_databases") : [schedule.targetType];
  const environment = licensing?.environment ?? schedule.manualEnvironment ?? "all";
  if (!selectedKinds.length || !selectedKinds.every(kind => kind === "domain" || kind === "database") ||
      !validEnvironment(environment)) return held();
  if (licensing && (licensing.activeOnly !== true || !["any", "all"].includes(licensing.licenseMatchMode) ||
      !licensing.licenseModuleIds.length || licensing.licenseModuleIds.length > 25 ||
      new Set(licensing.licenseModuleIds).size !== licensing.licenseModuleIds.length ||
      licensing.licenseModuleIds.some(id => !activeLicenseIds.has(id)))) return held();

  const ownerLinks = new Map<string, Link[]>();
  const parentLinks = new Map<string, Link[]>();
  for (const link of links) {
    const own = ownerLinks.get(link.clientId) ?? [];
    own.push(link);
    ownerLinks.set(link.clientId, own);
    if (link.kind === "domain") {
      const key = ownerDomainKey(link.clientId, link.domainId);
      const parents = parentLinks.get(key) ?? [];
      parents.push(link);
      parentLinks.set(key, parents);
    }
  }
  const sameEnvironment = (link: Link) => environment === "all" || environment === link.environment;
  const parentsFor = (link: Pick<Link, "clientId" | "domainId">) =>
    (parentLinks.get(ownerDomainKey(link.clientId, link.domainId)) ?? []).filter(sameEnvironment);
  const selected = new Map<string, Link>();
  const add = (rows: readonly Link[]) => rows.forEach(link => selected.set(link.linkId, link));
  const responsibles: AuthoritativeCandidateSet["responsibles"][number][] = [];

  for (const kind of selectedKinds) {
    const responsible = resolveCatalogScheduleAssignment(schedule, kind, scoped);
    if (!responsible || responsible.assignment.kind === "unassigned") return held();
    const assigned = responsible.assignment;
    if (assigned.kind === "role") responsibles.push({ targetKind: kind, principalKind: "role", principalId: assigned.id });
    else for (const id of catalogAssignedUsers(assigned)) responsibles.push({ targetKind: kind, principalKind: "user", principalId: id });
    const inScope = (link: Link) => link.kind === kind && sameEnvironment(link);
    if (licensing) {
      const excluded = new Set(kind === "domain" ? licensing.excludedDomainIds : licensing.excludedDatabaseIds);
      for (const link of links) {
        // An old link outside the certified active cohort cannot become a new license match.
        if (!inScope(link) || link.state === "absent" || excluded.has(link.targetId)) continue;
        const modules = link.historicalModuleIds;
        if (!modules) return held();
        const match = licensing.licenseMatchMode === "all" ? licensing.licenseModuleIds.every(id => modules.includes(id))
          : licensing.licenseModuleIds.some(id => modules.includes(id));
        if (match) add([link]);
      }
    } else if (groups.length) {
      for (const group of groups) {
        const owned = (ownerLinks.get(group.clientId) ?? []).filter(inScope);
        if (group.includeAllDomains) {
          if (!owned.length && !ownerStates.has(group.clientId)) return held();
          add(owned);
          continue;
        }
        for (const domain of group.domains) {
          const under = owned.filter(link => link.domainId === domain.domainId);
          if (kind === "domain") {
            if (!under.length) return held();
            add(under);
          } else if (domain.includeAllDatabases) {
            if (!under.length && !parentsFor({ clientId: group.clientId, domainId: domain.domainId }).some(link => link.state !== "unverifiable") &&
                ownerStates.get(group.clientId) !== "absent") return held();
            add(under);
          } else for (const id of domain.databaseIds) {
            const fixed = under.filter(link => link.targetId === id);
            if (!fixed.length) return held();
            add(fixed);
          }
        }
      }
    } else {
      if (!schedule.targetIds.length) return held();
      const owned = (ownerLinks.get(schedule.clientId) ?? []).filter(link =>
        inScope(link) && (!schedule.domainId || schedule.domainId === link.domainId));
      for (const id of schedule.targetIds) {
        const fixed = owned.filter(link => link.targetId === id);
        if (!fixed.length) return held();
        add(fixed);
      }
    }
  }
  for (const link of selected.values()) {
    if (link.state === "unverifiable") return held();
    if (link.state !== "eligible" || link.kind !== "database") continue;
    const parents = parentsFor(link);
    // A database can be selected without selecting its parent as work, but
    // must still have the exact certified owner-to-domain relationship.
    if (!parents.some(parent => parent.state === "eligible")) return held();
  }
  const targets: ScheduledTargetEvidence[] = [...selected.values()].map(({ linkId, state }) => ({ linkId, state }));
  return { labelsByLink: selected, responsibles, previousMembers: [], evidence: { complete: true, observedAt, validUntil, targets } };
}
