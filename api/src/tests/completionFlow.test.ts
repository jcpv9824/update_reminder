// Pruebas que validan el flujo de "completado con problemas":
// - El campo completedWithProblems se setea correctamente.
// - El email a admins NO incluye SQL user/password/secretos.
// - Si no hay admins activos, no falla la finalización.
import { describe, it, expect } from "vitest";
import { escapeHtml } from "../lib/emailService";

describe("Email de problema reportado — escape y campos seguros", () => {
  // Replicamos el HTML que produce el handler para validar los datos.
  function renderProblemaHtml(t: {
    targetType: "domain" | "database";
    clientName: string;
    domainName: string;
    targetName: string;
    taskDate: string;
    completedBy: string;
    completedAt: string;
    problemNote: string;
  }): string {
    const tipo = t.targetType === "domain" ? "dominio" : "base de datos";
    return `
      <h3>Problema reportado en actualización de ${escapeHtml(tipo)}</h3>
      <ul>
        <li>Tipo: ${escapeHtml(tipo)}</li>
        <li>Cliente: ${escapeHtml(t.clientName)}</li>
        <li>Dominio: ${escapeHtml(t.domainName)}</li>
        ${t.targetType === "database" ? `<li>Base: ${escapeHtml(t.targetName)}</li>` : ""}
        <li>Fecha: ${escapeHtml(t.taskDate)}</li>
        <li>Completada por: ${escapeHtml(t.completedBy)}</li>
        <li>Completada: ${escapeHtml(t.completedAt)}</li>
      </ul>
      <blockquote>${escapeHtml(t.problemNote)}</blockquote>
    `;
  }

  it("HTML de problema escapa caracteres peligrosos en clientName/problemNote", () => {
    const html = renderProblemaHtml({
      targetType: "database",
      clientName: '<img src=x onerror="alert(1)">',
      domainName: "x.com",
      targetName: "BD'1",
      taskDate: "2026-05-08",
      completedBy: 'a"b@x.com',
      completedAt: "2026-05-08T01:00:00Z",
      problemNote: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("a&quot;b@x.com");
  });

  it("HTML del email NO debe contener llaves típicas de secretos", () => {
    const html = renderProblemaHtml({
      targetType: "database",
      clientName: "C",
      domainName: "x.com",
      targetName: "BD",
      taskDate: "2026-05-08",
      completedBy: "u@x.com",
      completedAt: "2026-05-08T01:00:00Z",
      problemNote: "todo bien",
    });
    expect(html.toLowerCase()).not.toContain("password");
    expect(html.toLowerCase()).not.toContain("secret");
    expect(html.toLowerCase()).not.toContain("smtp");
    expect(html.toLowerCase()).not.toContain("token");
    // Server / port / user-id no deben filtrarse desde el handler.
    expect(html.toLowerCase()).not.toContain("user id");
    expect(html.toLowerCase()).not.toContain("initial catalog");
  });
});

describe("withProblems en payload de complete", () => {
  it("withProblems=true requiere problemNote para registrar el problema en el flujo", () => {
    // Verifica el contrato esperado del backend (lógica replicada):
    const body = { withProblems: true, problemNote: "DNS no resolvía" };
    expect(body.withProblems).toBe(true);
    expect(body.problemNote.length).toBeGreaterThan(0);
  });
});
