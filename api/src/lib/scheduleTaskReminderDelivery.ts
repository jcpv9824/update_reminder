import sql from "mssql";
import type { ClaimedEmail, EmailOutboxType } from "./emailOutboxSqlRepository";
import { buildDatabaseReminderEmail, buildDomainReminderEmail, buildOverdueTasksEmail } from "./emailService";
import { getSqlPool } from "./sql";
import type { UpdateTask } from "../types/models";
import { catalogTaskActiveLinkProjectionSql, catalogTaskHasVisibleLinkSql, catalogTaskHistoryEnvironmentSql,
  catalogTaskIsLegacySql, catalogWorkflowEnvironment } from "./catalogWorkflowTaskEligibilitySql";

export function isScheduleTaskNotice(type: EmailOutboxType): boolean {
  return type === "task_reminder" || type === "overdue_alert" || type === "blocked_task_reminder" ||
    type === "task_status_notification";
}

type TaskNoticeRef = { taskId: string; scheduleId: string | null; clientId?: string; domainId?: string; targetId?: string; status?: string };
type NoticeRow = { task_id: string; client_name: string; domain_name: string; target_name: string;
  target_type: "domain" | "database"; task_date: string; status: string; notes: string | null; schedule_id: string };

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 260 && value === value.trim() && !/\p{C}/u.test(value);
}

export const taskNoticeRepresentative = (task: UpdateTask) =>
  [task.id, task.clientId, task.domainId, task.targetId] as const;

export function taskNoticeRefs(message: ClaimedEmail): TaskNoticeRef[] {
  const idList = message.metadata.taskIds ?? (message.taskId ? [message.taskId] : []);
  if (!Array.isArray(idList) || idList.length > 1000 || !idList.every(isId) || new Set(idList).size !== idList.length) return [];
  const pinned = message.type !== "overdue_alert" ? message.metadata.schedulesByTask : undefined;
  const origins = new Map<string, string>();
  if (pinned !== undefined) {
    if (!Array.isArray(pinned) || pinned.length !== idList.length) return [];
    for (const row of pinned) {
      if (!Array.isArray(row) || row.length !== 2 || !isId(row[0]) || !isId(row[1]) ||
        row[1].length > 150 || origins.has(row[0])) return [];
      origins.set(row[0], row[1]);
    }
    if (idList.some(id => !origins.has(id))) return [];
  }
  const snapshots = new Map<string, Pick<TaskNoticeRef, "clientId" | "domainId" | "targetId">>();
  const reps = message.metadata.taskRepresentatives;
  if (reps !== undefined) {
    if (!Array.isArray(reps) || reps.length !== idList.length) return [];
    for (const row of reps) {
      if (!Array.isArray(row) || row.length !== 4 || !row.every(isId) || snapshots.has(row[0]) ||
        row.slice(1).some(id => id.length > 150)) return [];
      snapshots.set(row[0], { clientId: row[1], domainId: row[2], targetId: row[3] });
    }
    if (idList.some(id => !snapshots.has(id))) return [];
  }
  if (pinned !== undefined && (message.type === "blocked_task_reminder" || message.type === "task_status_notification") &&
    (idList.length !== 1 || snapshots.size !== 1)) return [];
  const status = message.type === "task_status_notification" && typeof message.metadata.status === "string"
    ? message.metadata.status : undefined;
  if (pinned !== undefined && message.type === "task_status_notification" && !status) return [];
  return idList.map(taskId => ({ taskId, scheduleId: origins.get(taskId) ?? null, ...snapshots.get(taskId), status }));
}

/** Worker-only projection. Read the current task and origin state by stable IDs; never parse stored HTML. */
export async function readDeliverableScheduleTaskNotices(type: EmailOutboxType, refs: readonly TaskNoticeRef[],
  resolveEnqueueOrigin = false): Promise<NoticeRow[]> {
  if (!isScheduleTaskNotice(type) || !refs.length) return [];
  const request = (await getSqlPool()).request();
  request.input("refs", sql.NVarChar(sql.MAX), JSON.stringify(refs));
  request.input("notice", sql.VarChar(60), type);
  request.input("resolveEnqueueOrigin", sql.Bit, resolveEnqueueOrigin);
  request.input("portalEnvironment", sql.VarChar(10), catalogWorkflowEnvironment());
  request.input("clientId", sql.NVarChar(150), null);
  request.input("domainId", sql.NVarChar(150), null);
  const result = await request.query<NoticeRow>(`
    DECLARE @now datetime2(3)=SYSUTCDATETIME();
    SELECT task.source_id AS task_id,COALESCE(active_catalog_link.client_name,task.client_name_snapshot) AS client_name,
      COALESCE(active_catalog_link.domain_name,task.domain_name_snapshot) AS domain_name,
      COALESCE(active_catalog_link.target_name,task.target_name_snapshot) AS target_name,
      task.target_type,CONVERT(char(10),task.task_date,23) AS task_date,task.status,task.notes,effective_origin.schedule_id
    FROM OPENJSON(@refs) WITH (task_id nvarchar(260) '$.taskId',schedule_id nvarchar(150) '$.scheduleId',
      client_id nvarchar(150) '$.clientId',domain_id nvarchar(150) '$.domainId',target_id nvarchar(150) '$.targetId',
      task_status varchar(30) '$.status') r
    JOIN workflow.update_tasks task ON task.source_id=r.task_id
    ${catalogTaskActiveLinkProjectionSql}
    CROSS APPLY (
      SELECT TOP (1) schedule.source_id AS schedule_id
      FROM scheduling.update_schedules schedule
      WHERE schedule.deleted_at IS NULL AND (task.status='completed' OR schedule.active=1)
        AND (@notice='overdue_alert' OR schedule.source_id=COALESCE(r.schedule_id,task.primary_schedule_source_id)
          OR (@resolveEnqueueOrigin=1 AND r.schedule_id IS NULL
            AND @notice IN ('blocked_task_reminder','task_status_notification')
            AND r.client_id IS NOT NULL AND r.domain_id IS NOT NULL AND r.target_id IS NOT NULL))
        AND ((${catalogTaskIsLegacySql} AND (schedule.schedule_key=task.primary_schedule_key OR EXISTS (
          SELECT 1 FROM workflow.task_sources provenance
          WHERE provenance.task_key=task.task_key AND provenance.schedule_key=schedule.schedule_key
        ))) OR EXISTS (
          SELECT 1 FROM workflow.catalog_task_executions execution
          JOIN workflow.catalog_task_execution_links link ON link.catalog_execution_key=execution.catalog_execution_key
          JOIN workflow.catalog_task_execution_sources exact_attachment ON exact_attachment.catalog_execution_link_key=link.catalog_execution_link_key
          WHERE execution.task_key=task.task_key AND exact_attachment.schedule_key=schedule.schedule_key
            AND exact_attachment.detached_at IS NULL AND link.retired_at IS NULL
            AND (link.catalog_execution_link_key=active_catalog_link.catalog_execution_link_key
              OR (task.status='completed' AND link.client_key=task.client_key AND link.domain_key=task.domain_key
                AND (task.target_type='domain' OR link.database_key=task.database_key)))
        ))
      ORDER BY CASE WHEN schedule.schedule_key=task.primary_schedule_key THEN 0 ELSE 1 END,schedule.schedule_key
    ) effective_origin
    WHERE (CASE
      WHEN @notice='task_status_notification' AND task.status IN ('completed','failed','blocked','reopened','in_progress') THEN 1
      WHEN @notice='blocked_task_reminder' AND task.status='blocked' THEN 1
      WHEN @notice IN ('task_reminder','overdue_alert') AND task.status IN ('pending','in_progress','failed','blocked','reopened') THEN 1
      ELSE 0 END)=1
      AND (r.task_status IS NULL OR task.status=r.task_status)
      AND ((task.status='completed' AND ${catalogTaskHistoryEnvironmentSql}) OR ${catalogTaskHasVisibleLinkSql})
      -- Stored single-task bodies were addressed to recipients for the original
      -- representative. Never use a surviving different alias to authorize them.
      AND COALESCE(active_catalog_link.client_id,task.client_source_id)=COALESCE(r.client_id,task.client_source_id)
      AND COALESCE(active_catalog_link.domain_id,task.domain_source_id)=COALESCE(r.domain_id,task.domain_source_id)
      AND COALESCE(active_catalog_link.target_id,task.target_source_id)=COALESCE(r.target_id,task.target_source_id)
    ORDER BY task.source_id;
  `);
  return result.recordset;
}

/** Pin only a fresh single-task body; never pass previously captured HTML to this resolver. */
export async function pinNewScheduleTaskNotice(type: "blocked_task_reminder" | "task_status_notification", task: UpdateTask) {
  const { id, clientId, domainId, targetId, status } = task;
  if (![id, clientId, domainId, targetId].every(isId) || [clientId, domainId, targetId].some(value => value.length > 150)) return null;
  const [row] = await readDeliverableScheduleTaskNotices(type, [{ taskId: id, scheduleId: null, clientId, domainId, targetId, status }], true);
  if (!row || row.task_id !== id || !isId(row.schedule_id) || row.schedule_id.length > 150) return null;
  const primary = task.rootScheduleId ?? task.scheduleId;
  return { scheduleId: row.schedule_id, idempotencySuffix: row.schedule_id === primary ? "" : `:${row.schedule_id}`,
    metadata: { taskIds: [id], taskRepresentatives: [taskNoticeRepresentative(task)],
    schedulesByTask: [[id, row.schedule_id]] } };
}

export function renderSurvivingScheduleTaskNotice(message: ClaimedEmail, rows: readonly NoticeRow[],
  frontendBaseUrl: string | undefined) {
  const { email, name } = message.recipients.find(recipient => recipient.type === "to") ?? {};
  const timezone = process.env.APP_TIMEZONE || "America/Bogota";
  const options = { recipientName: name, frontendBaseUrl, timezone };
  const domain = rows.filter(row => row.target_type === "domain").map(row => ({
    clientName: row.client_name, domainName: row.domain_name || row.target_name,
    scheduledFor: row.task_date, dueAt: row.task_date, status: row.status,
    notes: row.notes ?? undefined, assignedToName: name, assignedToEmail: email,
  }));
  const database = rows.filter(row => row.target_type === "database").map(row => ({
    clientName: row.client_name, domainName: row.domain_name, databaseName: row.target_name,
    scheduledFor: row.task_date, dueAt: row.task_date, status: row.status,
    notes: row.notes ?? undefined, assignedToName: name, assignedToEmail: email,
  }));
  if (message.type === "overdue_alert") {
    return buildOverdueTasksEmail({ ...options, overdueDomainTasks: domain, overdueDatabaseTasks: database });
  }
  if (message.type === "task_reminder") {
    if (domain.length > 0 && database.length === 0) return buildDomainReminderEmail({ ...options, tasks: domain });
    if (database.length > 0 && domain.length === 0) return buildDatabaseReminderEmail({ ...options, tasks: database });
  }
  return null;
}
