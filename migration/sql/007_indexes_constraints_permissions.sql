/* Portal SAG Web - Gate C / 007: indexes, guards, views and database roles. SQL Server 2019. */
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() <> N'PortalSAGWeb' THROW 51070, N'Wrong database.', 1;
IF OBJECT_ID(N'audit.audit_logs', N'U') IS NULL THROW 51071, N'Run 005 first.', 1;
IF OBJECT_ID(N'migration.stage_users', N'U') IS NULL THROW 51072, N'Run 006 first.', 1;
GO

BEGIN TRANSACTION;

IF NOT EXISTS (SELECT 1 FROM core.environments WHERE environment_id = 'production')
  INSERT core.environments(environment_id, name, sort_order) VALUES ('production', N'Producción', 10);
IF NOT EXISTS (SELECT 1 FROM core.environments WHERE environment_id = 'test')
  INSERT core.environments(environment_id, name, sort_order) VALUES ('test', N'Pruebas', 20);
IF NOT EXISTS (SELECT 1 FROM core.environments WHERE environment_id = 'demo')
  INSERT core.environments(environment_id, name, sort_order) VALUES ('demo', N'Demostración', 30);

/* Generated from api/src/lib/permissionModel.ts on 2026-07-16. */
DECLARE @permission_catalog TABLE
(
  module_key         NVARCHAR(80) NOT NULL,
  option_key         NVARCHAR(100) NOT NULL,
  permission_prefix  NVARCHAR(160) NOT NULL,
  option_label       NVARCHAR(200) NOT NULL,
  actions_json       NVARCHAR(MAX) NOT NULL
);

INSERT @permission_catalog(module_key, option_key, permission_prefix, option_label, actions_json)
VALUES
  (N'clients', N'clients', N'clients.clients', N'Clientes', N'[{"id":"view","label":"Ver"},{"id":"create","label":"Crear"},{"id":"edit","label":"Editar"},{"id":"delete","label":"Eliminar"},{"id":"deactivate","label":"Desactivar"},{"id":"reactivate","label":"Reactivar"},{"id":"assign_licenses","label":"Asignar Licencias"},{"id":"view_related","label":"Ver Relacionados"}]'),
  (N'clients', N'domains', N'clients.domains', N'Dominios', N'[{"id":"view","label":"Ver"},{"id":"create","label":"Crear"},{"id":"edit","label":"Editar"},{"id":"delete","label":"Eliminar"},{"id":"deactivate","label":"Desactivar"},{"id":"reactivate","label":"Reactivar"},{"id":"view_related_databases","label":"Ver Bases Relacionadas"}]'),
  (N'clients', N'databases', N'clients.databases', N'Bases de Datos', N'[{"id":"view","label":"Ver"},{"id":"create","label":"Crear"},{"id":"edit","label":"Editar"},{"id":"delete","label":"Eliminar"},{"id":"deactivate","label":"Desactivar"},{"id":"reactivate","label":"Reactivar"},{"id":"view_connection","label":"Ver Conexión"},{"id":"copy_connection_part","label":"Copiar Parte de Conexión"},{"id":"reveal_password","label":"Revelar Contraseña"}]'),
  (N'clients', N'licensing', N'clients.licensing', N'Licenciamiento', N'[{"id":"view","label":"Ver"},{"id":"create","label":"Crear"},{"id":"edit","label":"Editar"},{"id":"delete","label":"Eliminar"},{"id":"deactivate","label":"Desactivar"},{"id":"reactivate","label":"Reactivar"}]'),
  (N'updates', N'tasks', N'updates.tasks', N'Tareas', N'[{"id":"view","label":"Ver"},{"id":"start","label":"Iniciar"},{"id":"complete","label":"Completar"},{"id":"block","label":"Bloquear"},{"id":"resolve_block","label":"Resolver Bloqueo"},{"id":"fail","label":"Marcar Fallida"},{"id":"cancel","label":"Cancelar"},{"id":"reopen","label":"Reabrir"},{"id":"view_database_connection","label":"Ver Conexión de Base"},{"id":"copy_database_connection_part","label":"Copiar Conexión de Base"},{"id":"reveal_database_password","label":"Revelar Contraseña de Base"}]'),
  (N'updates', N'schedules', N'updates.schedules', N'Programar Actualizaciones', N'[{"id":"view","label":"Ver"},{"id":"create","label":"Crear"},{"id":"edit","label":"Editar"},{"id":"delete","label":"Eliminar"},{"id":"deactivate","label":"Desactivar"},{"id":"reactivate","label":"Reactivar"},{"id":"preview_scope","label":"Previsualizar Alcance"},{"id":"generate_tasks","label":"Generar Tareas"}]'),
  (N'implementation', N'public_downloads', N'implementation.public_downloads', N'Descargas Públicas', N'[{"id":"view","label":"Ver"},{"id":"create_section","label":"Crear Sección"},{"id":"edit_section","label":"Editar Sección"},{"id":"delete_section","label":"Eliminar Sección"},{"id":"create_document","label":"Crear Documento"},{"id":"edit_document","label":"Editar Documento"},{"id":"delete_document","label":"Eliminar Documento"},{"id":"replace_file","label":"Reemplazar Archivo"}]'),
  (N'configuration', N'alerts', N'configuration.alerts', N'Alertas y Correos', N'[{"id":"view","label":"Ver"},{"id":"edit","label":"Editar"},{"id":"test_email","label":"Probar Correo"},{"id":"send_report","label":"Enviar Reporte"},{"id":"test_administrative_reminder","label":"Probar Recordatorio Administrativo"}]'),
  (N'configuration', N'users', N'configuration.users', N'Usuarios', N'[{"id":"view","label":"Ver"},{"id":"create","label":"Crear"},{"id":"edit","label":"Editar"},{"id":"deactivate","label":"Desactivar"},{"id":"reactivate","label":"Reactivar"},{"id":"reset_password","label":"Restablecer Contraseña"},{"id":"resend_credentials","label":"Reenviar Credenciales"},{"id":"assign_roles","label":"Asignar Roles"}]'),
  (N'configuration', N'roles', N'configuration.roles', N'Roles', N'[{"id":"view","label":"Ver"},{"id":"create","label":"Crear"},{"id":"edit","label":"Editar"},{"id":"delete","label":"Eliminar"},{"id":"deactivate","label":"Desactivar"},{"id":"reactivate","label":"Reactivar"},{"id":"manage_permissions","label":"Gestionar Permisos"},{"id":"manage_task_visibility","label":"Gestionar Visibilidad de Tareas"}]'),
  (N'configuration', N'print_formats', N'configuration.print_formats', N'Formatos de Impresión', N'[{"id":"view","label":"Ver"},{"id":"create_source","label":"Crear Fuente"},{"id":"edit_source","label":"Editar Fuente"},{"id":"delete_source","label":"Eliminar Fuente"},{"id":"create_format","label":"Crear Formato"},{"id":"edit_format","label":"Editar Formato"},{"id":"delete_format","label":"Eliminar Formato"},{"id":"replace_pdf","label":"Reemplazar PDF"}]'),
  (N'visibility', N'audit', N'visibility.audit', N'Auditoría', N'[{"id":"view","label":"Ver"},{"id":"export","label":"Exportar"}]'),
  (N'visibility', N'dashboard', N'visibility.dashboard', N'Tablero', N'[{"id":"view","label":"Ver"}]');

INSERT security.permissions(permission_key, module_key, option_key, action_key, label, description, active)
SELECT
  c.permission_prefix + N'.' + a.action_id,
  c.module_key,
  c.option_key,
  a.action_id,
  a.action_label,
  c.option_label + N' / ' + a.action_label,
  1
FROM @permission_catalog AS c
CROSS APPLY OPENJSON(c.actions_json)
WITH
(
  action_id NVARCHAR(80) '$.id',
  action_label NVARCHAR(200) '$.label'
) AS a;

IF (SELECT COUNT(*) FROM security.permissions) <> 89
  THROW 51077, N'The permission catalog seed must contain exactly 89 current application permissions.', 1;

DECLARE @seeded_at DATETIME2(3) = SYSUTCDATETIME();
INSERT security.roles
(
  role_id, name, active, system_role, protected_role,
  domain_task_visibility, database_task_visibility,
  created_at, created_by, updated_at, updated_by
)
VALUES
  (N'super_admin', N'Super Administrador', 1, 1, 1, 'all', 'all', @seeded_at, N'schema_seed', @seeded_at, N'schema_seed'),
  (N'database_updater', N'Actualizador de Bases de Datos', 1, 1, 0, 'none', 'assigned', @seeded_at, N'schema_seed', @seeded_at, N'schema_seed'),
  (N'domain_updater', N'Actualizador de Dominios', 1, 1, 0, 'assigned', 'none', @seeded_at, N'schema_seed', @seeded_at, N'schema_seed'),
  (N'print_formats_admin', N'Administrador de Formatos de Impresión', 1, 1, 0, 'none', 'none', @seeded_at, N'schema_seed', @seeded_at, N'schema_seed');

INSERT security.role_permissions(role_id, permission_key, granted_at, granted_by)
SELECT N'super_admin', permission_key, @seeded_at, N'schema_seed'
FROM security.permissions;

INSERT security.role_permissions(role_id, permission_key, granted_at, granted_by)
SELECT N'domain_updater', permission_key, @seeded_at, N'schema_seed'
FROM security.permissions
WHERE permission_key IN
(
  N'updates.tasks.view', N'updates.tasks.start', N'updates.tasks.complete', N'updates.tasks.block',
  N'updates.tasks.resolve_block', N'updates.tasks.fail', N'updates.tasks.cancel', N'updates.tasks.reopen'
);

INSERT security.role_permissions(role_id, permission_key, granted_at, granted_by)
SELECT N'database_updater', permission_key, @seeded_at, N'schema_seed'
FROM security.permissions
WHERE permission_key IN
(
  N'updates.tasks.view', N'updates.tasks.start', N'updates.tasks.complete', N'updates.tasks.block',
  N'updates.tasks.resolve_block', N'updates.tasks.fail', N'updates.tasks.cancel', N'updates.tasks.reopen',
  N'updates.tasks.view_database_connection', N'updates.tasks.copy_database_connection_part', N'updates.tasks.reveal_database_password'
);

INSERT security.role_permissions(role_id, permission_key, granted_at, granted_by)
SELECT N'print_formats_admin', permission_key, @seeded_at, N'schema_seed'
FROM security.permissions
WHERE permission_key LIKE N'configuration.print_formats.%';

CREATE INDEX IX_user_roles_role_user ON security.user_roles(role_id, user_key);
CREATE INDEX IX_auth_sessions_user_active ON security.auth_sessions(user_key, revoked_at, expires_at, session_key);
CREATE INDEX IX_auth_sessions_expiry ON security.auth_sessions(expires_at, session_key);
CREATE INDEX IX_rate_limits_expiry ON security.rate_limits(expires_at, rate_limit_key);

CREATE INDEX IX_domains_client_status ON core.domains(client_key, status, domain_key)
  INCLUDE (source_id, domain_name, environment_id);
CREATE INDEX IX_domain_assignees_user ON core.domain_assignees(user_key, domain_key);
CREATE INDEX IX_databases_domain_status ON core.databases(domain_key, status, database_key)
  INCLUDE (source_id, company_name, environment_id, client_key);
CREATE INDEX IX_databases_client_status ON core.databases(client_key, status, database_key)
  INCLUDE (domain_key, source_id, company_name);
CREATE INDEX IX_database_assignees_user ON core.database_assignees(user_key, database_key);

CREATE INDEX IX_license_assignments_module_status ON licensing.license_assignments(module_key, status, target_type, assignment_key)
  INCLUDE (client_key, domain_key, database_key, environment_id);

CREATE INDEX IX_schedules_timer ON scheduling.update_schedules(active, frequency_type, start_date, end_date, schedule_key)
  INCLUDE (client_key, domain_key, timezone, selection_mode);
CREATE INDEX IX_schedules_client_active ON scheduling.update_schedules(client_key, active, schedule_key);
CREATE INDEX IX_schedule_targets_domain ON scheduling.schedule_targets(domain_key, schedule_key) WHERE domain_key IS NOT NULL;
CREATE INDEX IX_schedule_targets_database ON scheduling.schedule_targets(database_key, schedule_key) WHERE database_key IS NOT NULL;
CREATE INDEX IX_schedule_assignees_user ON scheduling.schedule_assignees(user_key, assignment_kind, schedule_key);

CREATE INDEX IX_update_tasks_operational ON workflow.update_tasks(status, task_date, target_type, task_key)
  INCLUDE (source_id, client_key, domain_key, database_key, assigned_role, target_name_snapshot, is_historical_orphan);
CREATE INDEX IX_update_tasks_client_date ON workflow.update_tasks(client_key, task_date, task_key)
  INCLUDE (status, target_type, domain_key, database_key);
CREATE INDEX IX_update_tasks_domain_date ON workflow.update_tasks(domain_key, task_date, task_key)
  INCLUDE (status, target_type, database_key);
CREATE INDEX IX_task_assignees_user ON workflow.task_assignees(user_key, task_key);
CREATE INDEX IX_task_sources_schedule ON workflow.task_sources(schedule_key, task_key) WHERE schedule_key IS NOT NULL;
CREATE INDEX IX_task_sources_source_id ON workflow.task_sources(schedule_source_id, task_key);
CREATE INDEX IX_task_history_task_date ON workflow.task_status_history(task_key, performed_at DESC, task_status_history_key DESC);

CREATE INDEX IX_notifications_outbox ON notifications.email_notifications(status, next_attempt_at, notification_key)
  INCLUDE (claim_expires_at, attempt_count, notification_type);
CREATE INDEX IX_notifications_entity ON notifications.email_notifications(entity_type, entity_source_id, created_at DESC)
  WHERE entity_source_id IS NOT NULL;

CREATE INDEX IX_audit_logs_date ON audit.audit_logs(performed_at DESC, audit_log_key DESC);
CREATE INDEX IX_audit_logs_entity ON audit.audit_logs(entity_type, entity_source_id, performed_at DESC, audit_log_key DESC);
CREATE INDEX IX_audit_logs_client ON audit.audit_logs(client_key, performed_at DESC, audit_log_key DESC) WHERE client_key IS NOT NULL;
CREATE INDEX IX_audit_logs_actor ON audit.audit_logs(performed_by, performed_at DESC, audit_log_key DESC);
CREATE INDEX IX_audit_logs_action ON audit.audit_logs(action, performed_at DESC, audit_log_key DESC);

CREATE INDEX IX_validation_results_open ON migration.validation_results(run_key, severity, resolution_status, validation_result_key)
  WHERE resolution_status = 'open';
CREATE INDEX IX_raw_documents_container ON migration.raw_documents(run_key, source_container, processing_status, source_id);

COMMIT TRANSACTION;
GO

CREATE OR ALTER VIEW core.v_databases_public
AS
SELECT
  d.source_id AS id,
  d.client_key,
  d.domain_key,
  d.company_name,
  d.environment_id,
  d.current_db_version,
  d.status,
  d.notes,
  d.last_updated_at,
  d.last_updated_by,
  d.created_at,
  d.created_by,
  d.updated_at,
  d.updated_by,
  d.deleted_at,
  d.deleted_by,
  d.row_version
FROM core.databases AS d;
GO

CREATE OR ALTER VIEW security.v_users_public
AS
SELECT
  source_id AS id,
  display_name,
  email,
  active,
  must_change_password,
  password_expires_at,
  last_login_at,
  created_at,
  created_by,
  updated_at,
  updated_by,
  row_version
FROM security.users;
GO

CREATE OR ALTER VIEW audit.v_audit_log_summary
AS
SELECT
  source_id AS id,
  entity_type,
  entity_source_id,
  client_key,
  client_name_snapshot,
  domain_key,
  domain_name_snapshot,
  company_name_snapshot,
  action,
  performed_by,
  performed_at,
  schema_version,
  data_classification
FROM audit.audit_logs;
GO

CREATE OR ALTER TRIGGER audit.TR_audit_logs_append_only
ON audit.audit_logs
AFTER UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  THROW 51073, N'audit.audit_logs is append-only.', 1;
END;
GO

CREATE OR ALTER TRIGGER workflow.TR_task_status_history_append_only
ON workflow.task_status_history
AFTER UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  THROW 51074, N'workflow.task_status_history is append-only.', 1;
END;
GO

CREATE OR ALTER TRIGGER notifications.TR_notification_attempts_append_only
ON notifications.email_notification_attempts
AFTER UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  THROW 51075, N'notifications.email_notification_attempts is append-only.', 1;
END;
GO

CREATE OR ALTER TRIGGER security.TR_roles_protect_super_admin
ON security.roles
AFTER UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS
  (
    SELECT 1
    FROM deleted AS d
    LEFT JOIN inserted AS i ON i.role_id = d.role_id
    WHERE d.role_id = N'super_admin'
      AND (i.role_id IS NULL OR i.active = 0 OR i.system_role = 0 OR i.protected_role = 0)
  )
    THROW 51076, N'The super_admin role cannot be deleted, disabled or unprotected.', 1;
END;
GO

IF DATABASE_PRINCIPAL_ID(N'portal_migrator') IS NULL CREATE ROLE portal_migrator AUTHORIZATION dbo;
IF DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NULL CREATE ROLE portal_runtime AUTHORIZATION dbo;
IF DATABASE_PRINCIPAL_ID(N'portal_reporting') IS NULL CREATE ROLE portal_reporting AUTHORIZATION dbo;
GO

GRANT CONTROL ON SCHEMA::migration TO portal_migrator;
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::security TO portal_migrator;
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::core TO portal_migrator;
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::licensing TO portal_migrator;
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::scheduling TO portal_migrator;
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::workflow TO portal_migrator;
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::settings TO portal_migrator;
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::content TO portal_migrator;
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::notifications TO portal_migrator;
GRANT SELECT, INSERT ON SCHEMA::audit TO portal_migrator;

GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::security TO portal_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::core TO portal_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::licensing TO portal_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::scheduling TO portal_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::workflow TO portal_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::settings TO portal_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::content TO portal_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::notifications TO portal_runtime;
GRANT SELECT, INSERT ON SCHEMA::audit TO portal_runtime;
DENY SELECT, INSERT, UPDATE, DELETE ON SCHEMA::migration TO portal_runtime;
DENY UPDATE, DELETE ON SCHEMA::audit TO portal_runtime;

GRANT SELECT ON OBJECT::security.v_users_public TO portal_reporting;
GRANT SELECT ON OBJECT::core.v_databases_public TO portal_reporting;
GRANT SELECT ON OBJECT::audit.v_audit_log_summary TO portal_reporting;
DENY SELECT ON SCHEMA::migration TO portal_reporting;
DENY SELECT ON OBJECT::security.users TO portal_reporting;
DENY SELECT ON OBJECT::core.database_access_profiles TO portal_reporting;
DENY SELECT ON OBJECT::notifications.email_notification_recipients TO portal_reporting;
GO

PRINT N'007 complete: indexes, append-only guards, sanitized views and least-privilege database roles created.';
PRINT N'No login/user membership was created. The provider must map dedicated users to these roles after approval.';
GO
