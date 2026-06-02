import {
  buildTaskId,
  getTaskDateBucket,
  isScheduleDueOnDate,
} from "./scheduleEngine";
import { expandLicensingSchedule } from "./licensingScope";
import type { ClientRecord, DatabaseRecord, DomainRecord, LicenseModuleRecord, UpdateSchedule, UpdateTask } from "../types/models";

export type TargetNameResolver = (id: string) => string;

export function taskTargetKey(targetType: "domain" | "database", targetId: string, isoDate: string): string {
  return `${targetType}|${targetId}|${isoDate}`;
}

export function taskDedupeKey(targetType: "domain" | "database", targetId: string, isoDate: string): string {
  return `${targetType}:${targetId}:${isoDate}`;
}

export function isTerminalTask(task: UpdateTask): boolean {
  return task.status === "completed" || task.status === "cancelled";
}

export function taskBelongsToSchedule(task: UpdateTask, scheduleId: string): boolean {
  return task.scheduleId === scheduleId ||
    task.scheduleId.startsWith(`${scheduleId}__`) ||
    rootScheduleId(task) === scheduleId ||
    (task.sources ?? []).some((source) => source.scheduleId === scheduleId || source.scheduleId.startsWith(`${scheduleId}__`));
}

// Devuelve el ID real de la programación de origen, eliminando los sufijos
// sintéticos de expansión (`__domain_`, `__db_`, `__db_inherited_`, etc.).
// Los IDs de programación son `schedule_<uuid>` y nunca contienen `__`, por
// lo que cortar en el primer `__` es seguro. Acepta un string o una tarea.
export function rootScheduleId(value: string | UpdateTask): string {
  const raw = typeof value === "string"
    ? value
    : (value.rootScheduleId || value.scheduleId || (value.sources?.[0]?.scheduleId ?? ""));
  return String(raw).split("__")[0];
}

function blocksTaskRegeneration(task: UpdateTask): boolean {
  return !(task.status === "cancelled" && task.result === "obsolete");
}

function canSyncExistingTask(task: UpdateTask): boolean {
  return task.status !== "completed" && task.status !== "cancelled";
}

function syncTaskAssignmentFromSchedule(task: UpdateTask, schedule: UpdateSchedule, targetName: string): boolean {
  const sourceType = schedule.origin === "special" ? "special" : schedule.origin === "licensing" ? "licensing" : "normal";
  const sourceExists = (task.sources ?? []).some((s) => s.scheduleId === schedule.id);
  if (!sourceExists) {
    task.sources = [...(task.sources ?? []), { scheduleId: schedule.id, scheduleType: sourceType as any, createdAt: new Date().toISOString() }];
  }
  const nextAssignedUserIds = schedule.assignedUserIds ?? [];
  const changed =
    task.assignedRole !== schedule.assignedRole ||
    JSON.stringify(task.assignedUserIds ?? []) !== JSON.stringify(nextAssignedUserIds) ||
    task.scheduleId !== schedule.id ||
    task.targetName !== targetName ||
    task.clientName !== schedule.clientName ||
    task.domainName !== (schedule.domainName ?? "");

  // Backfill del root id estable (FK lista para SQL) en tareas existentes.
  const nextRootId = rootScheduleId(schedule.id);
  const rootChanged = task.rootScheduleId !== nextRootId;
  if (rootChanged) task.rootScheduleId = nextRootId;

  if (!changed && !rootChanged) return false;
  task.scheduleId = schedule.id;
  task.rootScheduleId = nextRootId;
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

function reactivateObsoleteTaskFromSchedule(task: UpdateTask, schedule: UpdateSchedule, targetName: string): UpdateTask {
  syncTaskAssignmentFromSchedule(task, schedule, targetName);
  task.status = "pending";
  task.result = null;
  task.notes = task.notes
    ? `${task.notes}\nTarea reactivada automáticamente porque la programación vuelve a estar activa.`
    : "Tarea reactivada automáticamente porque la programación vuelve a estar activa.";
  task.updatedAt = new Date().toISOString();
  task.updatedBy = "system";
  return task;
}

export function summarizeTaskGenerationForDate(
  schedules: UpdateSchedule[],
  isoDate: string,
  existingTasks: UpdateTask[],
  resolveTargetName: TargetNameResolver
): { tasks: UpdateTask[]; skipped: number; syncedTasks: UpdateTask[] } {
  const blockingExistingTasks = existingTasks.filter(blocksTaskRegeneration);
  const existingIds = new Set(blockingExistingTasks.map((t) => t.id));
  const existingByTarget = new Map(blockingExistingTasks.map((t) => [taskTargetKey(t.targetType, t.targetId, t.taskDate), t]));
  const now = new Date().toISOString();
  const tasks: UpdateTask[] = [];
  const syncedTasks: UpdateTask[] = [];
  let skipped = 0;

  for (const schedule of schedules) {
    if (!schedule.active) continue;
    if (!isScheduleDueOnDate(schedule, isoDate)) continue;

    for (const targetId of schedule.targetIds) {
      const id = buildTaskId(schedule.id, targetId, isoDate);
      const exactExisting = existingTasks.find((t) => t.id === id);
      if (exactExisting?.status === "cancelled" && exactExisting.result === "obsolete") {
        syncedTasks.push(reactivateObsoleteTaskFromSchedule(exactExisting, schedule, resolveTargetName(targetId)));
        existingIds.add(exactExisting.id);
        existingByTarget.set(taskTargetKey(exactExisting.targetType, exactExisting.targetId, exactExisting.taskDate), exactExisting);
        skipped += 1;
        continue;
      }
      const existing = exactExisting && existingIds.has(id)
        ? exactExisting
        : existingByTarget.get(taskTargetKey(schedule.targetType, targetId, isoDate));
      if (existing) {
        if (canSyncExistingTask(existing)) {
          const changed = syncTaskAssignmentFromSchedule(existing, schedule, resolveTargetName(targetId));
          if (changed) syncedTasks.push(existing);
        }
        skipped += 1;
        continue;
      }

      const task: UpdateTask = {
        id,
        dedupeKey: taskDedupeKey(schedule.targetType, targetId, isoDate),
        sources: [{
          scheduleId: schedule.id,
          scheduleType: schedule.origin === "special" ? "special" : schedule.origin === "licensing" ? "licensing" : "normal",
          createdAt: now,
        }],
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
        rootScheduleId: rootScheduleId(schedule.id),
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
      };
      tasks.push(task);
      existingIds.add(task.id);
      existingByTarget.set(taskTargetKey(task.targetType, task.targetId, task.taskDate), task);
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
  nowIso = new Date().toISOString(),
  preserveOpenBeforeDate?: string
): UpdateTask[] {
  const obsoleted: UpdateTask[] = [];
  for (const task of existingTasks) {
    if (isTerminalTask(task)) continue;
    if (preserveOpenBeforeDate && task.taskDate <= preserveOpenBeforeDate) continue;
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

export function oneTimeSchedulesDueOnOrBefore(schedules: UpdateSchedule[], todayIso: string): UpdateSchedule[] {
  return schedules.filter((schedule) =>
    schedule.active &&
    schedule.frequencyType === "once" &&
    schedule.startDate <= todayIso
  );
}

export function oneTimeSchedulesReadyToComplete(
  schedules: UpdateSchedule[],
  tasks: UpdateTask[],
  todayIso: string
): UpdateSchedule[] {
  return oneTimeSchedulesDueOnOrBefore(schedules, todayIso).filter((schedule) => {
    const related = tasks.filter((task) => task.taskDate === schedule.startDate && taskBelongsToSchedule(task, schedule.id));
    return related.length > 0 && related.every(isTerminalTask);
  });
}

export function markOneTimeScheduleCompleted(
  schedule: UpdateSchedule,
  nowIso = new Date().toISOString(),
  userId = "system"
): UpdateSchedule {
  return {
    ...schedule,
    active: false,
    completedAt: nowIso,
    completedReason: "one_time_schedule_executed",
    updatedAt: nowIso,
    updatedBy: userId,
  };
}

export function expandSchedulesWithDomainInheritance(
  schedules: UpdateSchedule[],
  domains: DomainRecord[],
  databases: DatabaseRecord[],
  clients: ClientRecord[] = [],
  licenseModules: LicenseModuleRecord[] = []
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

  const expanded: UpdateSchedule[] = [];

  for (const schedule of schedules) {
    if (!schedule.active) continue;

    if (schedule.selectionMode === "licensing" && schedule.licensingScope) {
      expanded.push(...expandLicensingSchedule({ schedule, clients, domains, databases, licenseModules }));
      continue;
    }

    if (schedule.scopeGroups && schedule.scopeGroups.length > 0) {
      const includeManualDomains = (schedule.manualTargetTypes ?? "domains_and_databases") !== "databases_only";
      const includeManualDatabases = (schedule.manualTargetTypes ?? "domains_and_databases") !== "domains_only";
      for (const group of schedule.scopeGroups) {
        const groupDomains = group.includeAllDomains
          ? domains.filter((d) => d.clientId === group.clientId && d.status === "active")
          : group.domains.map((g) => activeDomains.get(g.domainId)).filter(Boolean) as DomainRecord[];
        for (const domain of groupDomains) {
          const domainConfig = group.domains.find((d) => d.domainId === domain.id);
          if (includeManualDomains) {
            expanded.push({
              ...schedule,
              id: `${schedule.id}__domain_${domain.id}`,
              clientId: domain.clientId,
              clientName: domain.clientName,
              domainId: domain.id,
              domainName: domain.domainName,
              targetType: "domain",
              targetIds: [domain.id],
              assignedRole: schedule.domainAssignedRole ?? "domain_updater",
              assignedUserIds: schedule.assignmentMode === "users" ? (schedule.assignedUserIds ?? []) : [],
            });
          }
          if (!includeManualDatabases) continue;
          const dbs = (group.includeAllDomains || domainConfig?.includeAllDatabases)
            ? (databasesByDomain.get(domain.id) ?? [])
            : (domainConfig?.databaseIds ?? []).map((id) => activeDatabases.find((db) => db.id === id)).filter(Boolean) as DatabaseRecord[];
          for (const db of dbs) {
            expanded.push({
              ...schedule,
              id: `${schedule.id}__db_${db.id}`,
              clientId: db.clientId,
              clientName: db.clientName,
              domainId: db.domainId,
              domainName: db.domainName,
              targetType: "database",
              targetIds: [db.id],
              assignedRole: schedule.databaseAssignedRole ?? "database_updater",
              assignedUserIds: schedule.assignmentMode === "users" ? (schedule.databaseAssignedUserIds ?? []) : [],
            });
          }
        }
      }
      continue;
    }

    if (schedule.targetType === "database") {
      const targetIds = schedule.targetIds.filter((id) => activeDbIds.has(id));
      if (targetIds.length === 0) continue;
      expanded.push({ ...schedule, targetIds });
      continue;
    }

    // Programación de dominio "plana" (sin scopeGroups ni licensing): genera
    // solo tareas de dominio. Las bases de datos YA NO se heredan de forma
    // implícita; para incluirlas, la programación debe marcarlas en el alcance
    // (scopeGroups con "incluir todas las bases del dominio" o bases concretas).
    const domainIds = schedule.targetIds.filter((id) => activeDomains.has(id));
    if (domainIds.length === 0) continue;
    expanded.push({ ...schedule, targetIds: domainIds });
  }

  return expanded;
}
