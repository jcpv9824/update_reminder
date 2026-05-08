// Tipos compartidos del frontend (espejo del backend).
export type Role =
  | "admin"
  | "client_manager"
  | "database_updater"
  | "domain_updater"
  | "viewer";

export type Usuario = {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  active?: boolean;
};

export type RespuestaMe =
  | { authenticated: true; registered: true; user: Usuario }
  | { authenticated: true; registered: false; user: Usuario; message: string };

export type Cliente = {
  id: string;
  name: string;
  status: "active" | "inactive" | "deleted";
  notes?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
};

export type Dominio = {
  id: string;
  clientId: string;
  clientName: string;
  domainName: string;
  environment: string;
  currentWebVersion?: string;
  assignedUpdaterIds: string[];
  status: "active" | "inactive" | "deleted";
  notes?: string;
  createdAt: string;
  updatedAt: string;
  lastUpdatedAt?: string | null;
  lastUpdatedBy?: string | null;
};

export type BaseDeDatos = {
  id: string;
  clientId: string;
  clientName: string;
  domainId: string;
  domainName: string;
  companyName: string;
  environment: string;
  dbAccess: {
    serverHostPort: string;
    initialCatalog: string;
    userId: string;
    passwordSecretName: string;
  };
  currentDbVersion?: string;
  assignedUpdaterIds: string[];
  status: "active" | "inactive" | "deleted";
  notes?: string;
  createdAt: string;
  updatedAt: string;
  lastUpdatedAt?: string | null;
  lastUpdatedBy?: string | null;
};

export type Frecuencia = {
  id: string;
  clientId: string;
  clientName: string;
  domainId?: string;
  domainName?: string;
  targetType: "domain" | "database";
  targetIds: string[];
  frequencyType: "weekly" | "interval" | "monthly" | "manual";
  everyNWeeks?: number;
  weekdays?: string[];
  intervalDays?: number;
  preferredWeekdays?: string[];
  dayOfMonth?: number;
  startDate: string;
  endDate?: string | null;
  timezone: string;
  assignedRole: string;
  assignedUserIds: string[];
  databaseAssignedUserIds?: string[];
  databaseReminderRecipientsMode?: "assignedUsers" | "roleUsers";
  origin?: "domain_default" | "special" | "database_inherited" | string;
  active: boolean;
  reminders?: {
    remindersEnabled: boolean;
    reminderDaysBefore: number[];
    reminderTime: string;
    reminderRecipientsMode: "assignedUsers" | "roleUsers" | "customEmails";
    customReminderEmails?: string[];
  };
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

export type EstadoTarea =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "reopened";

export type Tarea = {
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
  status: EstadoTarea;
  result: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  completedBy: string | null;
  completedWithProblems?: boolean;
  problemNote?: string;
  completionNote?: string;
};

export type RegistroAuditoria = {
  id: string;
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
  performedAt: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
};

export const ETIQUETAS_ROLES: Record<string, string> = {
  admin: "Administrador",
  client_manager: "Administrador de clientes",
  database_updater: "Actualizador de bases de datos",
  domain_updater: "Actualizador de dominios",
  viewer: "Visualizador",
};

export const ETIQUETAS_ESTADO: Record<string, string> = {
  active: "Activo",
  inactive: "Inactivo",
  deleted: "Eliminado",
  pending: "Pendiente",
  in_progress: "En progreso",
  completed: "Completada",
  failed: "Fallida",
  blocked: "Bloqueada",
  cancelled: "Cancelada",
  reopened: "Reabierta",
};

export const ETIQUETAS_AMBIENTE: Record<string, string> = {
  production: "Producción",
  staging: "Pre-producción",
  test: "Pruebas",
  development: "Desarrollo",
};

export const ETIQUETAS_FRECUENCIA: Record<string, string> = {
  weekly: "Semanal",
  interval: "Intervalo de días",
  monthly: "Mensual",
  manual: "Manual",
};

export const DIAS_SEMANA: Record<string, string> = {
  MONDAY: "Lunes",
  TUESDAY: "Martes",
  WEDNESDAY: "Miércoles",
  THURSDAY: "Jueves",
  FRIDAY: "Viernes",
  SATURDAY: "Sábado",
  SUNDAY: "Domingo",
};

export const ETIQUETAS_ACCION_AUDITORIA: Record<string, string> = {
  user_created: "Usuario creado",
  user_updated: "Usuario actualizado",
  user_deactivated: "Usuario desactivado",
  roles_updated: "Roles modificados",
  client_created: "Cliente creado",
  client_updated: "Cliente actualizado",
  client_deactivated: "Cliente desactivado",
  client_reactivated: "Cliente reactivado",
  client_deleted: "Cliente eliminado",
  domain_created: "Dominio creado",
  domain_updated: "Dominio actualizado",
  domain_deactivated: "Dominio desactivado",
  domain_reactivated: "Dominio reactivado",
  domain_deleted: "Dominio eliminado",
  database_created: "Base de datos creada",
  database_updated: "Base de datos actualizada",
  database_deactivated: "Base de datos desactivada",
  database_reactivated: "Base de datos reactivada",
  database_deleted: "Base de datos eliminada",
  database_access_part_copied: "Parte de acceso copiada",
  database_password_revealed: "Contraseña revelada",
  database_password_copied: "Contraseña copiada",
  schedule_created: "Frecuencia creada",
  schedule_updated: "Frecuencia actualizada",
  schedule_deactivated: "Frecuencia desactivada",
  schedule_reactivated: "Frecuencia reactivada",
  schedule_deleted: "Frecuencia eliminada",
  task_generated: "Tarea generada",
  task_started: "Tarea iniciada",
  task_completed: "Tarea completada",
  task_failed: "Tarea marcada como fallida",
  task_blocked: "Tarea bloqueada",
  task_reopened: "Tarea reabierta",
  task_cancelled: "Tarea cancelada",
};
