import { describe, it, expect, beforeEach } from "vitest";
import { sendEmail, renderTaskReminderEmail, renderOverdueAlertEmail } from "../lib/emailService";

beforeEach(() => {
  process.env.EMAIL_PROVIDER = "mock";
});

describe("emailService", () => {
  it("modo mock siempre retorna ok=true sin enviar nada real", async () => {
    const r = await sendEmail({ to: "a@b.com", subject: "x", text: "y" });
    expect(r.ok).toBe(true);
    expect(r.provider).toBe("mock");
  });

  it("falla si no hay destinatarios", async () => {
    const r = await sendEmail({ to: [], subject: "x" });
    expect(r.ok).toBe(false);
  });

  it("renderTaskReminderEmail produce un asunto en español", () => {
    const t = renderTaskReminderEmail({ clientName: "C", domainName: "d", targetType: "database", targetName: "X", taskDate: "2026-05-10", daysBefore: 3 });
    expect(t.subject).toMatch(/Bases de datos por actualizar/i);
    expect(t.html).toContain("Empresa / base");
  });

  it("renderOverdueAlertEmail describe los conteos", () => {
    const t = renderOverdueAlertEmail({ domainTasks: [], databaseTasks: [{ clientName: "C", domainName: "d", targetName: "T", taskDate: "x", status: "pending", assigned: "" }] });
    expect(t.subject).toMatch(/bases de datos vencidas/i);
    expect(t.html).toContain("Bases de datos / empresas vencidas");
  });
});
