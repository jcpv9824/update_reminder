import sql from "mssql";
import type { PageResult } from "./pagination";
import { getSqlPool } from "./sql";
import type { UpdateSchedule, Weekday } from "../types/models";

export type ScheduleSummaryDto = {
  proximas: number;
  vencidas: number;
  conError: number;
  completadas: number;
  requiereAtencion: boolean;
};

export type SqlScheduleDto = UpdateSchedule & { summary: ScheduleSummaryDto };

type ScheduleRow = {
  schedule_key: number;
  source_id: string;
  client_source_id: string;
  client_name: string;
  domain_source_id: string | null;
  domain_name: string | null;
  name: string;
  target_type: "domain" | "database";
  frequency_type: UpdateSchedule["frequencyType"];
  every_n_weeks: number | null;
  interval_days: number | null;
  day_of_month: number | null;
  start_date: string;
  end_date: string | null;
  timezone: string;
  assigned_role: string;
  domain_assigned_role: string | null;
  database_assigned_role: string | null;
  database_reminder_recipients_mode: "assignedUsers" | "roleUsers" | null;
  selection_mode: "manual" | "licensing" | null;
  manual_target_types: "domains_and_databases" | "domains_only" | "databases_only" | null;
  assignment_mode: "role" | "users";
  origin: string | null;
  active: boolean;
  completed_at: Date | null;
  completed_reason: string | null;
  notes: string | null;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
  target_ids_json: string | null;
  weekdays_json: string | null;
  preferred_weekdays_json: string | null;
  general_assignees_json: string | null;
  database_assignees_json: string | null;
  reminders_json: string | null;
  scope_groups_json: string | null;
  licensing_scope_json: string | null;
  proximas: number | null;
  vencidas: number | null;
  con_error: number | null;
  completadas: number | null;
  total_count: number;
};

type IdJson = { id: string };
type DayJson = { weekday: number };
type ReminderJson = {
  remindersEnabled: boolean;
  reminderTime: string | null;
  reminderRecipientsMode: "assignedUsers" | "roleUsers" | "customEmails" | null;
  reminderDaysBefore: Array<{ value: number }>;
  customReminderEmails: Array<{ value: string }>;
};
type ScopeGroupJson = {
  clientId: string;
  includeAllDomains: boolean;
  domains: Array<{
    domainId: string;
    includeAllDatabases: boolean;
    databaseIds: IdJson[];
  }>;
};
type LicensingScopeJson = {
  licenseMatchMode: "any" | "all";
  environment: string | null;
  targetTypes: "domains_and_databases" | "domains_only" | "databases_only";
  activeOnly: boolean;
  licenseModuleIds: IdJson[];
  excludedDomainIds: IdJson[];
  excludedDatabaseIds: IdJson[];
};

const weekdayByNumber: Record<number, Weekday> = {
  1: "MONDAY", 2: "TUESDAY", 3: "WEDNESDAY", 4: "THURSDAY",
  5: "FRIDAY", 6: "SATURDAY", 7: "SUNDAY",
};

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function mapSqlSchedule(row: ScheduleRow): SqlScheduleDto {
  const targets = parseJson<IdJson[]>(row.target_ids_json, []);
  const weekdays = parseJson<DayJson[]>(row.weekdays_json, []).map((entry) => weekdayByNumber[entry.weekday]).filter(Boolean);
  const preferredWeekdays = parseJson<DayJson[]>(row.preferred_weekdays_json, []).map((entry) => weekdayByNumber[entry.weekday]).filter(Boolean);
  const generalAssignees = parseJson<IdJson[]>(row.general_assignees_json, []);
  const databaseAssignees = parseJson<IdJson[]>(row.database_assignees_json, []);
  const reminder = parseJson<ReminderJson | null>(row.reminders_json, null);
  const scopeGroups = parseJson<ScopeGroupJson[]>(row.scope_groups_json, []);
  const licensingScope = parseJson<LicensingScopeJson | null>(row.licensing_scope_json, null);
  const proximas = Number(row.proximas ?? 0);
  const vencidas = Number(row.vencidas ?? 0);
  const conError = Number(row.con_error ?? 0);
  const completadas = Number(row.completadas ?? 0);

  return {
    id: row.source_id,
    name: row.name,
    clientId: row.client_source_id,
    clientName: row.client_name,
    domainId: row.domain_source_id ?? undefined,
    domainName: row.domain_name ?? undefined,
    targetType: row.target_type,
    targetIds: targets.map((entry) => entry.id),
    frequencyType: row.frequency_type,
    everyNWeeks: row.every_n_weeks ?? undefined,
    weekdays: weekdays.length ? weekdays : undefined,
    intervalDays: row.interval_days ?? undefined,
    preferredWeekdays: preferredWeekdays.length ? preferredWeekdays : undefined,
    dayOfMonth: row.day_of_month ?? undefined,
    startDate: row.start_date,
    endDate: row.end_date,
    timezone: row.timezone,
    assignedRole: row.assigned_role,
    assignedUserIds: generalAssignees.map((entry) => entry.id),
    databaseAssignedUserIds: databaseAssignees.map((entry) => entry.id),
    databaseReminderRecipientsMode: row.database_reminder_recipients_mode ?? undefined,
    scopeGroups: scopeGroups.length ? scopeGroups.map((group) => ({
      clientId: group.clientId,
      includeAllDomains: group.includeAllDomains,
      domains: group.domains.map((domain) => ({
        domainId: domain.domainId,
        includeAllDatabases: domain.includeAllDatabases,
        databaseIds: domain.databaseIds.map((entry) => entry.id),
      })),
    })) : undefined,
    selectionMode: row.selection_mode ?? undefined,
    manualTargetTypes: row.manual_target_types ?? undefined,
    licensingScope: licensingScope ? {
      licenseModuleIds: licensingScope.licenseModuleIds.map((entry) => entry.id),
      licenseMatchMode: licensingScope.licenseMatchMode,
      environment: licensingScope.environment ?? "all",
      targetTypes: licensingScope.targetTypes,
      activeOnly: licensingScope.activeOnly,
      excludedDomainIds: licensingScope.excludedDomainIds.map((entry) => entry.id),
      excludedDatabaseIds: licensingScope.excludedDatabaseIds.map((entry) => entry.id),
    } : undefined,
    assignmentMode: row.assignment_mode,
    domainAssignedRole: row.domain_assigned_role ?? undefined,
    databaseAssignedRole: row.database_assigned_role ?? undefined,
    origin: row.origin ?? undefined,
    active: row.active,
    completedAt: iso(row.completed_at),
    completedReason: row.completed_reason,
    notes: row.notes ?? undefined,
    reminders: reminder ? {
      remindersEnabled: reminder.remindersEnabled,
      reminderDaysBefore: reminder.reminderDaysBefore.map((entry) => Number(entry.value)),
      reminderTime: reminder.reminderTime ?? "08:00",
      reminderRecipientsMode: reminder.reminderRecipientsMode ?? "roleUsers",
      customReminderEmails: reminder.customReminderEmails.map((entry) => entry.value),
    } : undefined,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
    summary: { proximas, vencidas, conError, completadas, requiereAtencion: vencidas > 0 || conError > 0 },
  };
}

function escapeLike(value: string): string {
  return value.replace(/\[/g, "[[]").replace(/%/g, "[%]").replace(/_/g, "[_]");
}

export async function readSqlSchedules(
  filters: { sourceId?: string; clientId?: string | null; origin?: string | null; search?: string | null },
  pagination: { enabled: boolean; page: number; pageSize: number },
  today: string,
): Promise<SqlScheduleDto[] | PageResult<SqlScheduleDto>> {
  const pool = await getSqlPool();
  const request = pool.request();
  const conditions: string[] = ["s.deleted_at IS NULL"];
  request.input("today", sql.VarChar(10), today);
  if (filters.sourceId) {
    request.input("sourceId", sql.NVarChar(150), filters.sourceId);
    conditions.push("s.source_id=@sourceId");
  }
  if (filters.clientId) {
    request.input("clientId", sql.NVarChar(150), filters.clientId);
    conditions.push("client.source_id=@clientId");
  }
  if (filters.origin) {
    request.input("origin", sql.NVarChar(80), filters.origin);
    conditions.push("s.origin=@origin");
  }
  const search = filters.search?.trim();
  if (search) {
    request.input("search", sql.NVarChar(504), `%${escapeLike(search)}%`);
    conditions.push(`(
      s.client_name_snapshot LIKE @search OR s.domain_name_snapshot LIKE @search
      OR CASE s.target_type WHEN 'database' THEN N'base de datos' ELSE N'dominio' END LIKE @search
      OR CASE COALESCE(s.selection_mode,'manual') WHEN 'licensing' THEN N'licenciamiento' ELSE N'manual' END LIKE @search
      OR s.frequency_type LIKE @search OR s.assigned_role LIKE @search
      OR s.domain_assigned_role LIKE @search OR s.database_assigned_role LIKE @search
      OR CASE WHEN s.active=1 THEN N'activo' ELSE N'inactivo' END LIKE @search
      OR CASE WHEN s.active=1 THEN N'true' ELSE N'false' END LIKE @search
      OR s.notes LIKE @search
      OR EXISTS (
        SELECT 1 FROM scheduling.licensing_scope_modules lsm
        JOIN licensing.license_modules lm ON lm.module_key=lsm.module_key
        WHERE lsm.schedule_key=s.schedule_key AND (lm.name LIKE @search OR lm.code LIKE @search)
      )
    )`);
  }
  if (pagination.enabled) {
    request.input("offset", sql.Int, (pagination.page - 1) * pagination.pageSize);
    request.input("pageSize", sql.Int, pagination.pageSize);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await request.query<ScheduleRow>(`
    SELECT ${pagination.enabled ? "COUNT_BIG(*) OVER() AS total_count," : "TOP (500) 0 AS total_count,"}
      s.schedule_key,s.source_id,client.source_id AS client_source_id,
      COALESCE(s.client_name_snapshot,client.name) AS client_name,
      domain_record.source_id AS domain_source_id,
      COALESCE(s.domain_name_snapshot,domain_record.domain_name) AS domain_name,
      s.name,s.target_type,s.frequency_type,s.every_n_weeks,s.interval_days,s.day_of_month,
      CONVERT(char(10),s.start_date,23) AS start_date,CONVERT(char(10),s.end_date,23) AS end_date,
      s.timezone,s.assigned_role,s.domain_assigned_role,s.database_assigned_role,
      s.database_reminder_recipients_mode,s.selection_mode,s.manual_target_types,s.assignment_mode,
      s.origin,s.active,s.completed_at,s.completed_reason,s.notes,s.created_at,s.created_by,s.updated_at,s.updated_by,
      COALESCE((
        SELECT COALESCE(target_domain.source_id,target_database.source_id) AS id
        FROM scheduling.schedule_targets target
        LEFT JOIN core.domains target_domain ON target_domain.domain_key=target.domain_key
        LEFT JOIN core.databases target_database ON target_database.database_key=target.database_key
        WHERE target.schedule_key=s.schedule_key
        ORDER BY COALESCE(target_domain.source_id,target_database.source_id)
        FOR JSON PATH
      ),N'[]') AS target_ids_json,
      COALESCE((SELECT weekday FROM scheduling.schedule_weekdays
        WHERE schedule_key=s.schedule_key AND kind='weekly' ORDER BY weekday FOR JSON PATH),N'[]') AS weekdays_json,
      COALESCE((SELECT weekday FROM scheduling.schedule_weekdays
        WHERE schedule_key=s.schedule_key AND kind='preferred' ORDER BY weekday FOR JSON PATH),N'[]') AS preferred_weekdays_json,
      COALESCE((SELECT users.source_id AS id FROM scheduling.schedule_assignees assignee
        JOIN security.users users ON users.user_key=assignee.user_key
        WHERE assignee.schedule_key=s.schedule_key AND assignee.assignment_kind='general'
        ORDER BY users.source_id FOR JSON PATH),N'[]') AS general_assignees_json,
      COALESCE((SELECT users.source_id AS id FROM scheduling.schedule_assignees assignee
        JOIN security.users users ON users.user_key=assignee.user_key
        WHERE assignee.schedule_key=s.schedule_key AND assignee.assignment_kind='database'
        ORDER BY users.source_id FOR JSON PATH),N'[]') AS database_assignees_json,
      (SELECT reminder.reminders_enabled AS remindersEnabled,
          CONVERT(char(5),reminder.reminder_time,108) AS reminderTime,
          reminder.reminder_recipients_mode AS reminderRecipientsMode,
          JSON_QUERY(COALESCE((SELECT days_before AS value FROM scheduling.schedule_reminder_days
            WHERE schedule_key=s.schedule_key ORDER BY days_before FOR JSON PATH),N'[]')) AS reminderDaysBefore,
          JSON_QUERY(COALESCE((SELECT email_normalized AS value FROM scheduling.schedule_reminder_emails
            WHERE schedule_key=s.schedule_key ORDER BY email_normalized FOR JSON PATH),N'[]')) AS customReminderEmails
        FROM scheduling.schedule_reminder_settings reminder
        WHERE reminder.schedule_key=s.schedule_key FOR JSON PATH,WITHOUT_ARRAY_WRAPPER) AS reminders_json,
      COALESCE((SELECT scope_client.source_id AS clientId,scope_group.include_all_domains AS includeAllDomains,
          JSON_QUERY(COALESCE((SELECT scope_domain_record.source_id AS domainId,scope_domain.include_all_databases AS includeAllDatabases,
              JSON_QUERY(COALESCE((SELECT scope_database_record.source_id AS id
                FROM scheduling.scope_databases scope_database
                JOIN core.databases scope_database_record ON scope_database_record.database_key=scope_database.database_key
                WHERE scope_database.scope_domain_key=scope_domain.scope_domain_key
                ORDER BY scope_database_record.source_id FOR JSON PATH),N'[]')) AS databaseIds
            FROM scheduling.scope_domains scope_domain
            JOIN core.domains scope_domain_record ON scope_domain_record.domain_key=scope_domain.domain_key
            WHERE scope_domain.scope_group_key=scope_group.scope_group_key
            ORDER BY scope_domain.ordinal FOR JSON PATH),N'[]')) AS domains
        FROM scheduling.scope_groups scope_group
        JOIN core.clients scope_client ON scope_client.client_key=scope_group.client_key
        WHERE scope_group.schedule_key=s.schedule_key ORDER BY scope_group.ordinal FOR JSON PATH),N'[]') AS scope_groups_json,
      (SELECT license_scope.license_match_mode AS licenseMatchMode,
          license_scope.environment_id AS environment,license_scope.target_types AS targetTypes,
          license_scope.active_only AS activeOnly,
          JSON_QUERY(COALESCE((SELECT module_record.source_id AS id
            FROM scheduling.licensing_scope_modules scope_module
            JOIN licensing.license_modules module_record ON module_record.module_key=scope_module.module_key
            WHERE scope_module.schedule_key=s.schedule_key ORDER BY module_record.source_id FOR JSON PATH),N'[]')) AS licenseModuleIds,
          JSON_QUERY(COALESCE((SELECT excluded_domain_record.source_id AS id
            FROM scheduling.licensing_excluded_domains excluded_domain
            JOIN core.domains excluded_domain_record ON excluded_domain_record.domain_key=excluded_domain.domain_key
            WHERE excluded_domain.schedule_key=s.schedule_key ORDER BY excluded_domain_record.source_id FOR JSON PATH),N'[]')) AS excludedDomainIds,
          JSON_QUERY(COALESCE((SELECT excluded_database_record.source_id AS id
            FROM scheduling.licensing_excluded_databases excluded_database
            JOIN core.databases excluded_database_record ON excluded_database_record.database_key=excluded_database.database_key
            WHERE excluded_database.schedule_key=s.schedule_key ORDER BY excluded_database_record.source_id FOR JSON PATH),N'[]')) AS excludedDatabaseIds
        FROM scheduling.licensing_scope license_scope
        WHERE license_scope.schedule_key=s.schedule_key FOR JSON PATH,WITHOUT_ARRAY_WRAPPER) AS licensing_scope_json,
      summary.proximas,summary.vencidas,summary.con_error,summary.completadas
    FROM scheduling.update_schedules s
    JOIN core.clients client ON client.client_key=s.client_key
    LEFT JOIN core.domains domain_record ON domain_record.domain_key=s.domain_key
    OUTER APPLY (
      SELECT
        SUM(CASE WHEN task.status NOT IN ('completed','cancelled','failed','blocked') AND task.task_date>=CONVERT(date,@today,23) THEN 1 ELSE 0 END) AS proximas,
        SUM(CASE WHEN task.status NOT IN ('completed','cancelled','failed','blocked') AND task.task_date<CONVERT(date,@today,23) THEN 1 ELSE 0 END) AS vencidas,
        SUM(CASE WHEN task.status IN ('failed','blocked') THEN 1 ELSE 0 END) AS con_error,
        SUM(CASE WHEN task.status='completed' THEN 1 ELSE 0 END) AS completadas
      FROM workflow.update_tasks task
      WHERE task.task_date BETWEEN DATEADD(day,-30,CONVERT(date,@today,23)) AND DATEADD(day,30,CONVERT(date,@today,23))
        AND task.task_key IN (
          SELECT source.task_key FROM workflow.task_sources source WHERE source.schedule_key=s.schedule_key
          UNION
          SELECT primary_task.task_key FROM workflow.update_tasks primary_task WHERE primary_task.primary_schedule_key=s.schedule_key
        )
    ) summary
    ${where}
    ORDER BY s.created_at DESC,s.source_id
    ${pagination.enabled ? "OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY" : ""};
  `);

  const items = result.recordset.map(mapSqlSchedule);
  if (!pagination.enabled) return items;
  return { items, page: pagination.page, pageSize: pagination.pageSize, total: Number(result.recordset[0]?.total_count ?? 0) };
}
