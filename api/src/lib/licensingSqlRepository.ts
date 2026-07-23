import sql from "mssql";
import type { PageResult } from "./pagination";
import type { ClientRecord, LicenseAssignmentRecord, LicenseModuleRecord } from "../types/models";
import { getSqlPool } from "./sql";

type ModuleRow = {
  source_id: string; name: string; code: string | null; description: string | null;
  status: "active" | "inactive" | "deleted"; notes: string | null;
  created_at: Date; created_by: string; updated_at: Date; updated_by: string;
  deleted_at: Date | null; deleted_by: string | null; total_count: number;
};

type AssignmentRow = {
  source_id: string; module_source_id: string; module_name: string; module_code: string | null;
  target_type: "client" | "domain" | "database"; client_source_id: string;
  client_name: string; domain_source_id: string | null; domain_name: string | null;
  database_source_id: string | null; database_name: string | null; environment_id: string | null;
  status: "active" | "inactive" | "deleted"; created_at: Date; created_by: string;
  updated_at: Date; updated_by: string; deleted_at: Date | null; deleted_by: string | null;
  total_count: number;
};

const iso = (value: Date | null) => value ? value.toISOString() : null;

export function mapSqlLicenseModule(row: ModuleRow): LicenseModuleRecord {
  return {
    id: row.source_id, name: row.name, code: row.code ?? undefined,
    description: row.description ?? undefined, status: row.status,
    active: row.status === "active", notes: row.notes ?? undefined,
    createdAt: row.created_at.toISOString(), createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(), updatedBy: row.updated_by,
    deletedAt: iso(row.deleted_at), deletedBy: row.deleted_by,
  };
}

export function mapSqlLicenseAssignment(row: AssignmentRow): LicenseAssignmentRecord {
  const targetId = row.target_type === "client"
    ? row.client_source_id
    : row.target_type === "domain"
      ? row.domain_source_id!
      : row.database_source_id!;
  return {
    id: row.source_id, moduleId: row.module_source_id, moduleName: row.module_name,
    moduleCode: row.module_code ?? undefined, targetType: row.target_type, targetId,
    clientId: row.client_source_id, clientName: row.client_name,
    domainId: row.domain_source_id ?? undefined, domainName: row.domain_name ?? undefined,
    databaseId: row.database_source_id ?? undefined, databaseName: row.database_name ?? undefined,
    environment: row.environment_id ?? "all", status: row.status, active: row.status === "active",
    createdAt: row.created_at.toISOString(), createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(), updatedBy: row.updated_by,
    deletedAt: iso(row.deleted_at), deletedBy: row.deleted_by,
  };
}

export function expectedNormalizedLicenseAssignmentCount(
  explicitAssignments: LicenseAssignmentRecord[],
  clients: ClientRecord[],
  includeDeleted: boolean
): number {
  const nonDeletedClientAssignments = new Set(explicitAssignments
    .filter((assignment) => assignment.status !== "deleted"
      && (assignment.targetType ?? "client") === "client"
      && (assignment.environment ?? "all") === "all"
      && assignment.clientId)
    .map((assignment) => `${assignment.clientId}\u0000${assignment.moduleId}`));
  const visibleExplicit = includeDeleted
    ? explicitAssignments.length
    : explicitAssignments.filter((assignment) => assignment.status !== "deleted" && !assignment.deletedAt).length;
  const embedded = new Set<string>();
  for (const client of clients) {
    for (const moduleId of new Set(client.licenseModuleIds ?? [])) {
      const key = `${client.id}\u0000${moduleId}`;
      if (!nonDeletedClientAssignments.has(key)) embedded.add(key);
    }
  }
  return visibleExplicit + embedded.size;
}

export async function readSqlLicenseModules(
  filters: { includeDeleted: boolean; search?: string },
  pagination: { enabled: boolean; page: number; pageSize: number }
): Promise<LicenseModuleRecord[] | PageResult<LicenseModuleRecord>> {
  const pool = await getSqlPool();
  const request = pool.request();
  const conditions: string[] = [];
  if (!filters.includeDeleted) conditions.push("status<>'deleted'");
  if (filters.search) {
    request.input("search", sql.NVarChar(500), `%${filters.search}%`);
    conditions.push("(name LIKE @search OR code LIKE @search OR description LIKE @search OR status LIKE @search)");
  }
  if (pagination.enabled) {
    request.input("offset", sql.Int, (pagination.page - 1) * pagination.pageSize);
    request.input("pageSize", sql.Int, pagination.pageSize);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await request.query<ModuleRow>(`
    SELECT ${pagination.enabled ? "COUNT_BIG(*) OVER() AS total_count," : "TOP (500) 0 AS total_count,"}
      source_id,name,code,description,status,notes,created_at,created_by,updated_at,updated_by,
      deleted_at,deleted_by
    FROM licensing.license_modules
    ${where}
    ORDER BY name,source_id
    ${pagination.enabled ? "OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY" : ""};
  `);
  const items = result.recordset.map(mapSqlLicenseModule);
  if (!pagination.enabled) return items;
  return { items, page: pagination.page, pageSize: pagination.pageSize, total: Number(result.recordset[0]?.total_count ?? 0) };
}

export async function readSqlLicenseAssignments(
  includeDeleted: boolean,
  pagination: { enabled: boolean; page: number; pageSize: number }
): Promise<LicenseAssignmentRecord[] | PageResult<LicenseAssignmentRecord>> {
  const pool = await getSqlPool();
  const request = pool.request();
  if (pagination.enabled) {
    request.input("offset", sql.Int, (pagination.page - 1) * pagination.pageSize);
    request.input("pageSize", sql.Int, pagination.pageSize);
  }
  const result = await request.query<AssignmentRow>(`
    SELECT ${pagination.enabled ? "COUNT_BIG(*) OVER() AS total_count," : "TOP (500) 0 AS total_count,"}
      a.source_id,m.source_id AS module_source_id,COALESCE(a.module_name_snapshot,m.name) AS module_name,
      COALESCE(a.module_code_snapshot,m.code) AS module_code,a.target_type,
      COALESCE(client_direct.source_id,domain_client.source_id,database_client.source_id) AS client_source_id,
      COALESCE(client_direct.name,domain_client.name,database_client.name) AS client_name,
      COALESCE(domain_direct.source_id,database_domain.source_id) AS domain_source_id,
      COALESCE(domain_direct.domain_name,database_domain.domain_name) AS domain_name,
      database_record.source_id AS database_source_id,access_profile.initial_catalog AS database_name,
      a.environment_id,a.status,a.created_at,a.created_by,a.updated_at,a.updated_by,a.deleted_at,a.deleted_by
    FROM licensing.license_assignments a
    JOIN licensing.license_modules m ON m.module_key=a.module_key
    LEFT JOIN core.clients client_direct ON client_direct.client_key=a.client_key
    LEFT JOIN core.domains domain_direct ON domain_direct.domain_key=a.domain_key
    LEFT JOIN core.clients domain_client ON domain_client.client_key=domain_direct.client_key
    LEFT JOIN core.databases database_record ON database_record.database_key=a.database_key
    LEFT JOIN core.clients database_client ON database_client.client_key=database_record.client_key
    LEFT JOIN core.domains database_domain ON database_domain.domain_key=database_record.domain_key
    LEFT JOIN core.database_access_profiles access_profile ON access_profile.access_profile_key=database_record.access_profile_key
    ${includeDeleted ? "" : "WHERE a.status<>'deleted'"}
    ORDER BY COALESCE(client_direct.name,domain_client.name,database_client.name),a.source_id
    ${pagination.enabled ? "OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY" : ""};
  `);
  const items = result.recordset.map(mapSqlLicenseAssignment);
  if (!pagination.enabled) return items;
  return { items, page: pagination.page, pageSize: pagination.pageSize, total: Number(result.recordset[0]?.total_count ?? 0) };
}
