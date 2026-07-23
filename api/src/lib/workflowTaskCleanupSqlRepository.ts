import sql from "mssql";
import { writeSqlAuditLog } from "./auditSqlWriter";

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
    ? "domain_key=@targetKey"
    : "target_type='database' AND database_key=@targetKey";
  const result = await query.query<TaskRow>(`
    SELECT task_key,source_id,client_source_id,client_name_snapshot,domain_source_id,
      domain_name_snapshot,target_type,target_source_id,task_date,status,result,notes
    FROM workflow.update_tasks WITH (UPDLOCK,HOLDLOCK)
    WHERE ${targetPredicate} AND status NOT IN ('completed','cancelled')
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
): Promise<number> {
  const query = new sql.Request(transaction);
  query.input("scheduleId", sql.NVarChar(150), scheduleId);
  const result = await query.query<TaskRow>(`
    SELECT DISTINCT task.task_key,task.source_id,task.client_source_id,task.client_name_snapshot,
      task.domain_source_id,task.domain_name_snapshot,task.target_type,task.target_source_id,
      task.task_date,task.status,task.result,task.notes
    FROM workflow.update_tasks task WITH (UPDLOCK,HOLDLOCK)
    LEFT JOIN workflow.task_sources source ON source.task_key=task.task_key
    WHERE (task.primary_schedule_source_id=@scheduleId OR source.schedule_source_id=@scheduleId)
      AND task.status NOT IN ('completed','cancelled')
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
  return result.recordset.length;
}
