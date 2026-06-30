import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { canSendMastersReport } from "../lib/permissions";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { sendEmail } from "../lib/emailService";
import { badRequest, forbidden, ok, serverError } from "../lib/http";
import { buildMastersReportEmail, parseSemicolonEmails } from "../lib/reportsService";
import type { ClientRecord, DatabaseRecord, DomainRecord, LicenseAssignmentRecord, LicenseModuleRecord, UpdateSchedule } from "../types/models";
import { enforceRequestRateLimit, RATE_LIMIT_POLICIES } from "../lib/rateLimit";

async function getAllowedUser(req: HttpRequest) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  if (!canSendMastersReport(profile)) {
    throw Object.assign(new Error("Solo administradores y administradores de clientes."), { status: 403 });
  }
  return profile;
}

const SendMastersReportSchema = z.object({
  to: z.string().optional(),
  recipients: z.string().optional(),
});

async function queryOptionalContainer<T>(name: "licenseModules" | "licenseAssignments", query: string): Promise<T[]> {
  try {
    const { resources } = await getContainer(name).items.query<T>({ query }).fetchAll();
    return resources;
  } catch (e: any) {
    const code = e?.code ?? e?.statusCode;
    if (code === 404) return [];
    throw e;
  }
}

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

      const [{ resources: clients }, { resources: domains }, { resources: databases }, { resources: schedules }, licenseModules, licenseAssignments] = await Promise.all([
        getContainer("clients").items.query<ClientRecord>({ query: "SELECT * FROM c WHERE c.status = 'active'" }).fetchAll(),
        getContainer("domains").items.query<DomainRecord>({ query: "SELECT * FROM c WHERE c.status = 'active'" }).fetchAll(),
        getContainer("databases").items.query<DatabaseRecord>({ query: "SELECT * FROM c WHERE c.status = 'active'" }).fetchAll(),
        getContainer("updateSchedules").items.query<UpdateSchedule>({ query: "SELECT * FROM c WHERE c.active = true" }).fetchAll(),
        queryOptionalContainer<LicenseModuleRecord>("licenseModules", "SELECT * FROM c"),
        queryOptionalContainer<LicenseAssignmentRecord>("licenseAssignments", "SELECT * FROM c"),
      ]);

      const settings = await (await import("../lib/settingsService")).loadEmailAlertsSettings();
      const email = buildMastersReportEmail({
        clients,
        domains,
        databases,
        schedules,
        licenseModules,
        licenseAssignments,
        generatedAt: new Date(),
        frontendBaseUrl: settings.frontendBaseUrl || process.env.FRONTEND_BASE_URL,
        timezone: process.env.APP_TIMEZONE || "America/Bogota",
      });
      const result = await sendEmail({ to: recipients, ...email });

      await writeAuditLog({
        entityType: "report",
        entityId: "masters",
        action: result.ok ? "masters_report_email_sent" : "masters_report_email_failed",
        performedBy: user.id,
        performedByEmail: user.email,
        metadata: { recipientsCount: recipients.length, provider: result.provider, error: result.ok ? undefined : result.error },
      });

      if (!result.ok) return ok({ ok: false, sent: false, recipientsCount: recipients.length, message: "No se pudo enviar el reporte.", details: result.error });
      return ok({ ok: true, sent: true, recipientsCount: recipients.length, message: "Reporte enviado correctamente." });
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
