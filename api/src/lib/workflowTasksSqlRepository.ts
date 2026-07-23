import sql from "mssql";
import { getSqlPool } from "./sql";
import type { UpdateTask } from "../types/models";

type IdJson = { id: string };
type SourceJson = { scheduleId: string; scheduleType: string | null; reason: string | null; createdAt: string };

export type TaskRow = {
  source_id: string;
  dedupe_key: string | null;
  task_date: string;
  task_bucket: string;
  client_source_id: string;
  client_name: string;
  domain_source_id: string;
  domain_name: string;
  target_type: "domain" | "database";
  target_source_id: string;
  target_name: string;
  primary_schedule_source_id: string | null;
  assigned_role: string;
  status: UpdateTask["status"];
  result: string | null;
  notes: string | null;
  completed_at: Date | null;
  completed_by: string | null;
  completed_with_problems: boolean;
  problem_note: string | null;
  completion_note: string | null;
  blocked_at: Date | null;
  blocked_by: string | null;
  block_reason: string | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution_comment: string | null;
  reopened_at: Date | null;
  reopened_by: string | null;
  reopen_reason: string | null;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
  assignees_json: string | null;
  sources_json: string | null;
};

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

const iso = (value: Date | null): string | null => value ? value.toISOString() : null;

export function mapSqlWorkflowTask(row: TaskRow): UpdateTask {
  const assignees = parseJson<IdJson[]>(row.assignees_json, []);
  const sources = parseJson<SourceJson[]>(row.sources_json, []);
  return {
    id: row.source_id,
    dedupeKey: row.dedupe_key ?? undefined,
    taskDate: row.task_date,
    taskBucket: row.task_bucket,
    clientId: row.client_source_id,
    clientName: row.client_name,
    domainId: row.domain_source_id,
    domainName: row.domain_name,
    targetType: row.target_type,
    targetId: row.target_source_id,
    targetName: row.target_name,
    scheduleId: row.primary_schedule_source_id ?? "",
    rootScheduleId: row.primary_schedule_source_id ?? undefined,
    assignedRole: row.assigned_role,
    assignedUserIds: assignees.map((entry) => entry.id),
    sources: sources.map((entry) => ({
      scheduleId: entry.scheduleId,
      scheduleType: (entry.scheduleType ?? "normal") as "normal" | "special" | "licensing" | "manual",
      reason: entry.reason ?? undefined,
      createdAt: entry.createdAt,
    })),
    status: row.status,
    result: row.result,
    notes: row.notes ?? "",
    completedAt: iso(row.completed_at),
    completedBy: row.completed_by,
    completedWithProblems: row.completed_with_problems,
    problemNote: row.problem_note ?? undefined,
    completionNote: row.completion_note ?? undefined,
    blockedAt: iso(row.blocked_at),
    blockedBy: row.blocked_by,
    blockReason: row.block_reason,
    resolvedAt: iso(row.resolved_at),
    resolvedBy: row.resolved_by,
    resolutionComment: row.resolution_comment,
    reopenedAt: iso(row.reopened_at),
    reopenedBy: row.reopened_by,
    reopenReason: row.reopen_reason,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
  };
}

export type WorkflowTaskFilters = {
  sourceId?: string;
  operationalOnly?: boolean;
  date?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  range?: string | null;
  targetType?: string | null;
  status?: string | null;
  clientId?: string | null;
  domainId?: string | null;
  today: string;
  includeCancelled?: boolean;
};

export async function readSqlWorkflowTasks(filters: WorkflowTaskFilters): Promise<UpdateTask[]> {
  const pool = await getSqlPool();
  const request = pool.request();
  const conditions: string[] = [];
  request.input("today", sql.VarChar(10), filters.today);
  if (filters.sourceId) {
    request.input("sourceId", sql.NVarChar(260), filters.sourceId);
    conditions.push("(task.source_id=@sourceId OR EXISTS (SELECT 1 FROM workflow.task_source_aliases alias WHERE alias.task_key=task.task_key AND alias.alias_source_id=@sourceId))");
  }
  const dateFilters: Array<[keyof Pick<WorkflowTaskFilters, "date" | "dateFrom" | "dateTo">, string, string]> = [
    ["date", "date", "="], ["dateFrom", "dateFrom", ">="], ["dateTo", "dateTo", "<="],
  ];
  for (const [field, parameter, operator] of dateFilters) {
    const value = filters[field];
    if (value) {
      request.input(parameter, sql.VarChar(10), value);
      conditions.push(`task.task_date ${operator} TRY_CONVERT(date,@${parameter},23)`);
    }
  }
  if (filters.range === "overdue") {
    conditions.push("task.task_date<CONVERT(date,@today,23) AND task.status IN ('pending','in_progress','failed','blocked','reopened')");
  } else if (filters.range === "today") {
    conditions.push("task.task_date=CONVERT(date,@today,23)");
  } else if (filters.range === "upcoming") {
    conditions.push("task.task_date>CONVERT(date,@today,23)");
  }
  if (filters.targetType) {
    request.input("targetType", sql.VarChar(20), filters.targetType);
    conditions.push("task.target_type=@targetType");
  }
  if (filters.status) {
    request.input("status", sql.VarChar(30), filters.status);
    conditions.push("task.status=@status");
  } else if (!filters.sourceId && !filters.includeCancelled) {
    conditions.push("task.status<>'cancelled'");
  }
  if (filters.clientId) {
    request.input("clientId", sql.NVarChar(150), filters.clientId);
    conditions.push("task.client_source_id=@clientId");
  }
  if (filters.domainId) {
    request.input("domainId", sql.NVarChar(150), filters.domainId);
    conditions.push("task.domain_source_id=@domainId");
  }

  if (filters.operationalOnly !== false) {
    // A consolidated task remains operational when at least one of its source
    // schedules still exists. Open tasks additionally require an active source.
    conditions.push(`EXISTS (
      SELECT 1 FROM workflow.task_sources source
      JOIN scheduling.update_schedules source_schedule ON source_schedule.schedule_key=source.schedule_key
      WHERE source.task_key=task.task_key AND source_schedule.deleted_at IS NULL
      UNION ALL
      SELECT 1 FROM scheduling.update_schedules primary_schedule
      WHERE primary_schedule.schedule_key=task.primary_schedule_key AND primary_schedule.deleted_at IS NULL
    )`);
    conditions.push(`(task.status NOT IN ('pending','in_progress','blocked','failed','reopened') OR EXISTS (
      SELECT 1 FROM workflow.task_sources active_source
      JOIN scheduling.update_schedules active_schedule ON active_schedule.schedule_key=active_source.schedule_key
      WHERE active_source.task_key=task.task_key AND active_schedule.deleted_at IS NULL AND active_schedule.active=1
      UNION ALL
      SELECT 1 FROM scheduling.update_schedules active_primary
      WHERE active_primary.schedule_key=task.primary_schedule_key AND active_primary.deleted_at IS NULL AND active_primary.active=1
    ))`);
  }

  const result = await request.query<TaskRow>(`
    SELECT TOP (1000)
      task.source_id,task.dedupe_key,CONVERT(char(10),task.task_date,23) AS task_date,task.task_bucket,
      task.client_source_id,task.client_name_snapshot AS client_name,
      task.domain_source_id,task.domain_name_snapshot AS domain_name,
      task.target_type,task.target_source_id,task.target_name_snapshot AS target_name,
      task.primary_schedule_source_id,task.assigned_role,task.status,task.result,task.notes,
      task.completed_at,task.completed_by,task.completed_with_problems,task.problem_note,task.completion_note,
      task.blocked_at,task.blocked_by,task.block_reason,task.resolved_at,task.resolved_by,task.resolution_comment,
      task.reopened_at,task.reopened_by,task.reopen_reason,
      task.created_at,task.created_by,task.updated_at,task.updated_by,
      COALESCE((SELECT users.source_id AS id FROM workflow.task_assignees assignee
        JOIN security.users users ON users.user_key=assignee.user_key
        WHERE assignee.task_key=task.task_key ORDER BY users.source_id FOR JSON PATH),N'[]') AS assignees_json,
      COALESCE((SELECT source.schedule_source_id AS scheduleId,source.schedule_type AS scheduleType,
          source.reason,CONVERT(varchar(33),source.created_at,127) AS createdAt
        FROM workflow.task_sources source WHERE source.task_key=task.task_key
        ORDER BY source.is_primary DESC,source.created_at,source.schedule_source_id FOR JSON PATH),N'[]') AS sources_json
    FROM workflow.update_tasks task
    WHERE ${conditions.join(" AND ")}
    ORDER BY task.task_date,task.target_type,task.target_name_snapshot,task.source_id;
  `);
  return result.recordset.map(mapSqlWorkflowTask);
}

export function normalizedLogicalTaskCount(tasks: UpdateTask[]): number {
  return new Set(tasks.map((task) => `${task.targetType}\u0000${task.targetId}\u0000${task.taskDate}`)).size;
}
