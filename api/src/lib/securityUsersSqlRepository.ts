import sql from "mssql";
import { getSqlPool } from "./sql";
import type { PageResult } from "./pagination";
import type { UserRecord } from "../types/models";

type RoleJson = { value: string };
type UserRow = {
  source_id: string;
  display_name: string;
  email: string;
  active: boolean;
  password_updated_at: Date | null;
  password_expires_at: Date | null;
  must_change_password: boolean;
  last_login_at: Date | null;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
  roles_json: string | null;
  total_count: number;
};

function parseRoles(value: string | null): string[] {
  if (!value) return [];
  try { return (JSON.parse(value) as RoleJson[]).map((entry) => entry.value); } catch { return []; }
}

const iso = (value: Date | null): string | null => value ? value.toISOString() : null;

export function mapSqlPublicUser(row: UserRow): UserRecord {
  return {
    id: row.source_id,
    displayName: row.display_name,
    email: row.email,
    roles: parseRoles(row.roles_json),
    active: row.active,
    passwordUpdatedAt: iso(row.password_updated_at),
    passwordExpiresAt: iso(row.password_expires_at),
    mustChangePassword: row.must_change_password,
    lastLoginAt: iso(row.last_login_at),
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
  };
}

export async function readSqlPublicUsers(
  pagination: { enabled: boolean; page: number; pageSize: number },
): Promise<UserRecord[] | PageResult<UserRecord>> {
  const pool = await getSqlPool();
  const request = pool.request();
  if (pagination.enabled) {
    request.input("offset", sql.Int, (pagination.page - 1) * pagination.pageSize);
    request.input("pageSize", sql.Int, pagination.pageSize);
  }
  const result = await request.query<UserRow>(`
    SELECT ${pagination.enabled ? "COUNT_BIG(*) OVER() AS total_count," : "TOP (500) 0 AS total_count,"}
      users.source_id,users.display_name,users.email,users.active,users.password_updated_at,
      users.password_expires_at,users.must_change_password,users.last_login_at,
      users.created_at,users.created_by,users.updated_at,users.updated_by,
      COALESCE((SELECT user_role.role_id AS value FROM security.user_roles user_role
        WHERE user_role.user_key=users.user_key ORDER BY user_role.role_id FOR JSON PATH),N'[]') AS roles_json
    FROM security.users users
    ORDER BY users.display_name,users.email_normalized,users.user_key
    ${pagination.enabled ? "OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY" : ""};
  `);
  const items = result.recordset.map(mapSqlPublicUser);
  if (!pagination.enabled) return items;
  return { items, page: pagination.page, pageSize: pagination.pageSize, total: Number(result.recordset[0]?.total_count ?? 0) };
}
