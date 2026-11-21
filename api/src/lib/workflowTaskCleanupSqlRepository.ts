import sql from "mssql";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { catalogTaskIsLegacySql } from "./catalogWorkflowTaskEligibilitySql";
import { cancelQueuedEmailsForRemovedTasks } from "./emailOutboxSqlRepository";

type Actor = { id: string; email: string };
type TaskRow = {
  task_key: number; source_id: string; client_source_id: string; client_name_snapshot: string;
  domain_source_id: string; domain_name_snapshot: string; target_type: "domain" | "database";
  target_source_id: string; task_date: Date; status: string; result: string | null; notes: string | null;
};

export async function cancelOpenSqlTasksForTarget(
  transaction: sql.Transaction,
  target: { type: "domain" | "database"; key: number },
  actor: Actor,
  reason: string,
  now: Date,
): Promise<number> {
  const query = new sql.Request(transaction);
  query.input("targetKey", sql.BigInt, target.key);
  const targetPredicate = target.type === "domain"
    ? "task.domain_key=@targetKey"
    : "task.target_type='database' AND task.database_key=@targetKey";
  const result = await query.query<TaskRow>(`
    SELECT task_key,source_id,client_source_id,client_name_snapshot,domain_source_id,
      domain_name_snapshot,target_type,target_source_id,task_date,status,result,notes
    FROM workflow.update_tasks task WITH (UPDLOCK,HOLDLOCK)
    WHERE ${targetPredicate} AND task.status NOT IN ('completed','cancelled')
      AND ${catalogTaskIsLegacySql}
    ORDER BY task_key;
  `);
  for (const task of result.recordset) {
    const notes = task.notes
      ? `${task.notes}\nTarea cancelada automáticamente: ${reason}.`
      : `Tarea cancelada automáticamente: ${reason}.`;
    const update = new sql.Request(transaction);
    update.input("taskKey", sql.BigInt, task.task_key);
    update.input("notes", sql.NVarChar(sql.MAX), notes);
    update.input("now", sql.DateTime2(3), now);
    update.input("actorId", sql.NVarChar(150), actor.id);
    update.input("previousStatus", sql.VarChar(30), task.status);
    update.input("actorEmail", sql.NVarChar(254), actor.email);
    update.input("metadata", sql.NVarChar(sql.MAX), JSON.stringify({ reason }));
    await update.query(`
      UPDATE workflow.update_tasks
      SET status='cancelled',result=N'obsolete',notes=@notes,updated_at=@now,updated_by=@actorId
      WHERE task_key=@taskKey;
      INSERT workflow.task_status_history
        (task_key,previous_status,new_status,action,comment,performed_by,performed_by_email,
         performed_at,is_inferred,metadata_json)
      VALUES
        (@taskKey,@previousStatus,'cancelled',N'task_obsoleted',@notes,@actorId,@actorEmail,@now,0,@metadata);
    `);
    await writeSqlAuditLog(transaction, {
      entityType: "task", entityId: task.source_id,
      clientId: task.client_source_id, clientName: task.client_name_snapshot,
      domainId: task.domain_source_id, domainName: task.domain_name_snapshot,
      action: "task_obsoleted", performedBy: actor.id, performedByEmail: actor.email,
      metadata: {
        reason, taskId: task.source_id, targetType: task.target_type,
        targetId: task.target_source_id, domainId: task.domain_source_id,
        scheduledFor: task.task_date.toISOString().slice(0, 10),
      },
      before: { status: task.status, result: task.result, notes: task.notes },
      after: { status: "cancelled", result: "obsolete" },
    });
  }
  return result.recordset.length;
}

export async function cancelOpenSqlTasksForSchedule(
  transaction: sql.Transaction,
  scheduleId: string,
  actor: Actor,
  reason: string,
  now: Date,
  options: { deleting?: boolean } = {},
): Promise<number> {
  if (options.deleting) {
    const detach = new sql.Request(transaction);
    detach.input("scheduleId", sql.NVarChar(150), scheduleId);
    detach.input("now", sql.DateTime2(3), now);
    // The provenance row remains historical; only this schedule is detached.
    await detach.query(`
      UPDATE provenance SET detached_at=CASE WHEN attached_at>@now THEN attached_at ELSE @now END
      FROM workflow.catalog_task_execution_sources provenance
      JOIN scheduling.update_schedules removed ON removed.schedule_key=provenance.schedule_key
      JOIN workflow.catalog_task_execution_links link ON link.catalog_execution_link_key=provenance.catalog_execution_link_key
      JOIN workflow.catalog_task_executions execution ON execution.catalog_execution_key=link.catalog_execution_key
      JOIN workflow.update_tasks task ON task.task_key=execution.task_key
      WHERE removed.source_id=@scheduleId AND provenance.detached_at IS NULL
        AND task.status NOT IN ('completed','cancelled');
    `);
  }
  const query = new sql.Request(transaction);
  query.input("scheduleId", sql.NVarChar(150), scheduleId);
  const result = await query.query<TaskRow>(`
    SELECT DISTINCT task.task_key,task.source_id,task.client_source_id,task.client_name_snapshot,
      task.domain_source_id,task.domain_name_snapshot,task.target_type,task.target_source_id,
      task.task_date,task.status,task.result,task.notes
    FROM workflow.update_tasks task WITH (UPDLOCK,HOLDLOCK)
    LEFT JOIN workflow.task_sources source ON source.task_key=task.task_key
    WHERE (task.primary_schedule_source_id=@scheduleId OR source.schedule_source_id=@scheduleId
      ${options.deleting ? `OR EXISTS (
        SELECT 1 FROM workflow.catalog_task_executions execution
        JOIN workflow.catalog_task_execution_links link ON link.catalog_execution_key=execution.catalog_execution_key
        JOIN workflow.catalog_task_execution_sources provenance ON provenance.catalog_execution_link_key=link.catalog_execution_link_key
        JOIN scheduling.update_schedules removed ON removed.schedule_key=provenance.schedule_key
        WHERE execution.task_key=task.task_key AND removed.source_id=@scheduleId
      )` : ""})
      AND task.status NOT IN ('completed','cancelled')
      AND ${options.deleting ? `(
        (${catalogTaskIsLegacySql} AND NOT EXISTS (
          SELECT 1 FROM scheduling.update_schedules surviving_schedule WITH (HOLDLOCK)
          WHERE surviving_schedule.deleted_at IS NULL AND surviving_schedule.active=1 AND surviving_schedule.source_id<>@scheduleId
            AND (surviving_schedule.schedule_key=task.primary_schedule_key OR EXISTS (
              SELECT 1 FROM workflow.task_sources surviving_source
              WHERE surviving_source.task_key=task.task_key AND surviving_source.schedule_key=surviving_schedule.schedule_key
            ))
        )) OR (NOT (${catalogTaskIsLegacySql}) AND NOT EXISTS (
          SELECT 1 FROM workflow.catalog_task_executions execution
          JOIN workflow.catalog_task_execution_links link ON link.catalog_execution_key=execution.catalog_execution_key
          JOIN workflow.catalog_task_execution_sources surviving_source ON surviving_source.catalog_execution_link_key=link.catalog_execution_link_key
          JOIN scheduling.update_schedules surviving_schedule WITH (HOLDLOCK) ON surviving_schedule.schedule_key=surviving_source.schedule_key
          WHERE execution.task_key=task.task_key AND surviving_source.detached_at IS NULL AND link.retired_at IS NULL
            AND surviving_schedule.deleted_at IS NULL AND surviving_schedule.active=1 AND surviving_schedule.source_id<>@scheduleId
        ))
      )` : catalogTaskIsLegacySql}
    ORDER BY task.task_key;
  `);
  for (const task of result.recordset) {
    const notes = task.notes
      ? `${task.notes}\nTarea cancelada automáticamente: ${reason}.`
      : `Tarea cancelada automáticamente: ${reason}.`;
    const update = new sql.Request(transaction);
    update.input("taskKey", sql.BigInt, task.task_key);
    update.input("notes", sql.NVarChar(sql.MAX), notes);
    update.input("now", sql.DateTime2(3), now);
    update.input("actorId", sql.NVarChar(150), actor.id);
    update.input("actorEmail", sql.NVarChar(254), actor.email);
    update.input("previousStatus", sql.VarChar(30), task.status);
    update.input("metadata", sql.NVarChar(sql.MAX), JSON.stringify({ reason, scheduleId }));
    await update.query(`
      UPDATE workflow.update_tasks
      SET status='cancelled',result=N'obsolete',notes=@notes,updated_at=@now,updated_by=@actorId
      WHERE task_key=@taskKey;
      INSERT workflow.task_status_history
        (task_key,previous_status,new_status,action,comment,performed_by,performed_by_email,
         performed_at,is_inferred,metadata_json)
      VALUES
        (@taskKey,@previousStatus,'cancelled',N'task_obsoleted',@notes,@actorId,@actorEmail,@now,0,@metadata);
    `);
    await writeSqlAuditLog(transaction, {
      entityType: "task", entityId: task.source_id,
      clientId: task.client_source_id, clientName: task.client_name_snapshot,
      domainId: task.domain_source_id, domainName: task.domain_name_snapshot,
      action: "task_obsoleted", performedBy: actor.id, performedByEmail: actor.email,
      metadata: {
        reason, taskId: task.source_id, scheduleId, targetType: task.target_type,
        targetId: task.target_source_id, domainId: task.domain_source_id,
        scheduledFor: task.task_date.toISOString().slice(0, 10),
      },
      before: { status: task.status, result: task.result, notes: task.notes },
      after: { status: "cancelled", result: "obsolete" },
    });
  }
  if (options.deleting) await cancelQueuedEmailsForRemovedTasks(transaction, result.recordset.map(task => task.source_id), actor.id, scheduleId);
  return result.recordset.length;
}
