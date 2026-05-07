import {
  buildTaskId,
  getTaskDateBucket,
  isScheduleDueOnDate,
} from "./scheduleEngine";
import type { UpdateSchedule, UpdateTask } from "../types/models";

export type TargetNameResolver = (id: string) => string;

export function generateTasksForDate(
  schedules: UpdateSchedule[],
  isoDate: string,
  existingTasks: UpdateTask[],
  resolveTargetName: TargetNameResolver
): UpdateTask[] {
  const existingIds = new Set(existingTasks.map((t) => t.id));
  const now = new Date().toISOString();
  const tasks: UpdateTask[] = [];

  for (const schedule of schedules) {
    if (!schedule.active) continue;
    if (!isScheduleDueOnDate(schedule, isoDate)) continue;

    for (const targetId of schedule.targetIds) {
      const id = buildTaskId(schedule.id, targetId, isoDate);
      if (existingIds.has(id)) continue;

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

  return tasks;
}
