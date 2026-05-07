// Servicio de envío de correos. Soporta tres modos:
// - mock: solo registra en consola (desarrollo y pruebas).
// - sendgrid: usa @sendgrid/mail.
// - acs: Azure Communication Services (no implementado en MVP, marcador).

export type EmailMessage = {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
};

export type EmailResult = { ok: boolean; provider: string; error?: string; messageId?: string };

function provider(): string {
  return (process.env.EMAIL_PROVIDER ?? "mock").toLowerCase();
}

function fromAddress(): { email: string; name: string } {
  return {
    email: process.env.EMAIL_FROM ?? "no-reply@local",
    name: process.env.EMAIL_FROM_NAME ?? "Programador de Actualizaciones",
  };
}

export async function sendEmail(msg: EmailMessage): Promise<EmailResult> {
  const p = provider();
  const recipients = Array.isArray(msg.to) ? msg.to : [msg.to];
  if (recipients.length === 0) return { ok: false, provider: p, error: "Sin destinatarios." };

  if (p === "mock") {
    // Modo desarrollo / pruebas: no envía nada real.
    const from = fromAddress();
    console.log(`[email:mock] de ${from.name} <${from.email}> a ${recipients.join(", ")}: ${msg.subject}`);
    return { ok: true, provider: "mock", messageId: `mock-${Date.now()}` };
  }

  if (p === "sendgrid") {
    const key = process.env.SENDGRID_API_KEY;
    if (!key) return { ok: false, provider: p, error: "SENDGRID_API_KEY no configurado." };
    try {
      const sg = (await import("@sendgrid/mail")).default;
      sg.setApiKey(key);
      const from = fromAddress();
      const [r] = await sg.send({
        to: recipients,
        from: { email: from.email, name: from.name },
        subject: msg.subject,
        text: msg.text ?? msg.subject,
        html: msg.html ?? `<p>${msg.text ?? msg.subject}</p>`,
      });
      return { ok: true, provider: "sendgrid", messageId: (r.headers as any)?.["x-message-id"] };
    } catch (e: any) {
      return { ok: false, provider: "sendgrid", error: e?.message ?? "Error de SendGrid" };
    }
  }

  if (p === "acs") {
    // Marcador para Azure Communication Services. Devolvemos error explícito
    // para no fallar silenciosamente.
    return { ok: false, provider: "acs", error: "Proveedor ACS no implementado todavía. Use EMAIL_PROVIDER=sendgrid o mock." };
  }

  return { ok: false, provider: p, error: `Proveedor de email desconocido: ${p}` };
}

// Plantillas comunes -------------------------------------------------------

export function renderTaskReminderEmail(args: {
  clientName: string;
  domainName: string;
  targetType: "domain" | "database";
  targetName: string;
  taskDate: string;
  daysBefore: number;
}): { subject: string; html: string; text: string } {
  const cuando = args.daysBefore === 0 ? "hoy" : args.daysBefore === 1 ? "mañana" : `en ${args.daysBefore} días`;
  const tipo = args.targetType === "domain" ? "dominio" : "base de datos";
  const subject = `Recordatorio: actualización ${cuando} — ${args.clientName}`;
  const text = `Tienes una actualización programada ${cuando} (${args.taskDate}) del ${tipo} ${args.targetName} del cliente ${args.clientName} (dominio ${args.domainName}).`;
  const html = `
    <h3>Recordatorio de actualización</h3>
    <p>Tienes una actualización programada <strong>${cuando}</strong> (${args.taskDate}).</p>
    <ul>
      <li><strong>Cliente:</strong> ${args.clientName}</li>
      <li><strong>Dominio:</strong> ${args.domainName}</li>
      <li><strong>${args.targetType === "domain" ? "Dominio" : "Base de datos"}:</strong> ${args.targetName}</li>
    </ul>
    <p>Ingresa al Programador de Actualizaciones para gestionarla.</p>
  `;
  return { subject, html, text };
}

export function renderOverdueAlertEmail(args: {
  domainTasks: Array<{ clientName: string; domainName: string; taskDate: string; status: string; assigned: string }>;
  databaseTasks: Array<{ clientName: string; domainName: string; targetName: string; taskDate: string; status: string; assigned: string }>;
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
  const html = `
    <h3>Actualizaciones vencidas</h3>
    <p>Resumen del día:</p>
    <ul>
      <li>Dominios vencidos: <strong>${args.domainTasks.length}</strong></li>
      <li>Bases de datos vencidas: <strong>${args.databaseTasks.length}</strong></li>
    </ul>
    ${tabla([cabD, ...filasD], "Dominios")}
    ${tabla([cabB, ...filasB], "Bases de datos")}
  `;
  const text = `Resumen de vencidos: ${args.domainTasks.length} dominios, ${args.databaseTasks.length} bases de datos.`;
  return { subject, html, text };
}
