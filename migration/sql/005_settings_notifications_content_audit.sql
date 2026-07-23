/* Portal SAG Web - Gate C / 005: settings, notifications, content and audit. SQL Server 2019. */
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() <> N'PortalSAGWeb' THROW 51050, N'Wrong database.', 1;
IF OBJECT_ID(N'workflow.update_tasks', N'U') IS NULL THROW 51051, N'Run 004 first.', 1;
GO

BEGIN TRANSACTION;

CREATE TABLE settings.email_settings
(
  settings_key                         TINYINT NOT NULL CONSTRAINT DF_email_settings_key DEFAULT (1),
  source_id                            NVARCHAR(150) NOT NULL,
  email_provider                       VARCHAR(20) NOT NULL,
  email_from                           NVARCHAR(254) NOT NULL,
  email_from_name                      NVARCHAR(160) NOT NULL,
  frontend_base_url                    NVARCHAR(500) NULL,
  smtp_host                            NVARCHAR(500) NULL,
  smtp_port                            INT NULL,
  smtp_secure                          BIT NULL,
  smtp_user                            NVARCHAR(256) NULL,
  smtp_password_secret_name            NVARCHAR(256) NULL,
  smtp_password_configured             BIT NOT NULL CONSTRAINT DF_email_settings_password_configured DEFAULT (0),
  reminders_enabled                    BIT NOT NULL,
  default_reminder_time                TIME(0) NOT NULL,
  default_timezone                     NVARCHAR(100) NOT NULL,
  overdue_alerts_enabled               BIT NOT NULL,
  overdue_alert_time                   TIME(0) NOT NULL,
  overdue_alert_timezone               NVARCHAR(100) NOT NULL,
  legacy_overdue_recipient_mode        VARCHAR(40) NOT NULL,
  overdue_alert_frequency              VARCHAR(20) NULL,
  overdue_alert_last_sent_period       NVARCHAR(40) NULL,
  blocked_alerts_enabled               BIT NOT NULL CONSTRAINT DF_email_settings_blocked_enabled DEFAULT (0),
  blocked_alert_send_immediately       BIT NOT NULL CONSTRAINT DF_email_settings_blocked_immediate DEFAULT (0),
  blocked_alert_include_overdue        BIT NOT NULL CONSTRAINT DF_email_settings_blocked_overdue DEFAULT (0),
  blocked_reminder_enabled             BIT NOT NULL CONSTRAINT DF_email_settings_blocked_reminder DEFAULT (0),
  blocked_reminder_time                TIME(0) NULL,
  blocked_reminder_timezone            NVARCHAR(100) NULL,
  password_notification_enabled        BIT NOT NULL,
  send_temporary_password_by_email     BIT NOT NULL,
  created_at                           DATETIME2(3) NOT NULL,
  created_by                           NVARCHAR(150) NOT NULL,
  updated_at                           DATETIME2(3) NOT NULL,
  updated_by                           NVARCHAR(150) NOT NULL,
  row_version                          ROWVERSION NOT NULL,
  CONSTRAINT PK_email_settings PRIMARY KEY CLUSTERED (settings_key),
  CONSTRAINT UQ_email_settings_source_id UNIQUE (source_id),
  CONSTRAINT CK_email_settings_singleton CHECK (settings_key = 1 AND source_id = N'email-alerts'),
  CONSTRAINT CK_email_settings_provider CHECK (email_provider IN ('mock','smtp','sendgrid','acs')),
  CONSTRAINT CK_email_settings_smtp_port CHECK (smtp_port IS NULL OR smtp_port BETWEEN 1 AND 65535),
  CONSTRAINT CK_email_settings_overdue_mode CHECK (legacy_overdue_recipient_mode IN ('admins','adminsAndClientManagers','customEmails')),
  CONSTRAINT CK_email_settings_overdue_frequency CHECK (overdue_alert_frequency IS NULL OR overdue_alert_frequency IN ('daily','weekly')),
  CONSTRAINT CK_email_settings_smtp_secret CHECK (smtp_password_secret_name IS NULL OR LEN(LTRIM(RTRIM(smtp_password_secret_name))) > 0),
  CONSTRAINT CK_email_settings_timestamps CHECK (updated_at >= created_at)
);

CREATE TABLE settings.default_reminder_days
(
  days_before                 SMALLINT NOT NULL,
  CONSTRAINT PK_default_reminder_days PRIMARY KEY CLUSTERED (days_before),
  CONSTRAINT CK_default_reminder_days CHECK (days_before >= 0)
);

CREATE TABLE settings.alert_recipient_roles
(
  alert_kind                  VARCHAR(20) NOT NULL,
  role_id                     NVARCHAR(80) NOT NULL,
  CONSTRAINT PK_alert_recipient_roles PRIMARY KEY CLUSTERED (alert_kind, role_id),
  CONSTRAINT FK_alert_recipient_roles_role FOREIGN KEY (role_id) REFERENCES security.roles(role_id),
  CONSTRAINT CK_alert_recipient_roles_kind CHECK (alert_kind IN ('overdue','blocked'))
);

CREATE TABLE settings.alert_recipient_emails
(
  alert_kind                  VARCHAR(20) NOT NULL,
  email_normalized            NVARCHAR(254) NOT NULL,
  source_kind                 VARCHAR(20) NOT NULL CONSTRAINT DF_alert_recipient_emails_source DEFAULT ('current'),
  CONSTRAINT PK_alert_recipient_emails PRIMARY KEY CLUSTERED (alert_kind, email_normalized, source_kind),
  CONSTRAINT CK_alert_recipient_emails_kind CHECK (alert_kind IN ('overdue','blocked')),
  CONSTRAINT CK_alert_recipient_emails_source CHECK (source_kind IN ('current','legacy')),
  CONSTRAINT CK_alert_recipient_emails_normalized CHECK (email_normalized = LOWER(LTRIM(RTRIM(email_normalized))))
);

CREATE TABLE settings.overdue_alert_weekdays
(
  weekday                     TINYINT NOT NULL,
  CONSTRAINT PK_overdue_alert_weekdays PRIMARY KEY CLUSTERED (weekday),
  CONSTRAINT CK_overdue_alert_weekdays CHECK (weekday BETWEEN 1 AND 7)
);

CREATE TABLE settings.blocked_reminder_days
(
  days_after                  SMALLINT NOT NULL,
  CONSTRAINT PK_blocked_reminder_days PRIMARY KEY CLUSTERED (days_after),
  CONSTRAINT CK_blocked_reminder_days CHECK (days_after >= 0)
);

CREATE TABLE settings.administrative_reminders
(
  reminder_kind               VARCHAR(40) NOT NULL,
  enabled                     BIT NOT NULL,
  send_rule                   VARCHAR(30) NOT NULL,
  day_of_month                TINYINT NOT NULL,
  reminder_time               TIME(0) NOT NULL,
  timezone                    NVARCHAR(100) NOT NULL,
  subject                     NVARCHAR(300) NOT NULL,
  row_version                 ROWVERSION NOT NULL,
  CONSTRAINT PK_administrative_reminders PRIMARY KEY CLUSTERED (reminder_kind),
  CONSTRAINT CK_administrative_reminders_kind CHECK (reminder_kind IN ('sag_web_version','whats_new')),
  CONSTRAINT CK_administrative_reminders_rule CHECK (send_rule IN ('first_day','last_day','last_business_day','fixed_day')),
  CONSTRAINT CK_administrative_reminders_day CHECK (day_of_month BETWEEN 1 AND 28)
);

CREATE TABLE settings.administrative_reminder_recipients
(
  reminder_kind               VARCHAR(40) NOT NULL,
  email_normalized            NVARCHAR(254) NOT NULL,
  CONSTRAINT PK_administrative_reminder_recipients PRIMARY KEY CLUSTERED (reminder_kind, email_normalized),
  CONSTRAINT FK_admin_reminder_recipients_reminder FOREIGN KEY (reminder_kind) REFERENCES settings.administrative_reminders(reminder_kind),
  CONSTRAINT CK_admin_reminder_recipients_normalized CHECK (email_normalized = LOWER(LTRIM(RTRIM(email_normalized))))
);

CREATE TABLE content.files
(
  file_key                    BIGINT IDENTITY(1,1) NOT NULL,
  public_id                   UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_files_public_id DEFAULT NEWSEQUENTIALID(),
  storage_provider            VARCHAR(30) NOT NULL CONSTRAINT DF_files_provider DEFAULT ('azure_blob'),
  storage_container           NVARCHAR(100) NOT NULL,
  blob_name                   NVARCHAR(1024) NOT NULL,
  original_name               NVARCHAR(260) NOT NULL,
  mime_type                   NVARCHAR(160) NOT NULL,
  byte_count                  BIGINT NOT NULL,
  content_sha256              BINARY(32) NOT NULL,
  created_at                  DATETIME2(3) NOT NULL CONSTRAINT DF_files_created_at DEFAULT SYSUTCDATETIME(),
  created_by                  NVARCHAR(150) NOT NULL,
  CONSTRAINT PK_files PRIMARY KEY CLUSTERED (file_key),
  CONSTRAINT UQ_files_public_id UNIQUE (public_id),
  CONSTRAINT UQ_files_blob UNIQUE (storage_provider, storage_container, blob_name),
  CONSTRAINT CK_files_provider CHECK (storage_provider IN ('azure_blob')),
  CONSTRAINT CK_files_bytes CHECK (byte_count > 0)
);

CREATE TABLE content.print_format_sources
(
  print_format_source_key     BIGINT IDENTITY(1,1) NOT NULL,
  source_id                   NVARCHAR(150) NOT NULL,
  name                        NVARCHAR(200) NOT NULL,
  name_normalized             NVARCHAR(200) NOT NULL,
  description                 NVARCHAR(1000) NULL,
  active                      BIT NOT NULL,
  status                      VARCHAR(20) NOT NULL,
  created_at                  DATETIME2(3) NOT NULL,
  created_by                  NVARCHAR(150) NOT NULL,
  updated_at                  DATETIME2(3) NOT NULL,
  updated_by                  NVARCHAR(150) NOT NULL,
  deleted_at                  DATETIME2(3) NULL,
  deleted_by                  NVARCHAR(150) NULL,
  row_version                 ROWVERSION NOT NULL,
  CONSTRAINT PK_print_format_sources PRIMARY KEY CLUSTERED (print_format_source_key),
  CONSTRAINT UQ_print_format_sources_source_id UNIQUE (source_id),
  CONSTRAINT CK_print_format_sources_status CHECK (status IN ('active','inactive','deleted')),
  CONSTRAINT CK_print_format_sources_active CHECK ((status = 'active' AND active = 1) OR status <> 'active')
);

CREATE UNIQUE INDEX UX_print_format_sources_name_active
  ON content.print_format_sources(name_normalized) WHERE status <> 'deleted';

CREATE TABLE content.print_formats
(
  print_format_key            BIGINT IDENTITY(1,1) NOT NULL,
  source_id                   NVARCHAR(150) NOT NULL,
  print_format_source_key     BIGINT NOT NULL,
  name                        NVARCHAR(240) NOT NULL,
  name_normalized             NVARCHAR(240) NOT NULL,
  description                 NVARCHAR(MAX) NULL,
  format_size                 VARCHAR(30) NULL,
  custom_format_size          NVARCHAR(100) NULL,
  requires_license            BIT NOT NULL CONSTRAINT DF_print_formats_license DEFAULT (0),
  module_key                  BIGINT NULL,
  legacy_import_code          NVARCHAR(200) NULL,
  legacy_import_status        NVARCHAR(200) NULL,
  legacy_variant              NVARCHAR(200) NULL,
  active                      BIT NOT NULL,
  status                      VARCHAR(20) NOT NULL,
  created_at                  DATETIME2(3) NOT NULL,
  created_by                  NVARCHAR(150) NOT NULL,
  updated_at                  DATETIME2(3) NOT NULL,
  updated_by                  NVARCHAR(150) NOT NULL,
  deleted_at                  DATETIME2(3) NULL,
  deleted_by                  NVARCHAR(150) NULL,
  row_version                 ROWVERSION NOT NULL,
  CONSTRAINT PK_print_formats PRIMARY KEY CLUSTERED (print_format_key),
  CONSTRAINT UQ_print_formats_source_id UNIQUE (source_id),
  CONSTRAINT FK_print_formats_source FOREIGN KEY (print_format_source_key) REFERENCES content.print_format_sources(print_format_source_key),
  CONSTRAINT FK_print_formats_module FOREIGN KEY (module_key) REFERENCES licensing.license_modules(module_key),
  CONSTRAINT CK_print_formats_size CHECK (format_size IS NULL OR format_size IN ('carta','oficio','a4','legal','personalizado')),
  CONSTRAINT CK_print_formats_custom CHECK ((format_size = 'personalizado' AND custom_format_size IS NOT NULL) OR format_size <> 'personalizado' OR format_size IS NULL),
  CONSTRAINT CK_print_formats_license CHECK ((requires_license = 1 AND module_key IS NOT NULL) OR (requires_license = 0 AND module_key IS NULL)),
  CONSTRAINT CK_print_formats_status CHECK (status IN ('active','inactive','deleted'))
);

CREATE UNIQUE INDEX UX_print_formats_source_name_active
  ON content.print_formats(print_format_source_key, name_normalized) WHERE status <> 'deleted';

CREATE TABLE content.print_format_files
(
  print_format_key            BIGINT NOT NULL,
  version_no                  INT NOT NULL,
  file_key                    BIGINT NOT NULL,
  is_current                  BIT NOT NULL,
  created_at                  DATETIME2(3) NOT NULL CONSTRAINT DF_print_format_files_created DEFAULT SYSUTCDATETIME(),
  created_by                  NVARCHAR(150) NOT NULL,
  CONSTRAINT PK_print_format_files PRIMARY KEY CLUSTERED (print_format_key, version_no),
  CONSTRAINT FK_print_format_files_format FOREIGN KEY (print_format_key) REFERENCES content.print_formats(print_format_key),
  CONSTRAINT FK_print_format_files_file FOREIGN KEY (file_key) REFERENCES content.files(file_key),
  CONSTRAINT CK_print_format_files_version CHECK (version_no >= 1)
);

CREATE UNIQUE INDEX UX_print_format_files_current
  ON content.print_format_files(print_format_key) WHERE is_current = 1;

CREATE TABLE content.public_download_sections
(
  section_key                 BIGINT IDENTITY(1,1) NOT NULL,
  source_id                   NVARCHAR(150) NOT NULL,
  name                        NVARCHAR(200) NOT NULL,
  name_normalized             NVARCHAR(200) NOT NULL,
  slug                        NVARCHAR(200) NOT NULL,
  slug_normalized             NVARCHAR(200) NOT NULL,
  description                 NVARCHAR(1000) NULL,
  active                      BIT NOT NULL,
  status                      VARCHAR(20) NOT NULL,
  created_at                  DATETIME2(3) NOT NULL,
  created_by                  NVARCHAR(150) NOT NULL,
  updated_at                  DATETIME2(3) NOT NULL,
  updated_by                  NVARCHAR(150) NOT NULL,
  deleted_at                  DATETIME2(3) NULL,
  deleted_by                  NVARCHAR(150) NULL,
  row_version                 ROWVERSION NOT NULL,
  CONSTRAINT PK_public_download_sections PRIMARY KEY CLUSTERED (section_key),
  CONSTRAINT UQ_public_download_sections_source_id UNIQUE (source_id),
  CONSTRAINT CK_public_download_sections_status CHECK (status IN ('active','inactive','deleted'))
);

CREATE UNIQUE INDEX UX_public_download_sections_slug_active
  ON content.public_download_sections(slug_normalized) WHERE status <> 'deleted';

CREATE TABLE content.public_download_documents
(
  document_key                BIGINT IDENTITY(1,1) NOT NULL,
  source_id                   NVARCHAR(150) NOT NULL,
  section_key                 BIGINT NOT NULL,
  title                       NVARCHAR(240) NOT NULL,
  slug                        NVARCHAR(200) NOT NULL,
  slug_normalized             NVARCHAR(200) NOT NULL,
  description                 NVARCHAR(1000) NULL,
  active                      BIT NOT NULL,
  status                      VARCHAR(20) NOT NULL,
  created_at                  DATETIME2(3) NOT NULL,
  created_by                  NVARCHAR(150) NOT NULL,
  updated_at                  DATETIME2(3) NOT NULL,
  updated_by                  NVARCHAR(150) NOT NULL,
  deleted_at                  DATETIME2(3) NULL,
  deleted_by                  NVARCHAR(150) NULL,
  row_version                 ROWVERSION NOT NULL,
  CONSTRAINT PK_public_download_documents PRIMARY KEY CLUSTERED (document_key),
  CONSTRAINT UQ_public_download_documents_source_id UNIQUE (source_id),
  CONSTRAINT FK_public_download_documents_section FOREIGN KEY (section_key) REFERENCES content.public_download_sections(section_key),
  CONSTRAINT CK_public_download_documents_status CHECK (status IN ('active','inactive','deleted'))
);

CREATE UNIQUE INDEX UX_public_download_documents_slug_active
  ON content.public_download_documents(slug_normalized) WHERE status <> 'deleted';

CREATE TABLE content.public_download_files
(
  document_key                BIGINT NOT NULL,
  version_no                  INT NOT NULL,
  file_key                    BIGINT NOT NULL,
  is_current                  BIT NOT NULL,
  created_at                  DATETIME2(3) NOT NULL CONSTRAINT DF_public_download_files_created DEFAULT SYSUTCDATETIME(),
  created_by                  NVARCHAR(150) NOT NULL,
  CONSTRAINT PK_public_download_files PRIMARY KEY CLUSTERED (document_key, version_no),
  CONSTRAINT FK_public_download_files_document FOREIGN KEY (document_key) REFERENCES content.public_download_documents(document_key),
  CONSTRAINT FK_public_download_files_file FOREIGN KEY (file_key) REFERENCES content.files(file_key),
  CONSTRAINT CK_public_download_files_version CHECK (version_no >= 1)
);

CREATE UNIQUE INDEX UX_public_download_files_current
  ON content.public_download_files(document_key) WHERE is_current = 1;

CREATE TABLE notifications.email_notifications
(
  notification_key            BIGINT IDENTITY(1,1) NOT NULL,
  source_id                   NVARCHAR(150) NOT NULL,
  notification_type           VARCHAR(60) NOT NULL,
  entity_type                 NVARCHAR(80) NULL,
  entity_source_id            NVARCHAR(150) NULL,
  task_key                    BIGINT NULL,
  idempotency_key             NVARCHAR(500) NOT NULL,
  period                      NVARCHAR(40) NULL,
  send_date                   DATE NULL,
  subject                     NVARCHAR(500) NULL,
  status                      VARCHAR(20) NOT NULL,
  attempt_count               INT NOT NULL CONSTRAINT DF_email_notifications_attempts DEFAULT (0),
  claimed_by                  NVARCHAR(150) NULL,
  claim_expires_at            DATETIME2(3) NULL,
  next_attempt_at             DATETIME2(3) NULL,
  last_attempted_at           DATETIME2(3) NULL,
  sent_at                     DATETIME2(3) NULL,
  provider_message_id         NVARCHAR(300) NULL,
  last_error                  NVARCHAR(2000) NULL,
  metadata_json               NVARCHAR(MAX) NULL,
  created_at                  DATETIME2(3) NOT NULL,
  created_by                  NVARCHAR(150) NOT NULL,
  updated_at                  DATETIME2(3) NOT NULL,
  updated_by                  NVARCHAR(150) NOT NULL,
  row_version                 ROWVERSION NOT NULL,
  CONSTRAINT PK_email_notifications PRIMARY KEY CLUSTERED (notification_key),
  CONSTRAINT UQ_email_notifications_source_id UNIQUE (source_id),
  CONSTRAINT UQ_email_notifications_idempotency UNIQUE (idempotency_key),
  CONSTRAINT FK_email_notifications_task FOREIGN KEY (task_key) REFERENCES workflow.update_tasks(task_key),
  CONSTRAINT CK_email_notifications_type CHECK (notification_type IN ('administrative_reminder','blocked_task_reminder','task_reminder','overdue_alert','password_notification')),
  CONSTRAINT CK_email_notifications_status CHECK (status IN ('pending','processing','sent','failed','cancelled')),
  CONSTRAINT CK_email_notifications_attempts CHECK (attempt_count >= 0),
  CONSTRAINT CK_email_notifications_json CHECK (metadata_json IS NULL OR ISJSON(metadata_json) = 1),
  CONSTRAINT CK_email_notifications_claim CHECK ((claimed_by IS NULL AND claim_expires_at IS NULL) OR (claimed_by IS NOT NULL AND claim_expires_at IS NOT NULL)),
  CONSTRAINT CK_email_notifications_sent CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);

CREATE TABLE notifications.email_notification_recipients
(
  recipient_key               BIGINT IDENTITY(1,1) NOT NULL,
  notification_key            BIGINT NOT NULL,
  email                       NVARCHAR(254) NOT NULL,
  email_normalized            NVARCHAR(254) NOT NULL,
  recipient_type              VARCHAR(10) NOT NULL,
  display_name                NVARCHAR(160) NULL,
  delivery_status             VARCHAR(20) NULL,
  error_message               NVARCHAR(1000) NULL,
  CONSTRAINT PK_email_notification_recipients PRIMARY KEY CLUSTERED (recipient_key),
  CONSTRAINT UQ_email_notification_recipients UNIQUE (notification_key, recipient_type, email_normalized),
  CONSTRAINT FK_email_notification_recipients_notification FOREIGN KEY (notification_key) REFERENCES notifications.email_notifications(notification_key),
  CONSTRAINT CK_email_notification_recipients_type CHECK (recipient_type IN ('to','cc','bcc')),
  CONSTRAINT CK_email_notification_recipients_status CHECK (delivery_status IS NULL OR delivery_status IN ('pending','sent','failed','skipped')),
  CONSTRAINT CK_email_notification_recipients_normalized CHECK (email_normalized = LOWER(LTRIM(RTRIM(email_normalized))))
);

CREATE TABLE notifications.email_notification_attempts
(
  attempt_key                 BIGINT IDENTITY(1,1) NOT NULL,
  notification_key            BIGINT NOT NULL,
  attempt_no                  INT NOT NULL,
  started_at                  DATETIME2(3) NOT NULL,
  completed_at                DATETIME2(3) NULL,
  attempt_status              VARCHAR(20) NOT NULL,
  provider_message_id         NVARCHAR(300) NULL,
  error_message               NVARCHAR(2000) NULL,
  CONSTRAINT PK_email_notification_attempts PRIMARY KEY CLUSTERED (attempt_key),
  CONSTRAINT UQ_email_notification_attempts UNIQUE (notification_key, attempt_no),
  CONSTRAINT FK_email_notification_attempts_notification FOREIGN KEY (notification_key) REFERENCES notifications.email_notifications(notification_key),
  CONSTRAINT CK_email_notification_attempts_no CHECK (attempt_no >= 1),
  CONSTRAINT CK_email_notification_attempts_status CHECK (attempt_status IN ('processing','sent','failed')),
  CONSTRAINT CK_email_notification_attempts_dates CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE TABLE audit.audit_logs
(
  audit_log_key               BIGINT IDENTITY(1,1) NOT NULL,
  source_id                   NVARCHAR(150) NOT NULL,
  entity_type                 NVARCHAR(100) NOT NULL,
  entity_source_id            NVARCHAR(150) NOT NULL,
  client_key                  BIGINT NULL,
  client_name_snapshot        NVARCHAR(200) NULL,
  domain_key                  BIGINT NULL,
  domain_name_snapshot        NVARCHAR(500) NULL,
  company_name_snapshot       NVARCHAR(240) NULL,
  action                      NVARCHAR(160) NOT NULL,
  performed_by                NVARCHAR(150) NOT NULL,
  performed_by_email          NVARCHAR(254) NULL,
  performed_at                DATETIME2(3) NOT NULL,
  before_json                 NVARCHAR(MAX) NULL,
  after_json                  NVARCHAR(MAX) NULL,
  metadata_json               NVARCHAR(MAX) NULL,
  schema_version              SMALLINT NOT NULL CONSTRAINT DF_audit_logs_schema_version DEFAULT (1),
  data_classification         VARCHAR(20) NOT NULL CONSTRAINT DF_audit_logs_classification DEFAULT ('internal'),
  CONSTRAINT PK_audit_logs PRIMARY KEY CLUSTERED (audit_log_key),
  CONSTRAINT UQ_audit_logs_source_id UNIQUE (source_id),
  CONSTRAINT FK_audit_logs_client FOREIGN KEY (client_key) REFERENCES core.clients(client_key),
  CONSTRAINT FK_audit_logs_domain FOREIGN KEY (domain_key) REFERENCES core.domains(domain_key),
  CONSTRAINT CK_audit_logs_before_json CHECK (before_json IS NULL OR ISJSON(before_json) = 1),
  CONSTRAINT CK_audit_logs_after_json CHECK (after_json IS NULL OR ISJSON(after_json) = 1),
  CONSTRAINT CK_audit_logs_metadata_json CHECK (metadata_json IS NULL OR ISJSON(metadata_json) = 1),
  CONSTRAINT CK_audit_logs_schema_version CHECK (schema_version >= 1),
  CONSTRAINT CK_audit_logs_classification CHECK (data_classification IN ('public','internal','confidential','restricted'))
);

COMMIT TRANSACTION;
GO

PRINT N'005 complete: settings, content, notifications and audit tables created.';
GO
