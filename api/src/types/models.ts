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
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
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
  lastUpdatedAt?: string | null;
  lastUpdatedBy?: string | null;
};

export type Weekday =
  | "MONDAY"
  | "TUESDAY"
  | "WEDNESDAY"
  | "THURSDAY"
  | "FRIDAY"
  | "SATURDAY"
  | "SUNDAY";

export type FrequencyType = "weekly" | "interval" | "monthly" | "manual";

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
  timezone: string;
  assignedRole: Role | string;
  assignedUserIds: string[];
  active: boolean;
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
  remindersSent?: SentReminder[];
  overdueAlertSentDates?: string[];
};

export type SentReminder = {
  type: "before" | "sameDay";
  daysBefore: number;
  sentAt: string;
  recipients: string[];
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
