export type TaskVisibilityLevel = "none" | "assigned" | "all";

export type TaskVisibility = {
  domain: TaskVisibilityLevel;
  database: TaskVisibilityLevel;
};

export type PermissionAction = {
  id: string;
  label: string;
};

export type PermissionOption = {
  id: string;
  label: string;
  permissionPrefix: string;
  actions: PermissionAction[];
};

export type PermissionModule = {
  id: string;
  label: string;
  options: PermissionOption[];
};

export type RoleDefinition = {
  id: string;
  name: string;
  permissions: string[];
  taskVisibility: TaskVisibility;
  system: boolean;
  protected?: boolean;
  active?: boolean;
};

const DOMAIN_UPDATER_TASK_PERMISSIONS = [
  "updates.tasks.view",
  "updates.tasks.start",
  "updates.tasks.complete",
  "updates.tasks.block",
  "updates.tasks.resolve_block",
  "updates.tasks.fail",
  "updates.tasks.cancel",
  "updates.tasks.reopen",
];

const DATABASE_UPDATER_TASK_PERMISSIONS = [
  ...DOMAIN_UPDATER_TASK_PERMISSIONS,
  "updates.tasks.view_database_connection",
  "updates.tasks.copy_database_connection_part",
  "updates.tasks.reveal_database_password",
];

const ACTIONS = {
  view: { id: "view", label: "Ver" },
  create: { id: "create", label: "Crear" },
  edit: { id: "edit", label: "Editar" },
  delete: { id: "delete", label: "Eliminar" },
  deactivate: { id: "deactivate", label: "Desactivar" },
  reactivate: { id: "reactivate", label: "Reactivar" },
} satisfies Record<string, PermissionAction>;

function option(id: string, label: string, permissionPrefix: string, actions: PermissionAction[]): PermissionOption {
  return { id, label, permissionPrefix, actions };
}

export const PERMISSION_CATALOG: PermissionModule[] = [
  {
    id: "clients",
    label: "Clientes",
    options: [
      option("clients", "Clientes", "clients.clients", [ACTIONS.view, ACTIONS.create, ACTIONS.edit, ACTIONS.delete, ACTIONS.deactivate, ACTIONS.reactivate, { id: "assign_licenses", label: "Asignar Licencias" }, { id: "view_related", label: "Ver Relacionados" }]),
      option("domains", "Dominios", "clients.domains", [ACTIONS.view, ACTIONS.create, ACTIONS.edit, ACTIONS.delete, ACTIONS.deactivate, ACTIONS.reactivate, { id: "view_related_databases", label: "Ver Bases Relacionadas" }]),
      option("databases", "Bases de Datos", "clients.databases", [ACTIONS.view, ACTIONS.create, ACTIONS.edit, ACTIONS.delete, ACTIONS.deactivate, ACTIONS.reactivate, { id: "view_connection", label: "Ver Conexión" }, { id: "copy_connection_part", label: "Copiar Parte de Conexión" }, { id: "reveal_password", label: "Revelar Contraseña" }]),
      option("licensing", "Licenciamiento", "clients.licensing", [ACTIONS.view, ACTIONS.create, ACTIONS.edit, ACTIONS.delete, ACTIONS.deactivate, ACTIONS.reactivate]),
    ],
  },
  {
    id: "updates",
    label: "Actualizaciones",
    options: [
      option("tasks", "Tareas", "updates.tasks", [ACTIONS.view, { id: "start", label: "Iniciar" }, { id: "complete", label: "Completar" }, { id: "block", label: "Bloquear" }, { id: "resolve_block", label: "Resolver Bloqueo" }, { id: "fail", label: "Marcar Fallida" }, { id: "cancel", label: "Cancelar" }, { id: "reopen", label: "Reabrir" }, { id: "view_database_connection", label: "Ver Conexión de Base" }, { id: "copy_database_connection_part", label: "Copiar Conexión de Base" }, { id: "reveal_database_password", label: "Revelar Contraseña de Base" }]),
      option("schedules", "Programar Actualizaciones", "updates.schedules", [ACTIONS.view, ACTIONS.create, ACTIONS.edit, ACTIONS.delete, ACTIONS.deactivate, ACTIONS.reactivate, { id: "preview_scope", label: "Previsualizar Alcance" }, { id: "generate_tasks", label: "Generar Tareas" }]),
    ],
  },
  {
    id: "implementation",
    label: "Implementación",
    options: [
      option("public_downloads", "Descargas Públicas", "implementation.public_downloads", [ACTIONS.view, { id: "create_section", label: "Crear Sección" }, { id: "edit_section", label: "Editar Sección" }, { id: "delete_section", label: "Eliminar Sección" }, { id: "create_document", label: "Crear Documento" }, { id: "edit_document", label: "Editar Documento" }, { id: "delete_document", label: "Eliminar Documento" }, { id: "replace_file", label: "Reemplazar Archivo" }]),
    ],
  },
  {
    id: "configuration",
    label: "Configuración",
    options: [
      option("alerts", "Alertas y Correos", "configuration.alerts", [ACTIONS.view, ACTIONS.edit, { id: "test_email", label: "Probar Correo" }, { id: "send_report", label: "Enviar Reporte" }, { id: "test_administrative_reminder", label: "Probar Recordatorio Administrativo" }]),
      option("users", "Usuarios", "configuration.users", [ACTIONS.view, ACTIONS.create, ACTIONS.edit, ACTIONS.deactivate, ACTIONS.reactivate, { id: "reset_password", label: "Restablecer Contraseña" }, { id: "resend_credentials", label: "Reenviar Credenciales" }, { id: "assign_roles", label: "Asignar Roles" }]),
      option("roles", "Roles", "configuration.roles", [ACTIONS.view, ACTIONS.create, ACTIONS.edit, ACTIONS.delete, ACTIONS.deactivate, ACTIONS.reactivate, { id: "manage_permissions", label: "Gestionar Permisos" }, { id: "manage_task_visibility", label: "Gestionar Visibilidad de Tareas" }]),
      option("print_formats", "Formatos de Impresión", "configuration.print_formats", [ACTIONS.view, { id: "create_source", label: "Crear Fuente" }, { id: "edit_source", label: "Editar Fuente" }, { id: "delete_source", label: "Eliminar Fuente" }, { id: "create_format", label: "Crear Formato" }, { id: "edit_format", label: "Editar Formato" }, { id: "delete_format", label: "Eliminar Formato" }, { id: "replace_pdf", label: "Reemplazar PDF" }]),
    ],
  },
  {
    id: "visibility",
    label: "Auditoría y Visibilidad",
    options: [
      option("audit", "Auditoría", "visibility.audit", [ACTIONS.view, { id: "export", label: "Exportar" }]),
      option("dashboard", "Tablero", "visibility.dashboard", [ACTIONS.view]),
    ],
  },
];

export function permissionKey(option: Pick<PermissionOption, "permissionPrefix">, actionId: string): string {
  return `${option.permissionPrefix}.${actionId}`;
}

export function optionPermissionKeys(option: PermissionOption): string[] {
  return option.actions.map((action) => permissionKey(option, action.id));
}

export function modulePermissionKeys(module: PermissionModule): string[] {
  return module.options.flatMap(optionPermissionKeys);
}

export function allPermissionKeys(): string[] {
  return PERMISSION_CATALOG.flatMap((module) => module.options.flatMap(optionPermissionKeys));
}

export const DEFAULT_ROLE_DEFINITIONS: RoleDefinition[] = [
  {
    id: "super_admin",
    name: "Super Administrador",
    permissions: allPermissionKeys(),
    taskVisibility: { domain: "all", database: "all" },
    system: true,
    protected: true,
    active: true,
  },
  {
    id: "database_updater",
    name: "Actualizador de Bases de Datos",
    permissions: DATABASE_UPDATER_TASK_PERMISSIONS,
    taskVisibility: { domain: "none", database: "assigned" },
    system: true,
    active: true,
  },
  {
    id: "domain_updater",
    name: "Actualizador de Dominios",
    permissions: DOMAIN_UPDATER_TASK_PERMISSIONS,
    taskVisibility: { domain: "assigned", database: "none" },
    system: true,
    active: true,
  },
  {
    id: "print_formats_admin",
    name: "Administrador de Formatos de Impresión",
    permissions: optionPermissionKeys(
      PERMISSION_CATALOG
        .find((module) => module.id === "configuration")!
        .options.find((option) => option.id === "print_formats")!
    ),
    taskVisibility: { domain: "none", database: "none" },
    system: true,
    active: true,
  },
];
