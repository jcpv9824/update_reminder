import { app, InvocationContext, Timer } from "@azure/functions";
import { getContainer } from "../lib/cosmos";
import { writeAuditLog } from "../lib/audit";
import { buildDatabaseReminderEmail, buildDomainReminderEmail, sendEmail } from "../lib/emailService";
import { decidirRecordatorios, SCHEDULED_REMINDERS_TIMER_SCHEDULE, type ReminderDecision } from "../lib/reminderLogic";
import { loadEmailAlertsSettings } from "../lib/settingsService";
import { rootScheduleId } from "../lib/taskGenerator";
import type { RemindersConfig, UpdateSchedule, UpdateTask, UserRecord, SentReminder } from "../types/models";
import { assertCosmosRuntimeMutation } from "../lib/dataBackend";
import { getDataBackend } from "../lib/dataBackend";
import { readSqlPublicUsers } from "../lib/securityUsersSqlRepository";
import { readSqlWorkflowTasks } from "../lib/workflowTasksSqlRepository";
import { readSqlSchedules } from "../lib/schedulingSqlRepository";
import { enqueueSqlEmail } from "../lib/emailOutboxSqlRepository";
import { createHash } from "node:crypto";

type Recipient = { email: string; name?: string };

export function adaptarFrecuenciaParaTarea(schedule: UpdateSchedule | undefined, task: UpdateTask): UpdateSchedule | undefined {
  if (!schedule) return undefined;
  return {
    ...schedule,
    id: task.scheduleId,
    targetType: task.targetType,
    targetIds: [task.targetId],
    assignedRole: task.assignedRole,
    assignedUserIds: task.assignedUserIds ?? [],
  };
}

function ahoraEnBogota(): { isoDate: string; horaLocal: string } {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  const bogota = new Date(utcMs - 5 * 3600_000);
  const isoDate = bogota.toISOString().slice(0, 10);
  const horaLocal = bogota.toISOString().slice(11, 16);
  return { isoDate, horaLocal };
}

async function obtenerDestinatariosPorRol(role: string): Promise<Recipient[]> {
  if (getDataBackend() === "sql") {
    const result = await readSqlPublicUsers({ enabled: false, page: 1, pageSize: 500 });
    const users = Array.isArray(result) ? result : result.items;
    return users.filter((user) => user.active && user.roles.includes(role) && !!user.email)
      .map((user) => ({ email: user.email, name: user.displayName }));
  }
  const usuariosCnt = getContainer("users");
  const { resources } = await usuariosCnt.items
    .query<UserRecord>({ query: "SELECT * FROM c WHERE c.active = true AND ARRAY_CONTAINS(c.roles, @r)", parameters: [{ name: "@r", value: role }] })
    .fetchAll();
  return resources.map((u) => ({ email: u.email, name: u.displayName })).filter((u) => !!u.email);
}

async function obtenerDestinatarios(task: UpdateTask, schedule: UpdateSchedule | undefined, globalDefaults?: RemindersConfig, log?: (m: string) => void): Promise<Recipient[]> {
  const cfg = schedule?.reminders ?? globalDefaults;
  if (!cfg) return [];
  if (cfg.reminderRecipientsMode === "customEmails" && cfg.customReminderEmails && cfg.customReminderEmails.length > 0) {
    return cfg.customReminderEmails.map((email) => ({ email }));
  }
  if (cfg.reminderRecipientsMode === "roleUsers") {
    const role = schedule?.assignedRole;
    if (!role) return [];
    return obtenerDestinatariosPorRol(role);
  }

  const ids = Array.from(new Set([...(schedule?.assignedUserIds ?? []), ...(task.assignedUserIds ?? [])]));
  if (ids.length === 0) {
    const role = schedule?.assignedRole;
    if (!role) return [];
    log?.(`Recordatorio con assignedUsers sin usuarios asignados; se usa fallback por rol ${role}.`);
    return obtenerDestinatariosPorRol(role);
  }
  const recipients: Recipient[] = [];
  if (getDataBackend() === "sql") {
    const result = await readSqlPublicUsers({ enabled: false, page: 1, pageSize: 500 });
    const users = Array.isArray(result) ? result : result.items;
    const byId = new Map(users.map((user) => [user.id, user]));
    for (const id of ids) {
      const user = byId.get(id);
      if (user?.active && user.email) recipients.push({ email: user.email, name: user.displayName });
      else if (id.includes("@")) recipients.push({ email: id });
    }
    return [...new Map(recipients.map((recipient) => [recipient.email.toLowerCase(), recipient])).values()];
  }
  const usuariosCnt = getContainer("users");
  for (const id of ids) {
    try {
      const { resource } = await usuariosCnt.item(id, id).read<UserRecord>();
      if (resource && resource.active && resource.email) recipients.push({ email: resource.email, name: resource.displayName });
    } catch {
      // Puede ser un correo directo guardado como responsable.
    }
    if (id.includes("@")) recipients.push({ email: id });
  }
  const seen = new Set<string>();
  return recipients.filter((r) => {
    if (seen.has(r.email)) return false;
    seen.add(r.email);
    return true;
  });
}

async function marcarRecordatorio(args: {
  decision: ReminderDecision;
  recipientEmail: string;
  ok: boolean;
  error?: string;
}) {
  const d = args.decision;
  if (args.ok) {
    const sent: SentReminder = {
      type: d.type,
      daysBefore: d.daysBefore,
      sentAt: new Date().toISOString(),
      recipients: [args.recipientEmail],
    };
    d.task.remindersSent = [...(d.task.remindersSent ?? []), sent];
    d.task.updatedAt = new Date().toISOString();
    d.task.updatedBy = "system";
    await getContainer("updateTasks").item(d.task.id, d.task.taskBucket).replace(d.task);
    await writeAuditLog({
      entityType: "task",
      entityId: d.task.id,
      clientId: d.task.clientId,
      clientName: d.task.clientName,
      domainId: d.task.domainId,
      domainName: d.task.domainName,
      action: "reminder_email_sent",
      performedBy: "system",
      performedByEmail: "system",
      metadata: { daysBefore: d.daysBefore, recipient: args.recipientEmail, targetType: d.task.targetType },
    });
  } else {
    await writeAuditLog({
      entityType: "task",
      entityId: d.task.id,
      clientId: d.task.clientId,
      clientName: d.task.clientName,
      action: "reminder_email_failed",
      performedBy: "system",
      performedByEmail: "system",
      metadata: { error: args.error, daysBefore: d.daysBefore, recipient: args.recipientEmail, targetType: d.task.targetType },
    });
  }
}

export async function ejecutarRecordatorios(log: (m: string) => void): Promise<{ enviados: number; fallidos: number }> {
  const sqlBackend = getDataBackend() === "sql";
  if (!sqlBackend) assertCosmosRuntimeMutation("El envío de recordatorios programados");
  const settings = await loadEmailAlertsSettings();
  if (settings.remindersEnabled === false) {
    log("Recordatorios deshabilitados globalmente.");
    return { enviados: 0, fallidos: 0 };
  }
  const { isoDate, horaLocal } = ahoraEnBogota();
  const maxDate = new Date(Date.now() + 14 * 24 * 3600_000).toISOString().slice(0, 10);
  const tareas = sqlBackend
    ? await readSqlWorkflowTasks({ today: isoDate, dateFrom: isoDate, dateTo: maxDate })
    : (await getContainer("updateTasks")
      .items.query<UpdateTask>({ query: "SELECT * FROM c WHERE c.taskDate >= @hoy AND c.taskDate <= @max AND c.status NOT IN ('completed','cancelled')", parameters: [
        { name: "@hoy", value: isoDate }, { name: "@max", value: maxDate },
      ] }).fetchAll()).resources;
  if (tareas.length === 0) return { enviados: 0, fallidos: 0 };

  const ids = Array.from(new Set(tareas.map((t) => rootScheduleId(t))));
  const frecuencias = new Map<string, UpdateSchedule>();
  if (sqlBackend) {
    for (const id of ids) {
      const result = await readSqlSchedules({ sourceId: id }, { enabled: false, page: 1, pageSize: 1 }, isoDate);
      const schedule = Array.isArray(result) ? result[0] : result.items[0];
      if (schedule) frecuencias.set(id, schedule);
    }
  } else {
    for (const id of ids) {
      const { resources } = await getContainer("updateSchedules")
        .items.query<UpdateSchedule>({ query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: id }] })
        .fetchAll();
      if (resources[0]) frecuencias.set(id, resources[0]);
    }
  }
  for (const tarea of tareas) {
    const original = frecuencias.get(rootScheduleId(tarea));
    const ajustada = adaptarFrecuenciaParaTarea(original, tarea);
    if (ajustada) frecuencias.set(tarea.scheduleId, ajustada);
  }

  const globalDefaults: RemindersConfig = {
    remindersEnabled: settings.remindersEnabled,
    reminderDaysBefore: settings.defaultReminderDaysBefore,
    reminderTime: settings.defaultReminderTime,
    reminderRecipientsMode: "roleUsers",
    customReminderEmails: [],
  };
  const decisiones = decidirRecordatorios({
    ahoraIsoDate: isoDate,
    ahoraHoraLocal: horaLocal,
    tareas,
    frecuenciasPorId: frecuencias,
    globalDefaults,
  });
  const grupos = new Map<string, { recipient: Recipient; domains: ReminderDecision[]; databases: ReminderDecision[] }>();

  for (const decision of decisiones) {
    const sch = frecuencias.get(decision.task.scheduleId);
    const destinatarios = await obtenerDestinatarios(decision.task, sch, globalDefaults, log);
    for (const recipient of destinatarios) {
      const group = grupos.get(recipient.email) ?? { recipient, domains: [], databases: [] };
      if (decision.task.targetType === "domain") group.domains.push(decision);
      else group.databases.push(decision);
      grupos.set(recipient.email, group);
    }
  }

  let enviados = 0;
  let fallidos = 0;
  for (const group of grupos.values()) {
    if (group.domains.length > 0) {
      const email = buildDomainReminderEmail({
        recipientName: group.recipient.name,
        frontendBaseUrl: settings.frontendBaseUrl,
        timezone: process.env.APP_TIMEZONE || "America/Bogota",
        tasks: group.domains.map((d) => ({
          clientName: d.task.clientName,
          domainName: d.task.domainName || d.task.targetName,
          scheduledFor: d.task.taskDate,
          status: d.task.status,
          notes: d.task.notes,
          assignedToName: group.recipient.name,
          assignedToEmail: group.recipient.email,
        })),
      });
      if (sqlBackend) {
        const taskIds = group.domains.map((decision) => decision.task.id).sort();
        const digest = createHash("sha256").update(taskIds.join("|"), "utf8").digest("hex");
        const queued = await enqueueSqlEmail({
          type: "task_reminder",
          idempotencyKey: `task_reminder:${isoDate}:${group.recipient.email.toLowerCase()}:domain:${digest}`,
          entityType: "task", entityId: taskIds[0], taskId: taskIds[0], sendDate: isoDate,
          subject: email.subject, html: email.html, text: email.text,
          recipients: [group.recipient], metadata: { daysBefore: group.domains[0]?.daysBefore, targetType: "domain", taskIds },
        });
        if (queued.created) enviados++;
      } else {
      const r = await sendEmail({ to: group.recipient.email, subject: email.subject, html: email.html, text: email.text }, settings);
      for (const decision of group.domains) await marcarRecordatorio({ decision, recipientEmail: group.recipient.email, ok: r.ok, error: r.error });
      if (r.ok) enviados++; else fallidos++;
      }
    }

    if (group.databases.length > 0) {
      const email = buildDatabaseReminderEmail({
        recipientName: group.recipient.name,
        frontendBaseUrl: settings.frontendBaseUrl,
        timezone: process.env.APP_TIMEZONE || "America/Bogota",
        tasks: group.databases.map((d) => ({
          clientName: d.task.clientName,
          domainName: d.task.domainName,
          databaseName: d.task.targetName,
          scheduledFor: d.task.taskDate,
          status: d.task.status,
          notes: d.task.notes,
          assignedToName: group.recipient.name,
          assignedToEmail: group.recipient.email,
        })),
      });
      if (sqlBackend) {
        const taskIds = group.databases.map((decision) => decision.task.id).sort();
        const digest = createHash("sha256").update(taskIds.join("|"), "utf8").digest("hex");
        const queued = await enqueueSqlEmail({
          type: "task_reminder",
          idempotencyKey: `task_reminder:${isoDate}:${group.recipient.email.toLowerCase()}:database:${digest}`,
          entityType: "task", entityId: taskIds[0], taskId: taskIds[0], sendDate: isoDate,
          subject: email.subject, html: email.html, text: email.text,
          recipients: [group.recipient], metadata: { daysBefore: group.databases[0]?.daysBefore, targetType: "database", taskIds },
        });
        if (queued.created) enviados++;
      } else {
      const r = await sendEmail({ to: group.recipient.email, subject: email.subject, html: email.html, text: email.text }, settings);
      for (const decision of group.databases) await marcarRecordatorio({ decision, recipientEmail: group.recipient.email, ok: r.ok, error: r.error });
      if (r.ok) enviados++; else fallidos++;
      }
    }
  }

  log(`Recordatorios enviados: ${enviados}; fallidos: ${fallidos}`);
  return { enviados, fallidos };
}

app.timer("sendScheduledReminders", {
  schedule: SCHEDULED_REMINDERS_TIMER_SCHEDULE,
  handler: async (_t: Timer, ctx: InvocationContext) => {
    try {
      await ejecutarRecordatorios((m) => ctx.log(m));
    } catch (e: any) {
      ctx.error("Error en sendScheduledReminders", e);
    }
  },
});
