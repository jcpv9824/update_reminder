import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import type { EmailAlertsSettings } from "../types/models";

// Mockear los repositorios SQL y Key Vault para aislar pruebas.
const mocks = vi.hoisted(() => ({
  saveMock: vi.fn(async (_current: any, next: any) => next),
  readMock: vi.fn(async () => undefined as any),
  setSecretMock: vi.fn(async () => undefined),
  getSecretMock: vi.fn(async () => "secret-en-vault"),
}));
const { saveMock, readMock, setSecretMock, getSecretMock } = mocks;

vi.mock("../lib/emailSettingsSqlRepository", () => ({
  readSqlEmailAlertsSettings: mocks.readMock,
}));
vi.mock("../lib/emailSettingsSqlWriteRepository", () => ({
  saveSqlEmailAlertsSettings: mocks.saveMock,
}));
vi.mock("../lib/keyVault", () => ({
  setSecret: mocks.setSecretMock,
  getSecret: mocks.getSecretMock,
}));

import { loadEmailAlertsSettings, saveEmailAlertsSettings, sanitizeForResponse, getSmtpPassword } from "../lib/settingsService";

beforeEach(() => {
  process.env.DATA_BACKEND = "sql";
  saveMock.mockClear();
  setSecretMock.mockClear();
  getSecretMock.mockClear();
  readMock.mockReset();
  readMock.mockResolvedValue({
    id: "email-alerts",
    emailProvider: "mock",
    emailFrom: "info@pya.com.co",
    emailFromName: "Portal SAG Web",
  } as any);
});

afterEach(() => {
  delete process.env.DATA_BACKEND;
});

describe("settingsService", () => {
  it("loadEmailAlertsSettings combina la fila SQL con defaults", async () => {
    const s = await loadEmailAlertsSettings();
    expect(s.id).toBe("email-alerts");
    expect(s.emailProvider).toBeDefined();
    expect(s.emailFrom).toBe("info@pya.com.co");
    expect(s.emailFromName).toBe("Portal SAG Web");
    expect(s.frontendBaseUrl).toBe("https://agreeable-wave-07469d50f.7.azurestaticapps.net");
    expect(s.smtpHost).toBe("smtp.office365.com");
    expect(s.smtpPort).toBe(587);
    expect(s.smtpSecure).toBe(false);
    expect(s.smtpUser).toBe("info@pya.com.co");
    expect(s.remindersEnabled).toBe(true);
  });

  it("sanitizeForResponse omite smtpPasswordSecretName y expone smtpPasswordConfigured", () => {
    const s: EmailAlertsSettings = {
      id: "email-alerts",
      emailProvider: "smtp",
      emailFrom: "a@b.com",
      emailFromName: "X",
      smtpPasswordSecretName: "smtp-password-x",
      smtpPasswordConfigured: true,
      remindersEnabled: true,
      defaultReminderDaysBefore: [0],
      defaultReminderTime: "08:00",
      defaultTimezone: "America/Bogota",
      overdueAlertsEnabled: true,
      overdueAlertTime: "08:00",
      overdueAlertTimezone: "America/Bogota",
      overdueAlertRecipientsMode: "admins",
      passwordNotificationEnabled: true,
      sendTemporaryPasswordByEmail: false,
    };
    const r = sanitizeForResponse(s) as any;
    expect(r.smtpPasswordSecretName).toBeUndefined();
    expect(r.smtpPasswordConfigured).toBe(true);
  });

  it("saveEmailAlertsSettings guarda contraseña SMTP en Key Vault y no en SQL", async () => {
    const r = await saveEmailAlertsSettings({
      patch: { emailProvider: "smtp", smtpUser: "info@pya.com.co", smtpPassword: "valor-prueba-no-real" },
      performedBy: "admin",
    });
    expect(setSecretMock).toHaveBeenCalledTimes(1);
    const [secretName, secretValue] = setSecretMock.mock.calls[0];
    expect(secretValue).toBe("valor-prueba-no-real");
    expect(secretName).toMatch(/^smtp-password-/);
    expect(secretName).not.toContain("@");

    expect(saveMock).toHaveBeenCalledTimes(1);
    const persisted = saveMock.mock.calls[0][1] as any;
    expect(JSON.stringify(persisted)).not.toContain("valor-prueba-no-real");
    expect(persisted.smtpPasswordSecretName).toBe(secretName);
    expect(persisted.smtpPasswordConfigured).toBe(true);
    expect(r.smtpPasswordConfigured).toBe(true);
  });

  it("getSmtpPassword usa Key Vault si hay secretName", async () => {
    const s: EmailAlertsSettings = {
      id: "email-alerts", emailProvider: "smtp", emailFrom: "a@b.com", emailFromName: "X",
      smtpPasswordSecretName: "smtp-password-x", smtpPasswordConfigured: true,
      remindersEnabled: true, defaultReminderDaysBefore: [0], defaultReminderTime: "08:00", defaultTimezone: "America/Bogota",
      overdueAlertsEnabled: true, overdueAlertTime: "08:00", overdueAlertTimezone: "America/Bogota",
      overdueAlertRecipientsMode: "admins", passwordNotificationEnabled: true, sendTemporaryPasswordByEmail: false,
    };
    const v = await getSmtpPassword(s);
    expect(v).toBe("secret-en-vault");
    expect(getSecretMock).toHaveBeenCalledWith("smtp-password-x");
  });
});
