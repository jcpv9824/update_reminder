import { getContainer } from "./cosmos";
import { getDataBackend } from "./dataBackend";
import { readSqlEmailAlertsSettings, type StoredEmailAlertsSettings } from "./emailSettingsSqlRepository";
import { toKeyVaultSecretName } from "./keyVaultNames";
import * as keyVault from "./keyVault";
import type { EmailAlertsSettings } from "../types/models";
import { saveSqlEmailAlertsSettings } from "./emailSettingsSqlWriteRepository";

export const SETTINGS_ID = "email-alerts";

const DEFAULTS: EmailAlertsSettings = {
  id: SETTINGS_ID,
  emailProvider: "mock",
  emailFrom: "info@pya.com.co",
  emailFromName: "Portal SAG Web",
  frontendBaseUrl: "https://agreeable-wave-07469d50f.7.azurestaticapps.net",
  smtpHost: "smtp.office365.com",
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: "info@pya.com.co",
  smtpPasswordSecretName: undefined,
  smtpPasswordConfigured: false,
  remindersEnabled: true,
  defaultReminderDaysBefore: [3, 1, 0],
  defaultReminderTime: "08:00",
  defaultTimezone: "America/Bogota",
  overdueAlertsEnabled: true,
  overdueAlertTime: "08:00",
  overdueAlertTimezone: "America/Bogota",
  overdueAlertRecipientsMode: "admins",
  customAdminAlertEmails: [],
  overdueAlertRecipientRoleIds: ["super_admin"],
  overdueAlertCustomEmails: [],
  overdueAlertFrequency: "daily",
  overdueAlertWeekdays: ["MONDAY"],
  overdueAlertLastSentPeriod: null,
  blockedAlertsEnabled: true,
  blockedAlertRecipientRoleIds: ["super_admin"],
  blockedAlertCustomEmails: [],
  blockedAlertSendImmediately: true,
  blockedAlertIncludeInOverdueSummary: true,
  blockedReminderEnabled: false,
  blockedReminderDaysAfter: [1, 3, 5],
  blockedReminderTime: "08:00",
  blockedReminderTimezone: "America/Bogota",
  administrativeReminders: {
    sagWebVersionReminder: {
      enabled: false,
      recipients: [],
      sendRule: "last_business_day",
      dayOfMonth: 1,
      time: "08:00",
      timezone: "America/Bogota",
      subject: "Recordatorio: guardar la última versión mensual de SAG Web",
    },
    whatsNewReminder: {
      enabled: false,
      recipients: [],
      sendRule: "last_business_day",
      dayOfMonth: 1,
      time: "08:00",
      timezone: "America/Bogota",
      subject: "Recordatorio: crear documento \"¿Qué hay de nuevo en SAG Web?\"",
    },
  },
  passwordNotificationEnabled: true,
  sendTemporaryPasswordByEmail: false,
};

export function mergeEmailAlertsSettings(stored: StoredEmailAlertsSettings): EmailAlertsSettings {
  const defaultAdministrative = DEFAULTS.administrativeReminders!;
  return {
    ...DEFAULTS,
    ...stored,
    id: SETTINGS_ID,
    administrativeReminders: {
      sagWebVersionReminder: {
        ...defaultAdministrative.sagWebVersionReminder,
        ...(stored.administrativeReminders?.sagWebVersionReminder ?? {}),
      },
      whatsNewReminder: {
        ...defaultAdministrative.whatsNewReminder,
        ...(stored.administrativeReminders?.whatsNewReminder ?? {}),
      },
    },
  };
}

function parityShape(settings: EmailAlertsSettings): string {
  return JSON.stringify({
    provider: settings.emailProvider,
    remindersEnabled: settings.remindersEnabled,
    defaultDays: settings.defaultReminderDaysBefore.length,
    overdueEnabled: settings.overdueAlertsEnabled,
    overdueRoles: settings.overdueAlertRecipientRoleIds?.length ?? 0,
    overdueEmails: settings.overdueAlertCustomEmails?.length ?? 0,
    legacyEmails: settings.customAdminAlertEmails?.length ?? 0,
    weekdays: settings.overdueAlertWeekdays?.length ?? 0,
    blockedEnabled: settings.blockedAlertsEnabled,
    blockedRoles: settings.blockedAlertRecipientRoleIds?.length ?? 0,
    blockedEmails: settings.blockedAlertCustomEmails?.length ?? 0,
    blockedDays: settings.blockedReminderDaysAfter?.length ?? 0,
    administrative: Object.values(settings.administrativeReminders ?? {}).filter((reminder) => reminder.enabled).length,
    passwordNotificationEnabled: settings.passwordNotificationEnabled,
  });
}

// Lee la configuración desde Cosmos. Si no existe, devuelve los defaults
// combinados con valores de variables de entorno como respaldo.
export async function loadEmailAlertsSettings(): Promise<EmailAlertsSettings> {
  const backend = getDataBackend();
  if (backend === "sql") {
    const stored = await readSqlEmailAlertsSettings();
    if (!stored) throw Object.assign(new Error("La configuración SQL email-alerts no existe."), { status: 503 });
    return mergeEmailAlertsSettings(stored);
  }
  let primary: EmailAlertsSettings | null = null;
  try {
    const { resource } = await getContainer("appSettings").item(SETTINGS_ID, SETTINGS_ID).read<EmailAlertsSettings>();
    if (resource) primary = mergeEmailAlertsSettings(resource);
  } catch {/* ignorar — usar defaults */}
  // Fallback a variables de entorno cuando no hay documento todavía.
  primary ??= {
    ...DEFAULTS,
    emailProvider: (process.env.EMAIL_PROVIDER as any) ?? DEFAULTS.emailProvider,
    emailFrom: process.env.EMAIL_FROM ?? DEFAULTS.emailFrom,
    emailFromName: process.env.EMAIL_FROM_NAME ?? DEFAULTS.emailFromName,
    frontendBaseUrl: process.env.FRONTEND_BASE_URL ?? DEFAULTS.frontendBaseUrl,
    smtpHost: process.env.SMTP_HOST ?? DEFAULTS.smtpHost,
    smtpPort: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : DEFAULTS.smtpPort,
    smtpSecure: process.env.SMTP_SECURE === "true",
    smtpUser: process.env.SMTP_USER ?? DEFAULTS.smtpUser,
  };
  if (backend === "dual-read") {
    const stored = await readSqlEmailAlertsSettings();
    if (!stored || parityShape(primary) !== parityShape(mergeEmailAlertsSettings(stored))) {
      console.warn("Email settings dual-read parity mismatch.");
    }
  }
  return primary;
}

// Devuelve la configuración SIN secretos para enviarla al frontend.
export function sanitizeForResponse(s: EmailAlertsSettings): Omit<EmailAlertsSettings, "smtpPasswordSecretName"> & { smtpPasswordConfigured: boolean } {
  const { smtpPasswordSecretName, ...rest } = s;
  return { ...rest, smtpPasswordConfigured: !!s.smtpPasswordConfigured };
}

// Guarda configuración. Si viene smtpPassword (texto), la persiste en Key Vault
// y guarda solo el nombre del secreto + flag en Cosmos.
export async function saveEmailAlertsSettings(args: {
  patch: Partial<EmailAlertsSettings> & { smtpPassword?: string };
  performedBy: string;
}): Promise<EmailAlertsSettings> {
  const current = await loadEmailAlertsSettings();
  const { smtpPassword, ...rest } = args.patch;

  // Si el admin envía una nueva contraseña, sanitizar nombre y guardar en Key Vault.
  let smtpPasswordSecretName = current.smtpPasswordSecretName;
  let smtpPasswordConfigured = !!current.smtpPasswordConfigured;
  let priorSecretValue: string | null = null;
  let wroteSecret = false;
  if (typeof smtpPassword === "string" && smtpPassword.length > 0) {
    const baseName = `smtp-password-${rest.smtpUser ?? current.smtpUser ?? "default"}`;
    smtpPasswordSecretName = toKeyVaultSecretName(baseName);
    try {
      try { priorSecretValue = await keyVault.getSecret(smtpPasswordSecretName); } catch { priorSecretValue = null; }
      await keyVault.setSecret(smtpPasswordSecretName, smtpPassword);
      wroteSecret = true;
      smtpPasswordConfigured = true;
    } catch (e: any) {
      throw new Error(`No se pudo guardar la contraseña SMTP en Key Vault: ${e?.message ?? e}`);
    }
  }

  const now = new Date().toISOString();
  const next: EmailAlertsSettings = {
    ...current,
    ...rest,
    id: SETTINGS_ID,
    smtpPasswordSecretName,
    smtpPasswordConfigured,
    createdAt: current.createdAt ?? now,
    createdBy: current.createdBy ?? args.performedBy,
    updatedAt: now,
    updatedBy: args.performedBy,
  };

  if (getDataBackend() === "sql") {
    try {
      return await saveSqlEmailAlertsSettings(current, next, args.performedBy);
    } catch (error) {
      if (wroteSecret && smtpPasswordSecretName) {
        try {
          if (priorSecretValue !== null) await keyVault.setSecret(smtpPasswordSecretName, priorSecretValue);
          else await keyVault.deleteSecret(smtpPasswordSecretName);
        } catch {
          throw Object.assign(new Error("La configuración SQL falló y no se pudo compensar el secreto SMTP; revise Key Vault antes de reintentar."), { cause: error });
        }
      }
      throw error;
    }
  }

  await getContainer("appSettings").items.upsert(next);
  return next;
}

// Recupera la contraseña SMTP del Key Vault. Devuelve null si no está configurada
// o no se puede acceder. Nunca lanza para evitar exposición.
export async function getSmtpPassword(s: EmailAlertsSettings): Promise<string | null> {
  if (!s.smtpPasswordSecretName) {
    // Fallback a variable de entorno.
    return process.env.SMTP_PASSWORD ?? null;
  }
  try {
    return await keyVault.getSecret(s.smtpPasswordSecretName);
  } catch {
    return process.env.SMTP_PASSWORD ?? null;
  }
}
