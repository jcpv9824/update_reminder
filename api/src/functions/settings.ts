import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { hasRole } from "../lib/permissions";
import { writeAuditLog } from "../lib/audit";
import { loadEmailAlertsSettings, sanitizeForResponse, saveEmailAlertsSettings } from "../lib/settingsService";
import { buildTestEmail, sendEmail } from "../lib/emailService";
import { badRequest, forbidden, ok, serverError } from "../lib/http";

async function getAdmin(req: HttpRequest) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  if (!hasRole(profile, "admin")) throw Object.assign(new Error("Solo administradores."), { status: 403 });
  return profile;
}

const SettingsSchema = z.object({
  emailProvider: z.enum(["mock", "smtp", "sendgrid", "acs"]).optional(),
  emailFrom: z.string().email().optional(),
  emailFromName: z.string().optional(),
  frontendBaseUrl: z.string().optional(),
  smtpHost: z.string().optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpSecure: z.boolean().optional(),
  smtpUser: z.string().optional(),
  smtpPassword: z.string().optional(),
  remindersEnabled: z.boolean().optional(),
  defaultReminderDaysBefore: z.array(z.number().int().min(0)).optional(),
  defaultReminderTime: z.string().optional(),
  defaultTimezone: z.string().optional(),
  overdueAlertsEnabled: z.boolean().optional(),
  overdueAlertTime: z.string().optional(),
  overdueAlertTimezone: z.string().optional(),
  overdueAlertRecipientsMode: z.enum(["admins", "adminsAndClientManagers", "customEmails"]).optional(),
  customAdminAlertEmails: z.array(z.string().email()).optional(),
  overdueAlertRecipientRoleIds: z.array(z.string()).optional(),
  overdueAlertCustomEmails: z.array(z.string().email()).optional(),
  overdueAlertFrequency: z.enum(["daily", "weekly"]).optional(),
  overdueAlertWeekdays: z.array(z.enum(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"])).optional(),
  blockedAlertsEnabled: z.boolean().optional(),
  blockedAlertRecipientRoleIds: z.array(z.string()).optional(),
  blockedAlertCustomEmails: z.array(z.string().email()).optional(),
  blockedAlertSendImmediately: z.boolean().optional(),
  blockedAlertIncludeInOverdueSummary: z.boolean().optional(),
  administrativeReminders: z.object({
    sagWebVersionReminder: z.object({
      enabled: z.boolean(),
      recipients: z.array(z.string().email()),
      dayOfMonth: z.number().int().min(1).max(28),
      time: z.string(),
      timezone: z.string(),
      subject: z.string().min(1),
    }),
    whatsNewReminder: z.object({
      enabled: z.boolean(),
      recipients: z.array(z.string().email()),
      dayOfMonth: z.number().int().min(1).max(28),
      time: z.string(),
      timezone: z.string(),
      subject: z.string().min(1),
    }),
  }).optional(),
  passwordNotificationEnabled: z.boolean().optional(),
  sendTemporaryPasswordByEmail: z.boolean().optional(),
});

app.http("settingsEmailAlertsGet", {
  route: "settings/email-alerts",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      await getAdmin(req);
      const s = await loadEmailAlertsSettings();
      return ok(sanitizeForResponse(s));
    } catch (e) { return serverError(e); }
  },
});

app.http("settingsEmailAlertsUpdate", {
  route: "settings/email-alerts",
  methods: ["PUT"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const admin = await getAdmin(req);
      const body = await req.json();
      const parsed = SettingsSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const passwordChanged = typeof parsed.data.smtpPassword === "string" && parsed.data.smtpPassword.length > 0;
      const next = await saveEmailAlertsSettings({ patch: parsed.data, performedBy: admin.id });
      // Auditar sin incluir la contraseña SMTP. El sanitizador de audit ya
      // omite "password"; aquí enviamos solo claves seguras.
      await writeAuditLog({
        entityType: "settings",
        entityId: "email-alerts",
        action: passwordChanged ? "smtp_password_updated" : "email_alert_settings_updated",
        performedBy: admin.id,
        performedByEmail: admin.email,
        after: sanitizeForResponse(next),
      });
      return ok(sanitizeForResponse(next));
    } catch (e) { return serverError(e); }
  },
});

const TestSchema = z.object({ to: z.string().email("Correo destinatario no válido.") });

app.http("settingsEmailAlertsTestEmail", {
  route: "settings/email-alerts/test-email",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const admin = await getAdmin(req);
      const body = await req.json();
      const parsed = TestSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const settings = await loadEmailAlertsSettings();
      const email = buildTestEmail({
        recipientName: admin.displayName,
        frontendBaseUrl: settings.frontendBaseUrl || process.env.FRONTEND_BASE_URL,
        provider: settings.emailProvider || process.env.EMAIL_PROVIDER,
        emailFrom: settings.emailFrom,
        sentAt: new Date(),
        timezone: process.env.APP_TIMEZONE || "America/Bogota",
      });
      const r = await sendEmail({
        to: parsed.data.to,
        subject: email.subject,
        text: email.text,
        html: email.html,
      }, settings);
      await writeAuditLog({
        entityType: "settings",
        entityId: "email-alerts",
        action: r.ok ? "test_email_sent" : "test_email_failed",
        performedBy: admin.id,
        performedByEmail: admin.email,
        metadata: { to: parsed.data.to, provider: r.provider, error: r.ok ? undefined : r.error },
      });
      if (r.ok) return ok({ ok: true, message: "Correo de prueba enviado correctamente." });
      return ok({ ok: false, message: "No se pudo enviar el correo de prueba.", details: r.error });
    } catch (e) { return serverError(e); }
  },
});
