import { describe, expect, it } from "vitest";
import { mapSqlEmailAlertsSettings } from "../lib/emailSettingsSqlRepository";
import { mergeEmailAlertsSettings, sanitizeForResponse } from "../lib/settingsService";

const at = new Date("2026-07-21T12:00:00.000Z");

describe("Email settings SQL mapping", () => {
  it("reconstructs normalized settings and keeps the Key Vault reference out of the public DTO", () => {
    const stored = mapSqlEmailAlertsSettings({
      source_id: "email-alerts", email_provider: "smtp", email_from: "info@example.test",
      email_from_name: "Portal", frontend_base_url: "https://portal.example.test", smtp_host: "smtp.example.test",
      smtp_port: 587, smtp_secure: true, smtp_user: "info@example.test",
      smtp_password_secret_name: "smtp-password-reference", smtp_password_configured: true,
      reminders_enabled: true, default_reminder_time: "08:00", default_timezone: "America/Bogota",
      overdue_alerts_enabled: true, overdue_alert_time: "08:30", overdue_alert_timezone: "America/Bogota",
      legacy_overdue_recipient_mode: "admins", overdue_alert_frequency: "weekly",
      overdue_alert_last_sent_period: "2026-W29", blocked_alerts_enabled: true,
      blocked_alert_send_immediately: true, blocked_alert_include_overdue: true,
      blocked_reminder_enabled: true, blocked_reminder_time: "09:00", blocked_reminder_timezone: "America/Bogota",
      password_notification_enabled: true, send_temporary_password_by_email: false,
      created_at: at, created_by: "migration", updated_at: at, updated_by: "migration",
      default_reminder_days_json: '[{"value":0},{"value":3}]', overdue_roles_json: '[{"value":"super_admin"}]',
      blocked_roles_json: '[{"value":"super_admin"}]', overdue_emails_json: '[{"value":"ops@example.test"}]',
      legacy_overdue_emails_json: '[{"value":"legacy@example.test"}]', blocked_emails_json: '[]',
      overdue_weekdays_json: '[{"value":1},{"value":5}]', blocked_reminder_days_json: '[{"value":1},{"value":3}]',
      sag_web_reminder_json: '{"enabled":true,"sendRule":"last_business_day","dayOfMonth":1,"time":"08:00","timezone":"America/Bogota","subject":"Versión","recipients":[{"value":"admin@example.test"}]}',
      whats_new_reminder_json: null,
    });
    const settings = mergeEmailAlertsSettings(stored);

    expect(settings).toMatchObject({
      defaultReminderDaysBefore: [0, 3], overdueAlertWeekdays: ["MONDAY", "FRIDAY"],
      overdueAlertRecipientRoleIds: ["super_admin"], overdueAlertCustomEmails: ["ops@example.test"],
      customAdminAlertEmails: ["legacy@example.test"], blockedReminderDaysAfter: [1, 3],
      administrativeReminders: { sagWebVersionReminder: { enabled: true, recipients: ["admin@example.test"] } },
    });
    expect(settings.administrativeReminders?.whatsNewReminder.subject).toContain("¿Qué hay de nuevo");
    expect(JSON.stringify(sanitizeForResponse(settings))).not.toContain("smtp-password-reference");
  });
});
