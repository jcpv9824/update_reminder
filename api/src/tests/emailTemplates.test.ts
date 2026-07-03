import { describe, expect, it } from "vitest";
import {
  buildDatabaseReminderEmail,
  buildBlockedTaskReminderEmail,
  buildDomainReminderEmail,
  buildMastersReportEmail,
  buildOverdueTasksEmail,
  buildResendCredentialsEmail,
  buildTestEmail,
  buildWelcomeUserEmail,
  escapeHtml,
  normalizeBaseUrl,
  roleLabels,
} from "../lib/emailTemplates";

describe("emailTemplates", () => {
  it("escapeHtml neutraliza caracteres especiales", () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  it("normalizeBaseUrl evita slash final", () => {
    expect(normalizeBaseUrl("https://app.example.com///")).toBe("https://app.example.com");
  });

  it("normalizeBaseUrl rechaza esquemas ejecutables y credenciales embebidas", () => {
    expect(normalizeBaseUrl("javascript:alert(1)")).toBe("https://agreeable-wave-07469d50f.7.azurestaticapps.net");
    expect(normalizeBaseUrl("https://usuario:clave@app.example.com")).toBe("https://agreeable-wave-07469d50f.7.azurestaticapps.net");
  });

  it("buildDomainReminderEmail genera solo recordatorio de dominios para el responsable", () => {
    const email = buildDomainReminderEmail({
      recipientName: "Camilo",
      frontendBaseUrl: "https://app.example.com/",
      tasks: [
        { clientName: "Cliente A", domainName: "erp.a.com", scheduledFor: "2026-05-15", status: "pending", notes: "Actualizar publicación web." },
        { clientName: "Cliente B", domainName: "erp.b.com", scheduledFor: "2026-05-15", status: "pending" },
      ],
    });
    expect(email.subject).toMatch(/Dominios por actualizar/);
    expect(email.html).toContain("Dominios por actualizar");
    expect(email.html).toContain("erp.a.com");
    expect(email.html).toContain("Actualizar publicación web.");
    expect(email.html).not.toContain("Empresa / base");
    expect(email.html).toContain("https://app.example.com/tareas");
    expect(email.text).toContain("estos son los dominios");
  });

  it("buildDatabaseReminderEmail genera solo recordatorio de bases y no expone datos SQL", () => {
    const email = buildDatabaseReminderEmail({
      recipientName: "Laura",
      frontendBaseUrl: "https://app.example.com",
      tasks: [
        { clientName: "Cliente A", domainName: "erp.a.com", databaseName: "PYA_PROD", scheduledFor: "2026-05-15", status: "pending" },
        { clientName: "Cliente A", domainName: "erp.a.com", databaseName: "PYA_TEST", scheduledFor: "2026-05-16", status: "pending" },
        { clientName: "Cliente B", domainName: "erp.b.com", databaseName: "B_PROD", scheduledFor: "2026-05-17", status: "pending" },
      ],
    });
    const serialized = `${email.html}\n${email.text}`;
    expect(email.subject).toMatch(/Bases de datos por actualizar/);
    expect(serialized).toContain("PYA_PROD");
    expect(serialized).toContain("Empresa / base");
    expect(serialized).not.toMatch(/Servidor SQL|User ID|Password|connection string|secret-password|sql.example.com/i);
  });

  it("buildOverdueTasksEmail genera un solo correo combinado con dominios y bases vencidas", () => {
    const email = buildOverdueTasksEmail({
      recipientName: "Camilo",
      frontendBaseUrl: "https://app.example.com",
      overdueDomainTasks: [
        { clientName: "Cliente A", domainName: "erp.a.com", dueAt: "2026-05-01", status: "pending" },
        { clientName: "Cliente B", domainName: "erp.b.com", dueAt: "2026-05-02", status: "blocked" },
      ],
      overdueDatabaseTasks: [
        { clientName: "Cliente A", domainName: "erp.a.com", databaseName: "PYA_PROD", dueAt: "2026-05-01", status: "pending" },
        { clientName: "Cliente A", domainName: "erp.a.com", databaseName: "PYA_TEST", dueAt: "2026-05-02", status: "failed" },
        { clientName: "Cliente B", domainName: "erp.b.com", databaseName: "B_PROD", dueAt: "2026-05-03", status: "reopened" },
      ],
    });
    expect(email.subject).toBe("Alerta: tienes tareas vencidas de actualización");
    expect(email.html).toContain("Dominios vencidos");
    expect(email.html).toContain("Bases de datos / empresas vencidas");
    expect(email.html).toContain("Total vencidas");
    expect(email.html).toContain("PYA_PROD");
    expect(email.text).toContain("Dominios vencidos");
    expect(email.text).toContain("Bases de datos / empresas vencidas");
  });

  it("buildOverdueTasksEmail ajusta asunto para solo dominios o solo bases", () => {
    const onlyDomains = buildOverdueTasksEmail({
      overdueDomainTasks: [{ clientName: "Cliente A", domainName: "erp.a.com", dueAt: "2026-05-01" }],
      overdueDatabaseTasks: [],
    });
    const onlyDatabases = buildOverdueTasksEmail({
      overdueDomainTasks: [],
      overdueDatabaseTasks: [{ clientName: "Cliente A", domainName: "erp.a.com", databaseName: "PYA_PROD", dueAt: "2026-05-01" }],
    });
    expect(onlyDomains.subject).toBe("Alerta: tienes dominios vencidos por actualizar");
    expect(onlyDomains.html).toContain("Dominios vencidos");
    expect(onlyDomains.html).not.toContain("Bases de datos / empresas vencidas");
    expect(onlyDatabases.subject).toBe("Alerta: tienes bases de datos vencidas por actualizar");
    expect(onlyDatabases.html).toContain("Bases de datos / empresas vencidas");
    expect(onlyDatabases.html).not.toContain(">Dominios vencidos</h2>");
  });

  it("buildBlockedTaskReminderEmail neutraliza HTML, enlaces y atributos en todos los campos", () => {
    const email = buildBlockedTaskReminderEmail({
      frontendBaseUrl: `https://app.example.com/\" onmouseover=\"alert(9)`,
      task: {
        clientName: `<script>alert("cliente")</script>`,
        domainName: `dominio.example.com"><img src=x onerror=alert(2)>`,
        targetType: "database",
        targetName: `<a href="javascript:alert(3)">Base & Empresa</a>`,
        daysAfter: 3,
        reason: `Tom & Jerry dijo: "falló" ' <svg onload=alert(4)>`,
      },
    });

    expect(email.subject).toBe("Recordatorio: tarea bloqueada sin resolver");
    expect(email.html).not.toMatch(/<script|<img|<svg|<a href="javascript:/i);
    expect(email.html).not.toContain(`onmouseover="alert(9)`);
    expect(email.html).toContain("&lt;script&gt;alert(&quot;");
    expect(email.html).toContain("&lt;a href=&quot;javascript:alert(3)&quot;&gt;");
    expect(email.html).toContain("Base &amp; Empresa");
    expect(email.html).toContain("Tom &amp; Jerry");
    expect(email.html).toContain("&#39;");
    expect(email.text).toContain(`<script>alert("cliente")</script>`);
    expect(email.text).toContain("Días desde el bloqueo: 3");
  });

  it("buildBlockedTaskReminderEmail usa valores seguros cuando no hay motivo", () => {
    const email = buildBlockedTaskReminderEmail({
      task: { clientName: "Cliente", domainName: "erp.example.com", targetType: "domain", targetName: "ERP", daysAfter: 1 },
    });
    expect(email.html).toContain("Tarea bloqueada sin resolver");
    expect(email.html).toContain("Dominio");
    expect(email.text).toContain("Motivo: -");
    expect(email.html).toContain("/tareas");
  });

  it("buildTestEmail muestra proveedor, remitente, fecha y URL sin secretos", () => {
    const email = buildTestEmail({
      recipientName: "Admin",
      provider: "smtp",
      emailFrom: "info@pya.com.co",
      sentAt: "2026-05-07T13:00:00.000Z",
      frontendBaseUrl: "https://app.example.com",
    });
    const serialized = `${email.html}\n${email.text}`;
    expect(email.subject).toContain("Correo de prueba");
    expect(serialized).toContain("Proveedor actual");
    expect(serialized).toContain("info@pya.com.co");
    expect(serialized).toContain("https://app.example.com");
    expect(serialized).not.toMatch(/smtp-password-info|clave-real|valor-prueba-no-real/i);
  });

  it("buildWelcomeUserEmail incluye usuario, rol, contraseña temporal y enlace de login", () => {
    const email = buildWelcomeUserEmail({
      displayName: "Camilo",
      email: "camilo@empresa.com",
      temporaryPassword: "Tmp123!*",
      roles: ["admin", "database_updater"],
      frontendBaseUrl: "https://app.example.com/",
    });
    const serialized = `${email.html}\n${email.text}`;
    expect(email.subject).toContain("Bienvenido");
    expect(serialized).toContain("camilo@empresa.com");
    expect(serialized).toContain("Tmp123!*");
    expect(serialized).toContain("Administrador");
    expect(serialized).toContain("Actualizador de bases de datos");
    expect(serialized).toContain("https://app.example.com/login");
    expect(serialized).not.toMatch(/smtp|secretName|keyVault/i);
  });

  it("buildResendCredentialsEmail indica que la contraseña temporal es nueva", () => {
    const email = buildResendCredentialsEmail({
      displayName: "Laura",
      email: "laura@empresa.com",
      temporaryPassword: "Nueva123!*",
      roles: ["viewer"],
      frontendBaseUrl: "https://app.example.com",
    });
    const serialized = `${email.html}\n${email.text}`;
    expect(email.subject).toContain("Tus datos de acceso");
    expect(serialized).toContain("nueva contraseña temporal");
    expect(serialized).toContain("Nueva123!*");
    expect(serialized).toContain("Visualizador");
    expect(serialized).toContain("https://app.example.com/login");
  });

  it("roleLabels traduce roles conocidos y conserva roles desconocidos", () => {
    expect(roleLabels(["client_manager", "rol_custom"])).toBe("Administrador de clientes, rol_custom");
    expect(roleLabels([])).toBe("Sin rol asignado");
  });

  it("buildWelcomeUserEmail incluye credenciales, rol y enlace de acceso", () => {
    const email = buildWelcomeUserEmail({
      displayName: "Laura Pérez",
      email: "laura@example.com",
      temporaryPassword: "Temp#1234",
      roles: ["admin", "viewer"],
      frontendBaseUrl: "https://app.example.com/",
    });
    const serialized = `${email.html}\n${email.text}`;
    expect(email.subject).toContain("Bienvenido");
    expect(serialized).toContain("laura@example.com");
    expect(serialized).toContain("Temp#1234");
    expect(serialized).toContain("Administrador");
    expect(serialized).toContain("https://app.example.com/login");
    // Estándar responsivo: usa el layout con viewport y ancho máximo.
    expect(email.html).toContain("max-width");
  });

  it("buildWelcomeUserEmail sin contraseña no muestra fila de contraseña", () => {
    const email = buildWelcomeUserEmail({
      displayName: "Laura",
      email: "laura@example.com",
      roles: ["viewer"],
    });
    expect(email.html).not.toContain("Contraseña temporal");
    expect(email.text).toContain("solicítala al administrador");
  });

  it("buildResendCredentialsEmail entrega la nueva contraseña temporal y escapa HTML", () => {
    const email = buildResendCredentialsEmail({
      displayName: "Pedro <script>",
      email: "pedro@example.com",
      temporaryPassword: "Nueva#5678",
      roles: ["database_updater"],
      frontendBaseUrl: "https://app.example.com",
    });
    const serialized = `${email.html}\n${email.text}`;
    expect(email.subject).toContain("datos de acceso");
    expect(serialized).toContain("Nueva#5678");
    expect(serialized).toContain("Actualizador de bases de datos");
    expect(serialized).toContain("https://app.example.com/login");
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("reemplaza la anterior");
  });

  it("roleLabels traduce roles y tolera desconocidos", () => {
    expect(roleLabels(["admin", "otro_rol"])).toBe("Administrador, otro_rol");
    expect(roleLabels([])).toBe("Sin rol asignado");
  });

  it("buildMastersReportEmail agrupa clientes, dominios y bases sin datos sensibles", () => {
    const email = buildMastersReportEmail({
      frontendBaseUrl: "https://app.example.com",
      clients: [
        {
          name: "Cliente Uno",
          domains: [
            { name: "erp.uno.com", frequencyName: "Semanal", databases: [{ name: "UNO_PROD", status: "active" }, { name: "UNO_TEST", status: "active" }] },
            { name: "demo.uno.com", frequencyName: "Mensual", databases: [{ name: "DEMO_PROD", status: "active" }] },
          ],
        },
        { name: "Cliente Dos", domains: [{ name: "erp.dos.com", frequencyName: "Semanal", databases: [{ name: "DOS_PROD", status: "active" }] }] },
      ],
    });
    const serialized = `${email.html}\n${email.text}`;
    expect(email.subject).toBe("Reporte maestro ERP — clientes, dominios y empresas");
    expect(serialized).toContain("Clientes");
    expect(serialized).toContain("erp.uno.com");
    expect(serialized).toContain("UNO_PROD");
    expect(serialized).toContain("Este reporte omite usuarios SQL");
    expect(serialized).not.toMatch(/password-real|connectionString-real|userId-real|sqlUser-real|token-real|keyVault-real/i);
  });
});
