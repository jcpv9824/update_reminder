import { randomUUID } from "node:crypto";
import type { AuditLog } from "../types/models";

type AuditRule =
  | "scalar"
  | "scalarArray"
  | { object: AuditSchema }
  | { array: AuditRule };
type AuditSchema = Record<string, AuditRule>;

const sourceSchema: AuditSchema = {
  scheduleId: "scalar",
  scheduleType: "scalar",
  createdAt: "scalar",
};

const scopeDatabaseSchema: AuditSchema = { databaseId: "scalar" };
const scopeDomainSchema: AuditSchema = {
  domainId: "scalar",
  includeAllDatabases: "scalar",
  databaseIds: "scalarArray",
  databases: { array: { object: scopeDatabaseSchema } },
};
const scopeGroupSchema: AuditSchema = {
  clientId: "scalar",
  includeAllDomains: "scalar",
  domainIds: "scalarArray",
  domains: { array: { object: scopeDomainSchema } },
};
const remindersSchema: AuditSchema = {
  remindersEnabled: "scalar",
  reminderDaysBefore: "scalarArray",
  reminderTime: "scalar",
  reminderRecipientsMode: "scalar",
  timezone: "scalar",
  useGlobalReminderSettings: "scalar",
};
const licensingScopeSchema: AuditSchema = {
  licenseModuleIds: "scalarArray",
  licenseMatchMode: "scalar",
  environment: "scalar",
  targetTypes: "scalar",
  activeOnly: "scalar",
  excludedDomainIds: "scalarArray",
  excludedDatabaseIds: "scalarArray",
};

const ENTITY_SNAPSHOT_SCHEMAS: Record<string, AuditSchema> = {
  client: {
    id: "scalar", externalId: "scalar", name: "scalar", status: "scalar",
    licenseModuleIds: "scalarArray", licenseModuleNames: "scalarArray",
    createdAt: "scalar", createdBy: "scalar", updatedAt: "scalar", updatedBy: "scalar",
    deletedAt: "scalar", deletedBy: "scalar",
  },
  domain: {
    id: "scalar", clientId: "scalar", clientName: "scalar", domainName: "scalar",
    domainForPublishing: "scalar", environment: "scalar", currentWebVersion: "scalar",
    assignedUpdaterIds: "scalarArray", status: "scalar", lastUpdatedAt: "scalar", lastUpdatedBy: "scalar",
    createdAt: "scalar", createdBy: "scalar", updatedAt: "scalar", updatedBy: "scalar",
    deletedAt: "scalar", deletedBy: "scalar",
  },
  database: {
    id: "scalar", clientId: "scalar", clientName: "scalar", domainId: "scalar", domainName: "scalar",
    companyName: "scalar", environment: "scalar", currentDbVersion: "scalar",
    assignedUpdaterIds: "scalarArray", status: "scalar", lastUpdatedAt: "scalar", lastUpdatedBy: "scalar",
    dbAccess: { object: { initialCatalog: "scalar" } },
    initialCatalog: "scalar",
    createdAt: "scalar", createdBy: "scalar", updatedAt: "scalar", updatedBy: "scalar",
    deletedAt: "scalar", deletedBy: "scalar",
  },
  schedule: {
    id: "scalar", name: "scalar", clientId: "scalar", clientName: "scalar", domainId: "scalar",
    domainName: "scalar", targetType: "scalar", targetIds: "scalarArray", frequencyType: "scalar",
    everyNWeeks: "scalar", weekdays: "scalarArray", intervalDays: "scalar", preferredWeekdays: "scalarArray",
    dayOfMonth: "scalar", startDate: "scalar", endDate: "scalar", timezone: "scalar",
    assignedRole: "scalar", assignedUserIds: "scalarArray", databaseAssignedUserIds: "scalarArray",
    databaseReminderRecipientsMode: "scalar", selectionMode: "scalar", assignmentMode: "scalar",
    domainAssignedRole: "scalar", databaseAssignedRole: "scalar", origin: "scalar", active: "scalar",
    scopeGroups: { array: { object: scopeGroupSchema } },
    licensingScope: { object: licensingScopeSchema },
    reminders: { object: remindersSchema },
    completedAt: "scalar", completedReason: "scalar",
    createdAt: "scalar", createdBy: "scalar", updatedAt: "scalar", updatedBy: "scalar",
    deletedAt: "scalar", deletedBy: "scalar",
  },
  task: {
    id: "scalar", taskDate: "scalar", clientId: "scalar", clientName: "scalar", domainId: "scalar",
    domainName: "scalar", targetType: "scalar", targetId: "scalar", targetName: "scalar",
    scheduleId: "scalar", rootScheduleId: "scalar", dedupeKey: "scalar", assignedRole: "scalar",
    assignedUserIds: "scalarArray", status: "scalar", result: "scalar", completedWithProblems: "scalar",
    createdAt: "scalar", createdBy: "scalar", updatedAt: "scalar", updatedBy: "scalar",
    completedAt: "scalar", completedBy: "scalar", blockedAt: "scalar", blockedBy: "scalar",
    reopenedAt: "scalar", reopenedBy: "scalar", resolvedAt: "scalar", resolvedBy: "scalar",
    sources: { array: { object: sourceSchema } },
  },
  user: {
    id: "scalar", displayName: "scalar", email: "scalar", roles: "scalarArray", active: "scalar",
    mustChangePassword: "scalar", lastLoginAt: "scalar", passwordUpdatedAt: "scalar",
    passwordExpiresAt: "scalar", mfaEnabled: "scalar", mfaEnrolledAt: "scalar",
    createdAt: "scalar", createdBy: "scalar", updatedAt: "scalar", updatedBy: "scalar",
  },
  licenseModule: {
    id: "scalar", name: "scalar", code: "scalar", description: "scalar", status: "scalar", active: "scalar", notes: "scalar",
    createdAt: "scalar", createdBy: "scalar", updatedAt: "scalar", updatedBy: "scalar",
    deletedAt: "scalar", deletedBy: "scalar",
  },
  licenseAssignment: {
    id: "scalar", moduleId: "scalar", moduleName: "scalar", moduleCode: "scalar",
    targetType: "scalar", targetId: "scalar", active: "scalar",
    licenseModuleId: "scalar", licenseModuleName: "scalar", assignmentLevel: "scalar",
    clientId: "scalar", clientName: "scalar", domainId: "scalar", domainName: "scalar",
    databaseId: "scalar", databaseName: "scalar", environment: "scalar", status: "scalar",
    createdAt: "scalar", createdBy: "scalar", updatedAt: "scalar", updatedBy: "scalar",
    deletedAt: "scalar", deletedBy: "scalar",
  },
  fuenteFormato: {
    id: "scalar", nombre: "scalar", activa: "scalar",
    status: "scalar", createdAt: "scalar", createdBy: "scalar", updatedAt: "scalar", updatedBy: "scalar",
    deletedAt: "scalar", deletedBy: "scalar",
  },
  formatoImpresion: {
    id: "scalar", nombre: "scalar", fuenteId: "scalar", fuenteNombre: "scalar",
    fuenteIds: "scalarArray", fuenteNombres: "scalarArray",
    descripcion: "scalar", tamanoFormato: "scalar", tamanoFormatoPersonalizado: "scalar",
    requiereLicencia: "scalar", licenciaModuloId: "scalar", licenciaModuloNombre: "scalar",
    licenciaModuloCodigo: "scalar", pdfNombreOriginal: "scalar", pdfMimeType: "scalar", activo: "scalar",
    status: "scalar", createdAt: "scalar", createdBy: "scalar",
    updatedAt: "scalar", updatedBy: "scalar", deletedAt: "scalar", deletedBy: "scalar",
  },
  publicDownloadSection: {
    id: "scalar", nombre: "scalar", slug: "scalar", descripcion: "scalar", activa: "scalar",
    status: "scalar", createdAt: "scalar", createdBy: "scalar", updatedAt: "scalar", updatedBy: "scalar",
    deletedAt: "scalar", deletedBy: "scalar",
  },
  publicDownloadDocument: {
    id: "scalar", sectionId: "scalar", sectionName: "scalar", sectionSlug: "scalar",
    titulo: "scalar", slug: "scalar", descripcion: "scalar", assetKind: "scalar", archivoNombreOriginal: "scalar",
    archivoMimeType: "scalar", archivoBytes: "scalar", activo: "scalar", status: "scalar",
    createdAt: "scalar", createdBy: "scalar", updatedAt: "scalar", updatedBy: "scalar",
    deletedAt: "scalar", deletedBy: "scalar",
  },
  settings: {
    id: "scalar", emailProvider: "scalar", emailEnabled: "scalar", smtpPort: "scalar", smtpSecure: "scalar",
    updaterRemindersEnabled: "scalar", reminderDaysBefore: "scalarArray", reminderTime: "scalar",
    timezone: "scalar", overdueAlertsEnabled: "scalar", overdueFrequency: "scalar",
    overdueWeekday: "scalar", overdueTime: "scalar", blockedAlertsEnabled: "scalar",
    blockedReminderEnabled: "scalar", blockedReminderDaysAfter: "scalarArray",
    passwordNotificationEnabled: "scalar", updatedAt: "scalar", updatedBy: "scalar",
  },
};

const COMMON_COUNT_FIELDS = [
  "clients", "domains", "databases", "schedules", "tasks", "futureTasks", "openTasks",
  "created", "updated", "obsoleted", "skipped", "deduplicated", "updatedSources",
  "cancelledTasks", "cancelledOpenTasks", "cascadeSchedules", "obsoletedTasks", "recipientsCount",
] as const;

function fields(...keys: string[]): AuditSchema {
  return Object.fromEntries(keys.map((key) => [key, "scalar"])) as AuditSchema;
}

const cascadeFields = fields(
  ...COMMON_COUNT_FIELDS,
  "cascadeFromClient", "cascadeFromDomain", "cascadeFromDatabase"
);
const refreshFields = fields("date", "windowStart", "windowEnd", "created", "updated", "obsoleted", "skipped", "deduplicated", "updatedSources");

const ACTION_METADATA_SCHEMAS: Record<string, AuditSchema> = {
  password_reset_requested: fields("expiresAt"),
  mandatory_password_changed: fields(),
  mfa_enabled: fields(),
  mfa_recovery_code_used: fields(),
  user_created: fields("firstAdmin"),
  user_password_reset: fields("setup"),
  password_notification_sent: fields("kind", "includedPassword"),
  password_notification_failed: fields("kind", "includedPassword"),
  task_status_notification_sent: fields("notificationType"),
  task_status_notification_failed: fields("notificationType"),
  client_deleted_cascade: cascadeFields,
  domain_deleted_cascade: cascadeFields,
  database_deleted_cascade: cascadeFields,
  schedule_deleted_cascade: cascadeFields,
  task_cancelled: fields(...COMMON_COUNT_FIELDS, "cascadeFromClient", "previousStatus", "newStatus"),
  database_deactivated: fields("obsoletedTasks"),
  database_reactivated: fields("obsoletedTasks"),
  domain_deactivated: fields("obsoletedTasks"),
  domain_reactivated: fields("obsoletedTasks"),
  database_access_part_copied: fields("part"),
  database_password_copied: fields("databaseId", "taskId"),
  database_password_revealed: fields("databaseId", "taskId"),
  task_generated: fields("scheduleId", "targetType", "targetId", "date"),
  task_assignment_synced: fields("taskId", "scheduleId", "targetType"),
  task_obsoleted: fields("reason", "taskId", "scheduleId", "targetType", "targetId", "domainId", "scheduledFor"),
  tasks_refreshed_manually: refreshFields,
  schedule_one_time_completed: fields("reason", "runDate", "scheduleId"),
  schedule_updated: fields("oneTimeScheduleRescheduled", "oldDate", "newDate", "cancelledOpenTasks"),
  schedule_deleted: fields("cancelledOpenTasks"),
  reminder_email_sent: fields("daysBefore", "targetType"),
  reminder_email_failed: fields("daysBefore", "targetType"),
  blocked_task_reminder_sent: fields("daysAfter", "recipientsCount"),
  blocked_task_reminder_failed: fields("daysAfter", "recipientsCount"),
  administrative_reminder_sent: fields("key", "period", "sendDate", "recipientsCount"),
  administrative_reminder_failed: fields("key", "period", "sendDate", "recipientsCount"),
  admin_reminder_test_sent: fields("key", "period", "sendDate", "recipientsCount"),
  admin_reminder_test_failed: fields("key", "period", "sendDate", "recipientsCount"),
  overdue_alert_sent: fields("date", "recipientsCount", "domainCount", "databaseCount"),
  overdue_alert_failed: fields("date", "recipientsCount", "domainCount", "databaseCount"),
  masters_report_email_sent: fields("recipientsCount", "provider"),
  masters_report_email_failed: fields("recipientsCount", "provider"),
  test_email_sent: fields("provider"),
  test_email_failed: fields("provider"),
  task_started: fields("previousStatus", "newStatus"),
  task_completed: fields("previousStatus", "newStatus"),
  task_completed_with_problems: fields("previousStatus", "newStatus"),
  task_failed: fields("previousStatus", "newStatus"),
  task_blocked: fields("previousStatus", "newStatus"),
  task_reopened: fields("previousStatus", "newStatus"),
  task_cancelled_status: fields("previousStatus", "newStatus"),
  task_block_resolved: fields("previousStatus", "newStatus"),
  rate_limit_exceeded: fields("scope", "keyType", "retryAfterSeconds"),
  account_lockout_triggered: fields("scope", "keyType", "retryAfterSeconds"),
  audit_logs_sanitized: fields("scanned", "updated"),
  fuente_formato_created: fields(),
  fuente_formato_updated: fields(),
  fuente_formato_deleted: fields(),
  formato_impresion_created: fields("pdfLoaded"),
  formato_impresion_updated: fields(),
  formato_impresion_pdf_replaced: fields("previousPdfName", "newPdfName"),
  formato_impresion_deleted: fields(),
  public_download_section_created: fields(),
  public_download_section_updated: fields(),
  public_download_section_deleted: fields(),
  public_download_document_created: fields("fileLoaded", "assetKind"),
  public_download_document_updated: fields(),
  public_download_document_file_replaced: fields("previousFileName", "newFileName", "assetKind"),
  public_download_document_deleted: fields(),
};

const SECRET_CONTENT_PATTERNS = [
  /\bbearer\s+[a-z0-9._~+\/-]+=*/i,
  /\beyJ[a-z0-9_-]+\.eyJ[a-z0-9_-]+\.[a-z0-9_-]+\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:password|pwd|secret|token|api[_-]?key|authorization|cookie|connectionstring)\s*[:=]\s*[^;\s]+/i,
  /\b(?:server|data source|initial catalog|database|user id|uid|password|pwd|accountkey|sharedaccesssignature)\s*=/i,
  /[?&](?:token|api[_-]?key|key|code|sig)=[^&\s]+/i,
  /:\/\/[^\s/@:]+:[^\s/@]+@/i,
];

function sanitizeScalar(value: unknown): string | number | boolean | null | undefined {
  if (value == null) return value as null | undefined;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  if (SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(value))) return "[REDACTED]";
  return value.length > 1000 ? `${value.slice(0, 1000)}…` : value;
}

function sanitizeByRule(value: unknown, rule: AuditRule): unknown {
  if (rule === "scalar") return sanitizeScalar(value);
  if (rule === "scalarArray") {
    if (!Array.isArray(value)) return undefined;
    return value.slice(0, 200).map(sanitizeScalar).filter((item) => item !== undefined);
  }
  if ("object" in rule) return sanitizeObject(value, rule.object);
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 200).map((item) => sanitizeByRule(item, rule.array)).filter((item) => item !== undefined);
}

function sanitizeObject(value: unknown, schema: AuditSchema | undefined): Record<string, unknown> | undefined {
  if (!schema || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(schema)) {
    if (!(key in input)) continue;
    const sanitized = sanitizeByRule(input[key], rule);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export const AUDIT_DATA_CLASSIFICATION = {
  operational: "IDs, nombres, estados, fechas, roles, alcance y conteos autorizados por allowlist.",
  personal: "Correo del actor; se conserva para trazabilidad con acceso restringido a auditoria.",
  restricted: "Servidor, usuario SQL, destinatarios, errores externos y texto libre se omiten de snapshots/metadata.",
  secret: "Passwords, hashes, tokens, JWT, cookies, authorization, API keys, connection strings y cuerpos HTTP nunca se guardan.",
} as const;

export type BuildAuditLogInput = {
  entityType: string;
  entityId: string;
  clientId?: string;
  clientName?: string;
  domainId?: string;
  domainName?: string;
  companyName?: string;
  action: string;
  performedBy: string;
  performedByEmail: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
};

export function buildAuditLogEntry(input: BuildAuditLogInput): AuditLog {
  const snapshotSchema = ENTITY_SNAPSHOT_SCHEMAS[input.entityType];
  const metadataSchema = ACTION_METADATA_SCHEMAS[input.action];
  return {
    id: `audit_${randomUUID()}`,
    entityType: sanitizeScalar(input.entityType) as string,
    entityId: sanitizeScalar(input.entityId) as string,
    clientId: sanitizeScalar(input.clientId) as string | undefined,
    clientName: sanitizeScalar(input.clientName) as string | undefined,
    domainId: sanitizeScalar(input.domainId) as string | undefined,
    domainName: sanitizeScalar(input.domainName) as string | undefined,
    companyName: sanitizeScalar(input.companyName) as string | undefined,
    action: sanitizeScalar(input.action) as string,
    performedBy: sanitizeScalar(input.performedBy) as string,
    performedByEmail: sanitizeScalar(input.performedByEmail) as string,
    performedAt: new Date().toISOString(),
    before: sanitizeObject(input.before, snapshotSchema),
    after: sanitizeObject(input.after, snapshotSchema),
    metadata: sanitizeObject(input.metadata, metadataSchema),
  };
}

export function sanitizeStoredAuditLogEntry(entry: AuditLog): AuditLog {
  const sanitized = buildAuditLogEntry({
    entityType: entry.entityType,
    entityId: entry.entityId,
    clientId: entry.clientId,
    clientName: entry.clientName,
    domainId: entry.domainId,
    domainName: entry.domainName,
    companyName: entry.companyName,
    action: entry.action,
    performedBy: entry.performedBy,
    performedByEmail: entry.performedByEmail,
    before: entry.before,
    after: entry.after,
    metadata: entry.metadata,
  });
  return { ...sanitized, id: entry.id, performedAt: entry.performedAt };
}

// Solo este builder puede crear documentos de auditoria. Los handlers nunca
// deben persistir req, headers, cookies ni cuerpos HTTP completos.
export async function writeAuditLog(input: BuildAuditLogInput): Promise<AuditLog> {
  const { getDataBackend } = await import("./dataBackend");
  if (getDataBackend() === "sql") {
    const { appendSqlAuditLog } = await import("./auditSqlWriter");
    return appendSqlAuditLog(input);
  }
  const entry = buildAuditLogEntry(input);
  const { getContainer } = await import("./cosmos");
  const container = getContainer("auditLogs");
  await container.items.create(entry);
  return entry;
}
