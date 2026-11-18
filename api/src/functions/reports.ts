import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { canSendConfiguredReport } from "../lib/managementAccess";
import { writeAuditLog } from "../lib/audit";
import { badRequest, forbidden, ok, serverError, unauthorized } from "../lib/http";
import { buildMastersReportEmail, parseSemicolonEmails } from "../lib/reportsService";
import { enforceRequestRateLimit, RATE_LIMIT_POLICIES } from "../lib/rateLimit";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { loadSqlCatalogMastersReportData, loadSqlMastersReportData } from "../lib/mastersReportSqlData";
import { enqueueSqlEmail } from "../lib/emailOutboxSqlRepository";
import { randomUUID } from "node:crypto";
import { catalogActiveUserReportEnvironment, loadCatalogMastersActiveUsers } from "../lib/catalogMastersActiveUsers";
import { catalogMastersReportEnvironment, catalogMastersReportsEnabled, mayDeliverCatalogMastersReport,
  mayReceiveCatalogActiveUsersReport, resolveCatalogMastersReportScope } from "../lib/catalogReportRecipients";

async function getAllowedUser(req: HttpRequest) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  if (!canSendConfiguredReport(profile, await loadRoleDefinitions())) {
    throw Object.assign(new Error("No tiene permisos para enviar este reporte."), { status: 403 });
  }
  return profile;
}

const SendMastersReportSchema = z.object({
  to: z.string().optional(),
  recipients: z.string().optional(),
});

app.http("mastersReportSendEmail", {
  route: "reports/masters/send-email",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    let user: Awaited<ReturnType<typeof getAllowedUser>> | null = null;
    let recipients: string[] = [];
    const catalogOn = catalogMastersReportsEnabled();
    try {
      user = await getAllowedUser(req);
      const body = await req.json();
      const parsed = SendMastersReportSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const recipientsText = parsed.data.recipients ?? parsed.data.to ?? "";
      try {
        recipients = parseSemicolonEmails(recipientsText);
      } catch (e: any) {
        return badRequest(e?.message ?? "Destinatarios inválidos.");
      }

      const limited = await enforceRequestRateLimit(req, "email_masters_report", user.id, RATE_LIMIT_POLICIES.mastersReport);
      if (limited) return limited;

      const activeUsersEnv = catalogActiveUserReportEnvironment();
      const catalogEnvironment = catalogOn ? catalogMastersReportEnvironment() : null;
      if (catalogOn && (!catalogEnvironment || (activeUsersEnv && catalogEnvironment !== activeUsersEnv))) {
        return serverError({ status: 503, message: "El reporte del catálogo no está disponible." });
      }
      const scope = catalogEnvironment ? await resolveCatalogMastersReportScope(user.id, recipients, catalogEnvironment) : null;
      if (catalogOn && !scope) return forbidden("El reporte requiere un alcance de catálogo común y autorizado.");
      if (!catalogOn && activeUsersEnv && !await mayReceiveCatalogActiveUsersReport(recipients)) {
        return forbidden("El reporte de usuarios activos requiere destinatarios autorizados del Portal.");
      }
      const data = scope ? await loadSqlCatalogMastersReportData({ portalEnvironment: scope.environment,
        allowedSourceIds: new Set(scope.sourceIds) }) : await loadSqlMastersReportData(new Date().toISOString().slice(0, 10));
      const activeUsersReport = activeUsersEnv ? await loadCatalogMastersActiveUsers(data, activeUsersEnv) : undefined;

      const settings = await (await import("../lib/settingsService")).loadEmailAlertsSettings();
      const email = buildMastersReportEmail({
        ...data,
        activeUsersReport,
        generatedAt: new Date(),
        frontendBaseUrl: settings.frontendBaseUrl || process.env.FRONTEND_BASE_URL,
        timezone: process.env.APP_TIMEZONE || "America/Bogota",
      });
      if (scope) {
        if ((await getAllowedUser(req)).id !== user.id || !catalogMastersReportsEnabled() ||
            !await mayDeliverCatalogMastersReport(scope, recipients, catalogMastersReportEnvironment())) {
          return forbidden("El reporte requiere un alcance de catálogo común y autorizado.");
        }
      } else if (activeUsersEnv) {
        if ((await getAllowedUser(req)).id !== user.id || !await mayReceiveCatalogActiveUsersReport(recipients)) {
          return forbidden("El reporte de usuarios activos requiere destinatarios autorizados del Portal.");
        }
      }
      const queued = await enqueueSqlEmail({
        type: "masters_report",
        idempotencyKey: `masters-report:${user.id}:${randomUUID()}`,
        entityType: "report",
        entityId: "masters",
        subject: email.subject,
        html: email.html,
        text: email.text,
        recipients: recipients.map((emailAddress) => ({ email: emailAddress })),
        metadata: { recipientsCount: recipients.length, ...(activeUsersEnv ? { catalogActiveUsers: true } : {}),
          ...(scope ? { catalogReportScope: scope } : {}) },
        createdBy: user.id,
      });
      return ok({
        ok: queued.created,
        sent: false,
        queued: queued.created,
        recipientsCount: recipients.length,
        message: queued.created ? "Reporte puesto en cola correctamente." : "El reporte ya estaba en cola.",
      });
    } catch (e: any) {
      if (user) {
        await writeAuditLog({
          entityType: "report",
          entityId: "masters",
          action: "masters_report_email_failed",
          performedBy: user.id,
          performedByEmail: user.email,
          metadata: { recipientsCount: recipients.length, error: catalogOn ? "catalog_report_unavailable" : e?.message ?? "Error desconocido" },
        }).catch(() => undefined);
      }
      if (catalogOn) {
        if (e?.status === 401) return unauthorized();
        if (e?.status === 403) return forbidden();
        return serverError({ status: 503, message: "El reporte del catálogo no está disponible." });
      }
      if (e?.status === 403) return forbidden(e.message);
      return serverError(e);
    }
  },
});
