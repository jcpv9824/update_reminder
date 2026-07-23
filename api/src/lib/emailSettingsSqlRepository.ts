import { getSqlPool } from "./sql";
import type { AdministrativeReminderSettings, EmailAlertsSettings, Weekday } from "../types/models";

type ValueJson<T> = { value: T };
type AdministrativeReminderJson = {
  enabled: boolean;
  sendRule: AdministrativeReminderSettings["sendRule"];
  dayOfMonth: number;
  time: string;
  timezone: string;
  subject: string;
  recipients: ValueJson<string>[];
};

type EmailSettingsRow = {
  source_id: "email-alerts";
  email_provider: EmailAlertsSettings["emailProvider"];
  email_from: string;
  email_from_name: string;
  frontend_base_url: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: boolean | null;
  smtp_user: string | null;
  smtp_password_secret_name: string | null;
  smtp_password_configured: boolean;
  reminders_enabled: boolean;
  default_reminder_time: string;
  default_timezone: string;
  overdue_alerts_enabled: boolean;
  overdue_alert_time: string;
  overdue_alert_timezone: string;
  legacy_overdue_recipient_mode: EmailAlertsSettings["overdueAlertRecipientsMode"];
  overdue_alert_frequency: "daily" | "weekly" | null;
  overdue_alert_last_sent_period: string | null;
  blocked_alerts_enabled: boolean;
  blocked_alert_send_immediately: boolean;
  blocked_alert_include_overdue: boolean;
  blocked_reminder_enabled: boolean;
  blocked_reminder_time: string | null;
  blocked_reminder_timezone: string | null;
  password_notification_enabled: boolean;
  send_temporary_password_by_email: boolean;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
  default_reminder_days_json: string | null;
  overdue_roles_json: string | null;
  blocked_roles_json: string | null;
  overdue_emails_json: string | null;
  legacy_overdue_emails_json: string | null;
  blocked_emails_json: string | null;
  overdue_weekdays_json: string | null;
  blocked_reminder_days_json: string | null;
  sag_web_reminder_json: string | null;
  whats_new_reminder_json: string | null;
};

export type StoredEmailAlertsSettings = Omit<Partial<EmailAlertsSettings>, "administrativeReminders"> & {
  id: "email-alerts";
  administrativeReminders?: Partial<NonNullable<EmailAlertsSettings["administrativeReminders"]>>;
};

const weekdayByNumber: Record<number, Weekday> = {
  1: "MONDAY", 2: "TUESDAY", 3: "WEDNESDAY", 4: "THURSDAY",
  5: "FRIDAY", 6: "SATURDAY", 7: "SUNDAY",
};

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function values<T>(json: string | null): T[] {
  return parseJson<ValueJson<T>[]>(json, []).map((entry) => entry.value);
}

function mapAdministrativeReminder(json: string | null): AdministrativeReminderSettings | undefined {
  const reminder = parseJson<AdministrativeReminderJson | null>(json, null);
  if (!reminder) return undefined;
  return {
    enabled: reminder.enabled,
    recipients: reminder.recipients.map((entry) => entry.value),
    sendRule: reminder.sendRule,
    dayOfMonth: Number(reminder.dayOfMonth),
    time: reminder.time,
    timezone: reminder.timezone,
    subject: reminder.subject,
  };
}

export function mapSqlEmailAlertsSettings(row: EmailSettingsRow): StoredEmailAlertsSettings {
  const sagWebVersionReminder = mapAdministrativeReminder(row.sag_web_reminder_json);
  const whatsNewReminder = mapAdministrativeReminder(row.whats_new_reminder_json);
  return {
    id: "email-alerts",
    emailProvider: row.email_provider,
    emailFrom: row.email_from,
    emailFromName: row.email_from_name,
    frontendBaseUrl: row.frontend_base_url ?? undefined,
    smtpHost: row.smtp_host ?? undefined,
    smtpPort: row.smtp_port ?? undefined,
    smtpSecure: row.smtp_secure ?? false,
    smtpUser: row.smtp_user ?? undefined,
    smtpPasswordSecretName: row.smtp_password_secret_name ?? undefined,
    smtpPasswordConfigured: row.smtp_password_configured,
    remindersEnabled: row.reminders_enabled,
    defaultReminderDaysBefore: values<number>(row.default_reminder_days_json).map(Number),
    defaultReminderTime: row.default_reminder_time,
    defaultTimezone: row.default_timezone,
    overdueAlertsEnabled: row.overdue_alerts_enabled,
    overdueAlertTime: row.overdue_alert_time,
    overdueAlertTimezone: row.overdue_alert_timezone,
    overdueAlertRecipientsMode: row.legacy_overdue_recipient_mode,
    customAdminAlertEmails: values<string>(row.legacy_overdue_emails_json),
    overdueAlertRecipientRoleIds: values<string>(row.overdue_roles_json),
    overdueAlertCustomEmails: values<string>(row.overdue_emails_json),
    overdueAlertFrequency: row.overdue_alert_frequency ?? "daily",
    overdueAlertWeekdays: values<number>(row.overdue_weekdays_json).map((day) => weekdayByNumber[Number(day)]).filter(Boolean),
    overdueAlertLastSentPeriod: row.overdue_alert_last_sent_period,
    blockedAlertsEnabled: row.blocked_alerts_enabled,
    blockedAlertRecipientRoleIds: values<string>(row.blocked_roles_json),
    blockedAlertCustomEmails: values<string>(row.blocked_emails_json),
    blockedAlertSendImmediately: row.blocked_alert_send_immediately,
    blockedAlertIncludeInOverdueSummary: row.blocked_alert_include_overdue,
    blockedReminderEnabled: row.blocked_reminder_enabled,
    blockedReminderDaysAfter: values<number>(row.blocked_reminder_days_json).map(Number),
    blockedReminderTime: row.blocked_reminder_time ?? "08:00",
    blockedReminderTimezone: row.blocked_reminder_timezone ?? "America/Bogota",
    administrativeReminders: sagWebVersionReminder || whatsNewReminder ? {
      ...(sagWebVersionReminder ? { sagWebVersionReminder } : {}),
      ...(whatsNewReminder ? { whatsNewReminder } : {}),
    } : undefined,
    passwordNotificationEnabled: row.password_notification_enabled,
    sendTemporaryPasswordByEmail: row.send_temporary_password_by_email,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
  };
}

export async function readSqlEmailAlertsSettings(): Promise<StoredEmailAlertsSettings | null> {
  const pool = await getSqlPool();
  const result = await pool.request().query<EmailSettingsRow>(`
    SELECT settings.source_id,settings.email_provider,settings.email_from,settings.email_from_name,
      settings.frontend_base_url,settings.smtp_host,settings.smtp_port,settings.smtp_secure,settings.smtp_user,
      settings.smtp_password_secret_name,settings.smtp_password_configured,settings.reminders_enabled,
      CONVERT(char(5),settings.default_reminder_time,108) AS default_reminder_time,settings.default_timezone,
      settings.overdue_alerts_enabled,CONVERT(char(5),settings.overdue_alert_time,108) AS overdue_alert_time,
      settings.overdue_alert_timezone,settings.legacy_overdue_recipient_mode,settings.overdue_alert_frequency,
      settings.overdue_alert_last_sent_period,settings.blocked_alerts_enabled,settings.blocked_alert_send_immediately,
      settings.blocked_alert_include_overdue,settings.blocked_reminder_enabled,
      CONVERT(char(5),settings.blocked_reminder_time,108) AS blocked_reminder_time,
      settings.blocked_reminder_timezone,settings.password_notification_enabled,
      settings.send_temporary_password_by_email,settings.created_at,settings.created_by,settings.updated_at,settings.updated_by,
      COALESCE((SELECT days_before AS value FROM settings.default_reminder_days ORDER BY days_before FOR JSON PATH),N'[]') AS default_reminder_days_json,
      COALESCE((SELECT role_id AS value FROM settings.alert_recipient_roles WHERE alert_kind='overdue' ORDER BY role_id FOR JSON PATH),N'[]') AS overdue_roles_json,
      COALESCE((SELECT role_id AS value FROM settings.alert_recipient_roles WHERE alert_kind='blocked' ORDER BY role_id FOR JSON PATH),N'[]') AS blocked_roles_json,
      COALESCE((SELECT email_normalized AS value FROM settings.alert_recipient_emails WHERE alert_kind='overdue' AND source_kind='current' ORDER BY email_normalized FOR JSON PATH),N'[]') AS overdue_emails_json,
      COALESCE((SELECT email_normalized AS value FROM settings.alert_recipient_emails WHERE alert_kind='overdue' AND source_kind='legacy' ORDER BY email_normalized FOR JSON PATH),N'[]') AS legacy_overdue_emails_json,
      COALESCE((SELECT email_normalized AS value FROM settings.alert_recipient_emails WHERE alert_kind='blocked' AND source_kind='current' ORDER BY email_normalized FOR JSON PATH),N'[]') AS blocked_emails_json,
      COALESCE((SELECT weekday AS value FROM settings.overdue_alert_weekdays ORDER BY weekday FOR JSON PATH),N'[]') AS overdue_weekdays_json,
      COALESCE((SELECT days_after AS value FROM settings.blocked_reminder_days ORDER BY days_after FOR JSON PATH),N'[]') AS blocked_reminder_days_json,
      (SELECT reminder.enabled,reminder.send_rule AS sendRule,reminder.day_of_month AS dayOfMonth,
          CONVERT(char(5),reminder.reminder_time,108) AS time,reminder.timezone,reminder.subject,
          JSON_QUERY(COALESCE((SELECT email_normalized AS value FROM settings.administrative_reminder_recipients
            WHERE reminder_kind=reminder.reminder_kind ORDER BY email_normalized FOR JSON PATH),N'[]')) AS recipients
        FROM settings.administrative_reminders reminder WHERE reminder.reminder_kind='sag_web_version'
        FOR JSON PATH,WITHOUT_ARRAY_WRAPPER) AS sag_web_reminder_json,
      (SELECT reminder.enabled,reminder.send_rule AS sendRule,reminder.day_of_month AS dayOfMonth,
          CONVERT(char(5),reminder.reminder_time,108) AS time,reminder.timezone,reminder.subject,
          JSON_QUERY(COALESCE((SELECT email_normalized AS value FROM settings.administrative_reminder_recipients
            WHERE reminder_kind=reminder.reminder_kind ORDER BY email_normalized FOR JSON PATH),N'[]')) AS recipients
        FROM settings.administrative_reminders reminder WHERE reminder.reminder_kind='whats_new'
        FOR JSON PATH,WITHOUT_ARRAY_WRAPPER) AS whats_new_reminder_json
    FROM settings.email_settings settings
    WHERE settings.settings_key=1 AND settings.source_id=N'email-alerts';
  `);
  return result.recordset[0] ? mapSqlEmailAlertsSettings(result.recordset[0]) : null;
}
