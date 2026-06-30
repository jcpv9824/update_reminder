import type { CurrentUser, DatabaseRecord, DomainRecord, UpdateTask } from "../types/models";
import {
  canAccessDatabaseTaskConnection,
  canEditDatabaseLimited,
  canRevealDatabaseSecret,
  hasAnyRole,
  hasRole,
} from "./permissions";

const GLOBAL_READ_ROLES = ["admin", "client_manager", "viewer"];

export function canReadAllOperationalData(user: CurrentUser): boolean {
  return hasAnyRole(user, GLOBAL_READ_ROLES);
}

export function canReadDatabase(
  user: CurrentUser,
  database: DatabaseRecord,
  tasks: UpdateTask[] = []
): boolean {
  if (canReadAllOperationalData(user)) return true;
  if (!hasRole(user, "database_updater")) return false;
  if ((database.assignedUpdaterIds ?? []).includes(user.id)) return true;
  return tasks.some((task) => task.targetType === "database"
    && task.targetId === database.id
    && canReadTask(user, task));
}

export function canReadDomain(
  user: CurrentUser,
  domain: DomainRecord,
  databases: DatabaseRecord[] = [],
  tasks: UpdateTask[] = []
): boolean {
  if (canReadAllOperationalData(user)) return true;
  if (hasRole(user, "domain_updater") && (domain.assignedUpdaterIds ?? []).includes(user.id)) {
    return true;
  }
  if (tasks.some((task) => task.targetType === "domain"
    && task.targetId === domain.id
    && canReadTask(user, task))) return true;
  return hasRole(user, "database_updater")
    && databases.some((database) => database.domainId === domain.id && canReadDatabase(user, database, tasks));
}

// En el contexto explicito de un dominio asignado, el actualizador de dominio
// puede consultar metadata no sensible de sus bases. Esto no concede acceso a
// credenciales ni permite consultar esas bases mediante /databases/{id}.
export function canReadDatabaseInDomain(
  user: CurrentUser,
  database: DatabaseRecord,
  domain: DomainRecord,
  tasks: UpdateTask[] = []
): boolean {
  return canReadDatabase(user, database, tasks)
    || (database.domainId === domain.id
      && hasRole(user, "domain_updater")
      && (domain.assignedUpdaterIds ?? []).includes(user.id));
}

export function isTaskAssignedToUser(user: CurrentUser, task: UpdateTask): boolean {
  const assignedUserIds = task.assignedUserIds ?? [];
  if (assignedUserIds.length > 0) return assignedUserIds.includes(user.id);
  return !!task.assignedRole && hasRole(user, task.assignedRole);
}

export function canReadTask(user: CurrentUser, task: UpdateTask): boolean {
  if (canReadAllOperationalData(user)) return true;
  if (task.targetType === "database" && !hasRole(user, "database_updater")) return false;
  if (task.targetType === "domain" && !hasRole(user, "domain_updater")) return false;
  return isTaskAssignedToUser(user, task);
}

function isMatchingDatabaseTask(database: DatabaseRecord, task?: UpdateTask | null): task is UpdateTask {
  return !!task && task.targetType === "database" && task.targetId === database.id;
}

export function canReadDatabaseConnection(
  user: CurrentUser,
  database: DatabaseRecord,
  task?: UpdateTask | null
): boolean {
  if (isMatchingDatabaseTask(database, task) && canAccessDatabaseTaskConnection(user, task)) return true;
  return canRevealDatabaseSecret(user, database) || canEditDatabaseLimited(user, database);
}

export function canReadDatabasePassword(
  user: CurrentUser,
  database: DatabaseRecord,
  task?: UpdateTask | null
): boolean {
  if (isMatchingDatabaseTask(database, task) && canAccessDatabaseTaskConnection(user, task)) return true;
  return canRevealDatabaseSecret(user, database);
}

export function filterDatabasesForUser(
  user: CurrentUser,
  databases: DatabaseRecord[],
  tasks: UpdateTask[] = []
): DatabaseRecord[] {
  return databases.filter((database) => canReadDatabase(user, database, tasks));
}

export function filterDomainsForUser(
  user: CurrentUser,
  domains: DomainRecord[],
  databases: DatabaseRecord[] = [],
  tasks: UpdateTask[] = []
): DomainRecord[] {
  return domains.filter((domain) => canReadDomain(user, domain, databases, tasks));
}

export function filterClientIdsForUser(
  user: CurrentUser,
  domains: DomainRecord[],
  databases: DatabaseRecord[],
  tasks: UpdateTask[] = []
): Set<string> | null {
  if (canReadAllOperationalData(user)) return null;
  const ids = new Set<string>();
  for (const domain of filterDomainsForUser(user, domains, databases, tasks)) ids.add(domain.clientId);
  for (const database of filterDatabasesForUser(user, databases, tasks)) ids.add(database.clientId);
  for (const task of filterTasksForUser(user, tasks)) ids.add(task.clientId);
  return ids;
}

export function filterTasksForUser(user: CurrentUser, tasks: UpdateTask[]): UpdateTask[] {
  return tasks.filter((task) => canReadTask(user, task));
}
