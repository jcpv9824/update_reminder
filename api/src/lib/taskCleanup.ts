import { writeAuditLog } from "./audit";
import { getContainer } from "./cosmos";
import type { CurrentUser, UpdateTask } from "../types/models";

function isNonTerminal(task: UpdateTask): boolean {
  return task.status !== "completed" && task.status !== "cancelled";
}

async function cancelObsoleteTasks(tasks: UpdateTask[], user: CurrentUser | { id: string; email: string }, reason: string): Promise<number> {
  let count = 0;
  const now = new Date().toISOString();
  const container = getContainer("updateTasks");
  for (const task of tasks.filter(isNonTerminal)) {
    const before = { ...task };
    task.status = "cancelled";
    task.result = "obsolete";
    task.notes = task.notes
      ? `${task.notes}\nTarea cancelada automáticamente: ${reason}.`
      : `Tarea cancelada automáticamente: ${reason}.`;
    task.updatedAt = now;
    task.updatedBy = user.id;
    await container.item(task.id, task.taskBucket).replace(task);
    count++;
    await writeAuditLog({
      entityType: "task",
      entityId: task.id,
      clientId: task.clientId,
      clientName: task.clientName,
      domainId: task.domainId,
      domainName: task.domainName,
      action: "task_obsoleted",
      performedBy: user.id,
      performedByEmail: user.email,
      metadata: {
        reason,
        taskId: task.id,
        targetType: task.targetType,
        targetId: task.targetId,
        domainId: task.domainId,
        scheduledFor: task.taskDate,
      },
      before,
      after: { status: task.status, result: task.result },
    });
  }
  return count;
}

export async function cancelPendingTasksForDomain(domainId: string, user: CurrentUser, reason: string): Promise<number> {
  const { resources } = await getContainer("updateTasks")
    .items.query<UpdateTask>({
      query: "SELECT * FROM c WHERE c.domainId = @domainId",
      parameters: [{ name: "@domainId", value: domainId }],
    })
    .fetchAll();
  return cancelObsoleteTasks(resources, user, reason);
}

export async function cancelPendingTasksForDatabase(databaseId: string, user: CurrentUser, reason: string): Promise<number> {
  const { resources } = await getContainer("updateTasks")
    .items.query<UpdateTask>({
      query: "SELECT * FROM c WHERE c.targetType = 'database' AND c.targetId = @databaseId",
      parameters: [{ name: "@databaseId", value: databaseId }],
    })
    .fetchAll();
  return cancelObsoleteTasks(resources, user, reason);
}
