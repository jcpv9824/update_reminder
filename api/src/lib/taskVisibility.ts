import type { UpdateTask } from "../types/models";
import { rootScheduleId } from "./taskGenerator";

const OPEN_STATUSES = new Set(["pending", "in_progress", "blocked", "failed", "reopened"]);

export function isOpenTask(task: Pick<UpdateTask, "status">): boolean {
  return OPEN_STATUSES.has(task.status);
}

export function isTaskVisibleForOperationalView(task: UpdateTask, activeScheduleIds: Set<string>): boolean {
  if (!isOpenTask(task)) return true;
  const rid = rootScheduleId(task);
  if (!rid) return true;
  return activeScheduleIds.has(rid);
}

export function filterTasksForOperationalView(tasks: UpdateTask[], activeScheduleIds: Set<string>): UpdateTask[] {
  return tasks.filter((task) => isTaskVisibleForOperationalView(task, activeScheduleIds));
}
