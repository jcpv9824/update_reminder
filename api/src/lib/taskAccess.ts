import type { CurrentUser, UpdateTask } from "../types/models";
import {
  DEFAULT_ROLE_DEFINITIONS,
  effectiveTaskVisibility,
  hasPermissionFromRoles,
  migrateLegacyRoleId,
  migrateLegacyRoleIds,
  type RoleDefinition,
} from "./permissionModel";

export function resolveRoleDefinitionsForUser(
  user: CurrentUser,
  availableRoles: RoleDefinition[] = DEFAULT_ROLE_DEFINITIONS
): RoleDefinition[] {
  const roleIds = new Set(migrateLegacyRoleIds(user.roles ?? []));
  return availableRoles.filter((role) => roleIds.has(role.id));
}

export function hasPermissionWithRoleDefinitions(
  user: CurrentUser,
  permission: string,
  availableRoles: RoleDefinition[] = DEFAULT_ROLE_DEFINITIONS
): boolean {
  return hasPermissionFromRoles(resolveRoleDefinitionsForUser(user, availableRoles), permission);
}

export function isTaskAssignedToUserWithRoleDefinitions(user: CurrentUser, task: UpdateTask): boolean {
  const assignedUserIds = task.assignedUserIds ?? [];
  if (assignedUserIds.length > 0) return assignedUserIds.includes(user.id);
  if (!task.assignedRole) return false;

  const assignedRole = migrateLegacyRoleId(task.assignedRole);
  return migrateLegacyRoleIds(user.roles ?? []).includes(assignedRole);
}

export function canViewTaskWithRoleDefinitions(
  user: CurrentUser,
  task: UpdateTask,
  availableRoles: RoleDefinition[] = DEFAULT_ROLE_DEFINITIONS
): boolean {
  const roleDefinitions = resolveRoleDefinitionsForUser(user, availableRoles);
  if (roleDefinitions.some((role) => role.id === "super_admin")) return true;
  if (!hasPermissionFromRoles(roleDefinitions, "updates.tasks.view")) return false;

  const visibility = effectiveTaskVisibility(roleDefinitions);
  const level = visibility[task.targetType];
  if (level === "none") return false;
  if (level === "all") return true;
  return isTaskAssignedToUserWithRoleDefinitions(user, task);
}

export function canPerformTaskActionWithRoleDefinitions(
  user: CurrentUser,
  task: UpdateTask,
  actionId: string,
  availableRoles: RoleDefinition[] = DEFAULT_ROLE_DEFINITIONS
): boolean {
  const permission = `updates.tasks.${actionId}`;
  if (!hasPermissionWithRoleDefinitions(user, permission, availableRoles)) return false;
  return canViewTaskWithRoleDefinitions(user, task, availableRoles);
}

export function filterTasksWithRoleDefinitions(
  user: CurrentUser,
  tasks: UpdateTask[],
  availableRoles: RoleDefinition[] = DEFAULT_ROLE_DEFINITIONS
): UpdateTask[] {
  return tasks.filter((task) => canViewTaskWithRoleDefinitions(user, task, availableRoles));
}
