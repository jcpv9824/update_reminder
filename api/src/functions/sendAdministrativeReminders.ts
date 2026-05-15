import { app, InvocationContext, Timer } from "@azure/functions";
import { loadEmailAlertsSettings } from "../lib/settingsService";
import { sendEmail } from "../lib/emailService";
import { buildAdministrativeReminderEmail } from "../lib/emailTemplates";
import { parseSemicolonEmails, uniqueEmails } from "../lib/emailRecipients";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { requireUser, loadUserProfile } from "../lib/auth";
import { hasRole } from "../lib/permissions";
import { badRequest, forbidden, ok, serverError } from "../lib/http";
import type { AdministrativeReminderSettings } from "../types/models";

type ReminderKey = "sag-web-version" | "whats-new";

function nowInBogota(): Date {
  return new Date(Date.now() - 5 * 3600_000);
}

function periodKey(now = nowInBogota()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function due(reminder: AdministrativeReminderSettings, now = nowInBogota()): boolean {
  const hhmm = now.toISOString().slice(11, 16);
  return reminder.enabled && now.getUTCDate() === reminder.dayOfMonth && hhmm >= reminder.time;
}

async function wasSent(key: ReminderKey, period: string): Promise<boolean> {
  try {
    const id = `admin-reminder:${key}:${period}`;
    const { resource } = await getContainer("emailNotifications").item(id, id).read<any>();
    return !!resource;
  } catch {
    return false;
  }
}

async function markSent(key: ReminderKey, period: string, recipients: string[]): Promise<void> {
  const id = `admin-reminder:${key}:${period}`;
  await getContainer("emailNotifications").items.upsert({
    id,
    type: "administrative_reminder",
    key,
    period,
    recipients,
    sentAt: new Date().toISOString(),
  });
}

async function sendOne(key: ReminderKey, reminder: AdministrativeReminderSettings, frontendBaseUrl?: string, testRecipients?: string[]): Promise<{ sent: boolean; reason?: string }> {
  const period = periodKey();
  const recipients = uniqueEmails(testRecipients ?? reminder.recipients ?? []);
  if (recipients.length === 0) return { sent: false, reason: "Sin destinatarios configurados." };
  if (!testRecipients && await wasSent(key, period)) return { sent: false, reason: "Ya fue enviado para este mes." };
  const email = buildAdministrativeReminderEmail({
    type: key === "sag-web-version" ? "sagWebVersion" : "whatsNew",
    subject: reminder.subject,
    periodo: period,
    fechaProgramada: `${period}-${String(reminder.dayOfMonth).padStart(2, "0")} ${reminder.time}`,
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
    metadata: { key, period, recipientsCount: recipients.length, error: result.ok ? undefined : result.error },
  });
  if (!result.ok) return { sent: false, reason: result.error };
  if (!testRecipients) await markSent(key, period, recipients);
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
    if (!due(reminder)) continue;
    const result = await sendOne(key, reminder, settings.frontendBaseUrl);
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
      if (!profile || !hasRole(profile, "admin")) return forbidden("Solo administradores.");
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
      const result = await sendOne(key, reminder, settings.frontendBaseUrl, recipients);
      return ok({ ok: result.sent, message: result.sent ? "Correo de prueba enviado correctamente." : "No se pudo enviar el correo de prueba.", details: result.reason });
    } catch (e) {
      return serverError(e);
    }
  },
});
