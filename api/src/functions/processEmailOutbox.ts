import { randomUUID } from "node:crypto";
import { app, InvocationContext, Timer } from "@azure/functions";
import { claimSqlEmailBatch, completeSqlEmailAttempt } from "../lib/emailOutboxSqlRepository";
import { sendEmail } from "../lib/emailService";
import { loadEmailAlertsSettings } from "../lib/settingsService";
import { renderResetPasswordEmail } from "../lib/emailService";
import { generateResetToken, resetExpirationIso } from "../lib/resetTokens";
import { setSqlPasswordResetToken } from "../lib/securityManagementSqlWriteRepository";

export async function processSqlEmailOutbox(log: (message: string) => void): Promise<{ claimed: number; sent: number; failed: number }> {
  const workerId = `email-worker-${randomUUID()}`;
  const settings = await loadEmailAlertsSettings();
  const claimed = await claimSqlEmailBatch(workerId, 10, 120);
  let sent = 0;
  let failed = 0;
  for (const message of claimed) {
    const recipients = message.recipients.filter((recipient) => recipient.type === "to").map((recipient) => recipient.email);
    let subject = message.subject;
    let html = message.metadata.html;
    let plainText = message.metadata.text;
    if (message.type === "password_notification" && message.metadata.template === "password_reset" && message.entityId) {
      const { token, tokenHash } = generateResetToken();
      const expiresAt = resetExpirationIso(30);
      const user = await setSqlPasswordResetToken(message.entityId, tokenHash, new Date(expiresAt));
      if (user) {
        const baseUrl = settings.frontendBaseUrl?.replace(/\/$/, "") ?? "";
        const resetUrl = baseUrl
          ? `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`
          : `/reset-password?token=${encodeURIComponent(token)}`;
        const rendered = renderResetPasswordEmail({
          displayName: user.displayName,
          email: user.email,
          resetUrl,
          expiresInMinutes: 30,
        });
        subject = rendered.subject;
        html = rendered.html;
        plainText = rendered.text;
      }
    }
    let result: Awaited<ReturnType<typeof sendEmail>>;
    if (!html || !plainText || recipients.length === 0) {
      result = { ok: false, provider: "outbox", error: "La notificación no tiene contenido o destinatarios válidos." };
    } else {
      result = await sendEmail({
        to: recipients,
        subject,
        html,
        text: plainText,
      }, settings, { outboxClaimed: true });
    }
    await completeSqlEmailAttempt(message, workerId, {
      ok: result.ok,
      providerMessageId: result.messageId,
      error: result.error,
    });
    if (result.ok) sent++; else failed++;
  }
  log(`Outbox SQL: reclamados=${claimed.length}; enviados=${sent}; fallidos=${failed}.`);
  return { claimed: claimed.length, sent, failed };
}

app.timer("processEmailOutbox", {
  schedule: "0 */2 * * * *",
  handler: async (_timer: Timer, context: InvocationContext) => {
    try {
      await processSqlEmailOutbox((message) => context.log(message));
    } catch (error) {
      context.error("Error en processEmailOutbox", error);
    }
  },
});
