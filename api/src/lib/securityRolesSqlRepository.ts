import { getSqlPool } from "./sql";
import type { RoleDefinitionRecord } from "./roleDefinitions";

type PermissionJson = { value: string };
type RoleRow = {
  role_id: string;
  name: string;
  active: boolean;
  system_role: boolean;
  protected_role: boolean;
  domain_task_visibility: "none" | "assigned" | "all";
  database_task_visibility: "none" | "assigned" | "all";
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
  permissions_json: string | null;
};

function parsePermissions(value: string | null): string[] {
  if (!value) return [];
  try { return (JSON.parse(value) as PermissionJson[]).map((entry) => entry.value); } catch { return []; }
}

export function mapSqlRoleDefinition(row: RoleRow): RoleDefinitionRecord {
  return {
    id: row.role_id,
    name: row.name,
    active: row.active,
    system: row.system_role,
    protected: row.protected_role,
    permissions: parsePermissions(row.permissions_json),
    taskVisibility: {
      domain: row.domain_task_visibility,
      database: row.database_task_visibility,
    },
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
  };
}

export async function readSqlRoleDefinitions(): Promise<RoleDefinitionRecord[]> {
  const pool = await getSqlPool();
  const result = await pool.request().query<RoleRow>(`
    SELECT role.role_id,role.name,role.active,role.system_role,role.protected_role,
      role.domain_task_visibility,role.database_task_visibility,
      role.created_at,role.created_by,role.updated_at,role.updated_by,
      COALESCE((SELECT role_permission.permission_key AS value
        FROM security.role_permissions role_permission
        JOIN security.permissions permission_record ON permission_record.permission_key=role_permission.permission_key
        WHERE role_permission.role_id=role.role_id AND permission_record.active=1
        ORDER BY role_permission.permission_key FOR JSON PATH),N'[]') AS permissions_json
    FROM security.roles role
    ORDER BY CASE role.role_id WHEN N'super_admin' THEN 0 WHEN N'database_updater' THEN 1
      WHEN N'domain_updater' THEN 2 WHEN N'print_formats_admin' THEN 3 ELSE 4 END,
      role.name,role.role_id;
  `);
  return result.recordset.map(mapSqlRoleDefinition);
}

export function roleDefinitionParityShape(roles: RoleDefinitionRecord[]): string {
  return JSON.stringify(roles.map((role) => ({
    id: role.id,
    active: role.active,
    permissions: role.permissions.length,
    domain: role.taskVisibility.domain,
    database: role.taskVisibility.database,
  })).sort((a, b) => a.id.localeCompare(b.id)));
}
