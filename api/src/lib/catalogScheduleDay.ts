import type { UpdateTask } from "../types/models";
import { registerSqlCatalogTaskExecution, type CatalogExecutionSourceEvidence } from "./catalogExecutionRegistrationSqlRepository";
import { readSqlCatalogPhysicalTargets, planCatalogTasksWithVerifiedTargets } from "./catalogPhysicalTargetSqlRepository";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { catalogAssignedUsers, type CatalogTaskKind, type CatalogTaskLink, type CatalogTaskRequest } from "./catalogTaskTargetPlanning";
import { getTaskDateBucket, isScheduleDueOnDate, type CalendarSchedule } from "./scheduleEngine";
import { catalogPopulationRevisionPrefix } from "./catalogSchedulePopulationCoverage";
import { runSqlCatalogScheduleDayTransaction, type CatalogScheduleDayTransactionContext } from "./catalogScheduleDayTransaction";
import { recordSqlCatalogOnceObservationsInTransaction } from "./catalogOnceObservationSqlRepository";

export type CatalogScheduleRule = Omit<CatalogTaskRequest, "scheduleId"> & {
  calendar: CalendarSchedule & { id: string; timezone: string; version: string };
  /** Required by SQL workflow; explicit person assignment still takes precedence. */
  workflowRole: string;
  /** A persisted selection could not be reconstructed fully; this does not change task eligibility. */
  oneTimeSelectionIncomplete?: true;
};

type CatalogOneTimeSchedulePair = Readonly<{ linkId: string; executionKey: string }>;
export type CatalogOneTimeScheduleObservation = Readonly<{
  scheduleId: string;
  scheduleVersion: string;
  operationId: string;
  /** null explicitly invalidates proof for this occurrence; an empty proof is never emitted. */
  pairs: readonly CatalogOneTimeSchedulePair[] | null;
}>;

export type CatalogScheduleDay = {
  date: string;
  portalEnvironment: CatalogEnvironment;
  /** Same server-trusted match-key enrollment used to resolve licensed modules. */
  matchKeyVersion?: number;
  checkedAt: Date;
  /** Original business cutoff from the trusted schedule occurrence, never from HTTP. */
  cutoffAt: Date;
  revision: { id: string; complete: boolean };
  /** Original complete input, retained for the atomic SQL re-read after external planning. */
  populationFence?: Pick<CatalogScheduleDayTransactionContext, "scope" | "roster" | "manualIntents">;
  rules: readonly CatalogScheduleRule[];
  inventory: readonly { link: CatalogTaskLink; sourceId: string | null;
    sourceEvidence?: CatalogExecutionSourceEvidence;
    clientName: string; domainName: string; targetName: string }[];
  /** Already authorized by caller; a generic refresh leaves this absent. */
  manualScheduleIds?: readonly string[];
};

type DayResult = { status: "cutoff" | "unverified" } | { status: "evaluated";
  registered: number; existing: number; held: number; conflicts: number; accountedOrigins?: number };
const dependencies = { resolve: readSqlCatalogPhysicalTargets, register: registerSqlCatalogTaskExecution };
type CatalogScheduleDayIO = typeof dependencies & {
  /** Supplied by the certified SQL day transaction only; no standalone persistence. */
  observeOneTimeSchedules?: (observations: readonly CatalogOneTimeScheduleObservation[]) => Promise<void>;
};
const ruleKey = (scheduleId: string, kind: CatalogTaskKind) => JSON.stringify([scheduleId, kind]);
const validDay = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date))
  && new Date(date).toISOString().slice(0, 10) === date;
// The workflow stores a 240-unit display label separately from the 500-unit domain name.
const webTargetLabel = (name: string) => name.length <= 240 ? name : name.slice(0, 239).replace(/[\uD800-\uDBFF]$/, "") + "…";

type OneTimeScope = Omit<CatalogOneTimeScheduleObservation, "pairs"> & {
  invalid: boolean;
  kinds: Set<CatalogTaskKind>;
  pairs: Map<string, string>;
};

/** Collect one nonempty all-or-nothing set per schedule, not one row per deduplicated task. */
function collectOneTimeScheduleObservations(rules: readonly CatalogScheduleRule[]) {
  const scopes = new Map<string, OneTimeScope>();
  for (const rule of rules) {
    const { calendar, operationId } = rule;
    if (calendar.frequencyType !== "once") continue;
    const scope = scopes.get(calendar.id) ?? {
      scheduleId: calendar.id, scheduleVersion: calendar.version, operationId,
      invalid: false, kinds: new Set<CatalogTaskKind>(), pairs: new Map<string, string>(),
    };
    if (rule.oneTimeSelectionIncomplete || !operationId.trim() || scope.operationId !== operationId ||
        scope.scheduleVersion !== calendar.version || scope.kinds.has(rule.scope.kind)) scope.invalid = true;
    scope.kinds.add(rule.scope.kind);
    scopes.set(calendar.id, scope);
  }
  return {
    invalidate(scheduleId: string) {
      const scope = scopes.get(scheduleId);
      if (scope) scope.invalid = true;
    },
    verify(scheduleId: string, operationId: string, linkId: string, executionKey: string) {
      const scope = scopes.get(scheduleId);
      if (!scope || scope.invalid) return;
      if (scope.operationId !== operationId || scope.pairs.has(linkId)) scope.invalid = true;
      else scope.pairs.set(linkId, executionKey);
    },
    observations(): CatalogOneTimeScheduleObservation[] {
      return [...scopes.keys()].sort().map(id => {
        const { scheduleId, scheduleVersion, operationId, invalid, pairs } = scopes.get(id)!;
        return { scheduleId, scheduleVersion, operationId, pairs: invalid || !pairs.size ? null
          : [...pairs.keys()].sort().map(linkId => ({ linkId, executionKey: pairs.get(linkId)! })) };
      });
    },
  };
}

/**
 * Runs one Bogotá business date using the full trusted roster, not browser-provided targets.
 * Legacy task cleanup and schedule completion are deliberately not part of registration.
 */
export async function generateCatalogScheduleDay(input: CatalogScheduleDay, io?: CatalogScheduleDayIO): Promise<DayResult> {
  if (!validDay(input.date) || !Number.isFinite(input.checkedAt.valueOf()) || !Number.isFinite(input.cutoffAt.valueOf())
    || input.inventory.length > 5000 || input.rules.length > 5000) throw new Error("invalid_catalog_schedule_day");
  if (input.checkedAt >= input.cutoffAt) return { status: "cutoff" };
  if (!input.revision.complete) return { status: "unverified" };
  if (!io && input.revision.id.startsWith(catalogPopulationRevisionPrefix)) {
    if (!input.populationFence || input.populationFence.scope.portalEnvironment !== input.portalEnvironment ||
      new Set(input.manualScheduleIds).size !== input.populationFence.manualIntents.size ||
      input.manualScheduleIds?.some(id => !input.populationFence!.manualIntents.has(id))) {
      return { status: "unverified" };
    }
    const result = await runSqlCatalogScheduleDayTransaction({
      ...input.populationFence, date: input.date, cutoffAt: input.cutoffAt, revisionId: input.revision.id,
    }, scoped => generateCatalogScheduleDay(input, scoped), recordSqlCatalogOnceObservationsInTransaction);
    return result.status === "committed" ? result.value : { status: result.status };
  }
  const { resolve, register } = io ?? dependencies;
  const observeOneTimeSchedules = io?.observeOneTimeSchedules;
  const selectedManual = new Set(input.manualScheduleIds);
  const foundManual = new Set<string>();
  const activeRules: CatalogScheduleRule[] = [];
  const bySchedule = new Map<string, CatalogScheduleRule>();
  const versions = new Map<string, string>();
  for (const rule of input.rules) {
    const { calendar } = rule;
    if (!calendar.active) continue;
    if (calendar.timezone !== "America/Bogota" || !validDay(calendar.startDate) ||
        (calendar.endDate != null && (!validDay(calendar.endDate) || calendar.endDate < calendar.startDate)) ||
        !/^[a-f0-9]{16}$/.test(calendar.version)) throw new Error("invalid_catalog_schedule_calendar");
    if (calendar.frequencyType === "manual") {
      if (!selectedManual.has(calendar.id) || input.date < calendar.startDate ||
        (calendar.endDate && input.date > calendar.endDate)) continue;
      foundManual.add(calendar.id);
    } else if (!isScheduleDueOnDate(calendar, input.date)) continue;
    const key = ruleKey(calendar.id, rule.scope.kind);
    const previous = bySchedule.get(key);
    if ((versions.has(calendar.id) && versions.get(calendar.id) !== calendar.version)
        || (previous && previous.workflowRole !== rule.workflowRole)) {
      throw new Error("inconsistent_catalog_schedule_roster");
    }
    versions.set(calendar.id, calendar.version);
    bySchedule.set(key, rule);
    activeRules.push(rule);
  }
  if (foundManual.size !== selectedManual.size) throw new Error("invalid_catalog_manual_schedule");
  const result: DayResult & { status: "evaluated" } = { status: "evaluated", registered: 0, existing: 0, held: 0, conflicts: 0 };
  if (!activeRules.length) return result;
  const inventory = new Map(input.inventory.map(record => [record.link.linkId, record]));
  if (inventory.size !== input.inventory.length) throw new Error("inconsistent_catalog_schedule_inventory");
  const plan = await planCatalogTasksWithVerifiedTargets(input.portalEnvironment, {
    occurrenceId: input.date, revision: input.revision, links: input.inventory.map(row => row.link),
    requests: activeRules.map(rule => ({ scheduleId: rule.calendar.id, operationId: rule.operationId,
      assignment: rule.assignment, scope: rule.scope })),
  }, resolve);
  result.conflicts = plan.conflicts.length;
  result.held = plan.held.length;
  const oneTime = observeOneTimeSchedules ? collectOneTimeScheduleObservations(activeRules) : undefined;
  if (oneTime) {
    for (const hold of plan.held) oneTime.invalidate(hold.scheduleId);
    for (const conflict of plan.conflicts) for (const source of conflict.sources) oneTime.invalidate(source.scheduleId);
  }
  const now = input.checkedAt.toISOString();
  for (const group of plan.tasks) {
    const workflowRoles = new Set(group.sources.map(source => bySchedule.get(ruleKey(source.scheduleId, group.kind))!.workflowRole));
    const { assignment } = group;
    const workflowRole = [...workflowRoles][0];
    if (workflowRoles.size !== 1 || !workflowRole || assignment.kind === "unassigned" ||
      (assignment.kind === "role" && assignment.id !== workflowRole)) {
      result.conflicts++;
      if (oneTime) for (const source of group.sources) oneTime.invalidate(source.scheduleId);
      continue;
    }
    const representative = group.sources[0];
    const { link, clientName, domainName, targetName } = inventory.get(representative.link.linkId)!;
    const task: UpdateTask = {
      id: `catalog-${group.executionKey}`, taskDate: input.date, taskBucket: getTaskDateBucket(input.date, group.kind),
      clientId: link.customerId, clientName, domainId: link.domainId, domainName,
      targetType: group.kind, targetId: link.databaseId ?? link.domainId,
      targetName: group.kind === "domain" ? webTargetLabel(targetName) : targetName,
      scheduleId: representative.scheduleId, rootScheduleId: representative.scheduleId,
      assignedRole: workflowRole, assignedUserIds: catalogAssignedUsers(assignment),
      status: "pending", result: null, notes: "", createdAt: now, createdBy: "system", updatedAt: now, updatedBy: "system",
      completedAt: null, completedBy: null,
    };
    const write = await register({ group, task, portalEnvironment: input.portalEnvironment,
      ...(input.matchKeyVersion !== undefined ? { matchKeyVersion: input.matchKeyVersion } : {}),
      cutoffAt: input.cutoffAt, catalogSourceIdsByLink: new Map(group.sources.map(({ link: row }) =>
        [row.linkId, inventory.get(row.linkId)!.sourceId])),
      catalogEvidenceByLink: new Map(group.sources.flatMap(({ link: row }) => {
        const evidence = inventory.get(row.linkId)!.sourceEvidence;
        return evidence ? [[row.linkId, evidence] as const] : [];
      })), scheduleVersions: new Map(group.sources.map(source =>
        [source.scheduleId, versions.get(source.scheduleId)!])) });
    if (write.status === "conflict") {
      result.conflicts++;
      if (oneTime) for (const source of group.sources) oneTime.invalidate(source.scheduleId);
    } else {
      if (write.accountedOrigins) result.accountedOrigins = (result.accountedOrigins ?? 0) + write.accountedOrigins;
      if (!write.receiptOnly) result[write.status]++;
      if (oneTime) {
        // Until registration proves individual accepted aliases independently, any receipt
        // makes the whole group unusable as completion evidence.
        const certified = write.taskId === task.id && !write.receiptOnly && !write.accountedOrigins &&
          write.oneTimeExpectationVerified === true;
        for (const source of group.sources) {
          if (!certified) oneTime.invalidate(source.scheduleId);
          else oneTime.verify(source.scheduleId, source.operationId, source.link.linkId, group.executionKey);
        }
      }
    }
  }
  if (oneTime && observeOneTimeSchedules) {
    const observations = oneTime.observations();
    if (observations.length) await observeOneTimeSchedules(observations);
  }
  return result;
}
