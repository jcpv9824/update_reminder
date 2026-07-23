import sql from "mssql";
import type { PageResult } from "./pagination";
import type { AuditLog } from "../types/models";
import { getSqlPool } from "./sql";

export type AuditLogFilters = {
  clientId?: string;
  domainId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  performedBy?: string;
  search?: string;
  fromDate?: string;
  toDate?: string;
};

type SqlAuditLogRow = {
  source_id: string;
  entity_type: string;
  entity_source_id: string;
  client_source_id: string | null;
  client_name_snapshot: string | null;
  domain_source_id: string | null;
  domain_name_snapshot: string | null;
  company_name_snapshot: string | null;
  action: string;
  performed_by: string;
  performed_by_email: string | null;
  performed_at: Date;
  before_json: string | null;
  after_json: string | null;
  metadata_json: string | null;
  total_count?: number;
};

function parseJson(value: string | null): unknown {
  return value === null ? undefined : JSON.parse(value);
}

export function mapSqlAuditLog(row: SqlAuditLogRow): AuditLog {
  return {
    id: row.source_id,
    entityType: row.entity_type,
    entityId: row.entity_source_id,
    clientId: row.client_source_id ?? undefined,
    clientName: row.client_name_snapshot ?? undefined,
    domainId: row.domain_source_id ?? undefined,
    domainName: row.domain_name_snapshot ?? undefined,
    companyName: row.company_name_snapshot ?? undefined,
    action: row.action,
    performedBy: row.performed_by,
    performedByEmail: row.performed_by_email ?? "",
    performedAt: row.performed_at.toISOString(),
    before: parseJson(row.before_json),
    after: parseJson(row.after_json),
    metadata: parseJson(row.metadata_json) as Record<string, unknown> | undefined,
  };
}

function addFilters(request: sql.Request, filters: AuditLogFilters): string[] {
  const conditions: string[] = [];
  const exact: Array<[keyof AuditLogFilters, string, string, number]> = [
    ["clientId", "clientId", "c.source_id", 150],
    ["domainId", "domainId", "d.source_id", 150],
    ["entityType", "entityType", "a.entity_type", 100],
    ["entityId", "entityId", "a.entity_source_id", 150],
    ["action", "action", "a.action", 160],
    ["performedBy", "performedBy", "a.performed_by", 150],
  ];
  for (const [filterName, parameterName, column, length] of exact) {
    const value = filters[filterName];
    if (!value) continue;
    request.input(parameterName, sql.NVarChar(length), value);
    conditions.push(`${column}=@${parameterName}`);
  }
  if (filters.search) {
    request.input("search", sql.NVarChar(500), `%${filters.search}%`);
    conditions.push(`(
      a.action LIKE @search OR a.entity_type LIKE @search OR a.entity_source_id LIKE @search
      OR a.client_name_snapshot LIKE @search OR a.domain_name_snapshot LIKE @search
      OR a.performed_by_email LIKE @search OR a.performed_by LIKE @search
    )`);
  }
  if (filters.fromDate) {
    request.input("fromDate", sql.DateTime2(3), new Date(filters.fromDate));
    conditions.push("a.performed_at>=@fromDate");
  }
  if (filters.toDate) {
    request.input("toDate", sql.DateTime2(3), new Date(filters.toDate));
    conditions.push("a.performed_at<=@toDate");
  }
  return conditions;
}

export async function readSqlAuditLogs(
  filters: AuditLogFilters,
  pagination: { enabled: boolean; page: number; pageSize: number }
): Promise<AuditLog[] | PageResult<AuditLog>> {
  const pool = await getSqlPool();
  const request = pool.request();
  const conditions = addFilters(request, filters);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  if (pagination.enabled) {
    request.input("offset", sql.Int, (pagination.page - 1) * pagination.pageSize);
    request.input("pageSize", sql.Int, pagination.pageSize);
  }
  const result = await request.query<SqlAuditLogRow>(`
    SELECT ${pagination.enabled ? "COUNT_BIG(*) OVER() AS total_count," : "TOP (500)"}
      a.source_id,a.entity_type,a.entity_source_id,c.source_id AS client_source_id,
      a.client_name_snapshot,d.source_id AS domain_source_id,a.domain_name_snapshot,
      a.company_name_snapshot,a.action,a.performed_by,a.performed_by_email,a.performed_at,
      a.before_json,a.after_json,a.metadata_json
    FROM audit.audit_logs AS a
    LEFT JOIN core.clients AS c ON c.client_key=a.client_key
    LEFT JOIN core.domains AS d ON d.domain_key=a.domain_key
    ${where}
    ORDER BY a.performed_at DESC,a.audit_log_key DESC
    ${pagination.enabled ? "OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY" : ""};
  `);
  const items = result.recordset.map(mapSqlAuditLog);
  if (!pagination.enabled) return items;
  return {
    items,
    page: pagination.page,
    pageSize: pagination.pageSize,
    total: Number(result.recordset[0]?.total_count ?? 0),
  };
}
