import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { requireUser, loadUserProfile } from "../lib/auth";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { getDataBackend } from "../lib/dataBackend";
import { badRequest, forbidden, notFound, ok, serverError } from "../lib/http";
import { filterTasksForOperationalView } from "../lib/taskVisibility";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import {
  canPerformTaskActionWithRoleDefinitions,
  canViewTaskWithRoleDefinitions,
  filterTasksWithRoleDefinitions,
  isTaskAssignedToUserWithRoleDefinitions,
} from "../lib/taskAccess";
import { toPublicTask } from "../lib/publicDtos";
import { normalizedLogicalTaskCount, readSqlWorkflowTasks, type WorkflowTaskFilters } from "../lib/workflowTasksSqlRepository";
import { changeSqlWorkflowTaskStatus } from "../lib/workflowTasksSqlWriteRepository";
import type { DatabaseRecord, DomainRecord, UpdateTask } from "../types/models";
import { readSqlRestrictedDatabase } from "../lib/coreMastersSqlRepository";
import { enqueueSqlEmail } from "../lib/emailOutboxSqlRepository";

async function getUserOrFail(req: HttpRequest) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  return profile;
}

async function findTask(id: string): Promise<UpdateTask | null> {
  const backend = getDataBackend();
  const today = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
  if (backend === "sql") return (await readSqlWorkflowTasks({ sourceId: id, today, status: undefined, operationalOnly: false }))[0] ?? null;
  const { resources } = await getContainer("updateTasks")
    .items.query<UpdateTask>({ query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: id }] })
    .fetchAll();
  const primary = resources[0] ?? null;
  if (backend === "dual-read") {
    const shadow = (await readSqlWorkflowTasks({ sourceId: id, today, status: primary?.status, operationalOnly: false }))[0] ?? null;
    if (Boolean(primary) !== Boolean(shadow)) console.warn("Task detail dual-read parity mismatch.");
  }
  return primary;
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
      const backend = getDataBackend();
      const roleDefinitions = await loadRoleDefinitions();
      if (backend === "sql") {
        let sqlItems = filterTasksWithRoleDefinitions(user, await readSqlWorkflowTasks(sqlFilters), roleDefinitions);
        if (assignedToMe) sqlItems = sqlItems.filter((task) => isTaskAssignedToUserWithRoleDefinitions(user, task));
        return ok(sqlItems.map(toPublicTask));
      }
      const conditions: string[] = [];
      const parameters: { name: string; value: any }[] = [];
      if (date) {
        conditions.push("c.taskDate = @date");
        parameters.push({ name: "@date", value: date });
      }
      if (dateFrom) {
        conditions.push("c.taskDate >= @from");
        parameters.push({ name: "@from", value: dateFrom });
      }
      if (dateTo) {
        conditions.push("c.taskDate <= @to");
        parameters.push({ name: "@to", value: dateTo });
      }
      if (range === "overdue") {
        conditions.push("c.taskDate < @today AND c.status IN ('pending','in_progress','failed','blocked','reopened')");
        parameters.push({ name: "@today", value: today });
      } else if (range === "today") {
        conditions.push("c.taskDate = @today");
        parameters.push({ name: "@today", value: today });
      } else if (range === "upcoming") {
        conditions.push("c.taskDate > @today");
        parameters.push({ name: "@today", value: today });
      }
      if (targetType) {
        conditions.push("c.targetType = @t");
        parameters.push({ name: "@t", value: targetType });
      }
      if (status) {
        conditions.push("c.status = @s");
        parameters.push({ name: "@s", value: status });
      } else {
        conditions.push("c.status != 'cancelled'");
      }
      if (clientId) {
        conditions.push("c.clientId = @c");
        parameters.push({ name: "@c", value: clientId });
      }
      if (domainId) {
        conditions.push("c.domainId = @d");
        parameters.push({ name: "@d", value: domainId });
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const { resources } = await getContainer("updateTasks").items.query<UpdateTask>({ query: `SELECT * FROM c ${where}`, parameters }).fetchAll();
      let items = resources;
      const { resources: schedules } = await getContainer("updateSchedules").items
        .query<{ id: string; active?: boolean }>({
          query: "SELECT c.id, c.active FROM c WHERE (NOT IS_DEFINED(c.deletedAt) OR IS_NULL(c.deletedAt))",
        })
        .fetchAll();
      const existingScheduleIds = new Set(schedules.map((schedule) => schedule.id));
      const activeScheduleIds = new Set(
        schedules.filter((schedule) => schedule.active !== false).map((schedule) => schedule.id)
      );
      items = filterTasksForOperationalView(items, { activeScheduleIds, existingScheduleIds });
      items = filterTasksWithRoleDefinitions(user, items, roleDefinitions);
      if (assignedToMe) items = items.filter((t) => isTaskAssignedToUserWithRoleDefinitions(user, t));
      if (backend === "dual-read") {
        let shadow = filterTasksWithRoleDefinitions(user, await readSqlWorkflowTasks(sqlFilters), roleDefinitions);
        if (assignedToMe) shadow = shadow.filter((task) => isTaskAssignedToUserWithRoleDefinitions(user, task));
        if (normalizedLogicalTaskCount(items) !== shadow.length) console.warn("Tasks dual-read normalized parity mismatch.");
      }
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
    const { sendEmail, escapeHtml, formatDomainForPublishing } = await import("../lib/emailService");
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
      dbInfo = getDataBackend() === "sql"
        ? await readSqlRestrictedDatabase(t.targetId)
        : (await getContainer("databases")
          .items.query<DatabaseRecord>({ query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: t.targetId }] })
          .fetchAll()).resources[0] ?? null;
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
    if (getDataBackend() === "sql") {
      await enqueueSqlEmail({
        type: "task_status_notification",
        idempotencyKey: `task-status:${t.id}:${t.status}:${t.updatedAt}`,
        entityType: "task", entityId: t.id, taskId: t.id, subject, html, text,
        recipients: destinatarios.map((email) => ({ email })),
        metadata: { status: t.status, targetType: t.targetType, problem: true },
      });
    } else {
      await sendEmail({ to: destinatarios, subject, html, text }, settings);
    }
  } catch {/* no bloquear flujo de tarea */}
}

// Notificación de confirmación cuando una tarea se completa CON ÉXITO (sin
// problemas). Se envía a los mismos destinatarios de las alertas de vencidos
// (administradores/encargados configurados). No expone datos sensibles.
async function notificarCompletadaConExito(t: UpdateTask, performedByEmail: string): Promise<void> {
  try {
    const { loadEmailAlertsSettings } = await import("../lib/settingsService");
    const { sendEmail, escapeHtml, formatDomainForPublishing } = await import("../lib/emailService");
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
    if (getDataBackend() === "sql") {
      await enqueueSqlEmail({
        type: "task_status_notification",
        idempotencyKey: `task-status:${t.id}:${t.status}:${t.updatedAt}`,
        entityType: "task", entityId: t.id, taskId: t.id, subject, html, text,
        recipients: destinatarios.map((email) => ({ email })),
        metadata: { status: t.status, targetType: t.targetType, problem: false },
      });
    } else {
      await sendEmail({ to: destinatarios, subject, html, text }, settings);
    }
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
    const before = { ...t };
    if (newStatus === "blocked" && !String(body.notes ?? body.blockReason ?? "").trim()) {
      return badRequest("El motivo del bloqueo es obligatorio.");
    }
    if (getDataBackend() === "sql") {
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
    }
    t.status = newStatus;
    t.updatedAt = new Date().toISOString();
    t.updatedBy = user.id;
    if (typeof body.notes === "string") t.notes = body.notes.slice(0, 4000);
    if (typeof body.result === "string") t.result = body.result.slice(0, 200);

    // Marca de "completada con problemas" cuando llega withProblems=true.
    const conProblemas = newStatus === "completed" && body.withProblems === true;
    if (newStatus === "completed") {
      t.completedAt = new Date().toISOString();
      t.completedBy = user.id;
      t.completedWithProblems = conProblemas;
      if (typeof body.completionNote === "string") t.completionNote = body.completionNote.slice(0, 4000);
      if (conProblemas) {
        t.problemNote = typeof body.problemNote === "string" ? body.problemNote.slice(0, 4000) : "";
      } else {
        t.problemNote = undefined;
      }
    }
    if (newStatus === "blocked") {
      t.blockedAt = new Date().toISOString();
      t.blockedBy = user.id;
      t.blockReason = String(body.blockReason ?? body.notes ?? "").slice(0, 4000);
      t.problemNote = t.blockReason;
    }
    if (newStatus === "pending" && auditAction === "task_reopened") {
      t.reopenedAt = new Date().toISOString();
      t.reopenedBy = user.id;
      t.reopenReason = typeof body.reopenReason === "string" && body.reopenReason.trim()
        ? body.reopenReason.trim().slice(0, 4000)
        : undefined;
      t.completedWithProblems = false;
    }
    if (auditAction === "task_block_resolved") {
      t.resolvedAt = new Date().toISOString();
      t.resolvedBy = user.id;
      t.resolutionComment = typeof body.resolutionComment === "string" && body.resolutionComment.trim()
        ? body.resolutionComment.trim().slice(0, 4000)
        : undefined;
      if (newStatus !== "blocked") {
        t.blockReason = t.blockReason ?? null;
      }
    }
    await getContainer("updateTasks").item(t.id, t.taskBucket).replace(t);

    // Si se completó, actualizar lastUpdatedAt del objetivo (database / domain).
    if (newStatus === "completed") {
      if (t.targetType === "database") {
        const { resources } = await getContainer("databases")
          .items.query<DatabaseRecord>({ query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: t.targetId }] })
          .fetchAll();
        if (resources.length) {
          const db = resources[0];
          db.lastUpdatedAt = t.completedAt;
          db.lastUpdatedBy = user.id;
          await getContainer("databases").item(db.id, db.clientId).replace(db);
        }
      } else if (t.targetType === "domain") {
        const { resources } = await getContainer("domains")
          .items.query<DomainRecord>({ query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: t.targetId }] })
          .fetchAll();
        if (resources.length) {
          const dom = resources[0];
          dom.lastUpdatedAt = t.completedAt;
          dom.lastUpdatedBy = user.id;
          await getContainer("domains").item(dom.id, dom.clientId).replace(dom);
        }
      }
    }

    // Si fue completada con problemas, ajustamos la acción de auditoría
    // a algo más explícito y disparamos email a admins.
    const accionFinal = newStatus === "completed" && t.completedWithProblems
      ? "task_completed_with_problems"
      : auditAction;

    await writeAuditLog({
      entityType: "task",
      entityId: t.id,
      clientId: t.clientId,
      clientName: t.clientName,
      domainId: t.domainId,
      domainName: t.domainName,
      action: accionFinal,
      performedBy: user.id,
      performedByEmail: user.email,
      before,
      after: t,
      metadata: { previousStatus: before.status, newStatus },
    });

    // Matriz de notificaciones por estado (decisión "Atención + fallida + éxito").
    if (newStatus === "completed" || newStatus === "blocked" || newStatus === "failed") {
      const settings = await (await import("../lib/settingsService")).loadEmailAlertsSettings();
      const { decidirNotificacionPorEstado } = await import("../lib/taskNotifications");
      const decision = decidirNotificacionPorEstado({
        newStatus,
        completedWithProblems: !!t.completedWithProblems,
        blockedAlertsEnabled: settings.blockedAlertsEnabled !== false,
      });
      if (decision === "problema") void notificarProblemaAdmins(t, user.email);
      else if (decision === "exito") void notificarCompletadaConExito(t, user.email);
    }

    return ok(toPublicTask(t));
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
