import sql from "mssql";
import type { UpdateTask } from "../types/models";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { runSqlTransaction } from "./sqlTransaction";
import { mapSqlWorkflowTask, type TaskRow } from "./workflowTasksSqlRepository";

type Actor = { id: string; email: string };

export type SqlTaskTransitionBody = {
  notes?: unknown;
  result?: unknown;
  withProblems?: unknown;
  completionNote?: unknown;
  problemNote?: unknown;
  blockReason?: unknown;
  reopenReason?: unknown;
  resolutionComment?: unknown;
};

const text = (value: unknown, maximum: number): string | undefined =>
  typeof value === "string" ? value.slice(0, maximum) : undefined;
const trimmed = (value: unknown, maximum: number): string | undefined => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized.slice(0, maximum) : undefined;
};

export function buildSqlTaskTransition(
  current: UpdateTask,
  newStatus: UpdateTask["status"],
  auditAction: string,
  body: SqlTaskTransitionBody,
  actorId: string,
  now = new Date(),
): UpdateTask {
  const blockingReason = trimmed(body.blockReason ?? body.notes, 4000);
  if (newStatus === "blocked" && !blockingReason) {
    throw Object.assign(new Error("El motivo del bloqueo es obligatorio."), { status: 400 });
  }
  const updated: UpdateTask = {
    ...current,
    status: newStatus,
    updatedAt: now.toISOString(),
    updatedBy: actorId,
  };
  const notes = text(body.notes, 4000);
  const result = text(body.result, 200);
  if (notes !== undefined) updated.notes = notes;
  if (result !== undefined) updated.result = result;

  if (newStatus === "completed") {
    updated.completedAt = now.toISOString();
    updated.completedBy = actorId;
    updated.completedWithProblems = body.withProblems === true;
    const completionNote = text(body.completionNote, 4000);
    if (completionNote !== undefined) updated.completionNote = completionNote;
    if (updated.completedWithProblems) updated.problemNote = text(body.problemNote, 4000) ?? "";
    else updated.problemNote = undefined;
  }
  if (newStatus === "blocked") {
    updated.blockedAt = now.toISOString();
    updated.blockedBy = actorId;
    updated.blockReason = blockingReason!;
    updated.problemNote = blockingReason!;
  }
  if (newStatus === "pending" && auditAction === "task_reopened") {
    updated.reopenedAt = now.toISOString();
    updated.reopenedBy = actorId;
    updated.reopenReason = trimmed(body.reopenReason, 4000);
    updated.completedWithProblems = false;
  }
  if (auditAction === "task_block_resolved") {
    updated.resolvedAt = now.toISOString();
    updated.resolvedBy = actorId;
    updated.resolutionComment = trimmed(body.resolutionComment, 4000);
    if (newStatus !== "blocked") updated.blockReason = updated.blockReason ?? null;
  }
  return updated;
}

async function lockTask(transaction: sql.Transaction, sourceId: string): Promise<TaskRow | null> {
  const request = new sql.Request(transaction);
  request.input("sourceId", sql.NVarChar(260), sourceId);
  const result = await request.query<TaskRow>(`
    SELECT TOP (1)
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
    FROM workflow.update_tasks AS task WITH (UPDLOCK,HOLDLOCK)
    WHERE task.source_id=@sourceId OR EXISTS
      (SELECT 1 FROM workflow.task_source_aliases alias WHERE alias.task_key=task.task_key AND alias.alias_source_id=@sourceId)
    ORDER BY CASE WHEN task.source_id=@sourceId THEN 0 ELSE 1 END,task.task_key;
  `);
  return result.recordset[0] ?? null;
}

export async function changeSqlWorkflowTaskStatus(
  sourceId: string,
  newStatus: UpdateTask["status"],
  auditAction: string,
  body: SqlTaskTransitionBody,
  actor: Actor,
): Promise<UpdateTask | null> {
  return runSqlTransaction(async (transaction) => {
    const row = await lockTask(transaction, sourceId);
    if (!row) return null;
    const before = mapSqlWorkflowTask(row);
    const now = new Date();
    const updated = buildSqlTaskTransition(before, newStatus, auditAction, body, actor.id, now);

    const request = new sql.Request(transaction);
    request.input("sourceId", sql.NVarChar(260), before.id);
    request.input("status", sql.VarChar(30), updated.status);
    request.input("result", sql.NVarChar(500), updated.result ?? null);
    request.input("notes", sql.NVarChar(sql.MAX), updated.notes ?? null);
    request.input("completedAt", sql.DateTime2(3), updated.completedAt ? new Date(updated.completedAt) : null);
    request.input("completedBy", sql.NVarChar(150), updated.completedBy ?? null);
    request.input("completedWithProblems", sql.Bit, updated.completedWithProblems === true);
    request.input("problemNote", sql.NVarChar(sql.MAX), updated.problemNote ?? null);
    request.input("completionNote", sql.NVarChar(sql.MAX), updated.completionNote ?? null);
    request.input("blockedAt", sql.DateTime2(3), updated.blockedAt ? new Date(updated.blockedAt) : null);
    request.input("blockedBy", sql.NVarChar(150), updated.blockedBy ?? null);
    request.input("blockReason", sql.NVarChar(sql.MAX), updated.blockReason ?? null);
    request.input("resolvedAt", sql.DateTime2(3), updated.resolvedAt ? new Date(updated.resolvedAt) : null);
    request.input("resolvedBy", sql.NVarChar(150), updated.resolvedBy ?? null);
    request.input("resolutionComment", sql.NVarChar(sql.MAX), updated.resolutionComment ?? null);
    request.input("reopenedAt", sql.DateTime2(3), updated.reopenedAt ? new Date(updated.reopenedAt) : null);
    request.input("reopenedBy", sql.NVarChar(150), updated.reopenedBy ?? null);
    request.input("reopenReason", sql.NVarChar(sql.MAX), updated.reopenReason ?? null);
    request.input("now", sql.DateTime2(3), now);
    request.input("actorId", sql.NVarChar(150), actor.id);
    await request.query(`
      UPDATE workflow.update_tasks
      SET status=@status,result=@result,notes=@notes,completed_at=@completedAt,completed_by=@completedBy,
        completed_with_problems=@completedWithProblems,problem_note=@problemNote,completion_note=@completionNote,
        blocked_at=@blockedAt,blocked_by=@blockedBy,block_reason=@blockReason,resolved_at=@resolvedAt,
        resolved_by=@resolvedBy,resolution_comment=@resolutionComment,reopened_at=@reopenedAt,
        reopened_by=@reopenedBy,reopen_reason=@reopenReason,updated_at=@now,updated_by=@actorId
      WHERE source_id=@sourceId;
    `);

    if (newStatus === "completed") {
      const target = new sql.Request(transaction);
      target.input("targetId", sql.NVarChar(150), updated.targetId);
      target.input("now", sql.DateTime2(3), now);
      target.input("actorId", sql.NVarChar(150), actor.id);
      if (updated.targetType === "database") {
        await target.query(`
          UPDATE core.databases SET last_updated_at=@now,last_updated_by=@actorId WHERE source_id=@targetId;
        `);
      } else {
        await target.query(`
          UPDATE core.domains SET last_updated_at=@now,last_updated_by=@actorId WHERE source_id=@targetId;
        `);
      }
    }

    const history = new sql.Request(transaction);
    history.input("sourceId", sql.NVarChar(260), before.id);
    history.input("previousStatus", sql.VarChar(30), before.status);
    history.input("newStatus", sql.VarChar(30), newStatus);
    history.input("action", sql.NVarChar(100), auditAction);
    history.input("comment", sql.NVarChar(sql.MAX),
      updated.resolutionComment ?? updated.reopenReason ?? updated.blockReason ?? updated.completionNote ?? updated.notes ?? null);
    history.input("actorId", sql.NVarChar(150), actor.id);
    history.input("actorEmail", sql.NVarChar(254), actor.email);
    history.input("now", sql.DateTime2(3), now);
    history.input("metadataJson", sql.NVarChar(sql.MAX), JSON.stringify({ previousStatus: before.status, newStatus }));
    await history.query(`
      INSERT workflow.task_status_history
        (task_key,previous_status,new_status,action,comment,performed_by,performed_by_email,performed_at,is_inferred,metadata_json)
      SELECT task_key,@previousStatus,@newStatus,@action,@comment,@actorId,@actorEmail,@now,0,@metadataJson
      FROM workflow.update_tasks WHERE source_id=@sourceId;
    `);

    const finalAction = newStatus === "completed" && updated.completedWithProblems
      ? "task_completed_with_problems"
      : auditAction;
    await writeSqlAuditLog(transaction, {
      entityType: "task", entityId: before.id, clientId: updated.clientId, clientName: updated.clientName,
      domainId: updated.domainId, domainName: updated.domainName, action: finalAction,
      performedBy: actor.id, performedByEmail: actor.email, before, after: updated,
      metadata: { previousStatus: before.status, newStatus },
    });
    return updated;
  });
}
