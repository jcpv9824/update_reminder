import { randomUUID } from "node:crypto";
import sql from "mssql";
import { normalizeEmail } from "./password";
import { runSqlTransaction } from "./sqlTransaction";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { getSqlPool } from "./sql";

export type EmailOutboxType = "administrative_reminder" | "blocked_task_reminder" | "task_reminder" | "overdue_alert" | "password_notification" | "task_status_notification" | "test_email" | "masters_report";

export type EnqueueEmailInput = {
  type: EmailOutboxType;
  idempotencyKey: string;
  entityType?: string;
  entityId?: string;
  taskId?: string;
  period?: string;
  sendDate?: string;
  subject: string | null;
  html: string;
  text: string;
  recipients: Array<{ email: string; name?: string; type?: "to" | "cc" | "bcc" }>;
  metadata?: Record<string, unknown>;
  createdBy?: string;
};

export type ClaimedEmail = {
  notificationKey: number;
  sourceId: string;
  type: EmailOutboxType;
  entityType: string | null;
  entityId: string | null;
  taskId: string | null;
  subject: string;
  attemptNo: number;
  metadata: Record<string, unknown> & { html?: string; text?: string };
  recipients: Array<{ email: string; name?: string; type: "to" | "cc" | "bcc" }>;
};

/** A regrouping of the same recipient's reminders must not queue the same surviving task twice. */
export async function readCoveredTaskReminders(sendDate: string, recipient: string, origins: readonly (readonly [string, string])[]): Promise<Set<string>> {
  if (!origins.length) return new Set<string>();
  const request = (await getSqlPool()).request();
  request.input("sendDate", sql.Date, sendDate);
  request.input("recipient", sql.NVarChar(254), normalizeEmail(recipient));
  request.input("origins", sql.NVarChar(sql.MAX), JSON.stringify(origins));
  const results = await request.query<{ task_id: string }>(`
    SELECT DISTINCT input_origin.task_id
    FROM OPENJSON(@origins) WITH (task_id nvarchar(260) '$[0]',schedule_id nvarchar(150) '$[1]') input_origin
    JOIN workflow.update_tasks task ON task.source_id=input_origin.task_id
    WHERE EXISTS (
      SELECT 1 FROM notifications.email_notifications notice
      JOIN notifications.email_notification_recipients recipient ON recipient.notification_key=notice.notification_key
      WHERE notice.notification_type='task_reminder' AND notice.send_date=@sendDate
        AND recipient.email_normalized=@recipient AND recipient.recipient_type='to'
        AND notice.status IN ('pending','processing','failed','sent')
        AND (EXISTS (
          SELECT 1 FROM OPENJSON(notice.metadata_json,'$.schedulesByTask')
            WITH (task_id nvarchar(260) '$[0]',schedule_id nvarchar(150) '$[1]') pinned
          WHERE pinned.task_id=input_origin.task_id AND pinned.schedule_id=input_origin.schedule_id
        ) OR (
          JSON_QUERY(notice.metadata_json,'$.schedulesByTask') IS NULL
          AND task.primary_schedule_source_id=input_origin.schedule_id
          AND (notice.task_key=task.task_key OR EXISTS (
            SELECT 1 FROM OPENJSON(notice.metadata_json,'$.taskIds') member
            WHERE member.type=1 AND member.value=input_origin.task_id
          ))
        ))
    );
  `);
  return new Set(results.recordset.map(row => row.task_id));
}

export async function enqueueSqlEmail(input: EnqueueEmailInput): Promise<{ id: string; created: boolean }> {
  return runSqlTransaction(async (transaction) => {
    const existing = new sql.Request(transaction);
    existing.input("idempotencyKey", sql.NVarChar(500), input.idempotencyKey);
    const found = await existing.query<{ source_id: string }>(`
      SELECT source_id FROM notifications.email_notifications WITH (UPDLOCK,HOLDLOCK)
      WHERE idempotency_key=@idempotencyKey;
    `);
    if (found.recordset[0]) return { id: found.recordset[0].source_id, created: false };
    const now = new Date();
    const sourceId = `notification_${randomUUID()}`;
    const metadata = JSON.stringify({ ...(input.metadata ?? {}), html: input.html, text: input.text });
    const insert = new sql.Request(transaction);
    insert.input("sourceId", sql.NVarChar(150), sourceId);
    insert.input("type", sql.VarChar(60), input.type);
    insert.input("entityType", sql.NVarChar(80), input.entityType ?? null);
    insert.input("entityId", sql.NVarChar(260), input.entityId ?? null);
    insert.input("taskId", sql.NVarChar(260), input.taskId ?? null);
    insert.input("idempotencyKey", sql.NVarChar(500), input.idempotencyKey);
    insert.input("period", sql.NVarChar(40), input.period ?? null);
    insert.input("sendDate", sql.Date, input.sendDate ?? null);
    insert.input("subject", sql.NVarChar(500), input.subject);
    insert.input("metadata", sql.NVarChar(sql.MAX), metadata);
    insert.input("now", sql.DateTime2(3), now);
    insert.input("createdBy", sql.NVarChar(150), input.createdBy ?? "system");
    const result = await insert.query<{ notification_key: number }>(`
      INSERT notifications.email_notifications
      (source_id,notification_type,entity_type,entity_source_id,task_key,idempotency_key,period,
       send_date,subject,status,attempt_count,next_attempt_at,metadata_json,created_at,created_by,updated_at,updated_by)
      OUTPUT INSERTED.notification_key
      SELECT @sourceId,@type,@entityType,@entityId,task.task_key,@idempotencyKey,@period,
        @sendDate,@subject,'pending',0,@now,@metadata,@now,@createdBy,@now,@createdBy
      FROM (VALUES(1)) seed(value)
      OUTER APPLY (SELECT task_key FROM workflow.update_tasks WHERE source_id=@taskId) task;
    `);
    const key = result.recordset[0]?.notification_key;
    if (!key) throw new Error("No se pudo crear la notificación SQL.");
    for (const recipient of input.recipients) {
      const email = recipient.email.trim();
      const normalized = normalizeEmail(email);
      const request = new sql.Request(transaction);
      request.input("notificationKey", sql.BigInt, key);
      request.input("email", sql.NVarChar(254), email);
      request.input("normalized", sql.NVarChar(254), normalized);
      request.input("type", sql.VarChar(10), recipient.type ?? "to");
      request.input("name", sql.NVarChar(160), recipient.name?.trim() || null);
      await request.query(`
        IF NOT EXISTS (
          SELECT 1 FROM notifications.email_notification_recipients
          WHERE notification_key=@notificationKey AND recipient_type=@type AND email_normalized=@normalized
        )
          INSERT notifications.email_notification_recipients
            (notification_key,email,email_normalized,recipient_type,display_name,delivery_status)
          VALUES(@notificationKey,@email,@normalized,@type,@name,'pending');
      `);
    }
    return { id: sourceId, created: true };
  });
}

export async function claimSqlEmailBatch(workerId: string, batchSize = 10, leaseSeconds = 120): Promise<ClaimedEmail[]> {
  return runSqlTransaction(async (transaction) => {
    const request = new sql.Request(transaction);
    request.input("workerId", sql.NVarChar(150), workerId);
    request.input("batchSize", sql.Int, Math.max(1, Math.min(50, batchSize)));
    request.input("leaseSeconds", sql.Int, Math.max(30, Math.min(600, leaseSeconds)));
    const claimed = await request.query<{
      notification_key: number; source_id: string; notification_type: EmailOutboxType;
      entity_type: string | null; entity_source_id: string | null;
      subject: string; attempt_count: number; metadata_json: string | null;
    }>(`
      DECLARE @now DATETIME2(3)=SYSUTCDATETIME();
      UPDATE attempt SET completed_at=@now,attempt_status='failed',error_message=N'La concesión del trabajador expiró.'
      FROM notifications.email_notification_attempts attempt
      JOIN notifications.email_notifications notification
        ON notification.notification_key=attempt.notification_key
       AND notification.attempt_count=attempt.attempt_no
      WHERE notification.status='processing' AND notification.claim_expires_at<=@now
        AND attempt.completed_at IS NULL;

      ;WITH candidates AS (
        SELECT TOP (@batchSize) notification_key
        FROM notifications.email_notifications WITH (UPDLOCK,READPAST,ROWLOCK)
        WHERE
          (status IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at<=@now)
            AND (claimed_by IS NULL OR claim_expires_at<=@now))
          OR (status='processing' AND claim_expires_at<=@now)
        ORDER BY created_at,notification_key
      )
      UPDATE notification SET status='processing',claimed_by=@workerId,
        claim_expires_at=DATEADD(second,@leaseSeconds,@now),attempt_count=attempt_count+1,
        last_attempted_at=@now,updated_at=@now,updated_by=@workerId
      OUTPUT INSERTED.notification_key,INSERTED.source_id,INSERTED.notification_type,
        INSERTED.entity_type,INSERTED.entity_source_id,
        INSERTED.subject,INSERTED.attempt_count,INSERTED.metadata_json
      FROM notifications.email_notifications notification
      JOIN candidates ON candidates.notification_key=notification.notification_key;
    `);
    const output: ClaimedEmail[] = [];
    for (const row of claimed.recordset) {
      const recipientsRequest = new sql.Request(transaction);
      recipientsRequest.input("notificationKey", sql.BigInt, row.notification_key);
      const recipients = await recipientsRequest.query<{ email: string; display_name: string | null; recipient_type: "to" | "cc" | "bcc" }>(`
        SELECT email,display_name,recipient_type
        FROM notifications.email_notification_recipients
        WHERE notification_key=@notificationKey AND delivery_status IN ('pending','failed')
        ORDER BY recipient_type,recipient_key;
      `);
      let metadata: ClaimedEmail["metadata"] = {};
      try { metadata = JSON.parse(row.metadata_json ?? "{}"); } catch { /* worker will fail this row safely */ }
      output.push({
        notificationKey: row.notification_key, sourceId: row.source_id, type: row.notification_type,
        entityType: row.entity_type, entityId: row.entity_source_id,
        taskId: row.entity_type === "task" ? row.entity_source_id : null,
        subject: row.subject, attemptNo: row.attempt_count, metadata,
        recipients: recipients.recordset.map((recipient) => ({
          email: recipient.email, name: recipient.display_name ?? undefined, type: recipient.recipient_type,
        })),
      });
      const attempt = new sql.Request(transaction);
      attempt.input("notificationKey", sql.BigInt, row.notification_key);
      attempt.input("attemptNo", sql.Int, row.attempt_count);
      await attempt.query(`
        INSERT notifications.email_notification_attempts
          (notification_key,attempt_no,started_at,attempt_status)
        VALUES(@notificationKey,@attemptNo,SYSUTCDATETIME(),'processing');
      `);
    }
    return output;
  }, sql.ISOLATION_LEVEL.READ_COMMITTED);
}

export async function completeSqlEmailAttempt(
  claimed: ClaimedEmail,
  workerId: string,
  result: { ok: boolean; providerMessageId?: string; error?: string; deliveredTaskIds?: readonly string[]; attemptedTo?: readonly string[] },
): Promise<void> {
  await runSqlTransaction(async (transaction) => {
    const attemptedTo = result.attemptedTo === undefined ? null : [...new Set(result.attemptedTo.map(normalizeEmail))];
    const terminalFailure = !result.ok && claimed.attemptNo >= 5;
    const status = result.ok ? "sent" : terminalFailure ? "cancelled" : "failed";
    const request = new sql.Request(transaction);
    request.input("notificationKey", sql.BigInt, claimed.notificationKey);
    request.input("workerId", sql.NVarChar(150), workerId);
    request.input("attemptNo", sql.Int, claimed.attemptNo);
    request.input("status", sql.VarChar(20), status);
    request.input("providerId", sql.NVarChar(300), result.providerMessageId ?? null);
    request.input("error", sql.NVarChar(2000), result.error?.slice(0, 2000) ?? null);
    request.input("attemptedTo", sql.NVarChar(sql.MAX), attemptedTo === null ? null : JSON.stringify(attemptedTo));
    request.input("retrySeconds", sql.Int, Math.min(3600, 30 * (2 ** Math.max(0, claimed.attemptNo - 1))));
    const updated = await request.query(`
      -- Take the row lock before sampling the clock: a lock wait must not
      -- authorize an already expired lease using an earlier timestamp.
      DECLARE @lockedKey BIGINT;
      SELECT @lockedKey=notification_key
      FROM notifications.email_notifications WITH (UPDLOCK,HOLDLOCK)
      WHERE notification_key=@notificationKey;
      DECLARE @now DATETIME2(3)=SYSUTCDATETIME();
      UPDATE notifications.email_notifications SET status=@status,claimed_by=NULL,claim_expires_at=NULL,
        next_attempt_at=CASE WHEN @status='failed' THEN DATEADD(second,@retrySeconds,@now) ELSE NULL END,
        sent_at=CASE WHEN @status='sent' THEN @now ELSE sent_at END,
        provider_message_id=@providerId,last_error=@error,updated_at=@now,updated_by=@workerId
      WHERE notification_key=@notificationKey AND claimed_by=@workerId AND status='processing'
        AND attempt_count=@attemptNo AND claim_expires_at>@now;
      IF @@ROWCOUNT<>1 THROW 51071,N'La concesión de la notificación expiró.',1;

      UPDATE notifications.email_notification_attempts
      SET completed_at=@now,attempt_status=CASE WHEN @status='sent' THEN 'sent' ELSE 'failed' END,
        provider_message_id=@providerId,error_message=@error
      WHERE notification_key=@notificationKey AND attempt_no=@attemptNo AND completed_at IS NULL;
      IF @@ROWCOUNT<>1 THROW 51071,N'La concesión de la notificación expiró.',1;

      -- The configured audience may have shrunk between enqueue and delivery.
      -- Record exclusions in the same fenced attempt, not as provider results.
      UPDATE recipient
      SET delivery_status=CASE WHEN @attemptedTo IS NOT NULL AND attempted.email_normalized IS NULL THEN 'skipped'
                               WHEN @status='sent' THEN 'sent' ELSE 'failed' END,
          error_message=CASE WHEN @attemptedTo IS NOT NULL AND attempted.email_normalized IS NULL
                              THEN N'El destinatario no fue incluido en el intento de envío.' ELSE @error END
      FROM notifications.email_notification_recipients recipient
      LEFT JOIN OPENJSON(@attemptedTo) WITH (email_normalized nvarchar(254) '$') attempted
        ON recipient.recipient_type='to' AND recipient.email_normalized COLLATE Latin1_General_100_BIN2
          =attempted.email_normalized COLLATE Latin1_General_100_BIN2
      WHERE recipient.notification_key=@notificationKey AND recipient.delivery_status IN ('pending','failed');
    `);
    void updated;
    const suffix = result.ok ? "sent" : "failed";
    const actionByType: Record<EmailOutboxType, string> = {
      administrative_reminder: claimed.metadata.test ? `admin_reminder_test_${suffix}` : `administrative_reminder_${suffix}`,
      blocked_task_reminder: `blocked_task_reminder_${suffix}`,
      task_reminder: `reminder_email_${suffix}`,
      overdue_alert: `overdue_alert_${suffix}`,
      password_notification: `password_notification_${suffix}`,
      task_status_notification: `task_status_notification_${suffix}`,
      test_email: `test_email_${suffix}`,
      masters_report: `masters_report_email_${suffix}`,
    };
    const metadata = claimed.type === "password_notification"
      ? { kind: "reset_link", includedPassword: false }
      : claimed.type === "test_email"
        ? { provider: result.ok ? "configured" : "failed" }
        : claimed.type === "masters_report"
          ? { recipientsCount: claimed.recipients.length, provider: result.ok ? "configured" : "failed" }
          : claimed.type === "task_status_notification"
          ? { notificationType: claimed.metadata.notificationType ?? "task_status" }
          : result.deliveredTaskIds
            ? { taskIds: result.deliveredTaskIds, deliveryTaskCount: result.deliveredTaskIds.length }
          : claimed.metadata;
    await writeSqlAuditLog(transaction, {
      entityType: claimed.entityType ?? "notification",
      entityId: claimed.entityId ?? claimed.taskId ?? claimed.sourceId,
      action: actionByType[claimed.type],
      performedBy: workerId,
      performedByEmail: "system",
      metadata: attemptedTo === null ? metadata : { ...metadata, attemptedRecipientCount: attemptedTo.length },
    });
  }, sql.ISOLATION_LEVEL.READ_COMMITTED);
}

/** Execute inside a short transaction. SQL's clock is sampled after acquiring the row lock. */
export const renewSqlEmailClaimSql = `
  DECLARE @lockedKey BIGINT;
  SELECT @lockedKey=notification_key
  FROM notifications.email_notifications WITH (UPDLOCK,HOLDLOCK)
  WHERE notification_key=@notificationKey;
  DECLARE @now DATETIME2(3)=SYSUTCDATETIME();
  UPDATE notifications.email_notifications
  SET claim_expires_at=DATEADD(second,@leaseSeconds,@now),updated_at=@now,updated_by=@workerId
  WHERE notification_key=@notificationKey AND status='processing'
    AND claimed_by=@workerId AND attempt_count=@attemptNo AND claim_expires_at>@now;
  SELECT @@ROWCOUNT AS renewed;
`;

const cancelTaskNoticeRowsSql = `
  UPDATE attempt SET completed_at=@now,attempt_status='failed',error_message=@reason
  FROM notifications.email_notification_attempts attempt
  JOIN @suppressed n ON n.notification_key=attempt.notification_key AND n.attempt_count=attempt.attempt_no
  WHERE attempt.completed_at IS NULL;
  UPDATE recipient SET delivery_status='skipped',error_message=@reason
  FROM notifications.email_notification_recipients recipient
  JOIN @suppressed n ON n.notification_key=recipient.notification_key
  WHERE recipient.delivery_status IN ('pending','failed');
`;

/** Stop a current claim permanently without touching a stale or reclaimed attempt. */
export async function suppressSqlEmailClaim(claimed: ClaimedEmail, workerId: string): Promise<void> {
  await runSqlTransaction(async transaction => {
    const request = new sql.Request(transaction);
    request.input("notificationKey", sql.BigInt, claimed.notificationKey);
    request.input("workerId", sql.NVarChar(150), workerId);
    request.input("attemptNo", sql.Int, claimed.attemptNo);
    await request.query(`
      DECLARE @lockedKey bigint;
      SELECT @lockedKey=notification_key FROM notifications.email_notifications WITH (UPDLOCK,HOLDLOCK)
        WHERE notification_key=@notificationKey;
      DECLARE @now datetime2(3)=SYSUTCDATETIME(), @reason nvarchar(160)=N'Las tareas de este aviso ya no están vigentes.';
      DECLARE @suppressed TABLE (notification_key bigint PRIMARY KEY, attempt_count int NOT NULL);
      UPDATE notifications.email_notifications SET status='cancelled',claimed_by=NULL,claim_expires_at=NULL,
        next_attempt_at=NULL,last_error=@reason,updated_at=@now,updated_by=@workerId
      OUTPUT INSERTED.notification_key,INSERTED.attempt_count INTO @suppressed
      WHERE notification_key=@notificationKey AND status='processing' AND claimed_by=@workerId
        AND attempt_count=@attemptNo AND claim_expires_at>@now
        AND notification_type IN ('task_reminder','overdue_alert','blocked_task_reminder','task_status_notification');
      ${cancelTaskNoticeRowsSql}
    `);
  }, sql.ISOLATION_LEVEL.READ_COMMITTED);
}

/** Stop exclusive queued notices within the same transaction as schedule deletion. Mixed batches are rebuilt at delivery. */
export async function cancelQueuedEmailsForRemovedTasks(transaction: sql.Transaction, taskIds: readonly string[], actorId: string,
  removedScheduleId: string) {
  const request = new sql.Request(transaction);
  request.input("taskIds", sql.NVarChar(sql.MAX), JSON.stringify(taskIds));
  request.input("actorId", sql.NVarChar(150), actorId);
  request.input("removedScheduleId", sql.NVarChar(150), removedScheduleId);
  await request.query(`
    DECLARE @now datetime2(3)=SYSUTCDATETIME(),@reason nvarchar(160)=N'La programación de las tareas fue eliminada.';
    DECLARE @suppressed TABLE (notification_key bigint PRIMARY KEY, attempt_count int NOT NULL);
    DECLARE @removed TABLE (source_id nvarchar(260) COLLATE DATABASE_DEFAULT NOT NULL PRIMARY KEY);
    INSERT @removed SELECT DISTINCT CONVERT(nvarchar(260),value) FROM OPENJSON(@taskIds) WHERE type=1;

    UPDATE n SET status='cancelled',claimed_by=NULL,claim_expires_at=NULL,next_attempt_at=NULL,
      last_error=@reason,updated_at=@now,updated_by=@actorId
    OUTPUT INSERTED.notification_key,INSERTED.attempt_count INTO @suppressed
    FROM notifications.email_notifications n
    -- An already handed-off live attempt may still report its genuine delivery
    -- result. The worker fences it before handoff and before any retry.
    WHERE (n.status IN ('pending','failed') OR (n.status='processing' AND n.claim_expires_at<=@now))
      AND n.notification_type IN ('task_reminder','overdue_alert','blocked_task_reminder','task_status_notification')
      AND (
        (JSON_QUERY(n.metadata_json,'$.taskIds') IS NULL AND EXISTS (
          SELECT 1 FROM workflow.update_tasks task LEFT JOIN @removed removed ON removed.source_id=task.source_id
          WHERE task.task_key=n.task_key
            AND (removed.source_id IS NOT NULL OR (n.notification_type IN ('blocked_task_reminder','task_status_notification')
              AND JSON_QUERY(n.metadata_json,'$.schedulesByTask') IS NULL AND task.primary_schedule_source_id=@removedScheduleId))
        ))
        OR (EXISTS (SELECT 1 FROM OPENJSON(n.metadata_json,'$.taskIds'))
          AND NOT EXISTS (
            SELECT 1 FROM OPENJSON(n.metadata_json,'$.taskIds') member
            LEFT JOIN @removed removed ON removed.source_id=member.value
            LEFT JOIN workflow.update_tasks referred ON referred.source_id=member.value
            WHERE member.type<>1 OR (removed.source_id IS NULL AND NOT (
              n.notification_type IN ('task_reminder','blocked_task_reminder','task_status_notification') AND (
                EXISTS (
                  SELECT 1 FROM OPENJSON(n.metadata_json,'$.schedulesByTask')
                    WITH (task_id nvarchar(260) '$[0]',schedule_id nvarchar(150) '$[1]') origin
                  WHERE origin.task_id=member.value AND origin.schedule_id=@removedScheduleId
                ) OR (JSON_QUERY(n.metadata_json,'$.schedulesByTask') IS NULL
                  AND COALESCE(referred.primary_schedule_source_id,'')=@removedScheduleId)
              )
            ))
          ))
      );
    ${cancelTaskNoticeRowsSql}
  `);
}

export async function renewSqlEmailClaim(claimed: ClaimedEmail, workerId: string): Promise<boolean> {
  const started = performance.now();
  const renewed = await runSqlTransaction(async transaction => {
    const request = new sql.Request(transaction);
    request.input("notificationKey", sql.BigInt, claimed.notificationKey);
    request.input("workerId", sql.NVarChar(150), workerId);
    request.input("attemptNo", sql.Int, claimed.attemptNo);
    request.input("leaseSeconds", sql.Int, 120);
    const result = await request.query<{ renewed: number }>(renewSqlEmailClaimSql);
    return result.recordset[0]?.renewed === 1;
  }, sql.ISOLATION_LEVEL.READ_COMMITTED);
  // A delayed response cannot grant a fresh client-side 60s send window.
  // Even if SQL renewed early, at least 90s of its 120s lease must remain.
  return renewed && performance.now() - started < 30_000;
}
