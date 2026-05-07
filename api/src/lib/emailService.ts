// Servicio de envío de correos. Soporta los modos:
//   mock     - solo registra en consola (desarrollo y pruebas).
//   smtp     - usa nodemailer con la configuración guardada (KeyVault para password).
//   sendgrid - usa @sendgrid/mail.
//   acs      - placeholder, no implementado.
import { loadEmailAlertsSettings, getSmtpPassword } from "./settingsService";
import type { EmailAlertsSettings } from "../types/models";
import {
  buildDatabaseReminderEmail,
  buildDomainReminderEmail,
  buildOverdueTasksEmail,
  buildTestEmail,
} from "./emailTemplates";

export type EmailMessage = {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
};

export type EmailResult = { ok: boolean; provider: string; error?: string; messageId?: string };

async function sendViaMock(msg: EmailMessage, s: EmailAlertsSettings): Promise<EmailResult> {
  const recipients = Array.isArray(msg.to) ? msg.to : [msg.to];
  console.log(`[email:mock] de ${s.emailFromName} <${s.emailFrom}> a ${recipients.join(", ")}: ${msg.subject}`);
  return { ok: true, provider: "mock", messageId: `mock-${Date.now()}` };
}

async function sendViaSmtp(msg: EmailMessage, s: EmailAlertsSettings): Promise<EmailResult> {
  if (!s.smtpHost || !s.smtpPort || !s.smtpUser) {
    return { ok: false, provider: "smtp", error: "Configuración SMTP incompleta (host, puerto o usuario)." };
  }
  const password = await getSmtpPassword(s);
  if (!password) {
    return { ok: false, provider: "smtp", error: "Contraseña SMTP no configurada." };
  }
  try {
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      host: s.smtpHost,
      port: s.smtpPort,
      secure: !!s.smtpSecure,
      auth: { user: s.smtpUser, pass: password },
    });
    const info = await transporter.sendMail({
      from: { name: s.emailFromName, address: s.emailFrom },
      to: msg.to,
      subject: msg.subject,
      text: msg.text ?? msg.subject,
      html: msg.html ?? `<p>${msg.text ?? msg.subject}</p>`,
    });
    return { ok: true, provider: "smtp", messageId: info.messageId };
  } catch (e: any) {
    // Mensaje seguro: no incluye credenciales.
    return { ok: false, provider: "smtp", error: e?.message ?? "Error SMTP" };
  }
}

async function sendViaSendgrid(msg: EmailMessage, s: EmailAlertsSettings): Promise<EmailResult> {
  const key = process.env.SENDGRID_API_KEY;
  if (!key) return { ok: false, provider: "sendgrid", error: "SENDGRID_API_KEY no configurado." };
  try {
    const sg = (await import("@sendgrid/mail")).default;
    sg.setApiKey(key);
    const recipients = Array.isArray(msg.to) ? msg.to : [msg.to];
    const [r] = await sg.send({
      to: recipients,
      from: { email: s.emailFrom, name: s.emailFromName },
      subject: msg.subject,
      text: msg.text ?? msg.subject,
      html: msg.html ?? `<p>${msg.text ?? msg.subject}</p>`,
    });
    return { ok: true, provider: "sendgrid", messageId: (r.headers as any)?.["x-message-id"] };
  } catch (e: any) {
    return { ok: false, provider: "sendgrid", error: e?.message ?? "Error SendGrid" };
  }
}

export async function sendEmail(msg: EmailMessage, settings?: EmailAlertsSettings): Promise<EmailResult> {
  const recipients = Array.isArray(msg.to) ? msg.to : [msg.to];
  if (!recipients || recipients.length === 0) return { ok: false, provider: "n/a", error: "Sin destinatarios." };
  const s = settings ?? (await loadEmailAlertsSettings());
  switch (s.emailProvider) {
    case "smtp": return sendViaSmtp(msg, s);
    case "sendgrid": return sendViaSendgrid(msg, s);
    case "acs": return { ok: false, provider: "acs", error: "Proveedor ACS no implementado." };
    case "mock":
    default:
      return sendViaMock(msg, s);
  }
}

// Plantillas en español ----------------------------------------------------

export function renderTaskReminderEmail(args: {
  clientName: string;
  domainName: string;
  targetType: "domain" | "database";
  targetName: string;
  taskDate: string;
  daysBefore: number;
  appUrl?: string;
}): { subject: string; html: string; text: string } {
  if (args.targetType === "domain") {
    return buildDomainReminderEmail({
      tasks: [{
        clientName: args.clientName,
        domainName: args.domainName || args.targetName,
        scheduledFor: args.taskDate,
        status: "pendiente",
      }],
      frontendBaseUrl: args.appUrl,
    });
  }
  return buildDatabaseReminderEmail({
    tasks: [{
      clientName: args.clientName,
      domainName: args.domainName,
      databaseName: args.targetName,
      scheduledFor: args.taskDate,
      status: "pendiente",
    }],
    frontendBaseUrl: args.appUrl,
  });
}

export function renderOverdueAlertEmail(args: {
  domainTasks: Array<{ clientName: string; domainName: string; taskDate: string; status: string; assigned: string }>;
  databaseTasks: Array<{ clientName: string; domainName: string; targetName: string; taskDate: string; status: string; assigned: string }>;
  appUrl?: string;
}): { subject: string; html: string; text: string } {
  return buildOverdueTasksEmail({
    overdueDomainTasks: args.domainTasks.map((t) => ({
        clientName: t.clientName,
        domainName: t.domainName,
        dueAt: t.taskDate,
        status: t.status,
        assignedToName: t.assigned,
      })),
    overdueDatabaseTasks: args.databaseTasks.map((t) => ({
        clientName: t.clientName,
        domainName: t.domainName,
        databaseName: t.targetName,
        dueAt: t.taskDate,
        status: t.status,
        assignedToName: t.assigned,
      })),
    frontendBaseUrl: args.appUrl,
  });
}

export { buildDatabaseReminderEmail, buildDomainReminderEmail, buildOverdueTasksEmail, buildTestEmail };

export function renderUserPasswordEmail(args: {
  displayName: string;
  email: string;
  temporaryPassword?: string;
  isReset: boolean;
  appUrl?: string;
}): { subject: string; html: string; text: string } {
  const subject = args.isReset
    ? "Tu contraseña fue restablecida"
    : "Bienvenido al Programador de Actualizaciones";
  const enlace = args.appUrl ? `<p><a href="${args.appUrl}">Iniciar sesión</a></p>` : "";
  const incluyePwd = !!args.temporaryPassword;
  const detallePwd = incluyePwd
    ? `<p>Tu contraseña temporal es: <code>${args.temporaryPassword}</code></p><p>Te recomendamos cambiarla al iniciar sesión.</p>`
    : `<p>Solicita tu contraseña al administrador o usa la opción de inicio de sesión.</p>`;
  const html = `
    <h3>${subject}</h3>
    <p>Hola ${args.displayName},</p>
    ${args.isReset ? "<p>Un administrador ha restablecido tu contraseña.</p>" : "<p>Tu cuenta ha sido creada.</p>"}
    <p>Tu correo de acceso es: <strong>${args.email}</strong></p>
    ${detallePwd}
    ${enlace}
  `;
  const text = `${subject}. Correo: ${args.email}.${incluyePwd ? " Tu contraseña temporal fue enviada en este correo." : " Solicita tu contraseña al administrador."}`;
  return { subject, html, text };
}
