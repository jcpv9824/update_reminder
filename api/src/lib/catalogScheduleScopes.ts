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
  const byOwner = new Map<string, CatalogTaskLink[]>();
  const domainLinks = new Map<string, CatalogTaskLink[]>();
  for (const link of links) {
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
  for (const { schedule, version } of roster) {
    if (!schedule.active) continue;
    if (schedule.frequencyType === "manual") {
      if (!manual.has(schedule.id) || input.date < schedule.startDate ||
        (schedule.endDate && input.date > schedule.endDate)) continue;
      acceptedManual.add(schedule.id);
    } else if (!isScheduleDueOnDate(schedule, input.date)) continue;
    const operation = input.operationsBySchedule.get(schedule.id);
    if (!operation?.operationId.trim() || operation.scheduleVersion !== version || seen.has(schedule.id)) return { status: "unverified" };
    const { operationId } = operation;
    seen.add(schedule.id);
    const calendar = { ...schedule, version };
    const licensing = schedule.selectionMode === "licensing" ? schedule.licensingScope : undefined;
    const scoped = Boolean(licensing || schedule.scopeGroups?.length);
    if ((schedule.selectionMode === "licensing" && !licensing) || (licensing && schedule.scopeGroups?.length)) {
      return { status: "unverified" };
    }
    const selectedKinds = licensing ? kinds(licensing.targetTypes) : scoped
      ? kinds(schedule.manualTargetTypes ?? "domains_and_databases") : [schedule.targetType];
    if (!selectedKinds.length) return { status: "unverified" };
    if (licensing && (!licensing.licenseModuleIds.length || licensing.licenseModuleIds.some(id => !input.activeLicenseIds.has(id)) ||
        !["any", "all"].includes(licensing.licenseMatchMode) ||
        !["all", "production", "test", "demo"].includes(licensing.environment))) return { status: "unverified" };

    for (const kind of selectedKinds) {
      const responsible = assignment(schedule, kind, scoped);
      if (responsible === null) return { status: "unverified" };
      const selected = new Set<string>();
      const add = (found: CatalogTaskLink[]) => found.forEach(link => selected.add(link.linkId));
      const addFixed = (sources: CatalogTaskLink[], id: string, owner: string, domain = "") => {
        const found = sources.filter(link => targetId(link) === id);
        if (!found.length) missing.add(key(schedule.id, kind, owner, domain, id));
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
          }
          return false;
        }));
      } else if (schedule.scopeGroups?.length) {
        for (const group of schedule.scopeGroups) {
          const owned = byOwner.get(key(group.clientId, kind)) ?? [];
          if (group.includeAllDomains) { add(owned); continue; }
          for (const domain of group.domains) {
            const underDomain = owned.filter(link => link.domainId === domain.domainId);
            if (kind === "domain") addFixed(underDomain, domain.domainId, group.clientId, domain.domainId);
            else if (domain.includeAllDatabases) add(underDomain);
            else for (const id of domain.databaseIds) addFixed(underDomain, id, group.clientId, domain.domainId);
          }
        }
      } else {
        const owned = (byOwner.get(key(schedule.clientId, kind)) ?? [])
          .filter(link => !schedule.domainId || link.domainId === schedule.domainId);
        for (const id of schedule.targetIds) addFixed(owned, id, schedule.clientId, schedule.domainId);
      }
      rules.push({ calendar, operationId, ...responsible, scope: { kind, linkIds: [...selected].sort(),
        ...(licensing ? { modules: { mode: licensing.licenseMatchMode, ids: licensing.licenseModuleIds } } : {}) } });
    }
  }
  if (acceptedManual.size !== manual.size) throw new Error("invalid_catalog_manual_schedule");
  return { status: "ready", rules, missingSelections: missing.size };
}

function assignment(schedule: UpdateSchedule, kind: CatalogTaskKind, scoped: boolean):
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
