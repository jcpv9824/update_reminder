// Tipos del modelo de datos del programador de actualizaciones del ERP.

export type Role =
  | "admin"
  | "client_manager"
  | "database_updater"
  | "domain_updater"
  | "viewer";

export type EntityStatus = "active" | "inactive" | "deleted";

export type Environment = "production" | "staging" | "test" | "development";

export type CurrentUser = {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
};

export type UserRecord = {
  id: string;
  displayName: string;
  email: string;
  roles: string[];
  active: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  lastLoginAt?: string | null;
  passwordHash?: string;
  passwordUpdatedAt?: string | null;
  mustChangePassword?: boolean;
  // Reset de contraseña: nunca guardar el token en texto plano.
  passwordResetTokenHash?: string | null;
  passwordResetExpiresAt?: string | null;
  passwordResetUsedAt?: string | null;
};

// Configuración de recordatorios por email para una frecuencia.
export type RemindersConfig = {
  remindersEnabled: boolean;
  reminderDaysBefore: number[];  // 0 = el mismo día
  reminderTime: string;          // "HH:mm" en la zona horaria de la frecuencia
  reminderRecipientsMode: "assignedUsers" | "roleUsers" | "customEmails";
  customReminderEmails?: string[];
};

export type ClientRecord = {
  id: string;
  name: string;
  status: EntityStatus;
  notes?: string;
  licenseModuleIds?: string[];
  licenseModuleNames?: string[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  deletedAt?: string | null;
  deletedBy?: string | null;
};

export type DomainRecord = {
  id: string;
  clientId: string;
  clientName: string;
  domainName: string;
  environment: Environment | string;
  currentWebVersion?: string;
  assignedUpdaterIds: string[];
  status: EntityStatus;
  notes?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  deletedAt?: string | null;
  deletedBy?: string | null;
  lastUpdatedAt?: string | null;
  lastUpdatedBy?: string | null;
};

export type DbAccess = {
  serverHostPort: string;
  initialCatalog: string;
  userId: string;
  passwordSecretName: string;
};

export type DatabaseRecord = {
  id: string;
  clientId: string;
  clientName: string;
  domainId: string;
  domainName: string;
  companyName: string;
  environment: Environment | string;
  dbAccess: DbAccess;
  currentDbVersion?: string;
  assignedUpdaterIds: string[];
  status: EntityStatus;
  notes?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  deletedAt?: string | null;
  deletedBy?: string | null;
  lastUpdatedAt?: string | null;
  lastUpdatedBy?: string | null;
};

export type LicenseModuleRecord = {
  id: string;
  name: string;
  code?: string;
  description?: string;
  status?: EntityStatus;
  active?: boolean;
  notes?: string;
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
  deletedAt?: string | null;
  deletedBy?: string | null;
};

export type LicenseAssignmentLevel = "client" | "domain" | "database";

export type LicenseAssignmentRecord = {
  id: string;
  moduleId: string;
  moduleName?: string;
  moduleCode?: string;
  clientId?: string;
  clientName?: string;
  domainId?: string;
  domainName?: string;
  databaseId?: string;
  databaseName?: string;
  environment?: string;
  targetType?: LicenseAssignmentLevel;
  targetId?: string;
  status?: EntityStatus;
  active?: boolean;
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
  deletedAt?: string | null;
  deletedBy?: string | null;
};

export type ScheduleScopeGroup = {
  clientId: string;
  includeAllDomains: boolean;
  domains: Array<{
    domainId: string;
    includeAllDatabases: boolean;
    databaseIds: string[];
  }>;
};

export type ScheduleAssignmentMode = "role" | "users";
export type ScheduleSelectionMode = "manual" | "licensing";
export type LicenseMatchMode = "any" | "all";
export type LicensingTargetTypes = "domains_and_databases" | "domains_only" | "databases_only";

export type LicensingScope = {
  licenseModuleIds: string[];
  licenseMatchMode: LicenseMatchMode;
  environment: "all" | string;
  targetTypes: LicensingTargetTypes;
  activeOnly: boolean;
  excludedDomainIds?: string[];
  excludedDatabaseIds?: string[];
};

export type Weekday =
  | "MONDAY"
  | "TUESDAY"
  | "WEDNESDAY"
  | "THURSDAY"
  | "FRIDAY"
  | "SATURDAY"
  | "SUNDAY";

export type FrequencyType = "once" | "weekly" | "interval" | "monthly" | "manual";
export type ScheduleOrigin = "domain_default" | "special" | "database_inherited";

export type UpdateSchedule = {
  id: string;
  clientId: string;
  clientName: string;
  domainId?: string;
  domainName?: string;
  targetType: "domain" | "database";
  targetIds: string[];
  frequencyType: FrequencyType;
  everyNWeeks?: number;
  weekdays?: Weekday[];
  intervalDays?: number;
  preferredWeekdays?: Weekday[];
  dayOfMonth?: number;
  startDate: string; // YYYY-MM-DD
  endDate?: string | null; // YYYY-MM-DD opcional
  timezone: string;
  assignedRole: Role | string;
  assignedUserIds: string[];
  databaseAssignedUserIds?: string[];
  databaseReminderRecipientsMode?: "assignedUsers" | "roleUsers";
  scopeGroups?: ScheduleScopeGroup[];
  selectionMode?: ScheduleSelectionMode;
  licensingScope?: LicensingScope;
  assignmentMode?: ScheduleAssignmentMode;
  domainAssignedRole?: Role | string;
  databaseAssignedRole?: Role | string;
  origin?: ScheduleOrigin | string;
  active: boolean;
  completedAt?: string | null;
  completedReason?: string | null;
  notes?: string;
  reminders?: RemindersConfig;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
};

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "reopened";

export type UpdateTask = {
  id: string;
  dedupeKey?: string;
  sources?: Array<{
    scheduleId: string;
    scheduleType: "normal" | "special" | "licensing" | "manual";
    reason?: string;
    createdAt: string;
  }>;
  taskDate: string;
  taskBucket: string;
  clientId: string;
  clientName: string;
  domainId: string;
  domainName: string;
  targetType: "domain" | "database";
  targetId: string;
  targetName: string;
  scheduleId: string;
  assignedRole: string;
  assignedUserIds: string[];
  status: TaskStatus;
  result: string | null;
  notes: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  completedAt: string | null;
  completedBy: string | null;
  // Indica si el actualizador reportó algún problema durante la tarea.
  // Una tarea puede estar `status="completed"` y a la vez tener
  // `completedWithProblems=true` y un `problemNote`.
  completedWithProblems?: boolean;
  problemNote?: string;
  completionNote?: string;
  blockedAt?: string | null;
  blockedBy?: string | null;
  blockReason?: string | null;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  resolutionComment?: string | null;
  reopenedAt?: string | null;
  reopenedBy?: string | null;
  reopenReason?: string | null;
  remindersSent?: SentReminder[];
  overdueAlertSentDates?: string[];
};

export type SentReminder = {
  type: "before" | "sameDay";
  daysBefore: number;
  sentAt: string;
  recipients: string[];
};

// Configuración global de correos y alertas (un único documento en
// el contenedor "appSettings" con id="email-alerts").
export type EmailAlertsSettings = {
  id: "email-alerts";
  emailProvider: "mock" | "smtp" | "sendgrid" | "acs";
  emailFrom: string;
  emailFromName: string;
  frontendBaseUrl?: string;

  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPasswordSecretName?: string;
  smtpPasswordConfigured?: boolean;

  remindersEnabled: boolean;
  defaultReminderDaysBefore: number[];
  defaultReminderTime: string;
  defaultTimezone: string;

  overdueAlertsEnabled: boolean;
  overdueAlertTime: string;
  overdueAlertTimezone: string;
  overdueAlertRecipientsMode: "admins" | "adminsAndClientManagers" | "customEmails";
  customAdminAlertEmails?: string[];
  overdueAlertRecipientRoleIds?: string[];
  overdueAlertCustomEmails?: string[];
  overdueAlertFrequency?: "daily" | "weekly";
  overdueAlertWeekdays?: Weekday[];
  overdueAlertLastSentPeriod?: string | null;

  blockedAlertsEnabled?: boolean;
  blockedAlertRecipientRoleIds?: string[];
  blockedAlertCustomEmails?: string[];
  blockedAlertSendImmediately?: boolean;
  blockedAlertIncludeInOverdueSummary?: boolean;
  blockedReminderEnabled?: boolean;
  blockedReminderDaysAfter?: number[];
  blockedReminderTime?: string;
  blockedReminderTimezone?: string;

  administrativeReminders?: {
    sagWebVersionReminder: AdministrativeReminderSettings;
    whatsNewReminder: AdministrativeReminderSettings;
  };

  passwordNotificationEnabled: boolean;
  sendTemporaryPasswordByEmail: boolean;

  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
};

export type AdministrativeReminderSettings = {
  enabled: boolean;
  recipients: string[];
  sendRule?: "first_day" | "last_day" | "last_business_day" | "fixed_day";
  dayOfMonth: number;
  time: string;
  timezone: string;
  subject: string;
};

export type AuditAction = string;

export type AuditLog = {
  id: string;
  entityType: string;
  entityId: string;
  clientId?: string;
  clientName?: string;
  domainId?: string;
  domainName?: string;
  companyName?: string;
  action: AuditAction;
  performedBy: string;
  performedByEmail: string;
  performedAt: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
};
