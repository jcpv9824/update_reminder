import sql from "mssql";
import type { AdministrativeReminderSettings, EmailAlertsSettings, Weekday } from "../types/models";
import { writeSqlAuditLog } from "./auditSqlWriter";
import { normalizeEmail } from "./password";
import { runSqlTransaction } from "./sqlTransaction";

const weekdayNumber: Record<Weekday, number> = {
  MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4,
  FRIDAY: 5, SATURDAY: 6, SUNDAY: 7,
};

async function insertValues(
  transaction: sql.Transaction,
  table: "default_reminder_days" | "overdue_alert_weekdays" | "blocked_reminder_days",
  column: "days_before" | "weekday" | "days_after",
  values: number[],
): Promise<void> {
  const remove = new sql.Request(transaction);
  await remove.query(`DELETE settings.${table};`);
  for (const value of [...new Set(values)]) {
    const insert = new sql.Request(transaction);
    insert.input("value", sql.SmallInt, value);
    await insert.query(`INSERT settings.${table}(${column}) VALUES(@value);`);
  }
}

async function replaceRoles(transaction: sql.Transaction, kind: "overdue" | "blocked", roles: string[]): Promise<void> {
  const remove = new sql.Request(transaction);
  remove.input("kind", sql.VarChar(20), kind);
  await remove.query("DELETE settings.alert_recipient_roles WHERE alert_kind=@kind;");
  for (const role of [...new Set(roles)]) {
    const insert = new sql.Request(transaction);
    insert.input("kind", sql.VarChar(20), kind);
    insert.input("role", sql.NVarChar(80), role);
    const result = await insert.query(`
      INSERT settings.alert_recipient_roles(alert_kind,role_id)
      SELECT @kind,role_id FROM security.roles WHERE role_id=@role AND active=1;
      SELECT @@ROWCOUNT AS inserted_count;
    `);
    if (Number(result.recordset[0]?.inserted_count ?? 0) !== 1) throw Object.assign(new Error(`El rol ${role} no existe o está inactivo.`), { status: 400 });
  }
}

async function replaceEmails(transaction: sql.Transaction, kind: "overdue" | "blocked", source: "current" | "legacy", emails: string[]): Promise<void> {
  const remove = new sql.Request(transaction);
  remove.input("kind", sql.VarChar(20), kind);
  remove.input("source", sql.VarChar(20), source);
  await remove.query("DELETE settings.alert_recipient_emails WHERE alert_kind=@kind AND source_kind=@source;");
  for (const email of [...new Set(emails.map(normalizeEmail))]) {
    const insert = new sql.Request(transaction);
    insert.input("kind", sql.VarChar(20), kind);
    insert.input("source", sql.VarChar(20), source);
    insert.input("email", sql.NVarChar(254), email);
    await insert.query("INSERT settings.alert_recipient_emails(alert_kind,email_normalized,source_kind) VALUES(@kind,@email,@source);");
  }
}

async function replaceAdministrativeReminder(
  transaction: sql.Transaction,
  kind: "sag_web_version" | "whats_new",
  reminder: AdministrativeReminderSettings,
): Promise<void> {
  const request = new sql.Request(transaction);
  request.input("kind", sql.VarChar(40), kind);
  request.input("enabled", sql.Bit, reminder.enabled);
  request.input("rule", sql.VarChar(30), reminder.sendRule);
  request.input("day", sql.TinyInt, reminder.dayOfMonth);
  request.input("time", sql.VarChar(5), reminder.time);
  request.input("timezone", sql.NVarChar(100), reminder.timezone);
  request.input("subject", sql.NVarChar(300), reminder.subject);
  await request.query(`
    UPDATE settings.administrative_reminders SET enabled=@enabled,send_rule=@rule,day_of_month=@day,
      reminder_time=CONVERT(time(0),@time),timezone=@timezone,subject=@subject WHERE reminder_kind=@kind;
    IF @@ROWCOUNT=0 INSERT settings.administrative_reminders
      (reminder_kind,enabled,send_rule,day_of_month,reminder_time,timezone,subject)
      VALUES(@kind,@enabled,@rule,@day,CONVERT(time(0),@time),@timezone,@subject);
    DELETE settings.administrative_reminder_recipients WHERE reminder_kind=@kind;
  `);
  for (const email of [...new Set(reminder.recipients.map(normalizeEmail))]) {
    const insert = new sql.Request(transaction);
    insert.input("kind", sql.VarChar(40), kind);
    insert.input("email", sql.NVarChar(254), email);
    await insert.query("INSERT settings.administrative_reminder_recipients(reminder_kind,email_normalized) VALUES(@kind,@email);");
  }
}

export async function saveSqlEmailAlertsSettings(
  before: EmailAlertsSettings,
  next: EmailAlertsSettings,
  performedBy: string,
): Promise<EmailAlertsSettings> {
  return runSqlTransaction(async (transaction) => {
    const request = new sql.Request(transaction);
    request.input("provider", sql.VarChar(20), next.emailProvider);
    request.input("emailFrom", sql.NVarChar(254), next.emailFrom);
    request.input("emailFromName", sql.NVarChar(160), next.emailFromName);
    request.input("frontendUrl", sql.NVarChar(500), next.frontendBaseUrl ?? null);
    request.input("smtpHost", sql.NVarChar(500), next.smtpHost ?? null);
    request.input("smtpPort", sql.Int, next.smtpPort ?? null);
    request.input("smtpSecure", sql.Bit, next.smtpSecure ?? false);
    request.input("smtpUser", sql.NVarChar(256), next.smtpUser ?? null);
    request.input("smtpSecret", sql.NVarChar(256), next.smtpPasswordSecretName ?? null);
    request.input("smtpConfigured", sql.Bit, !!next.smtpPasswordConfigured);
    request.input("remindersEnabled", sql.Bit, next.remindersEnabled);
    request.input("defaultReminderTime", sql.VarChar(5), next.defaultReminderTime);
    request.input("defaultTimezone", sql.NVarChar(100), next.defaultTimezone);
    request.input("overdueEnabled", sql.Bit, next.overdueAlertsEnabled);
    request.input("overdueTime", sql.VarChar(5), next.overdueAlertTime);
    request.input("overdueTimezone", sql.NVarChar(100), next.overdueAlertTimezone);
    request.input("legacyMode", sql.VarChar(40), next.overdueAlertRecipientsMode);
    request.input("overdueFrequency", sql.VarChar(20), next.overdueAlertFrequency ?? "daily");
    request.input("overduePeriod", sql.NVarChar(40), next.overdueAlertLastSentPeriod ?? null);
    request.input("blockedEnabled", sql.Bit, next.blockedAlertsEnabled);
    request.input("blockedImmediate", sql.Bit, next.blockedAlertSendImmediately);
    request.input("blockedOverdue", sql.Bit, next.blockedAlertIncludeInOverdueSummary);
    request.input("blockedReminder", sql.Bit, next.blockedReminderEnabled);
    request.input("blockedTime", sql.VarChar(5), next.blockedReminderTime ?? "08:00");
    request.input("blockedTimezone", sql.NVarChar(100), next.blockedReminderTimezone ?? "America/Bogota");
    request.input("passwordNotifications", sql.Bit, next.passwordNotificationEnabled);
    request.input("sendTemporary", sql.Bit, next.sendTemporaryPasswordByEmail ?? false);
    request.input("createdAt", sql.DateTime2(3), new Date(next.createdAt ?? next.updatedAt ?? new Date()));
    request.input("createdBy", sql.NVarChar(150), next.createdBy ?? performedBy);
    request.input("updatedAt", sql.DateTime2(3), new Date(next.updatedAt ?? new Date()));
    request.input("updatedBy", sql.NVarChar(150), performedBy);
    await request.query(`
      UPDATE settings.email_settings SET email_provider=@provider,email_from=@emailFrom,email_from_name=@emailFromName,
        frontend_base_url=@frontendUrl,smtp_host=@smtpHost,smtp_port=@smtpPort,smtp_secure=@smtpSecure,smtp_user=@smtpUser,
        smtp_password_secret_name=@smtpSecret,smtp_password_configured=@smtpConfigured,reminders_enabled=@remindersEnabled,
        default_reminder_time=CONVERT(time(0),@defaultReminderTime),default_timezone=@defaultTimezone,
        overdue_alerts_enabled=@overdueEnabled,overdue_alert_time=CONVERT(time(0),@overdueTime),overdue_alert_timezone=@overdueTimezone,
        legacy_overdue_recipient_mode=@legacyMode,overdue_alert_frequency=@overdueFrequency,overdue_alert_last_sent_period=@overduePeriod,
        blocked_alerts_enabled=@blockedEnabled,blocked_alert_send_immediately=@blockedImmediate,blocked_alert_include_overdue=@blockedOverdue,
        blocked_reminder_enabled=@blockedReminder,blocked_reminder_time=CONVERT(time(0),@blockedTime),blocked_reminder_timezone=@blockedTimezone,
        password_notification_enabled=@passwordNotifications,send_temporary_password_by_email=@sendTemporary,
        updated_at=@updatedAt,updated_by=@updatedBy WHERE settings_key=1;
      IF @@ROWCOUNT=0 INSERT settings.email_settings
      (settings_key,source_id,email_provider,email_from,email_from_name,frontend_base_url,smtp_host,smtp_port,smtp_secure,
       smtp_user,smtp_password_secret_name,smtp_password_configured,reminders_enabled,default_reminder_time,default_timezone,
       overdue_alerts_enabled,overdue_alert_time,overdue_alert_timezone,legacy_overdue_recipient_mode,overdue_alert_frequency,
       overdue_alert_last_sent_period,blocked_alerts_enabled,blocked_alert_send_immediately,blocked_alert_include_overdue,
       blocked_reminder_enabled,blocked_reminder_time,blocked_reminder_timezone,password_notification_enabled,
       send_temporary_password_by_email,created_at,created_by,updated_at,updated_by)
      VALUES(1,N'email-alerts',@provider,@emailFrom,@emailFromName,@frontendUrl,@smtpHost,@smtpPort,@smtpSecure,
       @smtpUser,@smtpSecret,@smtpConfigured,@remindersEnabled,CONVERT(time(0),@defaultReminderTime),@defaultTimezone,
       @overdueEnabled,CONVERT(time(0),@overdueTime),@overdueTimezone,@legacyMode,@overdueFrequency,@overduePeriod,
       @blockedEnabled,@blockedImmediate,@blockedOverdue,@blockedReminder,CONVERT(time(0),@blockedTime),@blockedTimezone,
       @passwordNotifications,@sendTemporary,@createdAt,@createdBy,@updatedAt,@updatedBy);
    `);
    await insertValues(transaction, "default_reminder_days", "days_before", next.defaultReminderDaysBefore ?? []);
    await insertValues(transaction, "overdue_alert_weekdays", "weekday", (next.overdueAlertWeekdays ?? []).map((day) => weekdayNumber[day]));
    await insertValues(transaction, "blocked_reminder_days", "days_after", next.blockedReminderDaysAfter ?? []);
    await replaceRoles(transaction, "overdue", next.overdueAlertRecipientRoleIds ?? []);
    await replaceRoles(transaction, "blocked", next.blockedAlertRecipientRoleIds ?? []);
    await replaceEmails(transaction, "overdue", "current", next.overdueAlertCustomEmails ?? []);
    await replaceEmails(transaction, "overdue", "legacy", next.customAdminAlertEmails ?? []);
    await replaceEmails(transaction, "blocked", "current", next.blockedAlertCustomEmails ?? []);
    const reminders = next.administrativeReminders;
    if (reminders) {
      await replaceAdministrativeReminder(transaction, "sag_web_version", reminders.sagWebVersionReminder);
      await replaceAdministrativeReminder(transaction, "whats_new", reminders.whatsNewReminder);
    }
    await writeSqlAuditLog(transaction, { entityType: "settings", entityId: "email-alerts", action: "settings_updated",
      performedBy, performedByEmail: "", before, after: next });
    return next;
  });
}
