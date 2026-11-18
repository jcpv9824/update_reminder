import type { UpdateTask } from "../types/models";
import { registerSqlCatalogTaskExecution } from "./catalogExecutionRegistrationSqlRepository";
import { readSqlCatalogPhysicalTargets, planCatalogTasksWithVerifiedTargets } from "./catalogPhysicalTargetSqlRepository";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import type { CatalogTaskLink, CatalogTaskRequest } from "./catalogTaskTargetPlanning";
import { getTaskDateBucket, isScheduleDueOnDate, type CalendarSchedule } from "./scheduleEngine";

export type CatalogScheduleRule = Omit<CatalogTaskRequest, "scheduleId"> & {
  calendar: CalendarSchedule & { id: string; timezone: string; version: string };
  /** Required by SQL workflow; explicit person assignment still takes precedence. */
  workflowRole: string;
};

export type CatalogScheduleDay = {
  date: string;
  portalEnvironment: CatalogEnvironment;
  checkedAt: Date;
  /** Original business cutoff from the trusted schedule occurrence, never from HTTP. */
  cutoffAt: Date;
  revision: { id: string; complete: boolean };
  rules: readonly CatalogScheduleRule[];
  inventory: readonly { link: CatalogTaskLink; sourceId: string | null;
    clientName: string; domainName: string; targetName: string }[];
  /** Already authorized by caller; a generic refresh leaves this absent. */
  manualScheduleIds?: readonly string[];
};

type DayResult = { status: "cutoff" | "unverified" } | { status: "evaluated";
  registered: number; existing: number; held: number; conflicts: number };
const dependencies = { resolve: readSqlCatalogPhysicalTargets, register: registerSqlCatalogTaskExecution };
const validDay = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date))
  && new Date(date).toISOString().slice(0, 10) === date;

/**
 * Runs one Bogotá business date using the full trusted roster, not browser-provided targets.
 * Legacy task cleanup and schedule completion are deliberately not part of registration.
 */
export async function generateCatalogScheduleDay(input: CatalogScheduleDay, io = dependencies): Promise<DayResult> {
  if (!validDay(input.date) || !Number.isFinite(input.checkedAt.valueOf()) || !Number.isFinite(input.cutoffAt.valueOf())
    || input.inventory.length > 5000 || input.rules.length > 5000) throw new Error("invalid_catalog_schedule_day");
  if (input.checkedAt >= input.cutoffAt) return { status: "cutoff" };
  if (!input.revision.complete) return { status: "unverified" };
  const selectedManual = new Set(input.manualScheduleIds);
  const foundManual = new Set<string>();
  const activeRules: CatalogScheduleRule[] = [];
  const bySchedule = new Map<string, CatalogScheduleRule>();
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
    const previous = bySchedule.get(calendar.id);
    if (previous && (previous.calendar.version !== calendar.version || previous.workflowRole !== rule.workflowRole)) {
      throw new Error("inconsistent_catalog_schedule_roster");
    }
    bySchedule.set(calendar.id, rule);
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
  }, io.resolve);
  result.conflicts = plan.conflicts.length;
  result.held = plan.held.length;
  const now = input.checkedAt.toISOString();
  for (const group of plan.tasks) {
    const workflowRoles = new Set(group.sources.map(source => bySchedule.get(source.scheduleId)!.workflowRole));
    const { assignment } = group;
    const workflowRole = [...workflowRoles][0];
    if (workflowRoles.size !== 1 || !workflowRole || assignment.kind === "unassigned" ||
      (assignment.kind === "role" && assignment.id !== workflowRole)) { result.conflicts++; continue; }
    const representative = group.sources[0];
    const { link, clientName, domainName, targetName } = inventory.get(representative.link.linkId)!;
    const task: UpdateTask = {
      id: `catalog-${group.executionKey}`, taskDate: input.date, taskBucket: getTaskDateBucket(input.date, group.kind),
      clientId: link.customerId, clientName, domainId: link.domainId, domainName,
      targetType: group.kind, targetId: link.databaseId ?? link.domainId, targetName,
      scheduleId: representative.scheduleId, rootScheduleId: representative.scheduleId,
      assignedRole: workflowRole, assignedUserIds: assignment.kind === "user" ? [assignment.id] : [],
      status: "pending", result: null, notes: "", createdAt: now, createdBy: "system", updatedAt: now, updatedBy: "system",
      completedAt: null, completedBy: null,
    };
    const write = await io.register({ group, task, portalEnvironment: input.portalEnvironment,
      cutoffAt: input.cutoffAt, catalogSourceIdsByLink: new Map(group.sources.map(({ link: row }) =>
        [row.linkId, inventory.get(row.linkId)!.sourceId])), scheduleVersions: new Map(group.sources.map(source =>
        [source.scheduleId, bySchedule.get(source.scheduleId)!.calendar.version])) });
    if (write.status === "conflict") result.conflicts++;
    else result[write.status]++;
  }
  return result;
}
