import sql from "mssql";
import type { PageResult } from "./pagination";
import type { DatabaseRecord, DomainRecord } from "../types/models";
import { getSqlPool } from "./sql";

export type PublicDatabaseDto = ReturnType<typeof import("./publicDtos").toPublicDatabase>;

export type DomainFilters = {
  sourceId?: string;
  clientId?: string;
  status?: string;
  environment?: string;
  search?: string;
  responsable?: string;
  recurring?: "with" | "without";
  excludeDeleted?: boolean;
};

export type DatabaseFilters = {
  clientId?: string;
  domainId?: string;
  status?: string;
  environment?: string;
  search?: string;
  visibility?: "all" | "not-deleted" | "active";
};

type DomainRow = {
  source_id: string; client_source_id: string; client_name: string; domain_name: string;
  environment_id: string; current_web_version: string | null; status: DomainRecord["status"];
  notes: string | null; created_at: Date; created_by: string; updated_at: Date; updated_by: string;
  deleted_at: Date | null; deleted_by: string | null; last_updated_at: Date | null;
  last_updated_by: string | null; assignee_source_id: string | null; total_count: number;
};

type PublicDatabaseRow = {
  source_id: string; client_source_id: string; client_name: string; domain_source_id: string;
  domain_name: string; company_name: string; environment_id: string; initial_catalog: string;
  current_db_version: string | null; status: DatabaseRecord["status"]; notes: string | null;
  created_at: Date; updated_at: Date; last_updated_at: Date | null; total_count: number;
};

type RestrictedDatabaseRow = PublicDatabaseRow & {
  server_host_port: string; sql_user_id: string; password_secret_name: string;
  created_by: string; updated_by: string; deleted_at: Date | null; deleted_by: string | null;
  last_updated_by: string | null; assignee_source_id: string | null;
};

const iso = (value: Date | null) => value ? value.toISOString() : null;

function groupRows<T extends { source_id: string }>(rows: T[]): T[][] {
  const grouped = new Map<string, T[]>();
  for (const row of rows) grouped.set(row.source_id, [...(grouped.get(row.source_id) ?? []), row]);
  return [...grouped.values()];
}

export function mapSqlDomainRows(rows: DomainRow[]): DomainRecord {
  const first = rows[0];
  if (!first) throw new Error("El dominio SQL no existe.");
  return {
    id: first.source_id, clientId: first.client_source_id, clientName: first.client_name,
    domainName: first.domain_name, environment: first.environment_id,
    currentWebVersion: first.current_web_version ?? undefined,
    assignedUpdaterIds: rows.flatMap((row) => row.assignee_source_id ? [row.assignee_source_id] : []),
    status: first.status, notes: first.notes ?? undefined,
    createdAt: first.created_at.toISOString(), createdBy: first.created_by,
    updatedAt: first.updated_at.toISOString(), updatedBy: first.updated_by,
    deletedAt: iso(first.deleted_at), deletedBy: first.deleted_by,
    lastUpdatedAt: iso(first.last_updated_at), lastUpdatedBy: first.last_updated_by,
  };
}

export function mapSqlPublicDatabase(row: PublicDatabaseRow): PublicDatabaseDto {
  return {
    id: row.source_id, clientId: row.client_source_id, clientName: row.client_name,
    domainId: row.domain_source_id, domainName: row.domain_name, companyName: row.company_name,
    environment: row.environment_id, dbAccess: { initialCatalog: row.initial_catalog },
    currentDbVersion: row.current_db_version ?? undefined, status: row.status,
    notes: row.notes ?? undefined, createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(), lastUpdatedAt: iso(row.last_updated_at),
  };
}

export function mapSqlRestrictedDatabaseRows(rows: RestrictedDatabaseRow[]): DatabaseRecord {
  const first = rows[0];
  if (!first) throw new Error("La base de datos SQL no existe.");
  return {
    id: first.source_id, clientId: first.client_source_id, clientName: first.client_name,
    domainId: first.domain_source_id, domainName: first.domain_name, companyName: first.company_name,
    environment: first.environment_id,
    dbAccess: {
      serverHostPort: first.server_host_port, initialCatalog: first.initial_catalog,
      userId: first.sql_user_id, passwordSecretName: first.password_secret_name,
    },
    currentDbVersion: first.current_db_version ?? undefined,
    assignedUpdaterIds: rows.flatMap((row) => row.assignee_source_id ? [row.assignee_source_id] : []),
    status: first.status, notes: first.notes ?? undefined,
    createdAt: first.created_at.toISOString(), createdBy: first.created_by,
    updatedAt: first.updated_at.toISOString(), updatedBy: first.updated_by,
    deletedAt: iso(first.deleted_at), deletedBy: first.deleted_by,
    lastUpdatedAt: iso(first.last_updated_at), lastUpdatedBy: first.last_updated_by,
  };
}

function domainWhere(request: sql.Request, filters: DomainFilters): string {
  const conditions: string[] = [];
  if (filters.sourceId) { request.input("sourceId", sql.NVarChar(150), filters.sourceId); conditions.push("d.source_id=@sourceId"); }
  if (filters.clientId) { request.input("clientId", sql.NVarChar(150), filters.clientId); conditions.push("c.source_id=@clientId"); }
  if (filters.status) { request.input("status", sql.VarChar(20), filters.status); conditions.push("d.status=@status"); }
  if (filters.excludeDeleted) conditions.push("d.status<>'deleted'");
  if (filters.environment) { request.input("environment", sql.VarChar(20), filters.environment); conditions.push("d.environment_id=@environment"); }
  if (filters.search) {
    request.input("search", sql.NVarChar(500), `%${filters.search}%`);
    conditions.push("(c.name LIKE @search OR d.domain_name LIKE @search OR d.environment_id LIKE @search OR d.status LIKE @search OR d.notes LIKE @search)");
  }
  if (filters.responsable) {
    request.input("responsable", sql.NVarChar(150), filters.responsable);
    conditions.push("EXISTS (SELECT 1 FROM core.domain_assignees da JOIN security.users du ON du.user_key=da.user_key WHERE da.domain_key=d.domain_key AND du.source_id=@responsable)");
  }
  if (filters.recurring) {
    const recurrence = `EXISTS (
      SELECT 1 FROM scheduling.update_schedules rs
      LEFT JOIN scheduling.schedule_targets rt ON rt.schedule_key=rs.schedule_key AND rt.target_type='domain'
      WHERE rs.active=1 AND rs.deleted_at IS NULL AND rs.target_type='domain' AND rs.origin=N'domain_default'
        AND (rs.domain_key=d.domain_key OR rt.domain_key=d.domain_key)
    )`;
    conditions.push(filters.recurring === "with" ? recurrence : `NOT ${recurrence}`);
  }
  return conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
}

export async function readSqlDomains(
  filters: DomainFilters,
  pagination: { enabled: boolean; page: number; pageSize: number }
): Promise<DomainRecord[] | PageResult<DomainRecord>> {
  const pool = await getSqlPool();
  const request = pool.request();
  const where = domainWhere(request, filters);
  if (pagination.enabled) {
    request.input("offset", sql.Int, (pagination.page - 1) * pagination.pageSize);
    request.input("pageSize", sql.Int, pagination.pageSize);
  }
  const result = await request.query<DomainRow>(`
    WITH filtered AS (
      SELECT ${pagination.enabled ? "" : "TOP (500)"} d.domain_key,COUNT_BIG(*) OVER() AS total_count
      FROM core.domains d JOIN core.clients c ON c.client_key=d.client_key
      ${where}
      ORDER BY d.domain_name,d.source_id
      ${pagination.enabled ? "OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY" : ""}
    )
    SELECT d.source_id,c.source_id AS client_source_id,c.name AS client_name,d.domain_name,
      d.environment_id,d.current_web_version,d.status,d.notes,d.created_at,d.created_by,
      d.updated_at,d.updated_by,d.deleted_at,d.deleted_by,d.last_updated_at,d.last_updated_by,
      u.source_id AS assignee_source_id,f.total_count
    FROM filtered f JOIN core.domains d ON d.domain_key=f.domain_key
    JOIN core.clients c ON c.client_key=d.client_key
    LEFT JOIN core.domain_assignees a ON a.domain_key=d.domain_key
    LEFT JOIN security.users u ON u.user_key=a.user_key
    ORDER BY d.domain_name,d.source_id,u.source_id;
  `);
  const items = groupRows(result.recordset).map(mapSqlDomainRows);
  if (!pagination.enabled) return items;
  return { items, page: pagination.page, pageSize: pagination.pageSize, total: Number(result.recordset[0]?.total_count ?? 0) };
}

function databaseWhere(request: sql.Request, filters: DatabaseFilters): string {
  const conditions: string[] = [];
  if (filters.clientId) { request.input("clientId", sql.NVarChar(150), filters.clientId); conditions.push("c.source_id=@clientId"); }
  if (filters.domainId) { request.input("domainId", sql.NVarChar(150), filters.domainId); conditions.push("d.source_id=@domainId"); }
  if (filters.status) { request.input("status", sql.VarChar(20), filters.status); conditions.push("db.status=@status"); }
  if (filters.visibility === "not-deleted") conditions.push("db.status<>'deleted'");
  else if (filters.visibility === "active") conditions.push("db.status='active'");
  if (filters.environment) { request.input("environment", sql.VarChar(20), filters.environment); conditions.push("db.environment_id=@environment"); }
  if (filters.search) {
    request.input("search", sql.NVarChar(500), `%${filters.search}%`);
    conditions.push(`(c.name LIKE @search OR d.domain_name LIKE @search OR db.company_name LIKE @search
      OR p.initial_catalog LIKE @search OR p.server_host_port LIKE @search OR db.environment_id LIKE @search
      OR db.status LIKE @search OR db.notes LIKE @search)`);
  }
  return conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
}

export async function readSqlPublicDatabases(
  filters: DatabaseFilters,
  pagination: { enabled: boolean; page: number; pageSize: number }
): Promise<PublicDatabaseDto[] | PageResult<PublicDatabaseDto>> {
  const pool = await getSqlPool();
  const request = pool.request();
  const where = databaseWhere(request, filters);
  if (pagination.enabled) {
    request.input("offset", sql.Int, (pagination.page - 1) * pagination.pageSize);
    request.input("pageSize", sql.Int, pagination.pageSize);
  }
  const result = await request.query<PublicDatabaseRow>(`
    SELECT ${pagination.enabled ? "COUNT_BIG(*) OVER() AS total_count," : "TOP (500) 0 AS total_count,"}
      db.source_id,c.source_id AS client_source_id,c.name AS client_name,d.source_id AS domain_source_id,
      d.domain_name,db.company_name,db.environment_id,p.initial_catalog,db.current_db_version,
      db.status,db.notes,db.created_at,db.updated_at,db.last_updated_at
    FROM core.databases db JOIN core.clients c ON c.client_key=db.client_key
    JOIN core.domains d ON d.domain_key=db.domain_key
    JOIN core.database_access_profiles p ON p.access_profile_key=db.access_profile_key
    ${where}
    ORDER BY db.company_name,db.source_id
    ${pagination.enabled ? "OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY" : ""};
  `);
  const items = result.recordset.map(mapSqlPublicDatabase);
  if (!pagination.enabled) return items;
  return { items, page: pagination.page, pageSize: pagination.pageSize, total: Number(result.recordset[0]?.total_count ?? 0) };
}

export async function readSqlRestrictedDatabase(sourceId: string): Promise<DatabaseRecord | null> {
  const pool = await getSqlPool();
  const result = await pool.request().input("sourceId", sql.NVarChar(150), sourceId).query<RestrictedDatabaseRow>(`
    SELECT db.source_id,c.source_id AS client_source_id,c.name AS client_name,d.source_id AS domain_source_id,
      d.domain_name,db.company_name,db.environment_id,p.initial_catalog,db.current_db_version,
      db.status,db.notes,db.created_at,db.created_by,db.updated_at,db.updated_by,db.deleted_at,
      db.deleted_by,db.last_updated_at,db.last_updated_by,p.server_host_port,p.sql_user_id,
      p.password_secret_name,u.source_id AS assignee_source_id,0 AS total_count
    FROM core.databases db JOIN core.clients c ON c.client_key=db.client_key
    JOIN core.domains d ON d.domain_key=db.domain_key
    JOIN core.database_access_profiles p ON p.access_profile_key=db.access_profile_key
    LEFT JOIN core.database_assignees a ON a.database_key=db.database_key
    LEFT JOIN security.users u ON u.user_key=a.user_key
    WHERE db.source_id=@sourceId
    ORDER BY u.source_id;
  `);
  return result.recordset.length ? mapSqlRestrictedDatabaseRows(result.recordset) : null;
}
