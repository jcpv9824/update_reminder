import { describe, it, expect } from "vitest";
import { buildDomainReminderEmail, buildDatabaseReminderEmail, buildOverdueTasksEmail } from "../lib/emailTemplates";

describe("Plantillas de email — dominio publicable", () => {
  it("recordatorio de dominios incluye 'Dominio para publicar' y la versión limpia", () => {
    const r = buildDomainReminderEmail({
      tasks: [{ clientName: "C", domainName: "https://argatex.sagerp.cloud:54678/", scheduledFor: "2026-05-08", status: "pendiente" }],
      frontendBaseUrl: "https://app.example.com",
    });
    expect(r.html).toContain("Dominio para publicar");
    expect(r.html).toContain("argatex.sagerp.cloud");
    // El URL completa también debe aparecer (en la columna "Dominio registrado").
    expect(r.html).toContain("https://argatex.sagerp.cloud:54678/");
    // La versión publicable aparece en negrita.
    expect(r.html).toMatch(/<strong>argatex\.sagerp\.cloud<\/strong>/);
    // Texto plano contiene ambas.
    expect(r.text).toContain("Dominio registrado: https://argatex.sagerp.cloud:54678/");
    expect(r.text).toContain("Dominio para publicar: argatex.sagerp.cloud");
  });

  it("recordatorio de bases de datos incluye 'Dominio para publicar'", () => {
    const r = buildDatabaseReminderEmail({
      tasks: [{
        clientName: "C", domainName: "https://argatex.sagerp.cloud:54678/",
        databaseName: "BD-X", scheduledFor: "2026-05-08", status: "pendiente",
      }],
      frontendBaseUrl: "https://app.example.com",
    });
    expect(r.html).toContain("Dominio para publicar");
    expect(r.html).toContain("argatex.sagerp.cloud");
    expect(r.text).toContain("Dominio para publicar: argatex.sagerp.cloud");
  });

  it("alerta de vencidas incluye dominio publicable y NO contiene secretos", () => {
    const r = buildOverdueTasksEmail({
      overdueDomainTasks: [{ clientName: "C", domainName: "HTTP://INVENGY.SAGERP.CLOUD:54678/", scheduledFor: "2026-05-01", status: "pendiente" }],
      overdueDatabaseTasks: [],
      frontendBaseUrl: "https://app.example.com",
    });
    expect(r.html).toContain("invengy.sagerp.cloud");
    // No exponer secretos en ninguna plantilla.
    expect(r.html.toLowerCase()).not.toContain("password");
    expect(r.html.toLowerCase()).not.toContain("user id");
    expect(r.html.toLowerCase()).not.toContain("initial catalog");
    expect(r.html.toLowerCase()).not.toContain("connection string");
  });
});
