import { getContainer } from "./cosmos";
import { toKeyVaultSecretName } from "./keyVaultNames";
import * as keyVault from "./keyVault";
import type { EmailAlertsSettings } from "../types/models";

export const SETTINGS_ID = "email-alerts";

const DEFAULTS: EmailAlertsSettings = {
  id: SETTINGS_ID,
  emailProvider: "mock",
  emailFrom: "info@pya.com.co",
  emailFromName: "Programador de Actualizaciones",
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
  overdueAlertRecipientRoleIds: ["admin"],
  overdueAlertCustomEmails: [],
  overdueAlertFrequency: "daily",
  overdueAlertWeekdays: ["MONDAY"],
  overdueAlertLastSentPeriod: null,
  blockedAlertsEnabled: true,
  blockedAlertRecipientRoleIds: ["admin"],
  blockedAlertCustomEmails: [],
  blockedAlertSendImmediately: true,
  blockedAlertIncludeInOverdueSummary: true,
  administrativeReminders: {
    sagWebVersionReminder: {
      enabled: false,
      recipients: [],
      dayOfMonth: 1,
      time: "08:00",
      timezone: "America/Bogota",
      subject: "Recordatorio: registrar la versión mensual de SAG Web",
    },
    whatsNewReminder: {
      enabled: false,
      recipients: [],
      dayOfMonth: 1,
      time: "08:00",
      timezone: "America/Bogota",
      subject: "Recordatorio: crear documento \"¿Qué hay de nuevo en SAG Web?\"",
    },
  },
  passwordNotificationEnabled: true,
  sendTemporaryPasswordByEmail: false,
};

// Lee la configuración desde Cosmos. Si no existe, devuelve los defaults
// combinados con valores de variables de entorno como respaldo.
export async function loadEmailAlertsSettings(): Promise<EmailAlertsSettings> {
  try {
    const { resource } = await getContainer("appSettings").item(SETTINGS_ID, SETTINGS_ID).read<EmailAlertsSettings>();
    if (resource) return { ...DEFAULTS, ...resource, id: SETTINGS_ID };
  } catch {/* ignorar — usar defaults */}
  // Fallback a variables de entorno cuando no hay documento todavía.
  return {
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
  if (typeof smtpPassword === "string" && smtpPassword.length > 0) {
    const baseName = `smtp-password-${rest.smtpUser ?? current.smtpUser ?? "default"}`;
    smtpPasswordSecretName = toKeyVaultSecretName(baseName);
    try {
      await keyVault.setSecret(smtpPasswordSecretName, smtpPassword);
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
