import { createHash, randomUUID } from "node:crypto";
import sql from "mssql";
import { isValidEmail } from "./inputValidation";
import { normalizeEmail } from "./password";

const PASSWORD_RESET_DEDUPE_SECONDS = 15 * 60;

export type PasswordResetOutboxInput = {
  userId: string;
  email: string;
  displayName?: string;
  requestedBy: string;
  nowMs?: number;
};

export type PasswordResetOutboxRecord = {
  sourceId: string;
  idempotencyKey: string;
  userId: string;
  email: string;
  emailNormalized: string;
  displayName: string | null;
  createdBy: string;
  createdAt: Date;
  metadataJson: string;
};

function assertLength(label: string, value: string, maximum: number): void {
  if (!value || value.length > maximum) throw new Error(`${label} no es válido para SQL.`);
}

export function buildPasswordResetOutboxRecord(input: PasswordResetOutboxInput): PasswordResetOutboxRecord {
  const email = input.email.trim();
  const emailNormalized = normalizeEmail(email);
  if (!isValidEmail(emailNormalized) || emailNormalized.length > 254) throw new Error("Correo de recuperación no válido.");
  assertLength("security.users.source_id", input.userId, 150);
  assertLength("notifications.created_by", input.requestedBy, 150);
  if (input.displayName && input.displayName.length > 160) throw new Error("Nombre de destinatario demasiado largo.");
  const nowMs = input.nowMs ?? Date.now();
  const bucket = Math.floor(nowMs / (PASSWORD_RESET_DEDUPE_SECONDS * 1000));
  const identityDigest = createHash("sha256").update(input.userId, "utf8").digest("hex");
  return {
    sourceId: `notification_${randomUUID()}`,
    idempotencyKey: `password_reset:${identityDigest}:${bucket}`,
    userId: input.userId,
    email,
    emailNormalized,
    displayName: input.displayName?.trim() || null,
    createdBy: input.requestedBy,
    createdAt: new Date(nowMs),
    metadataJson: JSON.stringify({ template: "password_reset", locale: "es-CO", tokenGeneration: "claim_time" }),
  };
}

export async function enqueuePasswordResetNotificationSql(
  transaction: sql.Transaction,
  input: PasswordResetOutboxInput,
): Promise<{ notificationId: string; created: boolean }> {
  const record = buildPasswordResetOutboxRecord(input);
  const lookup = new sql.Request(transaction);
  lookup.input("idempotencyKey", sql.NVarChar(500), record.idempotencyKey);
  const existing = await lookup.query<{ source_id: string }>(`
    SELECT source_id FROM notifications.email_notifications WITH (UPDLOCK,HOLDLOCK)
    WHERE idempotency_key=@idempotencyKey;
  `);
  if (existing.recordset[0]) return { notificationId: existing.recordset[0].source_id, created: false };

  const insert = new sql.Request(transaction);
  insert.input("sourceId", sql.NVarChar(150), record.sourceId);
  insert.input("entitySourceId", sql.NVarChar(150), record.userId);
  insert.input("idempotencyKey", sql.NVarChar(500), record.idempotencyKey);
  insert.input("metadataJson", sql.NVarChar(sql.MAX), record.metadataJson);
  insert.input("createdAt", sql.DateTime2(3), record.createdAt);
  insert.input("createdBy", sql.NVarChar(150), record.createdBy);
  insert.input("email", sql.NVarChar(254), record.email);
  insert.input("emailNormalized", sql.NVarChar(254), record.emailNormalized);
  insert.input("displayName", sql.NVarChar(160), record.displayName);
  await insert.query(`
    DECLARE @inserted TABLE(notification_key BIGINT NOT NULL);
    INSERT notifications.email_notifications
    (
      source_id,notification_type,entity_type,entity_source_id,idempotency_key,
      subject,status,attempt_count,next_attempt_at,metadata_json,
      created_at,created_by,updated_at,updated_by
    )
    OUTPUT INSERTED.notification_key INTO @inserted(notification_key)
    VALUES
    (
      @sourceId,'password_notification',N'user',@entitySourceId,@idempotencyKey,
      NULL,'pending',0,@createdAt,@metadataJson,@createdAt,@createdBy,@createdAt,@createdBy
    );

    INSERT notifications.email_notification_recipients
      (notification_key,email,email_normalized,recipient_type,display_name,delivery_status)
    SELECT notification_key,@email,@emailNormalized,'to',@displayName,'pending'
    FROM @inserted;
  `);
  return { notificationId: record.sourceId, created: true };
}
