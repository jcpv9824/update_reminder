// Servicio de envío de correos. Soporta los modos:
//   mock     - solo registra en consola (desarrollo y pruebas).
//   smtp     - usa nodemailer con la configuración guardada (KeyVault para password).
//   sendgrid - usa @sendgrid/mail.
//   acs      - placeholder, no implementado.
import { loadEmailAlertsSettings, getSmtpPassword } from "./settingsService";
import type { EmailAlertsSettings } from "../types/models";

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
  const cuando = args.daysBefore === 0 ? "hoy" : args.daysBefore === 1 ? "mañana" : `en ${args.daysBefore} días`;
  const tipo = args.targetType === "domain" ? "dominio" : "base de datos";
  const subject = `Recordatorio: actualización ${cuando} — ${args.clientName}`;
  const enlace = args.appUrl ? `<p><a href="${args.appUrl}">Abrir el Programador de Actualizaciones</a></p>` : "";
  const text = `Tienes una actualización programada ${cuando} (${args.taskDate}) del ${tipo} ${args.targetName} del cliente ${args.clientName} (dominio ${args.domainName}).`;
  const html = `
    <h3>Recordatorio de actualización</h3>
    <p>Tienes una actualización programada <strong>${cuando}</strong> (${args.taskDate}).</p>
    <ul>
      <li><strong>Cliente:</strong> ${args.clientName}</li>
      <li><strong>Dominio:</strong> ${args.domainName}</li>
      <li><strong>${args.targetType === "domain" ? "Dominio" : "Base de datos"}:</strong> ${args.targetName}</li>
    </ul>
    ${enlace}
  `;
  return { subject, html, text };
}

export function renderOverdueAlertEmail(args: {
  domainTasks: Array<{ clientName: string; domainName: string; taskDate: string; status: string; assigned: string }>;
  databaseTasks: Array<{ clientName: string; domainName: string; targetName: string; taskDate: string; status: string; assigned: string }>;
  appUrl?: string;
}): { subject: string; html: string; text: string } {
  const subject = `Alerta: actualizaciones vencidas (${args.domainTasks.length} dominios, ${args.databaseTasks.length} bases de datos)`;
  function tabla(filas: string[], encabezado: string): string {
    if (filas.length === 0) return "";
    return `<h4>${encabezado}</h4><table border="1" cellpadding="6" cellspacing="0">${filas.join("")}</table>`;
  }
  const filasD = args.domainTasks.map((t) =>
    `<tr><td>${t.clientName}</td><td>${t.domainName}</td><td>${t.taskDate}</td><td>${t.status}</td><td>${t.assigned}</td></tr>`
  );
  const filasB = args.databaseTasks.map((t) =>
    `<tr><td>${t.clientName}</td><td>${t.domainName}</td><td>${t.targetName}</td><td>${t.taskDate}</td><td>${t.status}</td><td>${t.assigned}</td></tr>`
  );
  const cabD = `<tr><th>Cliente</th><th>Dominio</th><th>Fecha</th><th>Estado</th><th>Responsable</th></tr>`;
  const cabB = `<tr><th>Cliente</th><th>Dominio</th><th>Empresa/BD</th><th>Fecha</th><th>Estado</th><th>Responsable</th></tr>`;
  const enlace = args.appUrl ? `<p><a href="${args.appUrl}">Abrir el Programador de Actualizaciones</a></p>` : "";
  const html = `
    <h3>Actualizaciones vencidas</h3>
    <ul>
      <li>Dominios vencidos: <strong>${args.domainTasks.length}</strong></li>
      <li>Bases de datos vencidas: <strong>${args.databaseTasks.length}</strong></li>
    </ul>
    ${tabla([cabD, ...filasD], "Dominios")}
    ${tabla([cabB, ...filasB], "Bases de datos")}
    ${enlace}
  `;
  const text = `Resumen de vencidos: ${args.domainTasks.length} dominios, ${args.databaseTasks.length} bases de datos.`;
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
