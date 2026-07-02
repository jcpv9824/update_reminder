import { formatDomainForPublishing } from "./domainFormat";

export type EmailBuildResult = {
  subject: string;
  html: string;
  text: string;
};

export type DomainTaskEmailItem = {
  id?: string;
  clientName: string;
  domainName: string;
  scheduledFor?: string | Date;
  dueAt?: string | Date;
  status?: string;
  assignedToName?: string;
  assignedToEmail?: string;
  notes?: string;
};

export type DatabaseTaskEmailItem = {
  id?: string;
  clientName: string;
  domainName?: string;
  databaseName: string;
  companyName?: string;
  scheduledFor?: string | Date;
  dueAt?: string | Date;
  status?: string;
  assignedToName?: string;
  assignedToEmail?: string;
  notes?: string;
};

export type MasterReportDatabase = {
  name: string;
  companyName?: string;
  status?: string;
  environment?: string;
  createdAt?: string | Date;
  lastUpdatedAt?: string | Date;
};

export type MasterReportDomain = {
  name: string;
  url?: string;
  publishableDomain?: string;
  environment?: string;
  status?: string;
  frequencyName?: string;
  databases?: MasterReportDatabase[];
};

export type MasterReportLicense = {
  name: string;
  code?: string;
};

export type MasterReportClient = {
  name: string;
  status?: string;
  createdAt?: string | Date;
  licenses?: MasterReportLicense[];
  domains?: MasterReportDomain[];
};

const COLORS = {
  primary: "#1C3664",
  secondary: "#7E99B2",
  neutral: "#D1D3D2",
  accent: "#D3C193",
  background: "#F4F7FA",
  text: "#172A45",
  muted: "#607086",
  danger: "#A94036",
  success: "#2F7D5B",
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function normalizeBaseUrl(frontendBaseUrl?: string): string {
  return (frontendBaseUrl || "https://agreeable-wave-07469d50f.7.azurestaticapps.net").replace(/\/+$/, "");
}

function parseDate(value?: string | Date): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function hasTime(value?: string | Date): boolean {
  if (!value) return false;
  if (value instanceof Date) return true;
  return /T\d{2}:\d{2}/.test(value);
}

export function formatDate(value?: string | Date, locale = "es-CO", timezone = "America/Bogota"): string {
  const date = parseDate(value);
  if (!date) return "Sin fecha programada";
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    year: "numeric",
    month: "long",
    day: "2-digit",
    ...(hasTime(value) ? { hour: "numeric", minute: "2-digit" } : {}),
  }).format(date);
}

function daysLate(value?: string | Date, now = new Date()): number | null {
  const date = parseDate(value);
  if (!date) return null;
  const scheduled = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const diff = Math.floor((today - scheduled) / 86_400_000);
  return diff > 0 ? diff : null;
}

function sameScheduledDay(tasks: Array<{ scheduledFor?: string | Date }>, timezone: string): string | null {
  if (tasks.length === 0) return null;
  const dates = tasks.map((t) => parseDate(t.scheduledFor)?.toISOString().slice(0, 10)).filter(Boolean);
  if (dates.length !== tasks.length) return null;
  return new Set(dates).size === 1 ? formatDate(tasks[0].scheduledFor, "es-CO", timezone) : null;
}

function button(label: string, href: string): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0 2px;">
      <tr><td style="background:${COLORS.primary}; border-radius:6px;">
        <a href="${escapeHtml(href)}" style="display:inline-block; padding:11px 18px; color:#ffffff; text-decoration:none; font-family:Arial, sans-serif; font-weight:700;">${escapeHtml(label)}</a>
      </td></tr>
    </table>`;
}

function metric(label: string, value: string | number, color = COLORS.primary): string {
  return `
    <td style="padding:0 8px 8px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${COLORS.neutral}; background:#ffffff; border-radius:8px;">
        <tr><td style="padding:12px;">
          <div style="font-size:22px; line-height:26px; color:${color}; font-weight:700;">${escapeHtml(value)}</div>
          <div style="font-size:12px; line-height:16px; color:${COLORS.muted};">${escapeHtml(label)}</div>
        </td></tr>
      </table>
    </td>`;
}

function layout(args: {
  title: string;
  intro: string;
  preheader: string;
  body: string;
  cta?: string;
  ctaHref?: string;
  alert?: boolean;
  footerNote?: string;
}): string {
  const headerColor = args.alert ? COLORS.danger : COLORS.primary;
  return `<!doctype html>
<html>
  <body style="margin:0; padding:0; background:${COLORS.background}; font-family:Arial, Helvetica, sans-serif; color:${COLORS.text};">
    <div style="display:none; overflow:hidden; line-height:1px; opacity:0; max-height:0; max-width:0;">${escapeHtml(args.preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.background}; padding:24px 0;">
      <tr><td align="center" style="padding:0 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:700px; background:#ffffff; border:1px solid ${COLORS.neutral}; border-radius:10px; overflow:hidden;">
          <tr><td style="background:${headerColor}; padding:22px 26px; border-bottom:4px solid ${COLORS.accent};">
            <div style="font-size:13px; color:#ffffff; font-weight:700;">Programador de Actualizaciones ERP</div>
            <h1 style="margin:6px 0 0; color:#ffffff; font-size:23px; line-height:30px;">${escapeHtml(args.title)}</h1>
          </td></tr>
          <tr><td style="padding:24px 26px;">
            <p style="margin:0 0 18px; font-size:15px; line-height:23px;">${escapeHtml(args.intro)}</p>
            ${args.body}
            ${args.cta && args.ctaHref ? button(args.cta, args.ctaHref) : ""}
          </td></tr>
          <tr><td style="background:#f8fafc; padding:16px 26px; border-top:1px solid ${COLORS.neutral}; font-size:12px; line-height:18px; color:${COLORS.muted};">
            ${escapeHtml(args.footerNote || "Correo generado automaticamente por el Programador de Actualizaciones ERP. No incluye credenciales ni valores sensibles.")}
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function taskTable(headers: string[], rows: string[][]): string {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:13px; margin:0 0 14px;">
      <tr>${headers.map((h) => `<th align="left" style="padding:8px; background:#eef3f8; color:${COLORS.primary}; border:1px solid ${COLORS.neutral};">${escapeHtml(h)}</th>`).join("")}</tr>
      ${rows.map((row) => `<tr>${row.map((cell) => `<td style="padding:8px; border:1px solid ${COLORS.neutral}; vertical-align:top;">${cell}</td>`).join("")}</tr>`).join("")}
    </table>`;
}

function domainRows(tasks: DomainTaskEmailItem[], timezone: string, overdue = false): string[][] {
  return tasks.map((t) => [
    escapeHtml(t.clientName),
    escapeHtml(t.domainName),
    // Dominio para publicar: lo importante para el actualizador (sin protocolo, sin puerto, sin path).
    `<strong>${escapeHtml(formatDomainForPublishing(t.domainName))}</strong>`,
    escapeHtml(formatDate(t.dueAt ?? t.scheduledFor, "es-CO", timezone)),
    overdue ? escapeHtml(daysLate(t.dueAt ?? t.scheduledFor)?.toString() ?? "-") : escapeHtml(hasTime(t.scheduledFor) ? formatDate(t.scheduledFor, "es-CO", timezone).split(",").slice(-1)[0]?.trim() || "-" : "Sin hora definida"),
    escapeHtml(t.status || "-"),
    escapeHtml(t.notes || "-"),
  ]);
}

function databaseRows(tasks: DatabaseTaskEmailItem[], timezone: string, overdue = false): string[][] {
  return tasks.map((t) => [
    escapeHtml(t.clientName),
    escapeHtml(t.domainName || "-"),
    `<strong>${escapeHtml(formatDomainForPublishing(t.domainName))}</strong>`,
    escapeHtml(t.databaseName || t.companyName || "-"),
    escapeHtml(formatDate(t.dueAt ?? t.scheduledFor, "es-CO", timezone)),
    overdue ? escapeHtml(daysLate(t.dueAt ?? t.scheduledFor)?.toString() ?? "-") : escapeHtml(hasTime(t.scheduledFor) ? formatDate(t.scheduledFor, "es-CO", timezone).split(",").slice(-1)[0]?.trim() || "-" : "Sin hora definida"),
    escapeHtml(t.status || "-"),
    escapeHtml(t.notes || "-"),
  ]);
}

function textDomainTasks(tasks: DomainTaskEmailItem[], timezone: string, overdue = false): string {
  return tasks.map((t, i) => [
    `${i + 1}. Cliente: ${t.clientName}`,
    `Dominio registrado: ${t.domainName}`,
    `Dominio para publicar: ${formatDomainForPublishing(t.domainName)}`,
    `${overdue ? "Fecha programada original" : "Fecha programada"}: ${formatDate(t.dueAt ?? t.scheduledFor, "es-CO", timezone)}`,
    overdue ? `Días de atraso: ${daysLate(t.dueAt ?? t.scheduledFor) ?? "-"}` : `Hora: ${hasTime(t.scheduledFor) ? formatDate(t.scheduledFor, "es-CO", timezone).split(",").slice(-1)[0]?.trim() : "Sin hora definida"}`,
    `Estado: ${t.status || "-"}`,
    `Observaciones: ${t.notes || "-"}`,
  ].join("\n")).join("\n\n");
}

function textDatabaseTasks(tasks: DatabaseTaskEmailItem[], timezone: string, overdue = false): string {
  return tasks.map((t, i) => [
    `${i + 1}. Cliente: ${t.clientName}`,
    `Dominio asociado: ${t.domainName || "-"}`,
    `Dominio para publicar: ${formatDomainForPublishing(t.domainName)}`,
    `Empresa / base: ${t.databaseName || t.companyName || "-"}`,
    `${overdue ? "Fecha programada original" : "Fecha programada"}: ${formatDate(t.dueAt ?? t.scheduledFor, "es-CO", timezone)}`,
    overdue ? `Días de atraso: ${daysLate(t.dueAt ?? t.scheduledFor) ?? "-"}` : `Hora: ${hasTime(t.scheduledFor) ? formatDate(t.scheduledFor, "es-CO", timezone).split(",").slice(-1)[0]?.trim() : "Sin hora definida"}`,
    `Estado: ${t.status || "-"}`,
    `Observaciones: ${t.notes || "-"}`,
  ].join("\n")).join("\n\n");
}

export function buildDomainReminderEmail(input: {
  recipientName?: string;
  tasks: DomainTaskEmailItem[];
  frontendBaseUrl?: string;
  timezone?: string;
}): EmailBuildResult {
  const timezone = input.timezone || "America/Bogota";
  const baseUrl = normalizeBaseUrl(input.frontendBaseUrl);
  const sameDay = sameScheduledDay(input.tasks, timezone);
  const subject = sameDay ? `Dominios por actualizar — ${sameDay}` : "Dominios por actualizar — próximas actualizaciones";
  const intro = `Hola${input.recipientName ? ` ${input.recipientName}` : ""}, estos son los dominios que debes actualizar.`;
  const body = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${metric("Dominios por actualizar", input.tasks.length)}</tr></table>
    ${taskTable(["Cliente", "Dominio registrado", "Dominio para publicar", "Fecha programada", "Hora", "Estado", "Observaciones"], domainRows(input.tasks, timezone))}`;
  return {
    subject,
    html: layout({ title: "Dominios por actualizar", intro, preheader: intro, body, cta: "Abrir tareas en la aplicación", ctaHref: `${baseUrl}/tareas` }),
    text: `${subject}\n\n${intro}\n\n${textDomainTasks(input.tasks, timezone)}\n\nAbrir tareas en la aplicación: ${baseUrl}/tareas`,
  };
}

export function buildDatabaseReminderEmail(input: {
  recipientName?: string;
  tasks: DatabaseTaskEmailItem[];
  frontendBaseUrl?: string;
  timezone?: string;
}): EmailBuildResult {
  const timezone = input.timezone || "America/Bogota";
  const baseUrl = normalizeBaseUrl(input.frontendBaseUrl);
  const sameDay = sameScheduledDay(input.tasks, timezone);
  const subject = sameDay ? `Bases de datos por actualizar — ${sameDay}` : "Bases de datos por actualizar — próximas actualizaciones";
  const intro = `Hola${input.recipientName ? ` ${input.recipientName}` : ""}, estas son las empresas o bases de datos que debes actualizar.`;
  const body = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${metric("Bases / empresas por actualizar", input.tasks.length)}</tr></table>
    ${taskTable(["Cliente", "Dominio asociado", "Dominio para publicar", "Empresa / base", "Fecha programada", "Hora", "Estado", "Observaciones"], databaseRows(input.tasks, timezone))}`;
  return {
    subject,
    html: layout({ title: "Bases de datos por actualizar", intro, preheader: intro, body, cta: "Abrir tareas en la aplicación", ctaHref: `${baseUrl}/tareas` }),
    text: `${subject}\n\n${intro}\n\n${textDatabaseTasks(input.tasks, timezone)}\n\nAbrir tareas en la aplicación: ${baseUrl}/tareas`,
  };
}

export function buildOverdueTasksEmail(input: {
  recipientName?: string;
  overdueDomainTasks: DomainTaskEmailItem[];
  overdueDatabaseTasks: DatabaseTaskEmailItem[];
  frontendBaseUrl?: string;
  timezone?: string;
}): EmailBuildResult {
  const timezone = input.timezone || "America/Bogota";
  const baseUrl = normalizeBaseUrl(input.frontendBaseUrl);
  const domainCount = input.overdueDomainTasks.length;
  const databaseCount = input.overdueDatabaseTasks.length;
  const total = domainCount + databaseCount;
  const subject = domainCount > 0 && databaseCount > 0
    ? "Alerta: tienes tareas vencidas de actualización"
    : domainCount > 0
      ? "Alerta: tienes dominios vencidos por actualizar"
      : databaseCount > 0
        ? "Alerta: tienes bases de datos vencidas por actualizar"
        : "Alerta: tareas vencidas de actualización";
  const intro = `Hola${input.recipientName ? ` ${input.recipientName}` : ""}, estas tareas aparecen como vencidas y requieren atención.`;
  const domainSection = domainCount > 0
    ? `<h2 style="font-size:17px; color:${COLORS.primary}; margin:18px 0 8px;">Dominios vencidos</h2>${taskTable(["Cliente", "Dominio registrado", "Dominio para publicar", "Fecha original", "Días de atraso", "Estado", "Observaciones"], domainRows(input.overdueDomainTasks, timezone, true))}`
    : "";
  const databaseSection = databaseCount > 0
    ? `<h2 style="font-size:17px; color:${COLORS.primary}; margin:18px 0 8px;">Bases de datos / empresas vencidas</h2>${taskTable(["Cliente", "Dominio asociado", "Dominio para publicar", "Empresa / base", "Fecha original", "Días de atraso", "Estado", "Observaciones"], databaseRows(input.overdueDatabaseTasks, timezone, true))}`
    : "";
  const body = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${metric("Total vencidas", total, COLORS.danger)}
      ${metric("Dominios vencidos", domainCount, COLORS.primary)}
      ${metric("Bases / empresas vencidas", databaseCount, COLORS.secondary)}
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff7ed; border:1px solid #fed7aa; border-left:4px solid ${COLORS.danger}; border-radius:8px; margin:0 0 14px;">
      <tr><td style="padding:12px 14px; color:${COLORS.text}; font-weight:700;">Revise estas tareas para registrar avance o cierre en la aplicación.</td></tr>
    </table>
    ${domainSection}
    ${databaseSection}`;
  const textSections = [
    `Total vencidas: ${total}`,
    `Dominios vencidos: ${domainCount}`,
    `Bases / empresas vencidas: ${databaseCount}`,
    domainCount > 0 ? `\nDominios vencidos\n${textDomainTasks(input.overdueDomainTasks, timezone, true)}` : "",
    databaseCount > 0 ? `\nBases de datos / empresas vencidas\n${textDatabaseTasks(input.overdueDatabaseTasks, timezone, true)}` : "",
  ].filter(Boolean).join("\n");
  return {
    subject,
    html: layout({ title: "Tareas vencidas de actualización", intro, preheader: intro, body, cta: "Revisar tareas vencidas", ctaHref: `${baseUrl}/tareas`, alert: true }),
    text: `${subject}\n\n${intro}\n\n${textSections}\n\nRevisar tareas vencidas: ${baseUrl}/tareas`,
  };
}

export function buildTestEmail(input: {
  recipientName?: string;
  frontendBaseUrl?: string;
  provider?: string;
  emailFrom?: string;
  sentAt?: string | Date;
  timezone?: string;
}): EmailBuildResult {
  const timezone = input.timezone || "America/Bogota";
  const baseUrl = normalizeBaseUrl(input.frontendBaseUrl);
  const sentAt = formatDate(input.sentAt || new Date(), "es-CO", timezone);
  const intro = `Hola${input.recipientName ? ` ${input.recipientName}` : ""}, la configuración de correo funciona correctamente.`;
  const body = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${metric("Proveedor actual", input.provider || "mock")}
      ${metric("Correo remitente", input.emailFrom || "-")}
    </tr></table>
    <p style="margin:6px 0 0; font-size:14px; line-height:21px;">Fecha y hora de la prueba: <strong>${escapeHtml(sentAt)}</strong></p>
    <p style="margin:8px 0 0; font-size:14px; line-height:21px;">URL de la aplicación: ${escapeHtml(baseUrl)}</p>`;
  return {
    subject: "Correo de prueba — Programador de Actualizaciones ERP",
    html: layout({ title: "Correo de prueba", intro, preheader: intro, body, cta: "Abrir configuración de alertas", ctaHref: `${baseUrl}/alertas-correos` }),
    text: `${intro}\nProveedor actual: ${input.provider || "mock"}\nCorreo remitente: ${input.emailFrom || "-"}\nFecha y hora de la prueba: ${sentAt}\nURL de la aplicación: ${baseUrl}\nAbrir configuración de alertas: ${baseUrl}/alertas-correos`,
  };
}

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrador",
  client_manager: "Administrador de clientes",
  database_updater: "Actualizador de bases de datos",
  domain_updater: "Actualizador de dominios",
  viewer: "Visualizador",
};

export function roleLabels(roles: string[] = []): string {
  if (!roles.length) return "Sin rol asignado";
  return roles.map((r) => ROLE_LABELS[r] ?? r).join(", ");
}

// Bloque de credenciales reutilizable (correo de acceso, contraseña temporal,
// rol). Responsive: usa tabla con ancho 100% y estilos inline.
function credentialsBlock(args: { email: string; temporaryPassword?: string; roles: string[] }): string {
  const filas: string[] = [
    `<tr><td style="padding:8px 12px; border:1px solid ${COLORS.neutral}; background:#f8fafc; font-weight:700; width:42%;">Correo de acceso</td><td style="padding:8px 12px; border:1px solid ${COLORS.neutral}; font-family:Consolas, 'Courier New', monospace;">${escapeHtml(args.email)}</td></tr>`,
  ];
  if (args.temporaryPassword) {
    filas.push(`<tr><td style="padding:8px 12px; border:1px solid ${COLORS.neutral}; background:#f8fafc; font-weight:700;">Contraseña temporal</td><td style="padding:8px 12px; border:1px solid ${COLORS.neutral}; font-family:Consolas, 'Courier New', monospace; color:${COLORS.primary}; font-weight:700;">${escapeHtml(args.temporaryPassword)}</td></tr>`);
  }
  filas.push(`<tr><td style="padding:8px 12px; border:1px solid ${COLORS.neutral}; background:#f8fafc; font-weight:700;">Rol</td><td style="padding:8px 12px; border:1px solid ${COLORS.neutral};">${escapeHtml(roleLabels(args.roles))}</td></tr>`);
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin:6px 0 4px; font-size:14px; line-height:20px;">
      ${filas.join("")}
    </table>`;
}

// Correo de bienvenida enviado cuando se crea un usuario. Incluye sus
// credenciales (correo, contraseña temporal), su rol y el enlace de acceso.
export function buildWelcomeUserEmail(input: {
  displayName: string;
  email: string;
  temporaryPassword?: string;
  roles?: string[];
  frontendBaseUrl?: string;
}): EmailBuildResult {
  const baseUrl = normalizeBaseUrl(input.frontendBaseUrl);
  const subject = "Bienvenido al Programador de Actualizaciones ERP";
  const intro = `Hola ${input.displayName}, tu cuenta fue creada en el Programador de Actualizaciones ERP. A continuación encontrarás tus datos de acceso.`;
  const nota = input.temporaryPassword
    ? `<p style="margin:10px 0 0; font-size:13px; line-height:19px; color:${COLORS.muted};">Por seguridad, te recomendamos cambiar tu contraseña después de iniciar sesión por primera vez.</p>`
    : `<p style="margin:10px 0 0; font-size:13px; line-height:19px; color:${COLORS.muted};">Solicita tu contraseña al administrador o usa la opción de inicio de sesión.</p>`;
  const body = `
    ${credentialsBlock({ email: input.email, temporaryPassword: input.temporaryPassword, roles: input.roles ?? [] })}
    ${nota}`;
  const text = [
    `${intro}`,
    `Correo de acceso: ${input.email}`,
    input.temporaryPassword ? `Contraseña temporal: ${input.temporaryPassword}` : "Contraseña: solicítala al administrador.",
    `Rol: ${roleLabels(input.roles ?? [])}`,
    `Iniciar sesión: ${baseUrl}/login`,
  ].join("\n");
  return {
    subject,
    html: layout({ title: "Bienvenido", intro, preheader: intro, body, cta: "Iniciar sesión", ctaHref: `${baseUrl}/login`, footerNote: "Correo generado automáticamente por el Programador de Actualizaciones ERP. Si no esperabas este correo, contacta al administrador." }),
    text,
  };
}

// Correo de reenvío de credenciales. Como las contraseñas se guardan cifradas
// (no se pueden recuperar), este correo entrega una contraseña temporal NUEVA.
export function buildResendCredentialsEmail(input: {
  displayName: string;
  email: string;
  temporaryPassword: string;
  roles?: string[];
  frontendBaseUrl?: string;
}): EmailBuildResult {
  const baseUrl = normalizeBaseUrl(input.frontendBaseUrl);
  const subject = "Tus datos de acceso — Programador de Actualizaciones ERP";
  const intro = `Hola ${input.displayName}, un administrador reenvió tus datos de acceso al Programador de Actualizaciones ERP. Se generó una nueva contraseña temporal.`;
  const body = `
    ${credentialsBlock({ email: input.email, temporaryPassword: input.temporaryPassword, roles: input.roles ?? [] })}
    <p style="margin:10px 0 0; font-size:13px; line-height:19px; color:${COLORS.muted};">Esta contraseña reemplaza la anterior. Te recomendamos cambiarla después de iniciar sesión.</p>`;
  const text = [
    `${intro}`,
    `Correo de acceso: ${input.email}`,
    `Nueva contraseña temporal: ${input.temporaryPassword}`,
    `Rol: ${roleLabels(input.roles ?? [])}`,
    `Iniciar sesión: ${baseUrl}/login`,
  ].join("\n");
  return {
    subject,
    html: layout({ title: "Tus datos de acceso", intro, preheader: intro, body, cta: "Iniciar sesión", ctaHref: `${baseUrl}/login`, footerNote: "Correo generado automáticamente por el Programador de Actualizaciones ERP. Si no solicitaste este reenvío, contacta al administrador de inmediato." }),
    text,
  };
}

export function buildAdministrativeReminderEmail(input: {
  type: "sagWebVersion" | "whatsNew";
  subject?: string;
  periodo: string;
  fechaProgramada: string;
  frontendBaseUrl?: string;
}): EmailBuildResult {
  const baseUrl = normalizeBaseUrl(input.frontendBaseUrl);
  const isVersion = input.type === "sagWebVersion";
  const subject = input.subject || (isVersion
    ? "Recordatorio: guardar la última versión mensual de SAG Web"
    : "Recordatorio: crear documento \"¿Qué hay de nuevo en SAG Web?\"");
  const title = isVersion ? "Recordatorio de versión mensual" : "Recordatorio de documentación mensual";
  const subtitle = isVersion ? "SAG Web" : "¿Qué hay de nuevo en SAG Web?";
  const activity = isVersion ? "Guardar última versión mensual de SAG Web" : "Crear documento \"¿Qué hay de nuevo en SAG Web?\"";
  const description = isVersion
    ? `Este es un recordatorio para guardar o registrar la última versión mensual de SAG Web correspondiente al periodo ${input.periodo}.`
    : `Este es un recordatorio para crear o actualizar el documento \"¿Qué hay de nuevo en SAG Web?\" correspondiente al periodo ${input.periodo}.`;
  const extra = isVersion
    ? "Por favor verifica la versión actual publicada y registra la información correspondiente según el procedimiento interno."
    : "Recuerda preparar el documento para que el equipo pueda agregar las novedades, mejoras y cambios desarrollados durante el periodo.";
  const html = `<div style="font-family: Arial, sans-serif; color: ${COLORS.primary}; line-height: 1.5;">
  <div style="border-left: 6px solid ${COLORS.accent}; padding-left: 16px; margin-bottom: 20px;">
    <h2 style="margin: 0; color: ${COLORS.primary};">${escapeHtml(title)}</h2>
    <p style="margin: 4px 0 0 0; color: ${COLORS.secondary};">${escapeHtml(subtitle)}</p>
  </div>
  <p>Hola,</p>
  <p>${escapeHtml(description)}</p>
  <div style="background: #f5f7f8; border: 1px solid ${COLORS.neutral}; border-radius: 8px; padding: 14px; margin: 18px 0;">
    <p style="margin: 0;"><strong>Actividad:</strong> ${escapeHtml(activity)}</p>
    <p style="margin: 6px 0 0 0;"><strong>Periodo:</strong> ${escapeHtml(input.periodo)}</p>
    <p style="margin: 6px 0 0 0;"><strong>Fecha sugerida:</strong> ${escapeHtml(input.fechaProgramada)}</p>
  </div>
  <p>${escapeHtml(extra)}</p>
  ${!isVersion ? "<p>Si ya existe un documento base, usa la estructura correspondiente y actualiza el periodo.</p>" : ""}
  <p>Puedes ingresar al Programador de Actualizaciones desde el siguiente enlace:</p>
  <p><a href="${escapeHtml(baseUrl)}" style="display:inline-block; background:${COLORS.primary}; color:white; padding:10px 16px; border-radius:6px; text-decoration:none;">Abrir Programador de Actualizaciones</a></p>
  <p style="margin-top: 24px;">Gracias,<br /><strong>Programador de Actualizaciones</strong></p>
</div>`;
  const text = `${title} - ${subtitle}

Hola,

${description}

Actividad: ${activity}
Periodo: ${input.periodo}
Fecha sugerida: ${input.fechaProgramada}

${extra}

Abrir Programador de Actualizaciones:
${baseUrl}

Gracias,
Programador de Actualizaciones`;
  return { subject, html, text };
}

export function buildMastersReportEmail(input: {
  recipientName?: string;
  generatedAt?: string | Date;
  clients: MasterReportClient[];
  frontendBaseUrl?: string;
  timezone?: string;
}): EmailBuildResult {
  const timezone = input.timezone || "America/Bogota";
  const baseUrl = normalizeBaseUrl(input.frontendBaseUrl);
  const domainsCount = input.clients.reduce((acc, c) => acc + (c.domains?.length ?? 0), 0);
  const databasesCount = input.clients.reduce((acc, c) => acc + (c.domains ?? []).reduce((sum, d) => sum + (d.databases?.length ?? 0), 0), 0);
  const licensesCount = input.clients.reduce((acc, c) => acc + (c.licenses?.length ?? 0), 0);
  const intro = `Hola${input.recipientName ? ` ${input.recipientName}` : ""}, este es el reporte maestro ERP de clientes, dominios y empresas.`;
  const note = "Este reporte omite usuarios SQL, contraseñas, cadenas de conexión, tokens y secretos.";
  const licenseListHtml = (licenses?: MasterReportLicense[]) => (licenses ?? []).length > 0
    ? `<ul style="margin:6px 0 12px 18px; padding:0;">${(licenses ?? []).map((license) => `<li style="margin:0 0 4px;">${escapeHtml(license.name)}${license.code ? ` <span style="color:${COLORS.muted};">(${escapeHtml(license.code)})</span>` : ""}</li>`).join("")}</ul>`
    : `<ul style="margin:6px 0 12px 18px; padding:0;"><li style="margin:0 0 4px;">Sin licencias registradas</li></ul>`;
  const clientBlocks = input.clients.map((client) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${COLORS.neutral}; border-radius:8px; margin:0 0 14px;">
      <tr><td style="padding:14px;">
        <div style="font-size:16px; font-weight:700; color:${COLORS.primary};">Cliente: ${escapeHtml(client.name)}</div>
        <div style="font-size:12px; color:${COLORS.muted}; margin:3px 0 10px;">Estado: ${escapeHtml(client.status || "-")} · Creación: ${escapeHtml(formatDate(client.createdAt, "es-CO", timezone))}</div>
        <div style="font-size:13px; color:${COLORS.text}; margin-top:8px; font-weight:700;">Licencias / módulos:</div>
        ${licenseListHtml(client.licenses)}
        ${(client.domains ?? []).map((domain) => `
          <div style="border-top:1px solid ${COLORS.neutral}; padding-top:10px; margin-top:10px;">
            <div style="font-size:14px; font-weight:700; color:${COLORS.text};">Dominio: ${escapeHtml(domain.name)}</div>
            <div style="font-size:12px; color:${COLORS.muted};">Dominio para publicar: ${escapeHtml(formatDomainForPublishing(domain.publishableDomain || domain.url || domain.name))} · Ambiente: ${escapeHtml(domain.environment || "-")} · Estado: ${escapeHtml(domain.status || "-")} · Frecuencia: ${escapeHtml(domain.frequencyName || "Sin frecuencia activa")}</div>
            <div style="font-size:13px; color:${COLORS.text}; margin-top:8px; font-weight:700;">Empresas / bases:</div>
            ${(domain.databases ?? []).length > 0
              ? `<ul style="margin:6px 0 0 18px; padding:0;">${(domain.databases ?? []).map((db) => `<li style="margin:0 0 4px;">Empresa: ${escapeHtml(db.companyName || "-")} · Base de datos: ${escapeHtml(db.name || "-")} · Ambiente: ${escapeHtml(db.environment || "-")} · Estado: ${escapeHtml(db.status || "-")} · Creación: ${escapeHtml(formatDate(db.createdAt, "es-CO", timezone))}</li>`).join("")}</ul>`
              : `<div style="font-size:12px; color:${COLORS.muted}; margin-top:5px;">Sin empresas o bases activas asociadas.</div>`}
          </div>`).join("")}
      </td></tr>
    </table>`).join("");
  const body = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${metric("Clientes", input.clients.length)}
      ${metric("Dominios", domainsCount, COLORS.secondary)}
      ${metric("Empresas / bases", databasesCount, COLORS.accent)}
      ${metric("Licencias", licensesCount, COLORS.success)}
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc; border:1px solid ${COLORS.neutral}; border-radius:8px; margin:0 0 14px;">
      <tr><td style="padding:12px 14px; font-size:13px; color:${COLORS.text};">${escapeHtml(note)}</td></tr>
    </table>
    ${clientBlocks}`;
  const textClients = input.clients.map((client) => [
    `Cliente: ${client.name}`,
    `Estado: ${client.status || "-"}`,
    `Creación: ${formatDate(client.createdAt, "es-CO", timezone)}`,
    ``,
    `Licencias / módulos:`,
    ...((client.licenses ?? []).length > 0 ? (client.licenses ?? []).map((license) => `- ${license.name}${license.code ? ` (${license.code})` : ""}`) : ["- Sin licencias registradas"]),
    ``,
    `Dominios:`,
    ...(client.domains ?? []).flatMap((domain) => [
      `  Dominio: ${domain.name}`,
      `  Dominio para publicar: ${formatDomainForPublishing(domain.publishableDomain || domain.url || domain.name)}`,
      `  Ambiente: ${domain.environment || "-"}`,
      `  Estado: ${domain.status || "-"}`,
      `  Frecuencia: ${domain.frequencyName || "Sin frecuencia activa"}`,
      `    Empresas / bases:`,
      ...((domain.databases ?? []).length > 0 ? (domain.databases ?? []).map((db) => `    - Empresa: ${db.companyName || "-"} · Base de datos: ${db.name || "-"} · Ambiente: ${db.environment || "-"} · Estado: ${db.status || "-"} · Creación: ${formatDate(db.createdAt, "es-CO", timezone)}`) : ["    - Sin empresas o bases activas asociadas."]),
    ]),
  ].join("\n")).join("\n\n");
  return {
    subject: "Reporte maestro ERP — clientes, dominios y empresas",
    html: layout({ title: "Reporte maestro ERP", intro, preheader: intro, body, cta: "Abrir aplicación", ctaHref: baseUrl, footerNote: note }),
    text: `${intro}\nClientes: ${input.clients.length}\nDominios: ${domainsCount}\nEmpresas / bases: ${databasesCount}\nLicencias: ${licensesCount}\n${note}\n\n${textClients}\n\nAbrir aplicación: ${baseUrl}`,
  };
}

export type UpdateTaskEmailItem = DomainTaskEmailItem | DatabaseTaskEmailItem;
