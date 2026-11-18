import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { canSendConfiguredReport } from "../lib/managementAccess";
import { writeAuditLog } from "../lib/audit";
import { badRequest, forbidden, ok, serverError } from "../lib/http";
import { buildMastersReportEmail, parseSemicolonEmails } from "../lib/reportsService";
import { enforceRequestRateLimit, RATE_LIMIT_POLICIES } from "../lib/rateLimit";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { loadSqlMastersReportData } from "../lib/mastersReportSqlData";
import { enqueueSqlEmail } from "../lib/emailOutboxSqlRepository";
import { randomUUID } from "node:crypto";
import { catalogActiveUserReportEnvironment, loadCatalogMastersActiveUsers } from "../lib/catalogMastersActiveUsers";
import { mayReceiveCatalogActiveUsersReport } from "../lib/catalogReportRecipients";

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
      if (activeUsersEnv && !await mayReceiveCatalogActiveUsersReport(recipients)) {
        return forbidden("El reporte de usuarios activos requiere destinatarios autorizados del Portal.");
      }
      const data = await loadSqlMastersReportData(new Date().toISOString().slice(0, 10));
      const activeUsersReport = activeUsersEnv ? await loadCatalogMastersActiveUsers(data, activeUsersEnv) : undefined;

      const settings = await (await import("../lib/settingsService")).loadEmailAlertsSettings();
      const email = buildMastersReportEmail({
        ...data,
        activeUsersReport,
        generatedAt: new Date(),
        frontendBaseUrl: settings.frontendBaseUrl || process.env.FRONTEND_BASE_URL,
        timezone: process.env.APP_TIMEZONE || "America/Bogota",
      });
      if (activeUsersEnv) {
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
        metadata: { recipientsCount: recipients.length, ...(activeUsersEnv ? { catalogActiveUsers: true } : {}) },
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
          metadata: { recipientsCount: recipients.length, error: e?.message ?? "Error desconocido" },
        }).catch(() => undefined);
      }
      if (e?.status === 403) return forbidden(e.message);
      return serverError(e);
    }
  },
});
