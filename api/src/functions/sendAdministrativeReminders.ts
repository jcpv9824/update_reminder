import { app, InvocationContext, Timer } from "@azure/functions";
import { loadEmailAlertsSettings } from "../lib/settingsService";
import { sendEmail } from "../lib/emailService";
import { buildAdministrativeReminderEmail } from "../lib/emailTemplates";
import { parseSemicolonEmails, uniqueEmails } from "../lib/emailRecipients";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { administrativeReminderDueToday, type AdministrativeReminderDue } from "../lib/administrativeReminderSchedule";
import { requireUser, loadUserProfile } from "../lib/auth";
import { badRequest, forbidden, ok, serverError } from "../lib/http";
import { canSendAdministrativeReminderTest } from "../lib/managementAccess";
import { enforceRequestRateLimit, RATE_LIMIT_POLICIES } from "../lib/rateLimit";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import type { AdministrativeReminderSettings } from "../types/models";

type ReminderKey = "sag-web-version" | "whats-new";

function nowInBogota(): Date {
  return new Date(Date.now() - 5 * 3600_000);
}

async function wasSent(key: ReminderKey, period: string, sendDate: string): Promise<boolean> {
  try {
    const id = `admin-reminder:${key}:${period}:${sendDate}`;
    const { resource } = await getContainer("emailNotifications").item(id, id).read<any>();
    return !!resource;
  } catch {
    return false;
  }
}

async function markSent(key: ReminderKey, due: AdministrativeReminderDue, recipients: string[]): Promise<void> {
  const id = `admin-reminder:${key}:${due.period}:${due.sendDate}`;
  await getContainer("emailNotifications").items.upsert({
    id,
    type: "administrative_reminder",
    key,
    period: due.period,
    sendDate: due.sendDate,
    recipients,
    sentAt: new Date().toISOString(),
  });
}

async function sendOne(key: ReminderKey, reminder: AdministrativeReminderSettings, frontendBaseUrl?: string, testRecipients?: string[], due?: AdministrativeReminderDue): Promise<{ sent: boolean; reason?: string }> {
  const effectiveDue = due ?? administrativeReminderDueToday({ ...reminder, enabled: true }, nowInBogota()) ?? {
    period: `${nowInBogota().getUTCFullYear()}-${String(nowInBogota().getUTCMonth() + 1).padStart(2, "0")}`,
    sendDate: nowInBogota().toISOString().slice(0, 10),
    scheduledFor: `${nowInBogota().toISOString().slice(0, 10)} ${reminder.time}`,
  };
  const recipients = uniqueEmails(testRecipients ?? reminder.recipients ?? []);
  if (recipients.length === 0) return { sent: false, reason: "Sin destinatarios configurados." };
  if (!testRecipients && await wasSent(key, effectiveDue.period, effectiveDue.sendDate)) return { sent: false, reason: "Ya fue enviado para esta fecha." };
  const email = buildAdministrativeReminderEmail({
    type: key === "sag-web-version" ? "sagWebVersion" : "whatsNew",
    subject: reminder.subject,
    periodo: effectiveDue.period,
    fechaProgramada: effectiveDue.scheduledFor,
    frontendBaseUrl,
  });
  const settings = await loadEmailAlertsSettings();
  const result = await sendEmail({ to: recipients, subject: email.subject, html: email.html, text: email.text }, settings);
  await writeAuditLog({
    entityType: "settings",
    entityId: `administrative-reminder-${key}`,
    action: testRecipients ? (result.ok ? "admin_reminder_test_sent" : "admin_reminder_test_failed") : (result.ok ? "administrative_reminder_sent" : "administrative_reminder_failed"),
    performedBy: testRecipients ? "admin" : "system",
    performedByEmail: testRecipients ? "admin" : "system",
    metadata: { key, period: effectiveDue.period, sendDate: effectiveDue.sendDate, recipientsCount: recipients.length, error: result.ok ? undefined : result.error },
  });
  if (!result.ok) return { sent: false, reason: result.error };
  if (!testRecipients) await markSent(key, effectiveDue, recipients);
  return { sent: true };
}

export async function ejecutarRecordatoriosAdministrativos(log: (m: string) => void): Promise<{ enviados: number }> {
  const settings = await loadEmailAlertsSettings();
  const reminders = settings.administrativeReminders;
  if (!reminders) return { enviados: 0 };
  let enviados = 0;
  for (const [key, reminder] of [
    ["sag-web-version", reminders.sagWebVersionReminder],
    ["whats-new", reminders.whatsNewReminder],
  ] as const) {
    const due = administrativeReminderDueToday(reminder, nowInBogota());
    if (!due) continue;
    const result = await sendOne(key, reminder, settings.frontendBaseUrl, undefined, due);
    if (result.sent) enviados++;
    else log(`Recordatorio ${key} omitido: ${result.reason ?? "no aplica"}`);
  }
  return { enviados };
}

app.timer("sendAdministrativeReminders", {
  schedule: "0 */30 * * * *",
  handler: async (_t: Timer, ctx: InvocationContext) => {
    try {
      const r = await ejecutarRecordatoriosAdministrativos((m) => ctx.log(m));
      ctx.log(`Recordatorios administrativos enviados: ${r.enviados}`);
    } catch (e: any) {
      ctx.error("Error en sendAdministrativeReminders", e);
    }
  },
});

app.http("settingsEmailAlertsAdministrativeReminderTest", {
  route: "settings/email-alerts/administrative-reminders/{key}/test",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req) => {
    try {
      const auth = await requireUser(req);
      const profile = await loadUserProfile(auth);
      const roleDefinitions = profile ? await loadRoleDefinitions() : [];
      if (!profile || !canSendAdministrativeReminderTest(profile, roleDefinitions)) return forbidden("No tiene permisos para probar recordatorios administrativos.");
      const keyParam = req.params.key;
      const key: ReminderKey | null = keyParam === "sag-web-version" || keyParam === "whats-new" ? keyParam : null;
      if (!key) return badRequest("Recordatorio no válido.");
      const body = (await req.json().catch(() => ({}))) as any;
      const parsed = parseSemicolonEmails(String(body.recipients ?? ""));
      if (parsed.invalid.length > 0) return badRequest(`Correo inválido: ${parsed.invalid[0]}`);
      const settings = await loadEmailAlertsSettings();
      const reminder = key === "sag-web-version"
        ? settings.administrativeReminders!.sagWebVersionReminder
        : settings.administrativeReminders!.whatsNewReminder;
      const recipients = parsed.emails.length > 0 ? parsed.emails : reminder.recipients;
      const limited = await enforceRequestRateLimit(
        req,
        `email_admin_reminder_${key}`,
        profile.id,
        RATE_LIMIT_POLICIES.testEmail
      );
      if (limited) return limited;
      const result = await sendOne(key, reminder, settings.frontendBaseUrl, recipients);
      return ok({ ok: result.sent, message: result.sent ? "Correo de prueba enviado correctamente." : "No se pudo enviar el correo de prueba.", details: result.reason });
    } catch (e) {
      return serverError(e);
    }
  },
});
