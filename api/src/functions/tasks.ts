import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { requireUser, loadUserProfile } from "../lib/auth";
import { badRequest, forbidden, notFound, ok, serverError } from "../lib/http";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import {
  canPerformTaskActionWithRoleDefinitions,
  canViewTaskWithRoleDefinitions,
  filterTasksWithRoleDefinitions,
  isTaskAssignedToUserWithRoleDefinitions,
} from "../lib/taskAccess";
import { toPublicTask } from "../lib/publicDtos";
import { readSqlWorkflowTasks, type WorkflowTaskFilters } from "../lib/workflowTasksSqlRepository";
import { changeSqlWorkflowTaskStatus } from "../lib/workflowTasksSqlWriteRepository";
import type { DatabaseRecord, UpdateTask } from "../types/models";
import { readSqlRestrictedDatabase } from "../lib/coreMastersSqlRepository";
import { enqueueSqlEmail } from "../lib/emailOutboxSqlRepository";

async function getUserOrFail(req: HttpRequest) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  return profile;
}

async function findTask(id: string): Promise<UpdateTask | null> {
  const today = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
  return (await readSqlWorkflowTasks({ sourceId: id, today, status: undefined, operationalOnly: false }))[0] ?? null;
}

function actionIdForAuditAction(auditAction: string): string {
  const map: Record<string, string> = {
    task_started: "start",
    task_completed: "complete",
    task_failed: "fail",
    task_blocked: "block",
    task_reopened: "reopen",
    task_cancelled: "cancel",
    task_block_resolved: "resolve_block",
  };
  return map[auditAction] ?? auditAction;
}

app.http("tasksList", {
  route: "tasks",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const date = req.query.get("date");
      const targetType = req.query.get("targetType");
      const status = req.query.get("status");
      const clientId = req.query.get("clientId");
      const domainId = req.query.get("domainId");
      const dateFrom = req.query.get("dateFrom");
      const dateTo = req.query.get("dateTo");
      const assignedToMe = req.query.get("assignedToMe") === "true";
      const range = req.query.get("range"); // overdue | today | upcoming

      // Today en zona Bogotá (UTC-5). Evita que después de las 7pm locales el
      // backend reporte el día siguiente.
      const today = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
      const sqlFilters: WorkflowTaskFilters = { date, targetType, status, clientId, domainId, dateFrom, dateTo, range, today };
      const roleDefinitions = await loadRoleDefinitions();
      let items = filterTasksWithRoleDefinitions(user, await readSqlWorkflowTasks(sqlFilters), roleDefinitions);
      if (assignedToMe) items = items.filter((task) => isTaskAssignedToUserWithRoleDefinitions(user, task));
      return ok(items.map(toPublicTask));
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("tasksGet", {
  route: "tasks/{id}",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const t = await findTask(req.params.id);
      if (!t) return notFound("Tarea no encontrada.");
      if (!canViewTaskWithRoleDefinitions(user, t, await loadRoleDefinitions())) {
        return forbidden("No tiene permisos para consultar esta tarea.");
      }
      return ok(toPublicTask(t));
    } catch (e) { return serverError(e); }
  },
});

async function notificarProblemaAdmins(t: UpdateTask, performedByEmail: string): Promise<void> {
  try {
    const { loadEmailAlertsSettings } = await import("../lib/settingsService");
    const { escapeHtml, formatDomainForPublishing } = await import("../lib/emailService");
    const { normalizeBaseUrl } = await import("../lib/emailTemplates");
    const { resolveConfiguredRecipients } = await import("../lib/emailRecipients");
    const settings = await loadEmailAlertsSettings();
    const destinatarios = await resolveConfiguredRecipients(
      settings.blockedAlertRecipientRoleIds?.length ? settings.blockedAlertRecipientRoleIds : ["super_admin"],
      settings.blockedAlertCustomEmails ?? []
    );
    if (destinatarios.length === 0) {
      // Sin admins activos: no se envía email pero la tarea ya quedó guardada.
      return;
    }
    const tipo = t.targetType === "domain" ? "Dominio" : "Base de datos";
    const esFallida = t.status === "failed";
    const subject = esFallida
      ? (t.targetType === "domain" ? "Actualización de dominio fallida" : "Actualización de base de datos fallida")
      : (t.targetType === "domain" ? "Error reportado en actualización de dominio" : "Error reportado en actualización de base de datos");
    const detalleProblema = t.problemNote || t.notes || "(sin detalle)";
    const linkApp = settings.frontendBaseUrl
      ? `<p><a href="${escapeHtml(`${normalizeBaseUrl(settings.frontendBaseUrl)}/tareas`)}">Abrir tareas</a></p>`
      : "";
    const dominioPublicable = formatDomainForPublishing(t.domainName);
    let dbInfo: DatabaseRecord | null = null;
    if (t.targetType === "database") {
      dbInfo = await readSqlRestrictedDatabase(t.targetId);
    }
    const html = `
      <h3>${escapeHtml(subject)}</h3>
      <p>Se reportó un problema durante la actualización.</p>
      <ul>
        <li><strong>Tipo:</strong> ${escapeHtml(tipo)}</li>
        <li><strong>Cliente:</strong> ${escapeHtml(t.clientName)}</li>
        <li><strong>Dominio registrado:</strong> ${escapeHtml(t.domainName)}</li>
        <li><strong>Dominio para publicar:</strong> <code>${escapeHtml(dominioPublicable)}</code></li>
        ${t.targetType === "database" ? `
          <li><strong>Empresa:</strong> ${escapeHtml(dbInfo?.companyName ?? t.targetName)}</li>
          <li><strong>Servidor y puerto:</strong> ${escapeHtml(dbInfo?.dbAccess.serverHostPort ?? "-")}</li>
          <li><strong>Base de datos:</strong> ${escapeHtml(dbInfo?.dbAccess.initialCatalog ?? t.targetName)}</li>
          <li><strong>Usuario:</strong> ${escapeHtml(dbInfo?.dbAccess.userId ?? "-")}</li>
        ` : `<li><strong>Ambiente:</strong> ${escapeHtml((t as any).environment ?? "-")}</li>`}
        <li><strong>Fecha programada:</strong> ${escapeHtml(t.taskDate)}</li>
        <li><strong>Responsable:</strong> ${escapeHtml(performedByEmail)}</li>
        <li><strong>Fecha de reporte:</strong> ${escapeHtml(new Date().toISOString())}</li>
      </ul>
      <p><strong>${esFallida ? "Motivo de la falla:" : "Problema reportado:"}</strong></p>
      <blockquote>${escapeHtml(detalleProblema)}</blockquote>
      ${linkApp}
    `;
    const dbText = dbInfo ? ` Empresa: ${dbInfo.companyName}. Servidor y puerto: ${dbInfo.dbAccess.serverHostPort}. Base de datos: ${dbInfo.dbAccess.initialCatalog}. Usuario: ${dbInfo.dbAccess.userId}.` : "";
    const text = `${subject}. Tipo: ${tipo}. Cliente: ${t.clientName}. Dominio registrado: ${t.domainName}. Dominio para publicar: ${dominioPublicable}.${dbText} Fecha programada: ${t.taskDate}. Responsable: ${performedByEmail}. ${esFallida ? "Motivo" : "Problema"}: ${detalleProblema}`;
    await enqueueSqlEmail({
      type: "task_status_notification",
      idempotencyKey: `task-status:${t.id}:${t.status}:${t.updatedAt}`,
      entityType: "task", entityId: t.id, taskId: t.id, subject, html, text,
      recipients: destinatarios.map((email) => ({ email })),
      metadata: { status: t.status, targetType: t.targetType, problem: true },
    });
  } catch {/* no bloquear flujo de tarea */}
}

// Notificación de confirmación cuando una tarea se completa CON ÉXITO (sin
// problemas). Se envía a los mismos destinatarios de las alertas de vencidos
// (administradores/encargados configurados). No expone datos sensibles.
async function notificarCompletadaConExito(t: UpdateTask, performedByEmail: string): Promise<void> {
  try {
    const { loadEmailAlertsSettings } = await import("../lib/settingsService");
    const { escapeHtml, formatDomainForPublishing } = await import("../lib/emailService");
    const { normalizeBaseUrl } = await import("../lib/emailTemplates");
    const { resolveConfiguredRecipients } = await import("../lib/emailRecipients");
    const settings = await loadEmailAlertsSettings();
    const destinatarios = await resolveConfiguredRecipients(
      settings.overdueAlertRecipientRoleIds?.length ? settings.overdueAlertRecipientRoleIds : ["super_admin"],
      settings.overdueAlertCustomEmails ?? []
    );
    if (destinatarios.length === 0) return;
    const tipo = t.targetType === "domain" ? "Dominio" : "Base de datos";
    const subject = t.targetType === "domain"
      ? "Actualización de dominio completada"
      : "Actualización de base de datos completada";
    const dominioPublicable = formatDomainForPublishing(t.domainName);
    const linkApp = settings.frontendBaseUrl
      ? `<p><a href="${escapeHtml(`${normalizeBaseUrl(settings.frontendBaseUrl)}/tareas`)}">Abrir tareas</a></p>`
      : "";
    const nota = t.completionNote || t.notes || "";
    const html = `
      <h3>${escapeHtml(subject)}</h3>
      <p>Una actualización se completó correctamente.</p>
      <ul>
        <li><strong>Tipo:</strong> ${escapeHtml(tipo)}</li>
        <li><strong>Cliente:</strong> ${escapeHtml(t.clientName)}</li>
        <li><strong>Dominio registrado:</strong> ${escapeHtml(t.domainName)}</li>
        <li><strong>Dominio para publicar:</strong> <code>${escapeHtml(dominioPublicable)}</code></li>
        ${t.targetType === "database" ? `<li><strong>Empresa / Base:</strong> ${escapeHtml(t.targetName)}</li>` : ""}
        <li><strong>Fecha programada:</strong> ${escapeHtml(t.taskDate)}</li>
        <li><strong>Completada por:</strong> ${escapeHtml(performedByEmail)}</li>
        <li><strong>Fecha de finalización:</strong> ${escapeHtml(t.completedAt ?? new Date().toISOString())}</li>
      </ul>
      ${nota ? `<p><strong>Nota:</strong></p><blockquote>${escapeHtml(nota)}</blockquote>` : ""}
      ${linkApp}
    `;
    const text = `${subject}. Tipo: ${tipo}. Cliente: ${t.clientName}. Dominio para publicar: ${dominioPublicable}. Fecha programada: ${t.taskDate}. Completada por: ${performedByEmail}.${nota ? ` Nota: ${nota}` : ""}`;
    await enqueueSqlEmail({
      type: "task_status_notification",
      idempotencyKey: `task-status:${t.id}:${t.status}:${t.updatedAt}`,
      entityType: "task", entityId: t.id, taskId: t.id, subject, html, text,
      recipients: destinatarios.map((email) => ({ email })),
      metadata: { status: t.status, targetType: t.targetType, problem: false },
    });
  } catch {/* no bloquear flujo de tarea */}
}

async function changeTaskStatus(
  req: HttpRequest,
  newStatus: UpdateTask["status"],
  auditAction: string,
  providedBody?: any
): Promise<HttpResponseInit> {
  try {
    const user = await getUserOrFail(req);
    const t = await findTask(req.params.id);
    if (!t) return notFound("Tarea no encontrada.");

    const roleDefinitions = await loadRoleDefinitions();
    const allowed = canPerformTaskActionWithRoleDefinitions(user, t, actionIdForAuditAction(auditAction), roleDefinitions);
    if (!allowed) return forbidden("No puede cambiar el estado de esta tarea.");

    const body = providedBody ?? ((await req.json().catch(() => ({}))) as any);
    if (newStatus === "blocked" && !String(body.notes ?? body.blockReason ?? "").trim()) {
      return badRequest("El motivo del bloqueo es obligatorio.");
    }
    const updated = await changeSqlWorkflowTaskStatus(req.params.id, newStatus, auditAction, body, {
      id: user.id, email: user.email,
    });
    if (!updated) return notFound("Tarea no encontrada.");
    if (newStatus === "completed" || newStatus === "blocked" || newStatus === "failed") {
      const settings = await (await import("../lib/settingsService")).loadEmailAlertsSettings();
      const { decidirNotificacionPorEstado } = await import("../lib/taskNotifications");
      const decision = decidirNotificacionPorEstado({
        newStatus,
        completedWithProblems: !!updated.completedWithProblems,
        blockedAlertsEnabled: settings.blockedAlertsEnabled !== false,
      });
      if (decision === "problema") void notificarProblemaAdmins(updated, user.email);
      else if (decision === "exito") void notificarCompletadaConExito(updated, user.email);
    }
    return ok(toPublicTask(updated));
  } catch (e) {
    return serverError(e);
  }
}

app.http("tasksStart", { route: "tasks/{id}/start", methods: ["POST"], authLevel: "anonymous", handler: (req) => changeTaskStatus(req, "in_progress", "task_started") });
app.http("tasksComplete", { route: "tasks/{id}/complete", methods: ["POST"], authLevel: "anonymous", handler: (req) => changeTaskStatus(req, "completed", "task_completed") });
app.http("tasksFail", { route: "tasks/{id}/fail", methods: ["POST"], authLevel: "anonymous", handler: (req) => changeTaskStatus(req, "failed", "task_failed") });
app.http("tasksBlock", { route: "tasks/{id}/block", methods: ["POST"], authLevel: "anonymous", handler: (req) => changeTaskStatus(req, "blocked", "task_blocked") });
app.http("tasksReopen", { route: "tasks/{id}/reopen", methods: ["POST"], authLevel: "anonymous", handler: (req) => changeTaskStatus(req, "pending", "task_reopened") });
app.http("tasksCancel", { route: "tasks/{id}/cancel", methods: ["POST"], authLevel: "anonymous", handler: (req) => changeTaskStatus(req, "cancelled", "task_cancelled") });

app.http("tasksResolveBlock", {
  route: "tasks/{id}/resolve-block",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const body = (await req.json().catch(() => ({}))) as any;
      const newStatus = String(body.newStatus ?? "");
      if (!["pending", "in_progress", "completed"].includes(newStatus)) return badRequest("Seleccione un nuevo estado válido.");
      return await changeTaskStatus(req, newStatus as UpdateTask["status"], "task_block_resolved", {
        ...body,
        resolutionComment: String(body.resolutionComment ?? "").trim(),
      });
    } catch (e) {
      return serverError(e);
    }
  },
});
