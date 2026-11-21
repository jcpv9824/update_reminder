import type { UpdateSchedule } from "../types/models";
import { generateCatalogScheduleDay, type CatalogScheduleDay, type CatalogScheduleRule } from "./catalogScheduleDay";
import type { CatalogTaskAssignment, CatalogTaskKind, CatalogTaskLink } from "./catalogTaskTargetPlanning";
import { isScheduleDueOnDate } from "./scheduleEngine";
import { inferScheduleRole } from "./scheduleService";
import { readSqlCatalogScheduleRoster } from "./schedulingSqlRepository";

type Roster = Awaited<ReturnType<typeof readSqlCatalogScheduleRoster>>;
type PersistedDay = Omit<CatalogScheduleDay, "rules"> & {
  /** Operations are confirmed server-side, never inferred from the schedule name. */
  operationsBySchedule: ReadonlyMap<string, { operationId: string; scheduleVersion: string }>;
  activeLicenseIds: ReadonlySet<string>;
};
type DayScopePlan = { status: "unverified" } | { status: "ready"; rules: CatalogScheduleRule[]; missingSelections: number };
const targetId = (link: CatalogTaskLink) => link.databaseId ?? link.domainId;
const key = (...values: string[]) => JSON.stringify(values);
const kinds = (value: string): CatalogTaskKind[] => value === "domains_only" ? ["domain"]
  : value === "databases_only" ? ["database"] : value === "domains_and_databases" ? ["domain", "database"] : [];

/** Translate only persisted server-authorized scopes; apply logical filters before physical deduplication. */
export function compileCatalogScheduleScopes(input: PersistedDay, roster: Roster): DayScopePlan {
  const manual = new Set(input.manualScheduleIds);
  const links = input.inventory.map(item => item.link);
  const knownCustomers = new Set<string>();
  const byOwner = new Map<string, CatalogTaskLink[]>();
  const domainLinks = new Map<string, CatalogTaskLink[]>();
  for (const link of links) {
    knownCustomers.add(link.customerId);
    const owner = key(link.customerId, link.kind);
    const group = byOwner.get(owner) ?? [];
    group.push(link);
    byOwner.set(owner, group);
    if (link.kind === "domain") {
      const domain = key(link.customerId, link.domainId);
      const parents = domainLinks.get(domain) ?? [];
      parents.push(link);
      domainLinks.set(domain, parents);
    }
  }
  const rules: CatalogScheduleRule[] = [];
  const missing = new Set<string>();
  const acceptedManual = new Set<string>();
  const seen = new Set<string>();
  for (const { schedule, version, activation, copyLinks, draftLinks, draftOrigin } of roster) {
    if (!schedule.active) continue;
    if (schedule.frequencyType === "manual") {
      if (!manual.has(schedule.id) || input.date < schedule.startDate ||
        (schedule.endDate && input.date > schedule.endDate)) continue;
      acceptedManual.add(schedule.id);
    } else if (!isScheduleDueOnDate(schedule, input.date)) continue;
    const operation = input.operationsBySchedule.get(schedule.id);
    if (!operation?.operationId.trim() || operation.scheduleVersion !== version || seen.has(schedule.id)) return { status: "unverified" };
    const { operationId } = operation;
    if ((draftLinks && (!draftOrigin?.manual || copyLinks)) || (draftOrigin && (copyLinks || activation === undefined ||
        draftOrigin.manual !== Boolean(draftLinks) || draftOrigin.version !== version ||
        draftOrigin.environment !== input.portalEnvironment || draftOrigin.operationId !== operationId))) return { status: "unverified" };
    const exactLinks = copyLinks ?? draftLinks;
    seen.add(schedule.id);
    const calendar = { ...schedule, version };
    const licensing = schedule.selectionMode === "licensing" ? schedule.licensingScope : undefined;
    const manualEnvironment = schedule.manualEnvironment ?? "all";
    if (!["all", "production", "test", "demo"].includes(manualEnvironment)) return { status: "unverified" };
    const manualMatches = (link: CatalogTaskLink) => manualEnvironment === "all" ||
      (link.environment === manualEnvironment && (link.kind === "domain" ||
        domainLinks.get(key(link.customerId, link.domainId))?.some(parent => parent.environment === manualEnvironment && parent.state === "active")));
    const scoped = Boolean(licensing || schedule.scopeGroups?.length);
    if ((schedule.selectionMode === "licensing" && !licensing) || (licensing && schedule.scopeGroups?.length)) {
      return { status: "unverified" };
    }
    const selectedKinds = exactLinks ? [...new Set(exactLinks.map(link => link.kind))] : licensing ? kinds(licensing.targetTypes) : scoped
      ? kinds(schedule.manualTargetTypes ?? "domains_and_databases") : [schedule.targetType];
    if (!selectedKinds.length) return { status: "unverified" };
    if (exactLinks && (licensing || activation === undefined || schedule.targetIds.length > 0 || schedule.scopeGroups?.length)) return { status: "unverified" };
    const copyPins = exactLinks && new Map(exactLinks.map(link => [link.linkId, link]));
    if (copyPins && activation?.targets.some(target => {
      const initial = copyPins.get(target.linkId);
      return !initial || initial.kind !== target.kind || initial.targetId !== target.targetId;
    })) return { status: "unverified" };
    if (licensing && (!licensing.licenseModuleIds.length || !["any", "all"].includes(licensing.licenseMatchMode) ||
        !["all", "production", "test", "demo"].includes(licensing.environment))) return { status: "unverified" };
    if (activation !== undefined) {
      if (activation && (activation.environment !== input.portalEnvironment || activation.version !== version ||
        activation.targets.some(target => !selectedKinds.includes(target.kind)))) return { status: "unverified" };
      if (!activation || activation.phase === "held") missing.add(key(schedule.id, "activation_unverified"));
      for (const kind of selectedKinds) {
        const prior = resolveCatalogScheduleAssignment(schedule, kind, scoped || Boolean(exactLinks));
        const frozenTargets = activation?.phase === "frozen" ? activation.targets.filter(target => target.kind === kind) : [];
        const principals = activation?.principals.filter(principal => principal.kind === kind) ?? [];
        const role = principals.length === 1 && principals[0].principalKind === "role" ? principals[0].id : undefined;
        const users = principals.every(principal => principal.principalKind === "user")
          ? [...new Set(principals.map(principal => principal.id))].sort() : [];
        if (!prior || (frozenTargets.length > 0 && !role && (!users.length || users.length > 100))) return { status: "unverified" };
        const responsible: CatalogTaskAssignment = role ? { kind: "role", id: role } : users.length
          ? { kind: "users", ids: users } : prior.assignment;
        rules.push({ calendar, operationId, assignment: responsible, workflowRole: role ?? prior.workflowRole, closeFromActivation: true,
          ...(activation?.phase !== "frozen" && { oneTimeSelectionIncomplete: true as const }),
          scope: { kind, linkIds: frozenTargets.map(target => target.linkId),
            frozenTargetIds: new Map(frozenTargets.map(target => [target.linkId, target.targetId])),
            // The cohort is fixed; the current authorization needed to execute still applies.
            ...(licensing && frozenTargets.length > 0 && { modules: { mode: licensing.licenseMatchMode, ids: licensing.licenseModuleIds } }) } });
      }
      continue;
    }
    if (licensing?.licenseModuleIds.some(id => !input.activeLicenseIds.has(id))) return { status: "unverified" };

    for (const kind of selectedKinds) {
      const responsible = resolveCatalogScheduleAssignment(schedule, kind, scoped);
      if (responsible === null) return { status: "unverified" };
      const selected = new Set<string>();
      let selectionIncomplete = false;
      const add = (found: CatalogTaskLink[]) => found.forEach(link => selected.add(link.linkId));
      const addFixed = (sources: CatalogTaskLink[], id: string, owner: string, domain = "") => {
        const found = sources.filter(link => targetId(link) === id);
        if (!found.length) missing.add(key(schedule.id, kind, owner, domain, id));
        if (!found.length || found.some(link => link.state === "inactive")) selectionIncomplete = true;
        add(found);
      };
      if (licensing) {
        const excluded = new Set(kind === "domain" ? licensing.excludedDomainIds : licensing.excludedDatabaseIds);
        const environmentMatches = (link: CatalogTaskLink) => licensing.environment === "all" || link.environment === licensing.environment;
        add(links.filter(link => {
          if (link.kind !== kind || excluded.has(targetId(link)) || !environmentMatches(link)) return false;
          if (link.kind === "domain") return true;
          // The licensing scope applies the environment to both the database and its exact parent domain.
          const parents = domainLinks.get(key(link.customerId, link.domainId));
          const covered = parents?.filter(environmentMatches) ?? [];
          if (covered.some(parent => parent.state === "active")) return true;
          if (!parents?.length || covered.some(parent => parent.state === "unverifiable")) {
            missing.add(key(schedule.id, "parent_unverified", link.linkId));
            // Count holds as before. For completeness, known dynamically excluded choices
            // cannot require a parent, but an unknown module result cannot prove exclusion.
            const modules = link.moduleIds;
            if (link.state !== "inactive" && (modules === null || (licensing.licenseMatchMode === "all"
              ? licensing.licenseModuleIds.every(id => modules.includes(id))
              : licensing.licenseModuleIds.some(id => modules.includes(id))))) selectionIncomplete = true;
          }
          return false;
        }));
      } else if (schedule.scopeGroups?.length) {
        for (const group of schedule.scopeGroups) {
          const owned = (byOwner.get(key(group.clientId, kind)) ?? []).filter(manualMatches);
          if (group.includeAllDomains) {
            if (!knownCustomers.has(group.clientId)) selectionIncomplete = true;
            add(owned);
            continue;
          }
          for (const domain of group.domains) {
            const underDomain = owned.filter(link => link.domainId === domain.domainId);
            if (kind === "domain") addFixed(underDomain, domain.domainId, group.clientId, domain.domainId);
            else if (domain.includeAllDatabases) {
              const parents = domainLinks.get(key(group.clientId, domain.domainId))?.filter(manualMatches);
              if (!parents?.some(parent => parent.state === "active") ||
                  parents.some(parent => parent.state === "unverifiable")) selectionIncomplete = true;
              add(underDomain);
            }
            else for (const id of domain.databaseIds) addFixed(underDomain, id, group.clientId, domain.domainId);
          }
        }
      } else {
        const owned = (byOwner.get(key(schedule.clientId, kind)) ?? [])
          .filter(link => manualMatches(link) && (!schedule.domainId || link.domainId === schedule.domainId));
        for (const id of schedule.targetIds) addFixed(owned, id, schedule.clientId, schedule.domainId);
      }
      rules.push({ calendar, operationId, ...responsible,
        ...(calendar.frequencyType === "once" && selectionIncomplete ? { oneTimeSelectionIncomplete: true as const } : {}),
        scope: { kind, linkIds: [...selected].sort(),
        ...(licensing ? { modules: { mode: licensing.licenseMatchMode, ids: licensing.licenseModuleIds } } : {}) } });
    }
  }
  if (acceptedManual.size !== manual.size) throw new Error("invalid_catalog_manual_schedule");
  return { status: "ready", rules, missingSelections: missing.size };
}

export function resolveCatalogScheduleAssignment(schedule: UpdateSchedule, kind: CatalogTaskKind, scoped: boolean):
  { assignment: CatalogTaskAssignment; workflowRole: string } | null {
  if (schedule.assignmentMode !== undefined && schedule.assignmentMode !== "role" && schedule.assignmentMode !== "users") return null;
  const workflowRole = scoped
    ? (kind === "domain" ? schedule.domainAssignedRole : schedule.databaseAssignedRole) ?? inferScheduleRole(kind)
    : schedule.assignedRole;
  if (!workflowRole?.trim()) return null;
  const storedUsers = scoped && kind === "database" ? schedule.databaseAssignedUserIds : schedule.assignedUserIds;
  // The flat legacy task used its explicit assignees even without a normalized assignment mode.
  if (schedule.assignmentMode !== "users" && (scoped || !storedUsers?.length)) {
    return { assignment: { kind: "role", id: workflowRole }, workflowRole };
  }
  const ids = [...new Set(storedUsers)].sort();
  if (!ids.length || ids.length > 100 || ids.some(id => !id?.trim())) return null;
  return { assignment: { kind: "users", ids }, workflowRole };
}

/** An exact selection uses its saved links, not a broader legacy scope or a past activation. */
export function compileExactCopyProposal(row: Roster[number], date: string, operationId: string): DayScopePlan {
  const { schedule, version, draftOrigin } = row;
  if (draftOrigin && (!draftOrigin.manual || draftOrigin.version !== version || draftOrigin.operationId !== operationId || row.copyLinks))
    return { status: "unverified" };
  const copyLinks = row.copyLinks ?? (draftOrigin?.manual ? row.draftLinks : undefined);
  if (!copyLinks?.length || schedule.selectionMode === "licensing" || schedule.targetIds.length || schedule.scopeGroups?.length ||
      !operationId.trim()) return { status: "unverified" };
  const rules: CatalogScheduleRule[] = [];
  for (const kind of [...new Set(copyLinks.map(link => link.kind))]) {
    const links = copyLinks.filter(link => link.kind === kind);
    const responsible = resolveCatalogScheduleAssignment(schedule, kind, true);
    if (!responsible) return { status: "unverified" };
    rules.push({ calendar: { ...schedule, version, startDate: date, endDate: null, frequencyType: "once" },
      operationId, ...responsible, scope: { kind, linkIds: links.map(link => link.linkId),
        frozenTargetIds: new Map(links.map(link => [link.linkId, link.targetId])) } });
  }
  return { status: "ready", missingSelections: 0, rules };
}

/** Service only; callers supply a complete certified revision and authorized manual schedule IDs. */
export async function generateCatalogPersistedScheduleDay(input: PersistedDay, io = {
  readRoster: readSqlCatalogScheduleRoster, generate: generateCatalogScheduleDay,
}) {
  if (!input.revision.complete || input.checkedAt >= input.cutoffAt) return io.generate({ ...input, rules: [] });
  const compiled = compileCatalogScheduleScopes(input, await io.readRoster(input.date));
  if (compiled.status !== "ready") return { status: "unverified" as const };
  const result = await io.generate({ ...input, rules: compiled.rules });
  return result.status === "evaluated" ? { ...result, held: result.held + compiled.missingSelections } : result;
}
