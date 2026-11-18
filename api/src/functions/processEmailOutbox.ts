import { randomUUID } from "node:crypto";
import { app, InvocationContext, Timer } from "@azure/functions";
import { claimSqlEmailBatch, completeSqlEmailAttempt, renewSqlEmailClaim } from "../lib/emailOutboxSqlRepository";
import { sendEmail } from "../lib/emailService";
import { loadEmailAlertsSettings } from "../lib/settingsService";
import { renderResetPasswordEmail } from "../lib/emailService";
import { generateResetToken, resetExpirationIso } from "../lib/resetTokens";
import { setSqlPasswordResetToken } from "../lib/securityManagementSqlWriteRepository";
import { catalogMastersReportEnvironment, catalogMastersReportsEnabled, mayDeliverCatalogMastersReport,
  mayReceiveCatalogActiveUsersReport } from "../lib/catalogReportRecipients";

async function authorizedMastersReport(metadata: Record<string, unknown>, recipients: readonly string[]): Promise<boolean> {
  const counts = metadata.catalogActiveUsers === true;
  if (counts && process.env.PORTAL_CATALOG_ACTIVE_USERS_REPORT_ENABLED?.trim() !== "true") return false;
  const scoped = Object.prototype.hasOwnProperty.call(metadata, "catalogReportScope");
  if (scoped || catalogMastersReportsEnabled()) {
    // Pending legacy emails must not bypass the catalog cutover; scoped emails
    // remain sensitive even if the feature is subsequently disabled.
    const environment = catalogMastersReportEnvironment();
    return scoped && catalogMastersReportsEnabled() && environment !== null &&
      await mayDeliverCatalogMastersReport(metadata.catalogReportScope, recipients, environment);
  }
  return !counts || await mayReceiveCatalogActiveUsersReport(recipients);
}

export async function processSqlEmailOutbox(log: (message: string) => void): Promise<{ claimed: number; sent: number; failed: number }> {
  const workerId = `email-worker-${randomUUID()}`;
  const settings = await loadEmailAlertsSettings();
  let claimed = 0;
  let sent = 0;
  let failed = 0;
  // Do not age nine queued claims while validating or sending the first one.
  for (let index = 0; index < 10; index++) {
    const [message] = await claimSqlEmailBatch(workerId, 1, 120);
    if (!message) break;
    claimed++;
    try {
      if (!await renewSqlEmailClaim(message, workerId)) { failed++; continue; }
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
      if (message.type === "masters_report" && !await authorizedMastersReport(message.metadata, recipients)) {
        result = { ok: false, provider: "outbox", error: "El reporte no está habilitado o autorizado para sus destinatarios." };
      } else if (!html || !plainText || recipients.length === 0) {
        result = { ok: false, provider: "outbox", error: "La notificación no tiene contenido o destinatarios válidos." };
      } else {
        result = await sendEmail({
          to: recipients,
          subject,
          html,
          text: plainText,
        }, settings, { outboxClaimed: true, beforeSend: () => renewSqlEmailClaim(message, workerId) });
      }
      // A lost claim belongs to recovery or another worker, never to this attempt.
      if (result.leaseLost) { failed++; continue; }
      await completeSqlEmailAttempt(message, workerId, {
        ok: result.ok,
        providerMessageId: result.messageId,
        error: result.error,
      });
      if (result.ok) sent++; else failed++;
    } catch {
      // SQL recovery owns an expired/interrupted attempt. Never log provider or
      // SQL details, nor attempt an unfenced compensating write.
      failed++;
    }
  }
  log(`Outbox SQL: reclamados=${claimed}; enviados=${sent}; fallidos=${failed}.`);
  return { claimed, sent, failed };
}

app.timer("processEmailOutbox", {
  schedule: "0 */2 * * * *",
  handler: async (_timer: Timer, context: InvocationContext) => {
    try {
      await processSqlEmailOutbox((message) => context.log(message));
    } catch {
      context.error("No se pudo procesar la bandeja de salida SQL.");
    }
  },
});
