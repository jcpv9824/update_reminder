import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { requireUser, loadUserProfile } from "../lib/auth";
import { canCompleteDatabaseTask, canCompleteDomainTask, hasRole } from "../lib/permissions";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { badRequest, forbidden, notFound, ok, serverError } from "../lib/http";
import type { DatabaseRecord, DomainRecord, UpdateTask } from "../types/models";

async function getUserOrFail(req: HttpRequest) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  return profile;
}

async function findTask(id: string): Promise<UpdateTask | null> {
  const { resources } = await getContainer("updateTasks")
    .items.query<UpdateTask>({ query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: id }] })
    .fetchAll();
  return resources[0] ?? null;
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
        conditions.push("c.taskDate < @today AND c.status IN ('pending','in_progress','reopened')");
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
      if (assignedToMe) items = items.filter((t) => t.assignedUserIds.includes(user.id));
      return ok(items);
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
      await getUserOrFail(req);
      const t = await findTask(req.params.id);
      if (!t) return notFound("Tarea no encontrada.");
      return ok(t);
    } catch (e) { return serverError(e); }
  },
});

async function notificarProblemaAdmins(t: UpdateTask, performedByEmail: string): Promise<void> {
  try {
    const { loadEmailAlertsSettings } = await import("../lib/settingsService");
    const { sendEmail, escapeHtml, formatDomainForPublishing } = await import("../lib/emailService");
    const settings = await loadEmailAlertsSettings();
    // Buscar admins activos.
    const { resources: admins } = await getContainer("users")
      .items.query<any>({ query: "SELECT * FROM c WHERE c.active = true AND ARRAY_CONTAINS(c.roles, 'admin')" })
      .fetchAll();
    const destinatarios = admins.map((u) => u.email).filter(Boolean);
    if (destinatarios.length === 0) {
      // Sin admins activos: no se envía email pero la tarea ya quedó guardada.
      return;
    }
    const tipo = t.targetType === "domain" ? "dominio" : "base de datos";
    const subject = t.targetType === "domain"
      ? "Problema reportado en actualización de dominio"
      : "Problema reportado en actualización de base de datos";
    const linkApp = settings.frontendBaseUrl
      ? `<p><a href="${settings.frontendBaseUrl.replace(/\/$/, "")}/tareas">Abrir tareas</a></p>`
      : "";
    const dominioPublicable = formatDomainForPublishing(t.domainName);
    const html = `
      <h3>${escapeHtml(subject)}</h3>
      <p>Se reportó un problema al completar una actualización.</p>
      <ul>
        <li><strong>Tipo:</strong> ${escapeHtml(tipo)}</li>
        <li><strong>Cliente:</strong> ${escapeHtml(t.clientName)}</li>
        <li><strong>Dominio registrado:</strong> ${escapeHtml(t.domainName)}</li>
        <li><strong>Dominio para publicar:</strong> <code>${escapeHtml(dominioPublicable)}</code></li>
        ${t.targetType === "database" ? `<li><strong>Base / Empresa:</strong> ${escapeHtml(t.targetName)}</li>` : ""}
        <li><strong>Fecha programada:</strong> ${escapeHtml(t.taskDate)}</li>
        <li><strong>Completada por:</strong> ${escapeHtml(performedByEmail)}</li>
        <li><strong>Completada:</strong> ${escapeHtml(t.completedAt ?? "")}</li>
      </ul>
      <p><strong>Problema reportado:</strong></p>
      <blockquote>${escapeHtml(t.problemNote ?? "(sin detalle)")}</blockquote>
      ${linkApp}
    `;
    const text = `${subject}. Cliente: ${t.clientName}. Dominio registrado: ${t.domainName}. Dominio para publicar: ${dominioPublicable}. Fecha: ${t.taskDate}. Completada por: ${performedByEmail}. Problema: ${t.problemNote ?? "(sin detalle)"}`;
    await sendEmail({ to: destinatarios, subject, html, text }, settings);
  } catch {/* no bloquear flujo de tarea */}
}

async function changeTaskStatus(
  req: HttpRequest,
  newStatus: UpdateTask["status"],
  auditAction: string
): Promise<HttpResponseInit> {
  try {
    const user = await getUserOrFail(req);
    const t = await findTask(req.params.id);
    if (!t) return notFound("Tarea no encontrada.");

    const allowed = t.targetType === "database"
      ? canCompleteDatabaseTask(user, t)
      : canCompleteDomainTask(user, t);
    const isAdmin = hasRole(user, "admin");
    if (!allowed && !isAdmin) return forbidden("No puede cambiar el estado de esta tarea.");

    const body = (await req.json().catch(() => ({}))) as any;
    const before = { ...t };
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
    });

    if (newStatus === "completed" && t.completedWithProblems) {
      // Notificación a admins activos. No bloquea la respuesta.
      void notificarProblemaAdmins(t, user.email);
    }

    return ok(t);
  } catch (e) {
    return serverError(e);
  }
}

app.http("tasksStart", { route: "tasks/{id}/start", methods: ["POST"], authLevel: "anonymous", handler: (req) => changeTaskStatus(req, "in_progress", "task_started") });
app.http("tasksComplete", { route: "tasks/{id}/complete", methods: ["POST"], authLevel: "anonymous", handler: (req) => changeTaskStatus(req, "completed", "task_completed") });
app.http("tasksFail", { route: "tasks/{id}/fail", methods: ["POST"], authLevel: "anonymous", handler: (req) => changeTaskStatus(req, "failed", "task_failed") });
app.http("tasksBlock", { route: "tasks/{id}/block", methods: ["POST"], authLevel: "anonymous", handler: (req) => changeTaskStatus(req, "blocked", "task_blocked") });
app.http("tasksReopen", { route: "tasks/{id}/reopen", methods: ["POST"], authLevel: "anonymous", handler: (req) => changeTaskStatus(req, "reopened", "task_reopened") });
app.http("tasksCancel", { route: "tasks/{id}/cancel", methods: ["POST"], authLevel: "anonymous", handler: (req) => changeTaskStatus(req, "cancelled", "task_cancelled") });
