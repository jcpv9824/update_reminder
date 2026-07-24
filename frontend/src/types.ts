// Tipos compartidos del frontend (espejo del backend).
export type Role =
  | "super_admin"
  | "admin"
  | "client_manager"
  | "database_updater"
  | "domain_updater"
  | "viewer"
  | "print_formats_admin"
  | "formatos_impresion.admin"
  | "public_downloads.admin";

export type Usuario = {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  active?: boolean;
  mustChangePassword?: boolean;
  passwordExpiresAt?: string | null;
};

export type RespuestaMe =
  | { authenticated: true; registered: true; user: Usuario }
  | { authenticated: true; registered: false; user: Usuario; message: string };

export type RespuestaPaginada<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
};

export type Cliente = {
  id: string;
  externalId?: string;
  name: string;
  status: "active" | "inactive" | "deleted";
  notes?: string;
  licenseModuleIds?: string[];
  licenseModuleNames?: string[];
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
  assignedUpdaterIds?: string[];
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
    initialCatalog: string;
  };
  currentDbVersion?: string;
  assignedUpdaterIds?: string[];
  status: "active" | "inactive" | "deleted";
  notes?: string;
  createdAt: string;
  updatedAt: string;
  lastUpdatedAt?: string | null;
};

export type AccesoBaseDatos = {
  server: string;
  databaseName: string;
  user: string;
  hasPassword: boolean;
};

export type ModuloLicencia = {
  id: string;
  name: string;
  code?: string;
  description?: string;
  status: "active" | "inactive" | "deleted";
  active?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type NivelAsignacionLicencia = "client" | "domain" | "database";

export type AsignacionLicencia = {
  id: string;
  moduleId: string;
  moduleName?: string;
  moduleCode?: string;
  targetType: NivelAsignacionLicencia;
  targetId?: string;
  clientId: string;
  clientName?: string;
  domainId?: string;
  domainName?: string;
  databaseId?: string;
  databaseName?: string;
  environment?: string;
  status: "active" | "inactive" | "deleted";
  active?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type FuenteFormato = {
  id: string;
  nombre: string;
  activa: boolean;
  status: "active" | "inactive" | "deleted";
  formatosActivos?: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
};

export type FormatoImpresion = {
  id: string;
  nombre: string;
  fuenteId: string;
  fuenteNombre: string;
  fuenteIds?: string[];
  fuenteNombres?: string[];
  descripcion: string;
  tamanoFormato?: "carta" | "oficio" | "a4" | "legal" | "personalizado";
  tamanoFormatoPersonalizado?: string;
  requiereLicencia?: boolean;
  licenciaModuloId?: string;
  licenciaModuloNombre?: string;
  licenciaModuloCodigo?: string;
  pdfNombreOriginal: string;
  pdfMimeType: "application/pdf";
  pdfUrl: string;
  downloadUrl: string;
  activo: boolean;
  status: "active" | "inactive" | "deleted";
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
};

export type PublicDownloadDocument = {
  id: string;
  titulo: string;
  slug: string;
  descripcion?: string;
  assetKind: "document" | "video";
  archivoNombreOriginal: string;
  archivoMimeType: string;
  archivoBytes: number;
  downloadUrl: string;
  legacyDownloadUrl: string;
  activo: boolean;
  status: "active" | "inactive" | "deleted";
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
};

export type PublicFile = {
  id: string;
  titulo: string;
  slug: string;
  descripcion?: string;
  assetKind: "image" | "video" | "pdf";
  archivoNombreOriginal: string;
  archivoMimeType: string;
  archivoBytes: number;
  viewUrl: string;
  activo: boolean;
  status: "active" | "inactive" | "deleted";
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
};

export type Frecuencia = {
  id: string;
  name?: string;
  clientId: string;
  clientName: string;
  domainId?: string;
  domainName?: string;
  targetType: "domain" | "database";
  targetIds: string[];
  frequencyType: "once" | "weekly" | "interval" | "monthly" | "manual";
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
  scopeGroups?: Array<{
    clientId: string;
    includeAllDomains: boolean;
    domains: Array<{ domainId: string; includeAllDatabases: boolean; databaseIds: string[] }>;
  }>;
  selectionMode?: "manual" | "licensing";
  manualTargetTypes?: "domains_and_databases" | "domains_only" | "databases_only";
  licensingScope?: {
    licenseModuleIds: string[];
    licenseMatchMode: "any" | "all";
    environment: "all" | string;
    targetTypes: "domains_and_databases" | "domains_only" | "databases_only";
    activeOnly: boolean;
    excludedDomainIds?: string[];
    excludedDatabaseIds?: string[];
  };
  assignmentMode?: "role" | "users";
  domainAssignedRole?: string;
  databaseAssignedRole?: string;
  origin?: "domain_default" | "special" | "database_inherited" | string;
  active: boolean;
  completedAt?: string | null;
  completedReason?: string | null;
  summary?: {
    proximas: number;
    vencidas: number;
    conError: number;
    completadas: number;
    requiereAtencion: boolean;
  };
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
  taskBucket?: string;
  clientId: string;
  clientName: string;
  domainId: string;
  domainName: string;
  targetType: "domain" | "database";
  targetId: string;
  targetName: string;
  scheduleId: string;
  rootScheduleId?: string;
  assignedRole: string;
  assignedUserIds: string[];
  status: EstadoTarea;
  result: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  completedBy?: string | null;
  completedWithProblems?: boolean;
  problemNote?: string;
  completionNote?: string;
  blockReason?: string | null;
  resolutionComment?: string | null;
  reopenReason?: string | null;
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
  super_admin: "Super Administrador",
  admin: "Administrador",
  client_manager: "Administrador de clientes",
  database_updater: "Actualizador de Bases de Datos",
  domain_updater: "Actualizador de Dominios",
  viewer: "Visualizador",
  print_formats_admin: "Administrador de Formatos de Impresión",
  "formatos_impresion.admin": "Administrador de formatos de impresión",
  "public_downloads.admin": "Administrador de descargas públicas",
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
  all: "Todos",
  production: "Producción",
  test: "Pruebas",
  demo: "Demo",
};

export const AMBIENTES_OPERATIVOS = ["production", "test", "demo"] as const;

export const ETIQUETAS_FRECUENCIA: Record<string, string> = {
  once: "Única",
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
  schedule_created: "Actualización programada creada",
  schedule_updated: "Actualización programada actualizada",
  schedule_deactivated: "Actualización programada desactivada",
  schedule_reactivated: "Actualización programada reactivada",
  schedule_deleted: "Actualización programada eliminada",
  task_generated: "Tarea generada",
  task_started: "Tarea iniciada",
  task_completed: "Tarea completada",
  task_failed: "Tarea marcada como fallida",
  task_blocked: "Tarea bloqueada",
  task_reopened: "Tarea reabierta",
  task_cancelled: "Tarea cancelada",
  license_module_created: "Módulo de licencia creado",
  license_module_updated: "Módulo de licencia actualizado",
  license_module_deleted: "Módulo de licencia eliminado",
  license_assignment_created: "Asignación de licencia creada",
  license_assignment_updated: "Asignación de licencia actualizada",
  license_assignment_deleted: "Asignación de licencia eliminada",
  fuente_formato_created: "Fuente de formato creada",
  fuente_formato_updated: "Fuente de formato actualizada",
  fuente_formato_deleted: "Fuente de formato eliminada",
  formato_impresion_created: "Formato de impresión creado",
  formato_impresion_updated: "Formato de impresión actualizado",
  formato_impresion_pdf_replaced: "PDF de formato reemplazado",
  formato_impresion_deleted: "Formato de impresión eliminado",
  public_download_section_created: "Sección de descargas creada",
  public_download_section_updated: "Sección de descargas actualizada",
  public_download_section_deleted: "Sección de descargas eliminada",
  public_download_document_created: "Documento público creado",
  public_download_document_updated: "Documento público actualizado",
  public_download_document_file_replaced: "Archivo público reemplazado",
  public_download_document_deleted: "Documento público eliminado",
  public_file_created: "Archivo público creado",
  public_file_updated: "Archivo público actualizado",
  public_file_replaced: "Archivo público reemplazado",
  public_file_deleted: "Archivo público eliminado",
};
