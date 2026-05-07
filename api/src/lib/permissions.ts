import type {
  CurrentUser,
  DatabaseRecord,
  DomainRecord,
  UpdateTask,
} from "../types/models";

export function hasRole(user: CurrentUser, role: string): boolean {
  return Array.isArray(user.roles) && user.roles.includes(role);
}

export function hasAnyRole(user: CurrentUser, roles: string[]): boolean {
  return roles.some((r) => hasRole(user, r));
}

export function requireRole(user: CurrentUser, roles: string[]): void {
  if (!hasAnyRole(user, roles)) {
    const err = new Error("No tiene permisos para realizar esta acción.");
    (err as any).status = 403;
    throw err;
  }
}

export function canManageUsers(user: CurrentUser): boolean {
  return hasRole(user, "admin");
}

export function canManageClients(user: CurrentUser): boolean {
  return hasAnyRole(user, ["admin", "client_manager"]);
}

export function canManageSchedules(user: CurrentUser): boolean {
  return hasAnyRole(user, ["admin", "client_manager"]);
}

export function canViewAuditLogs(user: CurrentUser): boolean {
  return hasAnyRole(user, [
    "admin",
    "client_manager",
    "viewer",
    "database_updater",
    "domain_updater",
  ]);
}

export function canCompleteDatabaseTask(
  user: CurrentUser,
  task: UpdateTask
): boolean {
  if (task.targetType !== "database") return false;
  if (hasRole(user, "admin")) return true;
  if (hasRole(user, "database_updater")) {
    return task.assignedUserIds.includes(user.id);
  }
  return false;
}

export function canCompleteDomainTask(
  user: CurrentUser,
  task: UpdateTask
): boolean {
  if (task.targetType !== "domain") return false;
  if (hasRole(user, "admin")) return true;
  if (hasRole(user, "domain_updater")) {
    return task.assignedUserIds.includes(user.id);
  }
  return false;
}

export function canRevealDatabaseSecret(
  user: CurrentUser,
  database: DatabaseRecord
): boolean {
  if (hasRole(user, "admin")) return true;
  if (hasRole(user, "database_updater")) {
    return database.assignedUpdaterIds.includes(user.id);
  }
  return false;
}

export function canEditDomainLimited(
  user: CurrentUser,
  domain: DomainRecord
): boolean {
  if (hasAnyRole(user, ["admin", "client_manager"])) return true;
  if (hasRole(user, "domain_updater")) {
    return domain.assignedUpdaterIds.includes(user.id);
  }
  return false;
}

export function canEditDatabaseLimited(
  user: CurrentUser,
  database: DatabaseRecord
): boolean {
  if (hasAnyRole(user, ["admin", "client_manager"])) return true;
  if (hasRole(user, "database_updater")) {
    return database.assignedUpdaterIds.includes(user.id);
  }
  return false;
}
