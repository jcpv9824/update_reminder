/* Portal SAG Web - Gate C / 004: licensing, scheduling and workflow. SQL Server 2019. */
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() <> N'PortalSAGWeb' THROW 51040, N'Wrong database.', 1;
IF OBJECT_ID(N'core.clients', N'U') IS NULL THROW 51041, N'Run 003 first.', 1;
GO

BEGIN TRANSACTION;

CREATE TABLE licensing.license_modules
(
  module_key                  BIGINT IDENTITY(1,1) NOT NULL,
  source_id                   NVARCHAR(150) NOT NULL,
  name                        NVARCHAR(200) NOT NULL,
  name_normalized             NVARCHAR(200) NOT NULL,
  code                        NVARCHAR(80) NULL,
  code_normalized             NVARCHAR(80) NULL,
  description                 NVARCHAR(2000) NULL,
  status                      VARCHAR(20) NOT NULL,
  active_legacy               BIT NULL,
  notes                       NVARCHAR(MAX) NULL,
  created_at                  DATETIME2(3) NOT NULL,
  created_by                  NVARCHAR(150) NOT NULL,
  updated_at                  DATETIME2(3) NOT NULL,
  updated_by                  NVARCHAR(150) NOT NULL,
  deleted_at                  DATETIME2(3) NULL,
  deleted_by                  NVARCHAR(150) NULL,
  row_version                 ROWVERSION NOT NULL,
  CONSTRAINT PK_license_modules PRIMARY KEY CLUSTERED (module_key),
  CONSTRAINT UQ_license_modules_source_id UNIQUE (source_id),
  CONSTRAINT CK_license_modules_status CHECK (status IN ('active','inactive','deleted')),
  CONSTRAINT CK_license_modules_delete CHECK ((status = 'deleted' AND deleted_at IS NOT NULL) OR status <> 'deleted')
);

CREATE UNIQUE INDEX UX_license_modules_name_active
  ON licensing.license_modules(name_normalized) WHERE status <> 'deleted';
CREATE UNIQUE INDEX UX_license_modules_code_active
  ON licensing.license_modules(code_normalized) WHERE code_normalized IS NOT NULL AND status <> 'deleted';

CREATE TABLE licensing.license_assignments
(
  assignment_key              BIGINT IDENTITY(1,1) NOT NULL,
  source_id                   NVARCHAR(150) NOT NULL,
  module_key                  BIGINT NOT NULL,
  module_name_snapshot        NVARCHAR(200) NULL,
  module_code_snapshot        NVARCHAR(80) NULL,
  target_type                 VARCHAR(20) NOT NULL,
  client_key                  BIGINT NULL,
  domain_key                  BIGINT NULL,
  database_key                BIGINT NULL,
  environment_id              VARCHAR(20) NULL,
  status                      VARCHAR(20) NOT NULL,
  active_legacy               BIT NULL,
  created_at                  DATETIME2(3) NOT NULL,
  created_by                  NVARCHAR(150) NOT NULL,
  updated_at                  DATETIME2(3) NOT NULL,
  updated_by                  NVARCHAR(150) NOT NULL,
  deleted_at                  DATETIME2(3) NULL,
  deleted_by                  NVARCHAR(150) NULL,
  row_version                 ROWVERSION NOT NULL,
  CONSTRAINT PK_license_assignments PRIMARY KEY CLUSTERED (assignment_key),
  CONSTRAINT UQ_license_assignments_source_id UNIQUE (source_id),
  CONSTRAINT FK_license_assignments_module FOREIGN KEY (module_key) REFERENCES licensing.license_modules(module_key),
  CONSTRAINT FK_license_assignments_client FOREIGN KEY (client_key) REFERENCES core.clients(client_key),
  CONSTRAINT FK_license_assignments_domain FOREIGN KEY (domain_key) REFERENCES core.domains(domain_key),
  CONSTRAINT FK_license_assignments_database FOREIGN KEY (database_key) REFERENCES core.databases(database_key),
  CONSTRAINT FK_license_assignments_environment FOREIGN KEY (environment_id) REFERENCES core.environments(environment_id),
  CONSTRAINT CK_license_assignments_target_type CHECK (target_type IN ('client','domain','database')),
  CONSTRAINT CK_license_assignments_target CHECK (
    (target_type = 'client' AND client_key IS NOT NULL AND domain_key IS NULL AND database_key IS NULL) OR
    (target_type = 'domain' AND client_key IS NULL AND domain_key IS NOT NULL AND database_key IS NULL) OR
    (target_type = 'database' AND client_key IS NULL AND domain_key IS NULL AND database_key IS NOT NULL)
  ),
  CONSTRAINT CK_license_assignments_status CHECK (status IN ('active','inactive','deleted')),
  CONSTRAINT CK_license_assignments_delete CHECK ((status = 'deleted' AND deleted_at IS NOT NULL) OR status <> 'deleted')
);

CREATE UNIQUE INDEX UX_license_assignments_client
  ON licensing.license_assignments(module_key, client_key, environment_id)
  WHERE target_type = 'client' AND status <> 'deleted';
CREATE UNIQUE INDEX UX_license_assignments_domain
  ON licensing.license_assignments(module_key, domain_key, environment_id)
  WHERE target_type = 'domain' AND status <> 'deleted';
CREATE UNIQUE INDEX UX_license_assignments_database
  ON licensing.license_assignments(module_key, database_key, environment_id)
  WHERE target_type = 'database' AND status <> 'deleted';

CREATE TABLE scheduling.update_schedules
(
  schedule_key                BIGINT IDENTITY(1,1) NOT NULL,
  source_id                   NVARCHAR(150) NOT NULL,
  client_key                  BIGINT NOT NULL,
  client_name_snapshot        NVARCHAR(200) NULL,
  domain_key                  BIGINT NULL,
  domain_name_snapshot        NVARCHAR(500) NULL,
  name                        NVARCHAR(240) NOT NULL,
  target_type                 VARCHAR(20) NOT NULL,
  frequency_type              VARCHAR(20) NOT NULL,
  every_n_weeks               SMALLINT NULL,
  interval_days               INT NULL,
  day_of_month                TINYINT NULL,
  start_date                  DATE NOT NULL,
  end_date                    DATE NULL,
  timezone                    NVARCHAR(100) NOT NULL,
  assigned_role               NVARCHAR(80) NOT NULL,
  domain_assigned_role        NVARCHAR(80) NULL,
  database_assigned_role      NVARCHAR(80) NULL,
  database_reminder_recipients_mode VARCHAR(40) NULL,
  selection_mode              VARCHAR(20) NULL,
  manual_target_types         VARCHAR(40) NULL,
  assignment_mode             VARCHAR(20) NOT NULL CONSTRAINT DF_schedules_assignment_mode DEFAULT ('role'),
  origin                      NVARCHAR(80) NULL,
  active                      BIT NOT NULL CONSTRAINT DF_schedules_active DEFAULT (1),
  completed_at                DATETIME2(3) NULL,
  completed_reason            NVARCHAR(160) NULL,
  notes                       NVARCHAR(MAX) NULL,
  created_at                  DATETIME2(3) NOT NULL,
  created_by                  NVARCHAR(150) NOT NULL,
  updated_at                  DATETIME2(3) NOT NULL,
  updated_by                  NVARCHAR(150) NOT NULL,
  deleted_at                  DATETIME2(3) NULL,
  deleted_by                  NVARCHAR(150) NULL,
  row_version                 ROWVERSION NOT NULL,
  CONSTRAINT PK_update_schedules PRIMARY KEY CLUSTERED (schedule_key),
  CONSTRAINT UQ_update_schedules_source_id UNIQUE (source_id),
  CONSTRAINT UQ_update_schedules_key_client UNIQUE (schedule_key, client_key),
  CONSTRAINT UQ_update_schedules_key_source UNIQUE (schedule_key, source_id),
  CONSTRAINT FK_update_schedules_client FOREIGN KEY (client_key) REFERENCES core.clients(client_key),
  CONSTRAINT FK_update_schedules_domain FOREIGN KEY (domain_key, client_key) REFERENCES core.domains(domain_key, client_key),
  CONSTRAINT FK_update_schedules_assigned_role FOREIGN KEY (assigned_role) REFERENCES security.roles(role_id),
  CONSTRAINT FK_update_schedules_domain_role FOREIGN KEY (domain_assigned_role) REFERENCES security.roles(role_id),
  CONSTRAINT FK_update_schedules_database_role FOREIGN KEY (database_assigned_role) REFERENCES security.roles(role_id),
  CONSTRAINT CK_update_schedules_target CHECK (target_type IN ('domain','database')),
  CONSTRAINT CK_update_schedules_frequency CHECK (frequency_type IN ('once','weekly','interval','monthly','manual')),
  CONSTRAINT CK_update_schedules_dates CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT CK_update_schedules_every_n CHECK (every_n_weeks IS NULL OR every_n_weeks >= 1),
  CONSTRAINT CK_update_schedules_interval CHECK (interval_days IS NULL OR interval_days >= 1),
  CONSTRAINT CK_update_schedules_month CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 31),
  CONSTRAINT CK_update_schedules_selection CHECK (selection_mode IS NULL OR selection_mode IN ('manual','licensing')),
  CONSTRAINT CK_update_schedules_targets CHECK (manual_target_types IS NULL OR manual_target_types IN ('domains_and_databases','domains_only','databases_only')),
  CONSTRAINT CK_update_schedules_assignment CHECK (assignment_mode IN ('role','users')),
  CONSTRAINT CK_update_schedules_tombstone CHECK (deleted_at IS NULL OR active = 0)
);

CREATE TABLE scheduling.schedule_weekdays
(
  schedule_key                BIGINT NOT NULL,
  kind                        VARCHAR(20) NOT NULL,
  weekday                     TINYINT NOT NULL,
  CONSTRAINT PK_schedule_weekdays PRIMARY KEY CLUSTERED (schedule_key, kind, weekday),
  CONSTRAINT FK_schedule_weekdays_schedule FOREIGN KEY (schedule_key) REFERENCES scheduling.update_schedules(schedule_key),
  CONSTRAINT CK_schedule_weekdays_kind CHECK (kind IN ('weekly','preferred')),
  CONSTRAINT CK_schedule_weekdays_day CHECK (weekday BETWEEN 1 AND 7)
);

CREATE TABLE scheduling.schedule_targets
(
  schedule_target_key         BIGINT IDENTITY(1,1) NOT NULL,
  schedule_key                BIGINT NOT NULL,
  client_key                  BIGINT NOT NULL,
  target_type                 VARCHAR(20) NOT NULL,
  domain_key                  BIGINT NULL,
  database_key                BIGINT NULL,
  CONSTRAINT PK_schedule_targets PRIMARY KEY CLUSTERED (schedule_target_key),
  CONSTRAINT UQ_schedule_targets_identity UNIQUE (schedule_key, target_type, domain_key, database_key),
  CONSTRAINT FK_schedule_targets_schedule_client FOREIGN KEY (schedule_key, client_key) REFERENCES scheduling.update_schedules(schedule_key, client_key),
  CONSTRAINT FK_schedule_targets_domain_client FOREIGN KEY (domain_key, client_key) REFERENCES core.domains(domain_key, client_key),
  CONSTRAINT FK_schedule_targets_database_client FOREIGN KEY (database_key, client_key) REFERENCES core.databases(database_key, client_key),
  CONSTRAINT CK_schedule_targets_type CHECK (
    (target_type = 'domain' AND domain_key IS NOT NULL AND database_key IS NULL) OR
    (target_type = 'database' AND domain_key IS NULL AND database_key IS NOT NULL)
  )
);

CREATE TABLE scheduling.schedule_assignees
(
  schedule_key                BIGINT NOT NULL,
  assignment_kind             VARCHAR(20) NOT NULL,
  user_key                    BIGINT NOT NULL,
  CONSTRAINT PK_schedule_assignees PRIMARY KEY CLUSTERED (schedule_key, assignment_kind, user_key),
  CONSTRAINT FK_schedule_assignees_schedule FOREIGN KEY (schedule_key) REFERENCES scheduling.update_schedules(schedule_key),
  CONSTRAINT FK_schedule_assignees_user FOREIGN KEY (user_key) REFERENCES security.users(user_key),
  CONSTRAINT CK_schedule_assignees_kind CHECK (assignment_kind IN ('general','domain','database'))
);

CREATE TABLE scheduling.schedule_reminder_settings
(
  schedule_key                BIGINT NOT NULL,
  reminders_enabled           BIT NOT NULL,
  reminder_time               TIME(0) NULL,
  reminder_recipients_mode    VARCHAR(40) NULL,
  CONSTRAINT PK_schedule_reminder_settings PRIMARY KEY CLUSTERED (schedule_key),
  CONSTRAINT FK_schedule_reminder_settings_schedule FOREIGN KEY (schedule_key) REFERENCES scheduling.update_schedules(schedule_key)
);

CREATE TABLE scheduling.schedule_reminder_days
(
  schedule_key                BIGINT NOT NULL,
  days_before                 SMALLINT NOT NULL,
  CONSTRAINT PK_schedule_reminder_days PRIMARY KEY CLUSTERED (schedule_key, days_before),
  CONSTRAINT FK_schedule_reminder_days_schedule FOREIGN KEY (schedule_key) REFERENCES scheduling.update_schedules(schedule_key),
  CONSTRAINT CK_schedule_reminder_days CHECK (days_before >= 0)
);

CREATE TABLE scheduling.schedule_reminder_emails
(
  schedule_key                BIGINT NOT NULL,
  email_normalized            NVARCHAR(254) NOT NULL,
  CONSTRAINT PK_schedule_reminder_emails PRIMARY KEY CLUSTERED (schedule_key, email_normalized),
  CONSTRAINT FK_schedule_reminder_emails_schedule FOREIGN KEY (schedule_key) REFERENCES scheduling.update_schedules(schedule_key),
  CONSTRAINT CK_schedule_reminder_emails_normalized CHECK (email_normalized = LOWER(LTRIM(RTRIM(email_normalized))))
);

CREATE TABLE scheduling.scope_groups
(
  scope_group_key             BIGINT IDENTITY(1,1) NOT NULL,
  schedule_key                BIGINT NOT NULL,
  ordinal                     INT NOT NULL,
  client_key                  BIGINT NOT NULL,
  include_all_domains         BIT NOT NULL,
  CONSTRAINT PK_scope_groups PRIMARY KEY CLUSTERED (scope_group_key),
  CONSTRAINT UQ_scope_groups_schedule_ordinal UNIQUE (schedule_key, ordinal),
  CONSTRAINT UQ_scope_groups_key_client UNIQUE (scope_group_key, client_key),
  CONSTRAINT FK_scope_groups_schedule FOREIGN KEY (schedule_key) REFERENCES scheduling.update_schedules(schedule_key),
  CONSTRAINT FK_scope_groups_client FOREIGN KEY (client_key) REFERENCES core.clients(client_key),
  CONSTRAINT CK_scope_groups_ordinal CHECK (ordinal >= 0)
);

CREATE TABLE scheduling.scope_domains
(
  scope_domain_key            BIGINT IDENTITY(1,1) NOT NULL,
  scope_group_key             BIGINT NOT NULL,
  ordinal                     INT NOT NULL,
  client_key                  BIGINT NOT NULL,
  domain_key                  BIGINT NOT NULL,
  include_all_databases       BIT NOT NULL,
  CONSTRAINT PK_scope_domains PRIMARY KEY CLUSTERED (scope_domain_key),
  CONSTRAINT UQ_scope_domains_group_domain UNIQUE (scope_group_key, domain_key),
  CONSTRAINT UQ_scope_domains_group_ordinal UNIQUE (scope_group_key, ordinal),
  CONSTRAINT UQ_scope_domains_key_hierarchy UNIQUE (scope_domain_key, domain_key, client_key),
  CONSTRAINT FK_scope_domains_group_client FOREIGN KEY (scope_group_key, client_key) REFERENCES scheduling.scope_groups(scope_group_key, client_key),
  CONSTRAINT FK_scope_domains_domain_client FOREIGN KEY (domain_key, client_key) REFERENCES core.domains(domain_key, client_key),
  CONSTRAINT CK_scope_domains_ordinal CHECK (ordinal >= 0)
);

CREATE TABLE scheduling.scope_databases
(
  scope_domain_key            BIGINT NOT NULL,
  domain_key                  BIGINT NOT NULL,
  client_key                  BIGINT NOT NULL,
  database_key                BIGINT NOT NULL,
  CONSTRAINT PK_scope_databases PRIMARY KEY CLUSTERED (scope_domain_key, database_key),
  CONSTRAINT FK_scope_databases_scope_domain FOREIGN KEY (scope_domain_key, domain_key, client_key) REFERENCES scheduling.scope_domains(scope_domain_key, domain_key, client_key),
  CONSTRAINT FK_scope_databases_database FOREIGN KEY (database_key, domain_key, client_key) REFERENCES core.databases(database_key, domain_key, client_key)
);

CREATE TABLE scheduling.licensing_scope
(
  schedule_key                BIGINT NOT NULL,
  license_match_mode          VARCHAR(10) NOT NULL,
  environment_id              VARCHAR(20) NULL,
  target_types                VARCHAR(40) NOT NULL,
  active_only                 BIT NOT NULL,
  CONSTRAINT PK_licensing_scope PRIMARY KEY CLUSTERED (schedule_key),
  CONSTRAINT FK_licensing_scope_schedule FOREIGN KEY (schedule_key) REFERENCES scheduling.update_schedules(schedule_key),
  CONSTRAINT FK_licensing_scope_environment FOREIGN KEY (environment_id) REFERENCES core.environments(environment_id),
  CONSTRAINT CK_licensing_scope_match CHECK (license_match_mode IN ('any','all')),
  CONSTRAINT CK_licensing_scope_targets CHECK (target_types IN ('domains_and_databases','domains_only','databases_only'))
);

CREATE TABLE scheduling.licensing_scope_modules
(
  schedule_key                BIGINT NOT NULL,
  module_key                  BIGINT NOT NULL,
  CONSTRAINT PK_licensing_scope_modules PRIMARY KEY CLUSTERED (schedule_key, module_key),
  CONSTRAINT FK_licensing_scope_modules_scope FOREIGN KEY (schedule_key) REFERENCES scheduling.licensing_scope(schedule_key),
  CONSTRAINT FK_licensing_scope_modules_module FOREIGN KEY (module_key) REFERENCES licensing.license_modules(module_key)
);

CREATE TABLE scheduling.licensing_excluded_domains
(
  schedule_key                BIGINT NOT NULL,
  domain_key                  BIGINT NOT NULL,
  CONSTRAINT PK_licensing_excluded_domains PRIMARY KEY CLUSTERED (schedule_key, domain_key),
  CONSTRAINT FK_licensing_excluded_domains_scope FOREIGN KEY (schedule_key) REFERENCES scheduling.licensing_scope(schedule_key),
  CONSTRAINT FK_licensing_excluded_domains_domain FOREIGN KEY (domain_key) REFERENCES core.domains(domain_key)
);

CREATE TABLE scheduling.licensing_excluded_databases
(
  schedule_key                BIGINT NOT NULL,
  database_key                BIGINT NOT NULL,
  CONSTRAINT PK_licensing_excluded_databases PRIMARY KEY CLUSTERED (schedule_key, database_key),
  CONSTRAINT FK_licensing_excluded_databases_scope FOREIGN KEY (schedule_key) REFERENCES scheduling.licensing_scope(schedule_key),
  CONSTRAINT FK_licensing_excluded_databases_database FOREIGN KEY (database_key) REFERENCES core.databases(database_key)
);

CREATE TABLE workflow.update_tasks
(
  task_key                    BIGINT IDENTITY(1,1) NOT NULL,
  source_id                   NVARCHAR(150) NOT NULL,
  dedupe_key                  NVARCHAR(500) NULL,
  task_date                   DATE NOT NULL,
  task_bucket                 NVARCHAR(100) NOT NULL,
  client_key                  BIGINT NULL,
  client_source_id            NVARCHAR(150) NOT NULL,
  client_name_snapshot        NVARCHAR(200) NOT NULL,
  domain_key                  BIGINT NULL,
  domain_source_id            NVARCHAR(150) NOT NULL,
  domain_name_snapshot        NVARCHAR(500) NOT NULL,
  target_type                 VARCHAR(20) NOT NULL,
  target_source_id            NVARCHAR(150) NOT NULL,
  target_name_snapshot        NVARCHAR(240) NOT NULL,
  database_key                BIGINT NULL,
  primary_schedule_source_id  NVARCHAR(150) NULL,
  primary_schedule_key        BIGINT NULL,
  is_historical_orphan        BIT NOT NULL CONSTRAINT DF_update_tasks_orphan DEFAULT (0),
  assigned_role               NVARCHAR(80) NOT NULL,
  status                      VARCHAR(30) NOT NULL,
  result                      NVARCHAR(500) NULL,
  notes                       NVARCHAR(MAX) NULL,
  completed_at                DATETIME2(3) NULL,
  completed_by                NVARCHAR(150) NULL,
  completed_with_problems     BIT NOT NULL CONSTRAINT DF_update_tasks_problems DEFAULT (0),
  problem_note                NVARCHAR(MAX) NULL,
  completion_note             NVARCHAR(MAX) NULL,
  blocked_at                  DATETIME2(3) NULL,
  blocked_by                  NVARCHAR(150) NULL,
  block_reason                NVARCHAR(MAX) NULL,
  resolved_at                 DATETIME2(3) NULL,
  resolved_by                 NVARCHAR(150) NULL,
  resolution_comment          NVARCHAR(MAX) NULL,
  reopened_at                 DATETIME2(3) NULL,
  reopened_by                 NVARCHAR(150) NULL,
  reopen_reason               NVARCHAR(MAX) NULL,
  created_at                  DATETIME2(3) NOT NULL,
  created_by                  NVARCHAR(150) NOT NULL,
  updated_at                  DATETIME2(3) NOT NULL,
  updated_by                  NVARCHAR(150) NOT NULL,
  row_version                 ROWVERSION NOT NULL,
  CONSTRAINT PK_update_tasks PRIMARY KEY CLUSTERED (task_key),
  CONSTRAINT UQ_update_tasks_source_id UNIQUE (source_id),
  CONSTRAINT FK_update_tasks_client FOREIGN KEY (client_key) REFERENCES core.clients(client_key),
  CONSTRAINT FK_update_tasks_domain_client FOREIGN KEY (domain_key, client_key) REFERENCES core.domains(domain_key, client_key),
  CONSTRAINT FK_update_tasks_database_hierarchy FOREIGN KEY (database_key, domain_key, client_key) REFERENCES core.databases(database_key, domain_key, client_key),
  CONSTRAINT FK_update_tasks_schedule FOREIGN KEY (primary_schedule_key, primary_schedule_source_id) REFERENCES scheduling.update_schedules(schedule_key, source_id),
  CONSTRAINT FK_update_tasks_role FOREIGN KEY (assigned_role) REFERENCES security.roles(role_id),
  CONSTRAINT CK_update_tasks_target_type CHECK (target_type IN ('domain','database')),
  CONSTRAINT CK_update_tasks_target CHECK (
    (is_historical_orphan = 0 AND target_type = 'domain' AND domain_key IS NOT NULL AND database_key IS NULL) OR
    (is_historical_orphan = 0 AND target_type = 'database' AND domain_key IS NOT NULL AND database_key IS NOT NULL) OR
    (is_historical_orphan = 1)
  ),
  CONSTRAINT CK_update_tasks_status CHECK (status IN ('pending','in_progress','completed','failed','blocked','cancelled','reopened')),
  CONSTRAINT CK_update_tasks_historical_terminal CHECK (is_historical_orphan = 0 OR status IN ('completed','cancelled')),
  CONSTRAINT CK_update_tasks_schedule_pair CHECK (primary_schedule_key IS NULL OR primary_schedule_source_id IS NOT NULL),
  CONSTRAINT CK_update_tasks_completed CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  CONSTRAINT CK_update_tasks_blocked CHECK (status <> 'blocked' OR blocked_at IS NOT NULL),
  CONSTRAINT CK_update_tasks_timestamps CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX UX_update_tasks_dedupe
  ON workflow.update_tasks(target_type, target_source_id, task_date);

CREATE TABLE workflow.task_assignees
(
  task_key                    BIGINT NOT NULL,
  user_key                    BIGINT NOT NULL,
  CONSTRAINT PK_task_assignees PRIMARY KEY CLUSTERED (task_key, user_key),
  CONSTRAINT FK_task_assignees_task FOREIGN KEY (task_key) REFERENCES workflow.update_tasks(task_key),
  CONSTRAINT FK_task_assignees_user FOREIGN KEY (user_key) REFERENCES security.users(user_key)
);

CREATE TABLE workflow.task_sources
(
  task_source_key             BIGINT IDENTITY(1,1) NOT NULL,
  task_key                    BIGINT NOT NULL,
  schedule_source_id          NVARCHAR(150) NOT NULL,
  schedule_key                BIGINT NULL,
  schedule_type               NVARCHAR(80) NULL,
  reason                      NVARCHAR(500) NULL,
  created_at                  DATETIME2(3) NOT NULL,
  is_primary                  BIT NOT NULL CONSTRAINT DF_task_sources_primary DEFAULT (0),
  CONSTRAINT PK_task_sources PRIMARY KEY CLUSTERED (task_source_key),
  CONSTRAINT UQ_task_sources_task_source_type UNIQUE (task_key, schedule_source_id, schedule_type),
  CONSTRAINT FK_task_sources_task FOREIGN KEY (task_key) REFERENCES workflow.update_tasks(task_key),
  CONSTRAINT FK_task_sources_schedule FOREIGN KEY (schedule_key, schedule_source_id) REFERENCES scheduling.update_schedules(schedule_key, source_id)
);

CREATE UNIQUE INDEX UX_task_sources_one_primary
  ON workflow.task_sources(task_key) WHERE is_primary = 1;

CREATE TABLE workflow.task_source_aliases
(
  alias_source_id             NVARCHAR(150) NOT NULL,
  task_key                    BIGINT NOT NULL,
  original_status             VARCHAR(30) NULL,
  original_result             NVARCHAR(500) NULL,
  original_created_at         DATETIME2(3) NULL,
  original_updated_at         DATETIME2(3) NULL,
  consolidated_at             DATETIME2(3) NOT NULL CONSTRAINT DF_task_aliases_consolidated DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_task_source_aliases PRIMARY KEY CLUSTERED (alias_source_id),
  CONSTRAINT FK_task_source_aliases_task FOREIGN KEY (task_key) REFERENCES workflow.update_tasks(task_key)
);

CREATE TABLE workflow.task_status_history
(
  task_status_history_key     BIGINT IDENTITY(1,1) NOT NULL,
  task_key                    BIGINT NOT NULL,
  previous_status             VARCHAR(30) NULL,
  new_status                  VARCHAR(30) NOT NULL,
  action                      NVARCHAR(100) NOT NULL,
  comment                     NVARCHAR(MAX) NULL,
  performed_by                NVARCHAR(150) NOT NULL,
  performed_by_email          NVARCHAR(254) NULL,
  performed_at                DATETIME2(3) NOT NULL,
  is_inferred                 BIT NOT NULL CONSTRAINT DF_task_history_inferred DEFAULT (0),
  metadata_json               NVARCHAR(MAX) NULL,
  CONSTRAINT PK_task_status_history PRIMARY KEY CLUSTERED (task_status_history_key),
  CONSTRAINT FK_task_status_history_task FOREIGN KEY (task_key) REFERENCES workflow.update_tasks(task_key),
  CONSTRAINT CK_task_status_history_previous CHECK (previous_status IS NULL OR previous_status IN ('pending','in_progress','completed','failed','blocked','cancelled','reopened','unknown')),
  CONSTRAINT CK_task_status_history_new CHECK (new_status IN ('pending','in_progress','completed','failed','blocked','cancelled','reopened')),
  CONSTRAINT CK_task_status_history_json CHECK (metadata_json IS NULL OR ISJSON(metadata_json) = 1)
);

CREATE TABLE workflow.task_reminders
(
  task_reminder_key           BIGINT IDENTITY(1,1) NOT NULL,
  task_key                    BIGINT NOT NULL,
  reminder_type               NVARCHAR(80) NOT NULL,
  days_before                 SMALLINT NULL,
  sent_at                     DATETIME2(3) NOT NULL,
  CONSTRAINT PK_task_reminders PRIMARY KEY CLUSTERED (task_reminder_key),
  CONSTRAINT UQ_task_reminders_idempotent UNIQUE (task_key, reminder_type, days_before, sent_at),
  CONSTRAINT FK_task_reminders_task FOREIGN KEY (task_key) REFERENCES workflow.update_tasks(task_key),
  CONSTRAINT CK_task_reminders_days CHECK (days_before IS NULL OR days_before >= 0)
);

CREATE TABLE workflow.task_reminder_recipients
(
  task_reminder_key           BIGINT NOT NULL,
  email_normalized            NVARCHAR(254) NOT NULL,
  CONSTRAINT PK_task_reminder_recipients PRIMARY KEY CLUSTERED (task_reminder_key, email_normalized),
  CONSTRAINT FK_task_reminder_recipients_reminder FOREIGN KEY (task_reminder_key) REFERENCES workflow.task_reminders(task_reminder_key)
);

CREATE TABLE workflow.task_overdue_alerts
(
  task_key                    BIGINT NOT NULL,
  sent_date                   DATE NOT NULL,
  CONSTRAINT PK_task_overdue_alerts PRIMARY KEY CLUSTERED (task_key, sent_date),
  CONSTRAINT FK_task_overdue_alerts_task FOREIGN KEY (task_key) REFERENCES workflow.update_tasks(task_key)
);

COMMIT TRANSACTION;
GO

PRINT N'004 complete: licensing, scheduling and workflow tables created.';
GO
