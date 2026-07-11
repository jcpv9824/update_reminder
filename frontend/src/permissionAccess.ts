import { DEFAULT_ROLE_DEFINITIONS, type RoleDefinition, type TaskVisibility, type TaskVisibilityLevel } from "./permissionModel";

export function migrateLegacyRoleId(roleId: string): string {
  if (roleId === "admin") return "super_admin";
  if (roleId === "formatos_impresion.admin") return "print_formats_admin";
  return roleId;
}

const RETIRED_COMPATIBILITY_ROLE_IDS = new Set([
  "client_manager",
  "viewer",
  "public_downloads.admin",
]);

export function resolveRoleDefinitionsForRoleIds(
  roleIds: string[] = [],
  availableRoles: RoleDefinition[] = DEFAULT_ROLE_DEFINITIONS
): RoleDefinition[] {
  const normalized = new Set(roleIds.map(migrateLegacyRoleId).filter((roleId) => !RETIRED_COMPATIBILITY_ROLE_IDS.has(roleId)));
  return availableRoles.filter((role) => normalized.has(role.id) && role.active !== false);
}

export function hasPermissionForRoleIds(
  roleIds: string[] = [],
  permission: string,
  availableRoles: RoleDefinition[] = DEFAULT_ROLE_DEFINITIONS
): boolean {
  const roles = resolveRoleDefinitionsForRoleIds(roleIds, availableRoles);
  if (roles.some((role) => role.id === "super_admin")) return true;
  return roles.some((role) => role.permissions.includes(permission));
}

const VISIBILITY_RANK: Record<TaskVisibilityLevel, number> = {
  none: 0,
  assigned: 1,
  all: 2,
};

function maxVisibility(a: TaskVisibilityLevel, b: TaskVisibilityLevel): TaskVisibilityLevel {
  return VISIBILITY_RANK[b] > VISIBILITY_RANK[a] ? b : a;
}

export function resolveTaskVisibilityForRoleIds(
  roleIds: string[] = [],
  availableRoles: RoleDefinition[] = DEFAULT_ROLE_DEFINITIONS
): TaskVisibility {
  const roles = resolveRoleDefinitionsForRoleIds(roleIds, availableRoles);
  if (roles.some((role) => role.id === "super_admin")) return { domain: "all", database: "all" };
  return roles.reduce<TaskVisibility>((acc, role) => ({
    domain: maxVisibility(acc.domain, role.taskVisibility.domain),
    database: maxVisibility(acc.database, role.taskVisibility.database),
  }), { domain: "none", database: "none" });
}

export function hasTaskVisibilityForRoleIds(
  roleIds: string[] = [],
  targetType: keyof TaskVisibility,
  availableRoles: RoleDefinition[] = DEFAULT_ROLE_DEFINITIONS
): boolean {
  return resolveTaskVisibilityForRoleIds(roleIds, availableRoles)[targetType] !== "none";
}

export function eligibleRolesForTaskAssignment(
  availableRoles: RoleDefinition[] = DEFAULT_ROLE_DEFINITIONS,
  targetType: keyof TaskVisibility
): RoleDefinition[] {
  return availableRoles.filter((role) =>
    role.active !== false
    && (role.id === "super_admin" || role.permissions.includes("updates.tasks.view"))
    && (role.id === "super_admin" || role.taskVisibility[targetType] !== "none")
  );
}
