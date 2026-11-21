import { resolveConfiguredRecipients } from "./emailRecipients";
import { loadEmailAlertsSettings } from "./settingsService";

type Settings = Awaited<ReturnType<typeof loadEmailAlertsSettings>>;

export function resolveSingleTaskNoticeRecipients(type: "blocked_task_reminder" | "task_status_notification",
  problem: unknown, settings: Settings): Promise<string[]> {
  if (type === "blocked_task_reminder") return settings.blockedReminderEnabled
    ? resolveConfiguredRecipients(settings.blockedAlertRecipientRoleIds ?? ["super_admin"], settings.blockedAlertCustomEmails ?? [])
    : Promise.resolve([]);
  if (problem === true && settings.blockedAlertsEnabled !== false) {
    return resolveConfiguredRecipients(settings.blockedAlertRecipientRoleIds?.length ? settings.blockedAlertRecipientRoleIds : ["super_admin"],
      settings.blockedAlertCustomEmails ?? []);
  }
  if (problem === false) {
    return resolveConfiguredRecipients(settings.overdueAlertRecipientRoleIds?.length ? settings.overdueAlertRecipientRoleIds : ["super_admin"],
      settings.overdueAlertCustomEmails ?? []);
  }
  return Promise.resolve([]);
}
