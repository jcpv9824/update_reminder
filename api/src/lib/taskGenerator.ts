import {
  buildTaskId,
  getTaskDateBucket,
  isScheduleDueOnDate,
} from "./scheduleEngine";
import type { DatabaseRecord, DomainRecord, UpdateSchedule, UpdateTask } from "../types/models";

export type TargetNameResolver = (id: string) => string;

export function taskTargetKey(targetType: "domain" | "database", targetId: string, isoDate: string): string {
  return `${targetType}|${targetId}|${isoDate}`;
}

export function isTerminalTask(task: UpdateTask): boolean {
  return task.status === "completed" || task.status === "cancelled";
}

function canSyncExistingTask(task: UpdateTask): boolean {
  return task.status !== "completed" && task.status !== "cancelled";
}

function syncTaskAssignmentFromSchedule(task: UpdateTask, schedule: UpdateSchedule, targetName: string): boolean {
  const nextAssignedUserIds = schedule.assignedUserIds ?? [];
  const changed =
    task.assignedRole !== schedule.assignedRole ||
    JSON.stringify(task.assignedUserIds ?? []) !== JSON.stringify(nextAssignedUserIds) ||
    task.scheduleId !== schedule.id ||
    task.targetName !== targetName ||
    task.clientName !== schedule.clientName ||
    task.domainName !== (schedule.domainName ?? "");

  if (!changed) return false;
  task.scheduleId = schedule.id;
  task.assignedRole = schedule.assignedRole;
  task.assignedUserIds = nextAssignedUserIds;
  task.clientName = schedule.clientName;
  task.domainId = schedule.domainId ?? task.domainId;
  task.domainName = schedule.domainName ?? task.domainName;
  task.targetName = targetName;
  task.updatedAt = new Date().toISOString();
  task.updatedBy = "system";
  return true;
}

export function summarizeTaskGenerationForDate(
  schedules: UpdateSchedule[],
  isoDate: string,
  existingTasks: UpdateTask[],
  resolveTargetName: TargetNameResolver
): { tasks: UpdateTask[]; skipped: number; syncedTasks: UpdateTask[] } {
  const existingIds = new Set(existingTasks.map((t) => t.id));
  const existingByTarget = new Map(existingTasks.map((t) => [taskTargetKey(t.targetType, t.targetId, t.taskDate), t]));
  const now = new Date().toISOString();
  const tasks: UpdateTask[] = [];
  const syncedTasks: UpdateTask[] = [];
  let skipped = 0;

  for (const schedule of schedules) {
    if (!schedule.active) continue;
    if (!isScheduleDueOnDate(schedule, isoDate)) continue;

    for (const targetId of schedule.targetIds) {
      const id = buildTaskId(schedule.id, targetId, isoDate);
      const existing = existingIds.has(id)
        ? existingTasks.find((t) => t.id === id)
        : existingByTarget.get(taskTargetKey(schedule.targetType, targetId, isoDate));
      if (existing) {
        if (canSyncExistingTask(existing)) {
          const changed = syncTaskAssignmentFromSchedule(existing, schedule, resolveTargetName(targetId));
          if (changed) syncedTasks.push(existing);
        }
        skipped += 1;
        continue;
      }

      tasks.push({
        id,
        taskDate: isoDate,
        taskBucket: getTaskDateBucket(isoDate, schedule.targetType),
        clientId: schedule.clientId,
        clientName: schedule.clientName,
        domainId: schedule.domainId ?? "",
        domainName: schedule.domainName ?? "",
        targetType: schedule.targetType,
        targetId,
        targetName: resolveTargetName(targetId),
        scheduleId: schedule.id,
        assignedRole: schedule.assignedRole,
        assignedUserIds: schedule.assignedUserIds,
        status: "pending",
        result: null,
        notes: "",
        createdAt: now,
        createdBy: "system",
        updatedAt: now,
        updatedBy: "system",
        completedAt: null,
        completedBy: null,
      });
    }
  }

  return { tasks, skipped, syncedTasks };
}

export function generateTasksForDate(
  schedules: UpdateSchedule[],
  isoDate: string,
  existingTasks: UpdateTask[],
  resolveTargetName: TargetNameResolver
): UpdateTask[] {
  return summarizeTaskGenerationForDate(schedules, isoDate, existingTasks, resolveTargetName).tasks;
}

export function expectedTaskKeysForDate(
  schedules: UpdateSchedule[],
  isoDate: string
): Set<string> {
  const expected = new Set<string>();
  for (const schedule of schedules) {
    if (!schedule.active) continue;
    if (!isScheduleDueOnDate(schedule, isoDate)) continue;
    for (const targetId of schedule.targetIds) {
      expected.add(taskTargetKey(schedule.targetType, targetId, isoDate));
    }
  }
  return expected;
}

export function obsoleteTasksOutsideExpected(
  existingTasks: UpdateTask[],
  expectedKeys: Set<string>,
  nowIso = new Date().toISOString()
): UpdateTask[] {
  const obsoleted: UpdateTask[] = [];
  for (const task of existingTasks) {
    if (isTerminalTask(task)) continue;
    const key = taskTargetKey(task.targetType, task.targetId, task.taskDate);
    if (expectedKeys.has(key)) continue;
    task.status = "cancelled";
    task.result = "obsolete";
    task.notes = task.notes
      ? `${task.notes}\nTarea cancelada automáticamente porque ya no corresponde al estado actual.`
      : "Tarea cancelada automáticamente porque ya no corresponde al estado actual.";
    task.updatedAt = nowIso;
    task.updatedBy = "system";
    obsoleted.push(task);
  }
  return obsoleted;
}

export function expandSchedulesWithDomainInheritance(
  schedules: UpdateSchedule[],
  domains: DomainRecord[],
  databases: DatabaseRecord[]
): UpdateSchedule[] {
  const activeDomains = new Map(domains.filter((d) => d.status === "active").map((d) => [d.id, d]));
  const activeDatabases = databases.filter((d) => d.status === "active" && activeDomains.has(d.domainId));
  const activeDbIds = new Set(activeDatabases.map((d) => d.id));
  const databasesByDomain = new Map<string, DatabaseRecord[]>();
  for (const db of activeDatabases) {
    const list = databasesByDomain.get(db.domainId) ?? [];
    list.push(db);
    databasesByDomain.set(db.domainId, list);
  }

  const dbsWithSpecificSchedule = new Set<string>();
  for (const schedule of schedules) {
    if (!schedule.active || schedule.targetType !== "database") continue;
    for (const targetId of schedule.targetIds) {
      if (activeDbIds.has(targetId)) dbsWithSpecificSchedule.add(targetId);
    }
  }

  const expanded: UpdateSchedule[] = [];

  for (const schedule of schedules) {
    if (!schedule.active) continue;

    if (schedule.targetType === "database") {
      const targetIds = schedule.targetIds.filter((id) => activeDbIds.has(id));
      if (targetIds.length === 0) continue;
      expanded.push({ ...schedule, targetIds });
      continue;
    }

    const domainIds = schedule.targetIds.filter((id) => activeDomains.has(id));
    if (domainIds.length === 0) continue;
    expanded.push({ ...schedule, targetIds: domainIds });

    for (const domainId of domainIds) {
      const domain = activeDomains.get(domainId);
      const inheritedDbs = (databasesByDomain.get(domainId) ?? []).filter((db) => !dbsWithSpecificSchedule.has(db.id));
      if (!domain || inheritedDbs.length === 0) continue;
      const databaseAssignedUserIds = schedule.databaseAssignedUserIds ?? [];
      for (const db of inheritedDbs) {
        expanded.push({
          ...schedule,
          id: `${schedule.id}__db_inherited_${db.id}`,
          domainId,
          domainName: domain.domainName,
          targetType: "database",
          targetIds: [db.id],
          assignedRole: "database_updater",
          assignedUserIds: databaseAssignedUserIds,
          reminders: schedule.reminders
            ? {
                ...schedule.reminders,
                reminderRecipientsMode: databaseAssignedUserIds.length > 0 ? "assignedUsers" : "roleUsers",
                customReminderEmails: [],
              }
            : undefined,
          notes: [schedule.notes, "Frecuencia heredada del dominio. Una frecuencia especifica activa de base de datos tiene prioridad sobre esta herencia."]
            .filter(Boolean)
            .join("\n"),
        });
      }
    }
  }

  return expanded;
}
