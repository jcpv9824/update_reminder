import { randomUUID } from "node:crypto";
import sql from "mssql";
import { normalizeEmail } from "./password";
import { runSqlTransaction } from "./sqlTransaction";
import { writeSqlAuditLog } from "./auditSqlWriter";

export type EmailOutboxType = "administrative_reminder" | "blocked_task_reminder" | "task_reminder" | "overdue_alert" | "password_notification" | "task_status_notification" | "test_email";

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
  result: { ok: boolean; providerMessageId?: string; error?: string },
): Promise<void> {
  await runSqlTransaction(async (transaction) => {
    const now = new Date();
    const terminalFailure = !result.ok && claimed.attemptNo >= 5;
    const status = result.ok ? "sent" : terminalFailure ? "cancelled" : "failed";
    const request = new sql.Request(transaction);
    request.input("notificationKey", sql.BigInt, claimed.notificationKey);
    request.input("workerId", sql.NVarChar(150), workerId);
    request.input("attemptNo", sql.Int, claimed.attemptNo);
    request.input("status", sql.VarChar(20), status);
    request.input("now", sql.DateTime2(3), now);
    request.input("providerId", sql.NVarChar(300), result.providerMessageId ?? null);
    request.input("error", sql.NVarChar(2000), result.error?.slice(0, 2000) ?? null);
    request.input("retrySeconds", sql.Int, Math.min(3600, 30 * (2 ** Math.max(0, claimed.attemptNo - 1))));
    const updated = await request.query(`
      UPDATE notifications.email_notifications SET status=@status,claimed_by=NULL,claim_expires_at=NULL,
        next_attempt_at=CASE WHEN @status='failed' THEN DATEADD(second,@retrySeconds,@now) ELSE NULL END,
        sent_at=CASE WHEN @status='sent' THEN @now ELSE sent_at END,
        provider_message_id=@providerId,last_error=@error,updated_at=@now,updated_by=@workerId
      WHERE notification_key=@notificationKey AND claimed_by=@workerId AND status='processing';
      IF @@ROWCOUNT<>1 THROW 51071,N'La concesión de la notificación expiró.',1;

      UPDATE notifications.email_notification_attempts
      SET completed_at=@now,attempt_status=CASE WHEN @status='sent' THEN 'sent' ELSE 'failed' END,
        provider_message_id=@providerId,error_message=@error
      WHERE notification_key=@notificationKey AND attempt_no=@attemptNo;

      UPDATE notifications.email_notification_recipients
      SET delivery_status=CASE WHEN @status='sent' THEN 'sent' ELSE 'failed' END,error_message=@error
      WHERE notification_key=@notificationKey;
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
    };
    const metadata = claimed.type === "password_notification"
      ? { kind: "reset_link", includedPassword: false }
      : claimed.type === "test_email"
        ? { provider: result.ok ? "configured" : "failed" }
        : claimed.type === "task_status_notification"
          ? { notificationType: claimed.metadata.notificationType ?? "task_status" }
          : claimed.metadata;
    await writeSqlAuditLog(transaction, {
      entityType: claimed.entityType ?? "notification",
      entityId: claimed.entityId ?? claimed.taskId ?? claimed.sourceId,
      action: actionByType[claimed.type],
      performedBy: workerId,
      performedByEmail: "system",
      metadata,
    });
  }, sql.ISOLATION_LEVEL.READ_COMMITTED);
}
