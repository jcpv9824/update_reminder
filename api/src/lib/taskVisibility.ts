import type { UpdateTask } from "../types/models";
import { rootScheduleId } from "./taskGenerator";

const OPEN_STATUSES = new Set(["pending", "in_progress", "blocked", "failed", "reopened"]);

export interface TaskVisibilityScheduleContext {
  activeScheduleIds: Set<string>;
  existingScheduleIds: Set<string>;
}

export function isOpenTask(task: Pick<UpdateTask, "status">): boolean {
  return OPEN_STATUSES.has(task.status);
}

export function isTaskVisibleForOperationalView(
  task: UpdateTask,
  context: TaskVisibilityScheduleContext
): boolean {
  const rid = rootScheduleId(task);
  if (!rid) return true;
  if (!context.existingScheduleIds.has(rid)) return false;
  if (isOpenTask(task)) return context.activeScheduleIds.has(rid);
  return true;
}

export function filterTasksForOperationalView(
  tasks: UpdateTask[],
  context: TaskVisibilityScheduleContext
): UpdateTask[] {
  return tasks.filter((task) => isTaskVisibleForOperationalView(task, context));
}
