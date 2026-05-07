import { app, InvocationContext, Timer } from "@azure/functions";
import { getContainer } from "../lib/cosmos";
import { writeAuditLog } from "../lib/audit";
import { sendEmail, renderTaskReminderEmail } from "../lib/emailService";
import { decidirRecordatorios } from "../lib/reminderLogic";
import { loadEmailAlertsSettings } from "../lib/settingsService";
import type { UpdateSchedule, UpdateTask, UserRecord, SentReminder } from "../types/models";

function ahoraEnBogota(): { isoDate: string; horaLocal: string } {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  const bogota = new Date(utcMs - 5 * 3600_000);
  const isoDate = bogota.toISOString().slice(0, 10);
  const horaLocal = bogota.toISOString().slice(11, 16);
  return { isoDate, horaLocal };
}

async function obtenerEmailsDestinatarios(task: UpdateTask, schedule: UpdateSchedule | undefined): Promise<string[]> {
  const cfg = schedule?.reminders;
  if (!cfg) return [];
  if (cfg.reminderRecipientsMode === "customEmails" && cfg.customReminderEmails && cfg.customReminderEmails.length > 0) {
    return cfg.customReminderEmails;
  }
  const usuariosCnt = getContainer("users");
  if (cfg.reminderRecipientsMode === "roleUsers") {
    const role = schedule?.assignedRole;
    if (!role) return [];
    const { resources } = await usuariosCnt.items
      .query<UserRecord>({ query: "SELECT * FROM c WHERE c.active = true AND ARRAY_CONTAINS(c.roles, @r)", parameters: [{ name: "@r", value: role }] })
      .fetchAll();
    return resources.map((u) => u.email).filter(Boolean);
  }
  // assignedUsers (por defecto): combina IDs asignados de la frecuencia y de la tarea.
  const ids = Array.from(new Set([...(schedule?.assignedUserIds ?? []), ...(task.assignedUserIds ?? [])]));
  if (ids.length === 0) return [];
  const emails: string[] = [];
  for (const id of ids) {
    try {
      const { resource } = await usuariosCnt.item(id, id).read<UserRecord>();
      if (resource && resource.active && resource.email) emails.push(resource.email);
    } catch {/* puede ser un email directo */}
    if (id.includes("@")) emails.push(id);
  }
  return Array.from(new Set(emails));
}

export async function ejecutarRecordatorios(log: (m: string) => void): Promise<{ enviados: number; fallidos: number }> {
  const settings = await loadEmailAlertsSettings();
  if (settings.remindersEnabled === false) {
    log("Recordatorios deshabilitados globalmente.");
    return { enviados: 0, fallidos: 0 };
  }
  const { isoDate, horaLocal } = ahoraEnBogota();
  // Tareas activas en una ventana razonable (próximos 14 días).
  const { resources: tareas } = await getContainer("updateTasks")
    .items.query<UpdateTask>({ query: "SELECT * FROM c WHERE c.taskDate >= @hoy AND c.taskDate <= @max AND c.status NOT IN ('completed','cancelled')", parameters: [
      { name: "@hoy", value: isoDate },
      { name: "@max", value: new Date(Date.now() + 14 * 24 * 3600_000).toISOString().slice(0, 10) },
    ] })
    .fetchAll();
  if (tareas.length === 0) return { enviados: 0, fallidos: 0 };

  const ids = Array.from(new Set(tareas.map((t) => t.scheduleId)));
  const frecuencias = new Map<string, UpdateSchedule>();
  for (const id of ids) {
    const { resources } = await getContainer("updateSchedules")
      .items.query<UpdateSchedule>({ query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: id }] })
      .fetchAll();
    if (resources[0]) frecuencias.set(id, resources[0]);
  }

  const decisiones = decidirRecordatorios({ ahoraIsoDate: isoDate, ahoraHoraLocal: horaLocal, tareas, frecuenciasPorId: frecuencias });
  let enviados = 0, fallidos = 0;
  for (const d of decisiones) {
    const sch = frecuencias.get(d.task.scheduleId);
    const destinatarios = await obtenerEmailsDestinatarios(d.task, sch);
    if (destinatarios.length === 0) continue;
    const tpl = renderTaskReminderEmail({
      clientName: d.task.clientName,
      domainName: d.task.domainName,
      targetType: d.task.targetType,
      targetName: d.task.targetName,
      taskDate: d.task.taskDate,
      daysBefore: d.daysBefore,
      appUrl: settings.frontendBaseUrl,
    });
    const r = await sendEmail({ to: destinatarios, subject: tpl.subject, html: tpl.html, text: tpl.text }, settings);
    const sent: SentReminder = { type: d.type, daysBefore: d.daysBefore, sentAt: new Date().toISOString(), recipients: destinatarios };
    if (r.ok) {
      d.task.remindersSent = [...(d.task.remindersSent ?? []), sent];
      d.task.updatedAt = new Date().toISOString();
      d.task.updatedBy = "system";
      await getContainer("updateTasks").item(d.task.id, d.task.taskBucket).replace(d.task);
      await writeAuditLog({
        entityType: "task", entityId: d.task.id, clientId: d.task.clientId, clientName: d.task.clientName,
        domainId: d.task.domainId, domainName: d.task.domainName,
        action: "reminder_email_sent", performedBy: "system", performedByEmail: "system",
        metadata: { daysBefore: d.daysBefore, recipients: destinatarios.length },
      });
      enviados++;
    } else {
      await writeAuditLog({
        entityType: "task", entityId: d.task.id, clientId: d.task.clientId, clientName: d.task.clientName,
        action: "reminder_email_failed", performedBy: "system", performedByEmail: "system",
        metadata: { error: r.error, daysBefore: d.daysBefore },
      });
      fallidos++;
    }
  }
  log(`Recordatorios enviados: ${enviados}; fallidos: ${fallidos}`);
  return { enviados, fallidos };
}

// Cada 15 minutos.
app.timer("sendScheduledReminders", {
  schedule: "0 */15 * * * *",
  handler: async (_t: Timer, ctx: InvocationContext) => {
    try {
      await ejecutarRecordatorios((m) => ctx.log(m));
    } catch (e: any) {
      ctx.error("Error en sendScheduledReminders", e);
    }
  },
});
