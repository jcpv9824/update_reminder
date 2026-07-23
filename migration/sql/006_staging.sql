/*
  Portal SAG Web - Gate C / 006: migration staging.
  Staging is transient and restricted. Every source document remains immutable in
  migration.raw_documents; these tables hold typed projections and transform state.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() <> N'PortalSAGWeb' THROW 51060, N'Wrong database.', 1;
IF OBJECT_ID(N'migration.raw_documents', N'U') IS NULL THROW 51061, N'Run 002 first.', 1;
GO

BEGIN TRANSACTION;

CREATE TABLE migration.stage_users
(
  run_key                    BIGINT NOT NULL, source_id NVARCHAR(150) NOT NULL,
  display_name               NVARCHAR(160) NULL, email NVARCHAR(254) NULL, active BIT NULL,
  roles_json                 NVARCHAR(MAX) NULL, created_at DATETIME2(3) NULL, updated_at DATETIME2(3) NULL,
  source_document_sha256     BINARY(32) NOT NULL, transform_status VARCHAR(20) NOT NULL DEFAULT ('pending'),
  CONSTRAINT PK_stage_users PRIMARY KEY (run_key, source_id),
  CONSTRAINT FK_stage_users_run FOREIGN KEY (run_key) REFERENCES migration.migration_runs(run_key),
  CONSTRAINT CK_stage_users_roles_json CHECK (roles_json IS NULL OR ISJSON(roles_json)=1)
);

CREATE TABLE migration.stage_clients
(
  run_key                    BIGINT NOT NULL, source_id NVARCHAR(150) NOT NULL,
  external_id                NVARCHAR(100) NULL, name NVARCHAR(200) NULL, status VARCHAR(20) NULL,
  license_module_ids_json    NVARCHAR(MAX) NULL, created_at DATETIME2(3) NULL, updated_at DATETIME2(3) NULL,
  source_document_sha256     BINARY(32) NOT NULL, transform_status VARCHAR(20) NOT NULL DEFAULT ('pending'),
  CONSTRAINT PK_stage_clients PRIMARY KEY (run_key, source_id),
  CONSTRAINT FK_stage_clients_run FOREIGN KEY (run_key) REFERENCES migration.migration_runs(run_key),
  CONSTRAINT CK_stage_clients_licenses_json CHECK (license_module_ids_json IS NULL OR ISJSON(license_module_ids_json)=1)
);

CREATE TABLE migration.stage_domains
(
  run_key                    BIGINT NOT NULL, source_id NVARCHAR(150) NOT NULL,
  client_source_id           NVARCHAR(150) NULL, domain_name NVARCHAR(500) NULL, environment_id VARCHAR(20) NULL,
  status                     VARCHAR(20) NULL, assigned_user_ids_json NVARCHAR(MAX) NULL,
  source_document_sha256     BINARY(32) NOT NULL, transform_status VARCHAR(20) NOT NULL DEFAULT ('pending'),
  CONSTRAINT PK_stage_domains PRIMARY KEY (run_key, source_id),
  CONSTRAINT FK_stage_domains_run FOREIGN KEY (run_key) REFERENCES migration.migration_runs(run_key),
  CONSTRAINT CK_stage_domains_assignees_json CHECK (assigned_user_ids_json IS NULL OR ISJSON(assigned_user_ids_json)=1)
);

CREATE TABLE migration.stage_databases
(
  run_key                    BIGINT NOT NULL, source_id NVARCHAR(150) NOT NULL,
  client_source_id           NVARCHAR(150) NULL, domain_source_id NVARCHAR(150) NULL, company_name NVARCHAR(240) NULL,
  environment_id             VARCHAR(20) NULL, server_host_port NVARCHAR(500) NULL, initial_catalog NVARCHAR(256) NULL,
  sql_user_id                NVARCHAR(256) NULL, password_secret_name NVARCHAR(256) NULL,
  assigned_user_ids_json     NVARCHAR(MAX) NULL, status VARCHAR(20) NULL,
  source_document_sha256     BINARY(32) NOT NULL, transform_status VARCHAR(20) NOT NULL DEFAULT ('pending'),
  CONSTRAINT PK_stage_databases PRIMARY KEY (run_key, source_id),
  CONSTRAINT FK_stage_databases_run FOREIGN KEY (run_key) REFERENCES migration.migration_runs(run_key),
  CONSTRAINT CK_stage_databases_assignees_json CHECK (assigned_user_ids_json IS NULL OR ISJSON(assigned_user_ids_json)=1)
);

CREATE TABLE migration.stage_update_schedules
(
  run_key                    BIGINT NOT NULL, source_id NVARCHAR(150) NOT NULL,
  client_source_id           NVARCHAR(150) NULL, domain_source_id NVARCHAR(150) NULL,
  target_type                VARCHAR(20) NULL, frequency_type VARCHAR(20) NULL, start_date DATE NULL, end_date DATE NULL,
  selection_mode             VARCHAR(20) NULL, active BIT NULL, target_ids_json NVARCHAR(MAX) NULL,
  weekdays_json              NVARCHAR(MAX) NULL, preferred_weekdays_json NVARCHAR(MAX) NULL,
  assigned_user_ids_json     NVARCHAR(MAX) NULL, database_assigned_user_ids_json NVARCHAR(MAX) NULL,
  reminders_json             NVARCHAR(MAX) NULL, scope_groups_json NVARCHAR(MAX) NULL, licensing_scope_json NVARCHAR(MAX) NULL,
  source_document_sha256     BINARY(32) NOT NULL, transform_status VARCHAR(20) NOT NULL DEFAULT ('pending'),
  CONSTRAINT PK_stage_update_schedules PRIMARY KEY (run_key, source_id),
  CONSTRAINT FK_stage_update_schedules_run FOREIGN KEY (run_key) REFERENCES migration.migration_runs(run_key),
  CONSTRAINT CK_stage_update_schedules_json CHECK (
    (target_ids_json IS NULL OR ISJSON(target_ids_json)=1) AND
    (weekdays_json IS NULL OR ISJSON(weekdays_json)=1) AND
    (preferred_weekdays_json IS NULL OR ISJSON(preferred_weekdays_json)=1) AND
    (assigned_user_ids_json IS NULL OR ISJSON(assigned_user_ids_json)=1) AND
    (database_assigned_user_ids_json IS NULL OR ISJSON(database_assigned_user_ids_json)=1) AND
    (reminders_json IS NULL OR ISJSON(reminders_json)=1) AND
    (scope_groups_json IS NULL OR ISJSON(scope_groups_json)=1) AND
    (licensing_scope_json IS NULL OR ISJSON(licensing_scope_json)=1)
  )
);

CREATE TABLE migration.stage_update_tasks
(
  run_key                    BIGINT NOT NULL, source_id NVARCHAR(150) NOT NULL,
  dedupe_key                 NVARCHAR(500) NULL, task_date DATE NULL, task_bucket NVARCHAR(100) NULL,
  client_source_id           NVARCHAR(150) NULL, domain_source_id NVARCHAR(150) NULL,
  target_type                VARCHAR(20) NULL, target_source_id NVARCHAR(150) NULL,
  legacy_schedule_id         NVARCHAR(150) NULL, root_schedule_source_id NVARCHAR(150) NULL,
  status                     VARCHAR(30) NULL, result NVARCHAR(500) NULL,
  assigned_user_ids_json     NVARCHAR(MAX) NULL, sources_json NVARCHAR(MAX) NULL,
  reminders_sent_json        NVARCHAR(MAX) NULL, overdue_alert_dates_json NVARCHAR(MAX) NULL,
  source_document_sha256     BINARY(32) NOT NULL, transform_status VARCHAR(20) NOT NULL DEFAULT ('pending'),
  CONSTRAINT PK_stage_update_tasks PRIMARY KEY (run_key, source_id),
  CONSTRAINT FK_stage_update_tasks_run FOREIGN KEY (run_key) REFERENCES migration.migration_runs(run_key),
  CONSTRAINT CK_stage_update_tasks_json CHECK (
    (assigned_user_ids_json IS NULL OR ISJSON(assigned_user_ids_json)=1) AND
    (sources_json IS NULL OR ISJSON(sources_json)=1) AND
    (reminders_sent_json IS NULL OR ISJSON(reminders_sent_json)=1) AND
    (overdue_alert_dates_json IS NULL OR ISJSON(overdue_alert_dates_json)=1)
  )
);

CREATE TABLE migration.stage_license_modules
(
  run_key                    BIGINT NOT NULL, source_id NVARCHAR(150) NOT NULL,
  name                       NVARCHAR(200) NULL, code NVARCHAR(80) NULL, status VARCHAR(20) NULL, active BIT NULL,
  source_document_sha256     BINARY(32) NOT NULL, transform_status VARCHAR(20) NOT NULL DEFAULT ('pending'),
  CONSTRAINT PK_stage_license_modules PRIMARY KEY (run_key, source_id),
  CONSTRAINT FK_stage_license_modules_run FOREIGN KEY (run_key) REFERENCES migration.migration_runs(run_key)
);

CREATE TABLE migration.stage_license_assignments
(
  run_key                    BIGINT NOT NULL, source_id NVARCHAR(150) NOT NULL,
  module_source_id           NVARCHAR(150) NULL, target_type VARCHAR(20) NULL, target_source_id NVARCHAR(150) NULL,
  client_source_id           NVARCHAR(150) NULL, domain_source_id NVARCHAR(150) NULL, database_source_id NVARCHAR(150) NULL,
  environment_id             VARCHAR(20) NULL, status VARCHAR(20) NULL,
  source_document_sha256     BINARY(32) NOT NULL, transform_status VARCHAR(20) NOT NULL DEFAULT ('pending'),
  CONSTRAINT PK_stage_license_assignments PRIMARY KEY (run_key, source_id),
  CONSTRAINT FK_stage_license_assignments_run FOREIGN KEY (run_key) REFERENCES migration.migration_runs(run_key)
);

CREATE TABLE migration.stage_audit_logs
(
  run_key                    BIGINT NOT NULL, source_id NVARCHAR(150) NOT NULL,
  entity_type                NVARCHAR(100) NULL, entity_source_id NVARCHAR(150) NULL,
  client_source_id           NVARCHAR(150) NULL, domain_source_id NVARCHAR(150) NULL,
  action                     NVARCHAR(160) NULL, performed_by NVARCHAR(150) NULL, performed_at DATETIME2(3) NULL,
  before_json                NVARCHAR(MAX) NULL, after_json NVARCHAR(MAX) NULL, metadata_json NVARCHAR(MAX) NULL,
  source_document_sha256     BINARY(32) NOT NULL, transform_status VARCHAR(20) NOT NULL DEFAULT ('pending'),
  CONSTRAINT PK_stage_audit_logs PRIMARY KEY (run_key, source_id),
  CONSTRAINT FK_stage_audit_logs_run FOREIGN KEY (run_key) REFERENCES migration.migration_runs(run_key),
  CONSTRAINT CK_stage_audit_logs_json CHECK (
    (before_json IS NULL OR ISJSON(before_json)=1) AND
    (after_json IS NULL OR ISJSON(after_json)=1) AND
    (metadata_json IS NULL OR ISJSON(metadata_json)=1)
  )
);

CREATE TABLE migration.stage_app_settings
(
  run_key                    BIGINT NOT NULL, source_id NVARCHAR(150) NOT NULL,
  settings_json              NVARCHAR(MAX) NOT NULL,
  source_document_sha256     BINARY(32) NOT NULL, transform_status VARCHAR(20) NOT NULL DEFAULT ('pending'),
  CONSTRAINT PK_stage_app_settings PRIMARY KEY (run_key, source_id),
  CONSTRAINT FK_stage_app_settings_run FOREIGN KEY (run_key) REFERENCES migration.migration_runs(run_key),
  CONSTRAINT CK_stage_app_settings_json CHECK (ISJSON(settings_json)=1)
);

CREATE TABLE migration.stage_email_notifications
(
  run_key                    BIGINT NOT NULL, source_id NVARCHAR(150) NOT NULL,
  notification_type          VARCHAR(60) NULL, entity_source_id NVARCHAR(150) NULL,
  period                     NVARCHAR(40) NULL, send_date DATE NULL, sent_at DATETIME2(3) NULL,
  days_after                 SMALLINT NULL, recipients_json NVARCHAR(MAX) NULL,
  source_document_sha256     BINARY(32) NOT NULL, transform_status VARCHAR(20) NOT NULL DEFAULT ('pending'),
  CONSTRAINT PK_stage_email_notifications PRIMARY KEY (run_key, source_id),
  CONSTRAINT FK_stage_email_notifications_run FOREIGN KEY (run_key) REFERENCES migration.migration_runs(run_key),
  CONSTRAINT CK_stage_email_notifications_json CHECK (recipients_json IS NULL OR ISJSON(recipients_json)=1)
);

CREATE TABLE migration.stage_security_rate_limits
(
  run_key                    BIGINT NOT NULL, source_id NVARCHAR(150) NOT NULL,
  scope                      NVARCHAR(80) NULL, key_type NVARCHAR(80) NULL, attempt_count INT NULL,
  window_started_at          DATETIME2(3) NULL, blocked_until DATETIME2(3) NULL, updated_at DATETIME2(3) NULL, ttl_seconds INT NULL,
  source_document_sha256     BINARY(32) NOT NULL, validation_status VARCHAR(20) NOT NULL DEFAULT ('count_only'),
  CONSTRAINT PK_stage_security_rate_limits PRIMARY KEY (run_key, source_id),
  CONSTRAINT FK_stage_security_rate_limits_run FOREIGN KEY (run_key) REFERENCES migration.migration_runs(run_key)
);

CREATE TABLE migration.stage_auth_sessions
(
  run_key                    BIGINT NOT NULL, source_id NVARCHAR(150) NOT NULL,
  user_source_id             NVARCHAR(150) NULL, token_version INT NULL,
  created_at                 DATETIME2(3) NULL, last_used_at DATETIME2(3) NULL, expires_at DATETIME2(3) NULL,
  revoked_at                 DATETIME2(3) NULL, ttl_seconds INT NULL, has_mfa_verified_at BIT NOT NULL DEFAULT (0),
  source_document_sha256     BINARY(32) NOT NULL, validation_status VARCHAR(20) NOT NULL DEFAULT ('count_only'),
  CONSTRAINT PK_stage_auth_sessions PRIMARY KEY (run_key, source_id),
  CONSTRAINT FK_stage_auth_sessions_run FOREIGN KEY (run_key) REFERENCES migration.migration_runs(run_key)
);

CREATE TABLE migration.stage_roles
(
  run_key                    BIGINT NOT NULL, source_id NVARCHAR(150) NOT NULL,
  name                       NVARCHAR(160) NULL, active BIT NULL, system_role BIT NULL, protected_role BIT NULL,
  domain_task_visibility     VARCHAR(10) NULL, database_task_visibility VARCHAR(10) NULL,
  permissions_json           NVARCHAR(MAX) NULL,
  source_document_sha256     BINARY(32) NOT NULL, transform_status VARCHAR(20) NOT NULL DEFAULT ('pending'),
  CONSTRAINT PK_stage_roles PRIMARY KEY (run_key, source_id),
  CONSTRAINT FK_stage_roles_run FOREIGN KEY (run_key) REFERENCES migration.migration_runs(run_key),
  CONSTRAINT CK_stage_roles_permissions_json CHECK (permissions_json IS NULL OR ISJSON(permissions_json)=1)
);

CREATE TABLE migration.stage_print_format_sources
(
  run_key                    BIGINT NOT NULL, source_id NVARCHAR(150) NOT NULL,
  name                       NVARCHAR(200) NULL, active BIT NULL, status VARCHAR(20) NULL,
  source_document_sha256     BINARY(32) NOT NULL, transform_status VARCHAR(20) NOT NULL DEFAULT ('pending'),
  CONSTRAINT PK_stage_print_format_sources PRIMARY KEY (run_key, source_id),
  CONSTRAINT FK_stage_print_format_sources_run FOREIGN KEY (run_key) REFERENCES migration.migration_runs(run_key)
);

CREATE TABLE migration.stage_print_formats
(
  run_key                    BIGINT NOT NULL, source_id NVARCHAR(150) NOT NULL,
  print_format_source_id     NVARCHAR(150) NULL, name NVARCHAR(240) NULL, format_size VARCHAR(30) NULL,
  requires_license           BIT NULL, module_source_id NVARCHAR(150) NULL,
  legacy_import_code         NVARCHAR(200) NULL, legacy_import_status NVARCHAR(200) NULL, legacy_variant NVARCHAR(200) NULL,
  pdf_original_name          NVARCHAR(260) NULL, pdf_mime_type NVARCHAR(160) NULL, pdf_byte_count BIGINT NULL, pdf_sha256 BINARY(32) NULL,
  active                     BIT NULL, status VARCHAR(20) NULL,
  source_document_sha256     BINARY(32) NOT NULL, transform_status VARCHAR(20) NOT NULL DEFAULT ('pending'),
  CONSTRAINT PK_stage_print_formats PRIMARY KEY (run_key, source_id),
  CONSTRAINT FK_stage_print_formats_run FOREIGN KEY (run_key) REFERENCES migration.migration_runs(run_key)
);

CREATE TABLE migration.stage_public_downloads
(
  run_key                    BIGINT NOT NULL, source_id NVARCHAR(150) NOT NULL,
  record_type                VARCHAR(20) NULL, section_source_id NVARCHAR(150) NULL,
  name_or_title              NVARCHAR(240) NULL, slug NVARCHAR(200) NULL,
  file_original_name         NVARCHAR(260) NULL, file_mime_type NVARCHAR(160) NULL, file_byte_count BIGINT NULL, file_sha256 BINARY(32) NULL,
  active                     BIT NULL, status VARCHAR(20) NULL,
  source_document_sha256     BINARY(32) NOT NULL, transform_status VARCHAR(20) NOT NULL DEFAULT ('pending'),
  CONSTRAINT PK_stage_public_downloads PRIMARY KEY (run_key, source_id),
  CONSTRAINT FK_stage_public_downloads_run FOREIGN KEY (run_key) REFERENCES migration.migration_runs(run_key),
  CONSTRAINT CK_stage_public_downloads_type CHECK (record_type IS NULL OR record_type IN ('section','document'))
);

COMMIT TRANSACTION;
GO

PRINT N'006 complete: typed staging projections for all 17 Cosmos containers created.';
GO
