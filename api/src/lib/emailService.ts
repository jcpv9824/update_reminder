// Servicio de envío de correos. Soporta los modos:
//   mock     - solo registra en consola (desarrollo y pruebas).
//   smtp     - usa nodemailer con la configuración guardada (KeyVault para password).
//   sendgrid - usa @sendgrid/mail.
//   acs      - placeholder, no implementado.
import { loadEmailAlertsSettings, getSmtpPassword } from "./settingsService";
import { connect, type Socket } from "node:net";
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

export type EmailResult = { ok: boolean; provider: string; error?: string; messageId?: string; leaseLost?: boolean };
type BeforeEmailSend = () => Promise<boolean>;
const deliveryTimeoutMs = 60_000;
const lostLease = (): EmailResult => ({ ok: false, provider: "outbox", leaseLost: true,
  error: "La concesión de la notificación ya no está vigente." });
async function mayStartSend(beforeSend?: BeforeEmailSend): Promise<boolean> {
  try { return beforeSend ? await beforeSend() : true; } catch { return false; }
}

async function sendViaMock(msg: EmailMessage, s: EmailAlertsSettings, beforeSend?: BeforeEmailSend): Promise<EmailResult> {
  if (!await mayStartSend(beforeSend)) return lostLease();
  const recipients = Array.isArray(msg.to) ? msg.to : [msg.to];
  console.log(`[email:mock] de ${s.emailFromName} <${s.emailFrom}> a ${recipients.join(", ")}: ${msg.subject}`);
  return { ok: true, provider: "mock", messageId: `mock-${Date.now()}` };
}

async function sendViaSmtp(msg: EmailMessage, s: EmailAlertsSettings, beforeSend?: BeforeEmailSend): Promise<EmailResult> {
  if (!s.smtpHost || !s.smtpPort || !s.smtpUser) {
    return { ok: false, provider: "smtp", error: "Configuración SMTP incompleta (host, puerto o usuario)." };
  }
  const password = await getSmtpPassword(s);
  if (!password) {
    return { ok: false, provider: "smtp", error: "Contraseña SMTP no configurada." };
  }
  let socket: Socket | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const nodemailer = await import("nodemailer");
    const controller = new AbortController();
    const transporter = nodemailer.createTransport({
      host: s.smtpHost,
      port: s.smtpPort,
      secure: !!s.smtpSecure,
      auth: { user: s.smtpUser, pass: password },
      connectionTimeout: deliveryTimeoutMs,
      greetingTimeout: deliveryTimeoutMs,
      socketTimeout: deliveryTimeoutMs,
      // Own the raw socket so an absolute deadline cancels actual I/O, including
      // a socket subsequently wrapped by Nodemailer's STARTTLS/implicit TLS.
      // Nodemailer still performs TLS with the original hostname and defaults.
      getSocket: (_options, callback) => {
        socket = connect({ host: s.smtpHost!, port: s.smtpPort!, signal: controller.signal });
        const onError = (error: Error) => callback(error, false);
        socket.once("error", onError);
        socket.once("connect", () => {
          socket!.removeListener("error", onError);
          callback(null, { connection: socket });
        });
      },
    });
    if (!await mayStartSend(beforeSend)) return lostLease();
    deadline = setTimeout(() => controller.abort(), deliveryTimeoutMs);
    const info = await transporter.sendMail({
      from: { name: s.emailFromName, address: s.emailFrom },
      to: msg.to,
      subject: msg.subject,
      text: msg.text ?? msg.subject,
      html: msg.html ?? `<p>${msg.text ?? msg.subject}</p>`,
    });
    return { ok: true, provider: "smtp", messageId: info.messageId };
  } catch {
    return { ok: false, provider: "smtp", error: "No se pudo confirmar el envío SMTP." };
  } finally {
    clearTimeout(deadline);
    socket?.destroy();
  }
}

async function sendViaSendgrid(msg: EmailMessage, s: EmailAlertsSettings, beforeSend?: BeforeEmailSend): Promise<EmailResult> {
  const key = process.env.SENDGRID_API_KEY;
  if (!key) return { ok: false, provider: "sendgrid", error: "SENDGRID_API_KEY no configurado." };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const [mailModule, clientModule] = await Promise.all([import("@sendgrid/mail"), import("@sendgrid/client")]);
    // The SDK exposes these constructors on its CommonJS root exports, but
    // its export= declarations omit their properties on the default value.
    const { MailService } = mailModule.default as typeof mailModule.default & { MailService: new () => typeof mailModule.default };
    const { Client } = clientModule.default as typeof clientModule.default & { Client: new () => typeof clientModule.default };
    const sg = new MailService();
    const client = new Client();
    const controller = new AbortController();
    // Client forwards default request options to Axios. A per-send instance
    // prevents one worker's abort signal from cancelling another's request.
    client.setDefaultRequest({ signal: controller.signal, timeout: deliveryTimeoutMs } as unknown as Parameters<typeof client.setDefaultRequest>[0]);
    sg.setClient(client);
    sg.setApiKey(key);
    const recipients = Array.isArray(msg.to) ? msg.to : [msg.to];
    if (!await mayStartSend(beforeSend)) return lostLease();
    deadline = setTimeout(() => controller.abort(), deliveryTimeoutMs);
    const [r] = await sg.send({
      to: recipients,
      from: { email: s.emailFrom, name: s.emailFromName },
      subject: msg.subject,
      text: msg.text ?? msg.subject,
      html: msg.html ?? `<p>${msg.text ?? msg.subject}</p>`,
    });
    return { ok: true, provider: "sendgrid", messageId: (r.headers as any)?.["x-message-id"] };
  } catch {
    return { ok: false, provider: "sendgrid", error: "No se pudo confirmar el envío SendGrid." };
  } finally {
    clearTimeout(deadline);
  }
}

export async function sendEmail(
  msg: EmailMessage,
  settings?: EmailAlertsSettings,
  options: { outboxClaimed?: boolean; beforeSend?: BeforeEmailSend } = {},
): Promise<EmailResult> {
  if (!options.outboxClaimed) {
    throw Object.assign(new Error("El envío directo de correo no está permitido; use la bandeja de salida SQL."), { status: 503 });
  }
  const recipients = Array.isArray(msg.to) ? msg.to : [msg.to];
  if (!recipients || recipients.length === 0) return { ok: false, provider: "n/a", error: "Sin destinatarios." };
  const s = settings ?? (await loadEmailAlertsSettings());
  switch (s.emailProvider) {
    case "smtp": return sendViaSmtp(msg, s, options.beforeSend);
    case "sendgrid": return sendViaSendgrid(msg, s, options.beforeSend);
    case "acs": return { ok: false, provider: "acs", error: "Proveedor ACS no implementado." };
    case "mock":
    default:
      return sendViaMock(msg, s, options.beforeSend);
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

// Reexporta el helper para usarlo en plantillas y otros módulos.
export { formatDomainForPublishing } from "./domainFormat";
import { formatDomainForPublishing as _formatDomainForPublishing } from "./domainFormat";

// Escapa HTML para evitar inyección en plantillas.
export function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderResetPasswordEmail(args: {
  displayName: string;
  email: string;
  resetUrl: string;
  expiresInMinutes: number;
}): { subject: string; html: string; text: string } {
  const subject = "Restablecer contraseña — Portal SAG Web";
  const nombre = escapeHtml(args.displayName);
  const correo = escapeHtml(args.email);
  // El URL puede contener el token — no se loguea, solo se envía al destinatario.
  const url = args.resetUrl;
  const html = `
    <h3>${subject}</h3>
    <p>Hola ${nombre},</p>
    <p>Recibimos una solicitud para restablecer la contraseña de la cuenta <strong>${correo}</strong>.</p>
    <p><a href="${url}" style="display:inline-block;padding:10px 16px;background:#1C3664;color:white;border-radius:6px;text-decoration:none;">Restablecer contraseña</a></p>
    <p>Este enlace vence en ${args.expiresInMinutes} minutos.</p>
    <p>Si no solicitaste este cambio, puedes ignorar este mensaje.</p>
  `;
  const text = `${subject}\nAbre el siguiente enlace para restablecer tu contraseña: ${url}\nEste enlace vence en ${args.expiresInMinutes} minutos. Si no solicitaste este cambio, ignora este mensaje.`;
  return { subject, html, text };
}

export function renderUserPasswordEmail(args: {
  displayName: string;
  email: string;
  temporaryPassword?: string;
  isReset: boolean;
  appUrl?: string;
}): { subject: string; html: string; text: string } {
  const subject = args.isReset
    ? "Tu contraseña fue restablecida"
    : "Bienvenido a Portal SAG Web";
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
