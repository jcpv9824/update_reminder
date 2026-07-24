import { app, InvocationContext, Timer } from "@azure/functions";
import { buildOverdueTasksEmail } from "../lib/emailService";
import { loadEmailAlertsSettings } from "../lib/settingsService";
import { resolveConfiguredRecipients } from "../lib/emailRecipients";
import type { UpdateTask, UserRecord } from "../types/models";
import { findSqlUserById } from "../lib/securityManagementSqlWriteRepository";
import { readSqlWorkflowTasks } from "../lib/workflowTasksSqlRepository";
import { enqueueSqlEmail } from "../lib/emailOutboxSqlRepository";
import { createHash } from "node:crypto";

type Recipient = { email: string; name?: string };

function ahoraEnBogotaIso(): string {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  const bogota = new Date(utcMs - 5 * 3600_000);
  return bogota.toISOString().slice(0, 10);
}

async function getActiveUserById(id: string): Promise<UserRecord | null> {
  const user = await findSqlUserById(id);
  return user?.active ? user : null;
}

async function recipientsFromAssigned(task: UpdateTask): Promise<Recipient[]> {
  const recipients: Recipient[] = [];
  for (const id of task.assignedUserIds ?? []) {
    const user = await getActiveUserById(id);
    if (user?.email) recipients.push({ email: user.email, name: user.displayName });
    else if (id.includes("@")) recipients.push({ email: id });
  }
  const seen = new Set<string>();
  return recipients.filter((r) => {
    if (seen.has(r.email)) return false;
    seen.add(r.email);
    return true;
  });
}

async function fallbackRecipients(settings: Awaited<ReturnType<typeof loadEmailAlertsSettings>>): Promise<Recipient[]> {
  if ((settings.overdueAlertRecipientRoleIds?.length ?? 0) > 0 || (settings.overdueAlertCustomEmails?.length ?? 0) > 0) {
    const emails = await resolveConfiguredRecipients(settings.overdueAlertRecipientRoleIds ?? [], settings.overdueAlertCustomEmails ?? []);
    return emails.map((email) => ({ email }));
  }
  if (settings.overdueAlertRecipientsMode === "customEmails") {
    return (settings.customAdminAlertEmails ?? []).map((email) => ({ email }));
  }
  const roleIds = settings.overdueAlertRecipientsMode === "adminsAndClientManagers"
    ? ["super_admin", "client_manager"]
    : ["super_admin"];
  const emails = await resolveConfiguredRecipients(roleIds, []);
  return emails.map((email) => ({ email }));
}

const WEEKDAY_BY_JS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const;

function shouldSendForFrequency(settings: Awaited<ReturnType<typeof loadEmailAlertsSettings>>, todayIso: string): { send: boolean; period: string; reason?: string } {
  const today = new Date(`${todayIso}T12:00:00Z`);
  const frequency = settings.overdueAlertFrequency ?? "daily";
  if (frequency === "weekly") {
    const weekday = WEEKDAY_BY_JS[today.getUTCDay()];
    if (!(settings.overdueAlertWeekdays ?? ["MONDAY"]).includes(weekday as any)) {
      return { send: false, period: `weekly:${todayIso.slice(0, 7)}`, reason: "Hoy no corresponde a la frecuencia semanal configurada." };
    }
    const yearStart = Date.UTC(today.getUTCFullYear(), 0, 1);
    const week = Math.ceil((((today.getTime() - yearStart) / 86_400_000) + new Date(yearStart).getUTCDay() + 1) / 7);
    return { send: settings.overdueAlertLastSentPeriod !== `${today.getUTCFullYear()}-W${week}`, period: `${today.getUTCFullYear()}-W${week}` };
  }
  return { send: settings.overdueAlertLastSentPeriod !== todayIso, period: todayIso };
}

export async function ejecutarAlertasVencidas(log: (m: string) => void): Promise<{ enviados: number; tareas: number }> {
  const settings = await loadEmailAlertsSettings();
  if (settings.overdueAlertsEnabled === false) {
    log("Alertas de vencidos deshabilitadas globalmente.");
    return { enviados: 0, tareas: 0 };
  }
  const hoy = ahoraEnBogotaIso();
  const frequency = shouldSendForFrequency(settings, hoy);
  if (!frequency.send) {
    log(frequency.reason ?? "La alerta de vencidos ya fue enviada para este periodo.");
    return { enviados: 0, tareas: 0 };
  }
  const tareas = await readSqlWorkflowTasks({ today: hoy, range: "overdue", operationalOnly: true });
  if (tareas.length === 0) {
    log("No hay tareas vencidas visibles.");
    return { enviados: 0, tareas: 0 };
  }
  const tareasVisibles = tareas;
  const pendientes = tareasVisibles;
  if (pendientes.length === 0) {
    log("Todas las tareas vencidas ya recibieron alerta hoy.");
    return { enviados: 0, tareas: tareasVisibles.length };
  }

  const fallback = await fallbackRecipients(settings);
  const grupos = new Map<string, { recipient: Recipient; domains: UpdateTask[]; databases: UpdateTask[] }>();

  for (const task of pendientes) {
    const assigned = await recipientsFromAssigned(task);
    const recipients = assigned.length > 0 ? assigned : fallback;
    for (const recipient of recipients) {
      const group = grupos.get(recipient.email) ?? { recipient, domains: [], databases: [] };
      if (task.targetType === "domain") group.domains.push(task);
      else group.databases.push(task);
      grupos.set(recipient.email, group);
    }
  }

  if (grupos.size === 0) {
    log("No hay responsables o administradores activos para enviar la alerta.");
    return { enviados: 0, tareas: pendientes.length };
  }

  let enviados = 0;
  const alertedTaskIds = new Set<string>();
  for (const group of grupos.values()) {
    const email = buildOverdueTasksEmail({
      recipientName: group.recipient.name,
      frontendBaseUrl: settings.frontendBaseUrl,
      timezone: process.env.APP_TIMEZONE || "America/Bogota",
      overdueDomainTasks: group.domains.map((t) => ({
        clientName: t.clientName,
        domainName: t.domainName || t.targetName,
        dueAt: t.taskDate,
        status: t.status,
        notes: t.notes,
        assignedToEmail: group.recipient.email,
        assignedToName: group.recipient.name,
      })),
      overdueDatabaseTasks: group.databases.map((t) => ({
        clientName: t.clientName,
        domainName: t.domainName,
        databaseName: t.targetName,
        dueAt: t.taskDate,
        status: t.status,
        notes: t.notes,
        assignedToEmail: group.recipient.email,
        assignedToName: group.recipient.name,
      })),
    });
    const taskIds = [...group.domains, ...group.databases].map((task) => task.id).sort();
    const digest = createHash("sha256").update(taskIds.join("|"), "utf8").digest("hex");
    const queued = await enqueueSqlEmail({
      type: "overdue_alert",
      idempotencyKey: `overdue:${hoy}:${group.recipient.email.toLowerCase()}:${digest}`,
      entityType: "task", entityId: "overdue_summary", taskId: taskIds[0],
      period: frequency.period, sendDate: hoy,
      subject: email.subject, html: email.html, text: email.text,
      recipients: [group.recipient],
      metadata: { date: hoy, recipientsCount: 1, domainCount: group.domains.length, databaseCount: group.databases.length, taskIds },
    });
    if (queued.created) {
      enviados++;
      for (const task of [...group.domains, ...group.databases]) alertedTaskIds.add(task.id);
    }
  }

  log(`Alertas de vencidos enviadas: ${enviados}; tareas incluidas: ${alertedTaskIds.size}.`);
  return { enviados, tareas: pendientes.length };
}

app.timer("sendOverdueAlerts", {
  schedule: "0 0 13 * * *",
  handler: async (_t: Timer, ctx: InvocationContext) => {
    try {
      await ejecutarAlertasVencidas((m) => ctx.log(m));
    } catch (e: any) {
      ctx.error("Error en sendOverdueAlerts", e);
    }
  },
});
