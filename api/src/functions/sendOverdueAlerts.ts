import { app, InvocationContext, Timer } from "@azure/functions";
import { getContainer } from "../lib/cosmos";
import { writeAuditLog } from "../lib/audit";
import { renderOverdueAlertEmail, sendEmail } from "../lib/emailService";
import type { UpdateTask, UserRecord } from "../types/models";

function ahoraEnBogotaIso(): string {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  const bogota = new Date(utcMs - 5 * 3600_000);
  return bogota.toISOString().slice(0, 10);
}

export async function ejecutarAlertasVencidas(log: (m: string) => void): Promise<{ enviados: number; tareas: number }> {
  const hoy = ahoraEnBogotaIso();
  const { resources: tareas } = await getContainer("updateTasks")
    .items.query<UpdateTask>({ query: "SELECT * FROM c WHERE c.taskDate < @hoy AND c.status IN ('pending','in_progress','failed','blocked','reopened')", parameters: [{ name: "@hoy", value: hoy }] })
    .fetchAll();
  if (tareas.length === 0) {
    log("No hay tareas vencidas.");
    return { enviados: 0, tareas: 0 };
  }

  // Filtrar tareas a las que aún no se les envió alerta hoy.
  const pendientes = tareas.filter((t) => !((t.overdueAlertSentDates ?? []).includes(hoy)));
  if (pendientes.length === 0) {
    log("Todas las tareas vencidas ya recibieron alerta hoy.");
    return { enviados: 0, tareas: tareas.length };
  }

  // Destinatarios: administradores activos.
  const { resources: admins } = await getContainer("users")
    .items.query<UserRecord>({ query: "SELECT * FROM c WHERE c.active = true AND (ARRAY_CONTAINS(c.roles, 'admin') OR ARRAY_CONTAINS(c.roles, 'client_manager'))" })
    .fetchAll();
  const destinatarios = admins.map((u) => u.email).filter(Boolean);
  if (destinatarios.length === 0) {
    log("No hay administradores activos para enviar la alerta.");
    return { enviados: 0, tareas: tareas.length };
  }

  const dominios = pendientes.filter((t) => t.targetType === "domain").map((t) => ({
    clientName: t.clientName, domainName: t.domainName, taskDate: t.taskDate, status: t.status, assigned: (t.assignedUserIds ?? []).join(", "),
  }));
  const bds = pendientes.filter((t) => t.targetType === "database").map((t) => ({
    clientName: t.clientName, domainName: t.domainName, targetName: t.targetName, taskDate: t.taskDate, status: t.status, assigned: (t.assignedUserIds ?? []).join(", "),
  }));
  const tpl = renderOverdueAlertEmail({ domainTasks: dominios, databaseTasks: bds });
  const r = await sendEmail({ to: destinatarios, subject: tpl.subject, html: tpl.html, text: tpl.text });

  if (r.ok) {
    // Marcar las tareas como alertadas hoy.
    for (const t of pendientes) {
      t.overdueAlertSentDates = [...(t.overdueAlertSentDates ?? []), hoy];
      t.updatedAt = new Date().toISOString();
      t.updatedBy = "system";
      await getContainer("updateTasks").item(t.id, t.taskBucket).replace(t);
    }
    await writeAuditLog({
      entityType: "task",
      entityId: "overdue_summary",
      action: "overdue_alert_sent",
      performedBy: "system",
      performedByEmail: "system",
      metadata: { date: hoy, domainCount: dominios.length, databaseCount: bds.length, recipients: destinatarios.length },
    });
    log(`Alerta de vencidos enviada a ${destinatarios.length} admins.`);
    return { enviados: 1, tareas: pendientes.length };
  } else {
    await writeAuditLog({
      entityType: "task",
      entityId: "overdue_summary",
      action: "overdue_alert_failed",
      performedBy: "system",
      performedByEmail: "system",
      metadata: { date: hoy, error: r.error },
    });
    log(`Falló envío: ${r.error}`);
    return { enviados: 0, tareas: pendientes.length };
  }
}

// Una vez al día a las 08:00 hora Bogotá = 13:00 UTC.
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
