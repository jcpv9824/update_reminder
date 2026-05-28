import type { UpdateSchedule, UpdateTask } from "../types/models";
import { taskBelongsToSchedule } from "./taskGenerator";

export function isOpenTaskForReschedule(task: UpdateTask): boolean {
  return task.status !== "completed" && task.status !== "cancelled";
}

export function shouldCancelTaskForOneTimeReschedule(
  task: UpdateTask,
  before: UpdateSchedule,
  after: UpdateSchedule
): boolean {
  if (before.frequencyType !== "once" || after.frequencyType !== "once") return false;
  if (before.startDate === after.startDate) return false;
  if (!before.active || before.completedAt || before.completedReason) return false;
  return task.taskDate === before.startDate &&
    isOpenTaskForReschedule(task) &&
    taskBelongsToSchedule(task, before.id);
}

export function markTaskCancelledForOneTimeReschedule(
  task: UpdateTask,
  before: UpdateSchedule,
  after: UpdateSchedule,
  userId: string,
  nowIso = new Date().toISOString()
): UpdateTask {
  const note = `Tarea cancelada automáticamente porque la programación única se reprogramó de ${before.startDate} a ${after.startDate}.`;
  return {
    ...task,
    status: "cancelled",
    result: "obsolete",
    notes: task.notes ? `${task.notes}\n${note}` : note,
    updatedAt: nowIso,
    updatedBy: userId,
  };
}
