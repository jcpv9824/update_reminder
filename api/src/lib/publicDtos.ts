import type { DatabaseRecord, UpdateTask } from "../types/models";

// DTO de lectura general. La metadata de conexión se obtiene únicamente desde
// /databases/{id}/access-info, que aplica autorización y nunca revela nombres
// de secretos de Key Vault.
export function toPublicDatabase(database: DatabaseRecord) {
  return {
    id: database.id,
    clientId: database.clientId,
    clientName: database.clientName,
    domainId: database.domainId,
    domainName: database.domainName,
    companyName: database.companyName,
    environment: database.environment,
    dbAccess: {
      initialCatalog: database.dbAccess.initialCatalog,
    },
    currentDbVersion: database.currentDbVersion,
    status: database.status,
    notes: database.notes,
    createdAt: database.createdAt,
    updatedAt: database.updatedAt,
    lastUpdatedAt: database.lastUpdatedAt,
  };
}

// Evita exponer claves de deduplicación, buckets, fuentes internas y marcas de
// idempotencia de correos. Solo conserva datos necesarios para operar la tarea.
export function toPublicTask(task: UpdateTask) {
  return {
    id: task.id,
    taskDate: task.taskDate,
    clientId: task.clientId,
    clientName: task.clientName,
    domainId: task.domainId,
    domainName: task.domainName,
    targetType: task.targetType,
    targetId: task.targetId,
    targetName: task.targetName,
    scheduleId: task.scheduleId,
    rootScheduleId: task.rootScheduleId,
    assignedRole: task.assignedRole,
    assignedUserIds: task.assignedUserIds ?? [],
    status: task.status,
    result: task.result,
    notes: task.notes,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    completedWithProblems: task.completedWithProblems,
    problemNote: task.problemNote,
    completionNote: task.completionNote,
    blockReason: task.blockReason,
    resolutionComment: task.resolutionComment,
    reopenReason: task.reopenReason,
  };
}
