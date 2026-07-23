import sql from "mssql";
import type { UpdateSchedule, UpdateTask } from "../types/models";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { runSqlTransaction } from "./sqlTransaction";
import { rootScheduleId } from "./taskGenerator";

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { number?: number; originalError?: { info?: { number?: number } } };
  return (candidate.number ?? candidate.originalError?.info?.number) === 2601
    || (candidate.number ?? candidate.originalError?.info?.number) === 2627;
}

async function replaceTaskAssignees(transaction: sql.Transaction, taskKey: number, userIds: string[]): Promise<void> {
  const remove = new sql.Request(transaction);
  remove.input("taskKey", sql.BigInt, taskKey);
  await remove.query("DELETE workflow.task_assignees WHERE task_key=@taskKey;");
  for (const userId of [...new Set(userIds)]) {
    const insert = new sql.Request(transaction);
    insert.input("taskKey", sql.BigInt, taskKey);
    insert.input("userId", sql.NVarChar(150), userId);
    const result = await insert.query(`
      INSERT workflow.task_assignees(task_key,user_key)
      SELECT @taskKey,user_key FROM security.users WHERE source_id=@userId AND active=1;
      SELECT @@ROWCOUNT AS inserted_count;
    `);
    if (Number(result.recordset[0]?.inserted_count ?? 0) !== 1) {
      throw Object.assign(new Error("Un responsable de tarea no existe o está inactivo."), { status: 400 });
    }
  }
}

async function upsertTaskSource(transaction: sql.Transaction, taskKey: number, task: UpdateTask): Promise<void> {
  const scheduleId = rootScheduleId(task.rootScheduleId || task.scheduleId);
  const request = new sql.Request(transaction);
  request.input("taskKey", sql.BigInt, taskKey);
  request.input("scheduleId", sql.NVarChar(150), scheduleId);
  request.input("scheduleType", sql.NVarChar(80), task.sources?.[0]?.scheduleType ?? "normal");
  request.input("createdAt", sql.DateTime2(3), new Date(task.sources?.[0]?.createdAt ?? task.createdAt));
  const result = await request.query(`
    DECLARE @scheduleKey BIGINT=(SELECT schedule_key FROM scheduling.update_schedules WHERE source_id=@scheduleId);
    IF @scheduleKey IS NULL THROW 51070,N'La programación origen de la tarea no existe.',1;
    IF NOT EXISTS (SELECT 1 FROM workflow.task_sources WHERE task_key=@taskKey AND schedule_source_id=@scheduleId)
      INSERT workflow.task_sources
        (task_key,schedule_source_id,schedule_key,schedule_type,reason,created_at,is_primary)
      VALUES
        (@taskKey,@scheduleId,@scheduleKey,@scheduleType,N'generated',@createdAt,
         CASE WHEN EXISTS(SELECT 1 FROM workflow.task_sources WHERE task_key=@taskKey AND is_primary=1) THEN 0 ELSE 1 END);
  `);
  void result;
}

export async function createSqlGeneratedTask(task: UpdateTask): Promise<boolean> {
  try {
    return await runSqlTransaction(async (transaction) => {
      const request = new sql.Request(transaction);
      request.input("sourceId", sql.NVarChar(260), task.id);
      request.input("dedupeKey", sql.NVarChar(500), task.dedupeKey ?? null);
      request.input("taskDate", sql.Date, task.taskDate);
      request.input("taskBucket", sql.NVarChar(100), task.taskBucket);
      request.input("clientId", sql.NVarChar(150), task.clientId);
      request.input("clientName", sql.NVarChar(200), task.clientName);
      request.input("domainId", sql.NVarChar(150), task.domainId);
      request.input("domainName", sql.NVarChar(500), task.domainName);
      request.input("targetType", sql.VarChar(20), task.targetType);
      request.input("targetId", sql.NVarChar(150), task.targetId);
      request.input("targetName", sql.NVarChar(240), task.targetName);
      request.input("scheduleId", sql.NVarChar(150), rootScheduleId(task.rootScheduleId || task.scheduleId));
      request.input("assignedRole", sql.NVarChar(80), task.assignedRole);
      request.input("status", sql.VarChar(30), task.status);
      request.input("result", sql.NVarChar(500), task.result ?? null);
      request.input("notes", sql.NVarChar(sql.MAX), task.notes ?? null);
      request.input("createdAt", sql.DateTime2(3), new Date(task.createdAt));
      request.input("createdBy", sql.NVarChar(150), task.createdBy);
      request.input("updatedAt", sql.DateTime2(3), new Date(task.updatedAt));
      request.input("updatedBy", sql.NVarChar(150), task.updatedBy);
      const result = await request.query<{ task_key: number }>(`
        INSERT workflow.update_tasks
        (source_id,dedupe_key,task_date,task_bucket,client_key,client_source_id,client_name_snapshot,
         domain_key,domain_source_id,domain_name_snapshot,target_type,target_source_id,target_name_snapshot,
         database_key,primary_schedule_source_id,primary_schedule_key,is_historical_orphan,assigned_role,
         status,result,notes,created_at,created_by,updated_at,updated_by)
        OUTPUT INSERTED.task_key
        SELECT @sourceId,@dedupeKey,@taskDate,@taskBucket,client.client_key,@clientId,@clientName,
          domain_record.domain_key,@domainId,@domainName,@targetType,@targetId,@targetName,
          CASE WHEN @targetType='database' THEN database_record.database_key END,
          schedule.source_id,schedule.schedule_key,0,@assignedRole,
          @status,@result,@notes,@createdAt,@createdBy,@updatedAt,@updatedBy
        FROM core.clients client
        JOIN core.domains domain_record ON domain_record.client_key=client.client_key
          AND domain_record.source_id=@domainId AND domain_record.status='active'
        LEFT JOIN core.databases database_record
          ON @targetType='database' AND database_record.client_key=client.client_key
          AND database_record.domain_key=domain_record.domain_key AND database_record.source_id=@targetId
          AND database_record.status='active'
        JOIN scheduling.update_schedules schedule ON schedule.source_id=@scheduleId
          AND schedule.active=1 AND schedule.deleted_at IS NULL
        WHERE client.source_id=@clientId AND client.status='active'
          AND ((@targetType='domain' AND domain_record.source_id=@targetId) OR database_record.database_key IS NOT NULL);
      `);
      const key = result.recordset[0]?.task_key;
      if (!key) throw Object.assign(new Error("El objetivo de la tarea no pertenece a la jerarquía activa."), { status: 400 });
      await replaceTaskAssignees(transaction, key, task.assignedUserIds ?? []);
      await upsertTaskSource(transaction, key, task);
      const history = new sql.Request(transaction);
      history.input("taskKey", sql.BigInt, key);
      history.input("performedAt", sql.DateTime2(3), new Date(task.createdAt));
      await history.query(`
        INSERT workflow.task_status_history
          (task_key,previous_status,new_status,action,performed_by,performed_by_email,performed_at,is_inferred)
        VALUES(@taskKey,NULL,'pending',N'task_generated',N'system',N'system',@performedAt,0);
      `);
      await writeSqlAuditLog(transaction, {
        entityType: "task", entityId: task.id, clientId: task.clientId, clientName: task.clientName,
        domainId: task.domainId, domainName: task.domainName, action: "task_generated",
        performedBy: "system", performedByEmail: "system",
        metadata: { scheduleId: rootScheduleId(task.scheduleId), targetType: task.targetType, targetId: task.targetId, date: task.taskDate },
        after: task,
      });
      return true;
    });
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

export async function syncSqlGeneratedTask(task: UpdateTask, action: "task_assignment_synced" | "task_obsoleted"): Promise<boolean> {
  return runSqlTransaction(async (transaction) => {
    const lock = new sql.Request(transaction);
    lock.input("sourceId", sql.NVarChar(260), task.id);
    lock.input("targetType", sql.VarChar(20), task.targetType);
    lock.input("targetId", sql.NVarChar(150), task.targetId);
    lock.input("taskDate", sql.Date, task.taskDate);
    const existing = await lock.query<{ task_key: number; source_id: string; status: string; result: string | null; notes: string | null }>(`
      SELECT task_key,source_id,status,result,notes
      FROM workflow.update_tasks WITH (UPDLOCK,HOLDLOCK)
      WHERE source_id=@sourceId OR (target_type=@targetType AND target_source_id=@targetId AND task_date=@taskDate);
    `);
    if (existing.recordset.length > 1) {
      throw Object.assign(new Error("El identificador y la clave idempotente apuntan a tareas distintas."), { status: 409 });
    }
    const row = existing.recordset[0];
    if (!row) return false;
    const update = new sql.Request(transaction);
    update.input("taskKey", sql.BigInt, row.task_key);
    update.input("scheduleId", sql.NVarChar(150), rootScheduleId(task.rootScheduleId || task.scheduleId));
    update.input("assignedRole", sql.NVarChar(80), task.assignedRole);
    update.input("targetName", sql.NVarChar(240), task.targetName);
    update.input("clientName", sql.NVarChar(200), task.clientName);
    update.input("domainName", sql.NVarChar(500), task.domainName);
    update.input("status", sql.VarChar(30), task.status);
    update.input("result", sql.NVarChar(500), task.result ?? null);
    update.input("notes", sql.NVarChar(sql.MAX), task.notes ?? null);
    update.input("updatedAt", sql.DateTime2(3), new Date(task.updatedAt));
    update.input("updatedBy", sql.NVarChar(150), task.updatedBy);
    await update.query(`
      UPDATE task SET primary_schedule_source_id=schedule.source_id,primary_schedule_key=schedule.schedule_key,
        assigned_role=@assignedRole,target_name_snapshot=@targetName,client_name_snapshot=@clientName,
        domain_name_snapshot=@domainName,status=@status,result=@result,notes=@notes,
        updated_at=@updatedAt,updated_by=@updatedBy
      FROM workflow.update_tasks task
      JOIN scheduling.update_schedules schedule ON schedule.source_id=@scheduleId
      WHERE task.task_key=@taskKey;
    `);
    await replaceTaskAssignees(transaction, row.task_key, task.assignedUserIds ?? []);
    await upsertTaskSource(transaction, row.task_key, task);
    if (row.status !== task.status) {
      const history = new sql.Request(transaction);
      history.input("taskKey", sql.BigInt, row.task_key);
      history.input("previousStatus", sql.VarChar(30), row.status);
      history.input("newStatus", sql.VarChar(30), task.status);
      history.input("action", sql.NVarChar(100), action);
      history.input("performedAt", sql.DateTime2(3), new Date(task.updatedAt));
      history.input("metadata", sql.NVarChar(sql.MAX), JSON.stringify({ reason: action }));
      await history.query(`
        INSERT workflow.task_status_history
          (task_key,previous_status,new_status,action,performed_by,performed_by_email,performed_at,is_inferred,metadata_json)
        VALUES(@taskKey,@previousStatus,@newStatus,@action,N'system',N'system',@performedAt,0,@metadata);
      `);
    }
    await writeSqlAuditLog(transaction, {
      entityType: "task", entityId: row.source_id, clientId: task.clientId, clientName: task.clientName,
      domainId: task.domainId, domainName: task.domainName, action,
      performedBy: "system", performedByEmail: "system",
      metadata: action === "task_obsoleted"
        ? { reason: "target_or_schedule_not_expected", taskId: row.source_id, targetType: task.targetType, targetId: task.targetId, domainId: task.domainId, scheduledFor: task.taskDate }
        : { taskId: row.source_id, scheduleId: rootScheduleId(task.scheduleId), targetType: task.targetType },
      before: { status: row.status, result: row.result, notes: row.notes },
      after: task,
    });
    return true;
  });
}

export async function completeSqlOneTimeSchedule(schedule: UpdateSchedule): Promise<boolean> {
  return runSqlTransaction(async (transaction) => {
    const request = new sql.Request(transaction);
    request.input("sourceId", sql.NVarChar(150), schedule.id);
    request.input("completedAt", sql.DateTime2(3), schedule.completedAt ? new Date(schedule.completedAt) : new Date());
    request.input("reason", sql.NVarChar(160), schedule.completedReason ?? "one_time_schedule_executed");
    const result = await request.query(`
      UPDATE scheduling.update_schedules SET active=0,completed_at=@completedAt,completed_reason=@reason,
        updated_at=@completedAt,updated_by=N'system'
      WHERE source_id=@sourceId AND active=1 AND frequency_type='once';
      SELECT @@ROWCOUNT AS updated_count;
    `);
    if (Number(result.recordset[0]?.updated_count ?? 0) !== 1) return false;
    await writeSqlAuditLog(transaction, {
      entityType: "schedule", entityId: schedule.id, clientId: schedule.clientId,
      clientName: schedule.clientName, action: "schedule_one_time_completed",
      performedBy: "system", performedByEmail: "system",
      metadata: { reason: "one_time_schedule_executed", runDate: schedule.startDate, scheduleId: schedule.id },
      after: schedule,
    });
    return true;
  });
}
