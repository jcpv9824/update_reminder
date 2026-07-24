import { afterEach, describe, it, expect, beforeEach } from "vitest";
import { sendEmail, renderTaskReminderEmail, renderOverdueAlertEmail } from "../lib/emailService";

beforeEach(() => {
  process.env.DATA_BACKEND = "sql";
  process.env.EMAIL_PROVIDER = "mock";
});

afterEach(() => {
  delete process.env.DATA_BACKEND;
  delete process.env.EMAIL_PROVIDER;
});

describe("emailService", () => {
  it("modo mock siempre retorna ok=true sin enviar nada real", async () => {
    const r = await sendEmail(
      { to: "a@b.com", subject: "x", text: "y" },
      {
        id: "email-alerts", emailProvider: "mock", emailFrom: "info@pya.com.co",
        emailFromName: "Portal SAG Web", remindersEnabled: true,
        defaultReminderDaysBefore: [0], defaultReminderTime: "08:00",
        defaultTimezone: "America/Bogota", overdueAlertsEnabled: true,
        overdueAlertTime: "08:00", overdueAlertTimezone: "America/Bogota",
        overdueAlertRecipientsMode: "admins", passwordNotificationEnabled: true,
        sendTemporaryPasswordByEmail: false,
      },
      { outboxClaimed: true },
    );
    expect(r.ok).toBe(true);
    expect(r.provider).toBe("mock");
  });

  it("falla si no hay destinatarios", async () => {
    const r = await sendEmail({ to: [], subject: "x" }, undefined, { outboxClaimed: true });
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
