import { app, InvocationContext, Timer } from "@azure/functions";
import { getContainer } from "../lib/cosmos";
import { resolveConfiguredRecipients } from "../lib/emailRecipients";
import { sendEmail } from "../lib/emailService";
import { loadEmailAlertsSettings } from "../lib/settingsService";
import { writeAuditLog } from "../lib/audit";
import type { UpdateTask } from "../types/models";
import { buildBlockedTaskReminderEmail } from "../lib/emailTemplates";

function bogotaNow(): Date {
  return new Date(Date.now() - 5 * 3600_000);
}

function daysBetweenIso(startIso: string, endIsoDate: string): number {
  const start = new Date(startIso).toISOString().slice(0, 10);
  const a = Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, Number(start.slice(8, 10)));
  const b = Date.UTC(Number(endIsoDate.slice(0, 4)), Number(endIsoDate.slice(5, 7)) - 1, Number(endIsoDate.slice(8, 10)));
  return Math.floor((b - a) / 86_400_000);
}

async function wasSent(taskId: string, daysAfter: number): Promise<boolean> {
  try {
    const id = `blockedReminder:${taskId}:${daysAfter}`;
    const { resource } = await getContainer("emailNotifications").item(id, id).read<any>();
    return !!resource;
  } catch {
    return false;
  }
}

async function markSent(taskId: string, daysAfter: number, recipients: string[]): Promise<void> {
  const id = `blockedReminder:${taskId}:${daysAfter}`;
  await getContainer("emailNotifications").items.upsert({
    id,
    type: "blocked_task_reminder",
    taskId,
    daysAfter,
    recipients,
    sentAt: new Date().toISOString(),
  });
}

export async function ejecutarRecordatoriosBloqueos(log: (message: string) => void, now = bogotaNow()): Promise<{ enviados: number }> {
  const settings = await loadEmailAlertsSettings();
  if (!settings.blockedReminderEnabled) return { enviados: 0 };
  const hhmm = now.toISOString().slice(11, 16);
  if (hhmm < (settings.blockedReminderTime ?? "08:00")) return { enviados: 0 };
  const days = settings.blockedReminderDaysAfter ?? [];
  if (days.length === 0) return { enviados: 0 };
  const recipients = await resolveConfiguredRecipients(settings.blockedAlertRecipientRoleIds ?? ["super_admin"], settings.blockedAlertCustomEmails ?? []);
  if (recipients.length === 0) {
    log("Recordatorios de bloqueos omitidos: sin destinatarios.");
    return { enviados: 0 };
  }

  const today = now.toISOString().slice(0, 10);
  const { resources: tasks } = await getContainer("updateTasks")
    .items.query<UpdateTask>({ query: "SELECT * FROM c WHERE c.status = 'blocked'" })
    .fetchAll();
  let enviados = 0;
  for (const task of tasks) {
    if (!task.blockedAt) continue;
    const elapsed = daysBetweenIso(task.blockedAt, today);
    if (!days.includes(elapsed)) continue;
    if (await wasSent(task.id, elapsed)) continue;
    const email = buildBlockedTaskReminderEmail({
      task: {
        clientName: task.clientName,
        domainName: task.domainName,
        targetType: task.targetType,
        targetName: task.targetName,
        daysAfter: elapsed,
        reason: task.blockReason ?? task.problemNote,
      },
      frontendBaseUrl: settings.frontendBaseUrl,
    });
    const result = await sendEmail({ to: recipients, subject: email.subject, html: email.html, text: email.text }, settings);
    await writeAuditLog({
      entityType: "task",
      entityId: task.id,
      clientId: task.clientId,
      clientName: task.clientName,
      domainId: task.domainId,
      domainName: task.domainName,
      action: result.ok ? "blocked_task_reminder_sent" : "blocked_task_reminder_failed",
      performedBy: "system",
      performedByEmail: "system",
      metadata: { daysAfter: elapsed, recipientsCount: recipients.length, error: result.ok ? undefined : result.error },
    });
    if (result.ok) {
      await markSent(task.id, elapsed, recipients);
      enviados++;
    }
  }
  return { enviados };
}

app.timer("sendBlockedReminders", {
  schedule: "0 */30 * * * *",
  handler: async (_t: Timer, ctx: InvocationContext) => {
    try {
      const r = await ejecutarRecordatoriosBloqueos((m) => ctx.log(m));
      ctx.log(`Recordatorios de bloqueos enviados: ${r.enviados}`);
    } catch (e: any) {
      ctx.error("Error en sendBlockedReminders", e);
    }
  },
});
