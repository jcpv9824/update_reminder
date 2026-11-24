/* Portal SAG Web - SQL Server 2019 / 063 — DRAFT, NOT APPLIED
   Qué hay de nuevo: reportes HTML enviados desde la pestaña Probadas.
   - El HTML vive en SeaweedFS (…/QueHayDeNuevo/reportes/<aaaa>/<mm>/<reportId>.html);
     SQL guarda solo el localizador en content.files y la evidencia de qué
     entradas y qué destinatarios incluyó el reporte.
   - Amplía notifications.CK_email_notifications_type con 'whats_new_report'
     conservando los ocho valores vigentes (patrón de 019 y 023).
   Solo inserción. Reejecutable. */
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() NOT IN (N'PortalSAGWeb',N'PortalSAGWeb-TEST')
  THROW 53400,N'Wrong database.',1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT)<>15
  THROW 53401,N'This migration is certified for SQL Server 2019 (major version 15).',1;
IF (SELECT compatibility_level FROM sys.databases WHERE database_id=DB_ID())<>150
  THROW 53407,N'Compatibility level 150 is required.',1;
IF OBJECT_ID(N'migration.schema_migrations',N'U') IS NULL
  THROW 53402,N'Migration history is missing.',1;
IF NOT EXISTS (SELECT 1 FROM migration.schema_migrations WHERE migration_version='062' AND succeeded=1)
  THROW 53403,N'Run migration 062 first.',1;
IF OBJECT_ID(N'whats_new.entries',N'U') IS NULL OR OBJECT_ID(N'notifications.email_notifications',N'U') IS NULL
  THROW 53404,N'The whats_new report prerequisites are missing.',1;
GO

BEGIN TRY
BEGIN TRANSACTION;

IF OBJECT_ID(N'whats_new.reports',N'U') IS NULL
BEGIN
  CREATE TABLE whats_new.reports
  (
    report_key            BIGINT IDENTITY(1,1) NOT NULL,
    source_id             NVARCHAR(150) NOT NULL,
    include_mode          VARCHAR(20) NOT NULL,
    filters_json          NVARCHAR(1000) NULL,
    entry_count           INT NOT NULL,
    approved_count        INT NOT NULL,
    failed_count          INT NOT NULL,
    recipient_count       SMALLINT NOT NULL,
    file_key              BIGINT NOT NULL,
    snapshot_sha256       BINARY(32) NOT NULL,
    generated_by_user_key BIGINT NOT NULL,
    generated_at          DATETIME2(3) NOT NULL,
    idempotency_key       NVARCHAR(200) NOT NULL,
    CONSTRAINT PK_whats_new_reports PRIMARY KEY CLUSTERED (report_key),
    CONSTRAINT UQ_whats_new_reports_source_id UNIQUE (source_id),
    CONSTRAINT UQ_whats_new_reports_idempotency UNIQUE (generated_by_user_key,idempotency_key),
    CONSTRAINT FK_whats_new_reports_file FOREIGN KEY (file_key) REFERENCES content.files(file_key),
    CONSTRAINT FK_whats_new_reports_user FOREIGN KEY (generated_by_user_key) REFERENCES security.users(user_key),
    CONSTRAINT CK_whats_new_reports_include CHECK (include_mode IN ('todas','aprobadas','fallidas')),
    CONSTRAINT CK_whats_new_reports_filters CHECK (filters_json IS NULL OR ISJSON(filters_json)=1),
    CONSTRAINT CK_whats_new_reports_counts CHECK
      (entry_count BETWEEN 1 AND 200 AND approved_count>=0 AND failed_count>=0
        AND approved_count+failed_count=entry_count AND recipient_count BETWEEN 1 AND 30)
  );
END;

IF OBJECT_ID(N'whats_new.report_entries',N'U') IS NULL
BEGIN
  CREATE TABLE whats_new.report_entries
  (
    report_key      BIGINT NOT NULL,
    entry_key       BIGINT NOT NULL,
    status_snapshot VARCHAR(20) NOT NULL,
    revision_no     INT NOT NULL,
    round_count     INT NOT NULL,
    finding_count   INT NOT NULL,
    CONSTRAINT PK_whats_new_report_entries PRIMARY KEY CLUSTERED (report_key,entry_key),
    CONSTRAINT FK_whats_new_report_entries_report FOREIGN KEY (report_key) REFERENCES whats_new.reports(report_key),
    CONSTRAINT FK_whats_new_report_entries_entry FOREIGN KEY (entry_key) REFERENCES whats_new.entries(entry_key),
    CONSTRAINT CK_whats_new_report_entries_status CHECK (status_snapshot IN ('probado','fallida'))
  );
END;

IF OBJECT_ID(N'whats_new.report_recipients',N'U') IS NULL
BEGIN
  CREATE TABLE whats_new.report_recipients
  (
    report_key       BIGINT NOT NULL,
    user_key         BIGINT NOT NULL,
    notification_key BIGINT NOT NULL,
    email_snapshot   NVARCHAR(254) NOT NULL,
    CONSTRAINT PK_whats_new_report_recipients PRIMARY KEY CLUSTERED (report_key,user_key),
    CONSTRAINT UQ_whats_new_report_recipients_notification UNIQUE (notification_key),
    CONSTRAINT FK_whats_new_report_recipients_report FOREIGN KEY (report_key) REFERENCES whats_new.reports(report_key),
    CONSTRAINT FK_whats_new_report_recipients_user FOREIGN KEY (user_key) REFERENCES security.users(user_key),
    CONSTRAINT FK_whats_new_report_recipients_notification FOREIGN KEY (notification_key)
      REFERENCES notifications.email_notifications(notification_key)
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'whats_new.report_recipients') AND name=N'IX_whats_new_report_recipients_user')
  CREATE INDEX IX_whats_new_report_recipients_user ON whats_new.report_recipients(user_key,report_key);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'whats_new.reports') AND name=N'IX_whats_new_reports_generated')
  CREATE INDEX IX_whats_new_reports_generated ON whats_new.reports(generated_by_user_key,generated_at DESC);

DENY UPDATE, DELETE ON OBJECT::whats_new.reports           TO portal_runtime;
DENY UPDATE, DELETE ON OBJECT::whats_new.report_entries    TO portal_runtime;
DENY UPDATE, DELETE ON OBJECT::whats_new.report_recipients TO portal_runtime;

-- Extend the installed constraint rather than rebuilding a stale whitelist:
-- parallel features may have added notification types after this branch split.
DECLARE @prior_notification_check NVARCHAR(MAX);
SELECT @prior_notification_check=definition FROM sys.check_constraints
WHERE parent_object_id=OBJECT_ID(N'notifications.email_notifications')
  AND name=N'CK_email_notifications_type' AND is_disabled=0 AND is_not_trusted=0;
IF @prior_notification_check IS NULL
  THROW 53408,N'The existing trusted notification type constraint is required.',1;
IF CHARINDEX(N'''whats_new_report''',@prior_notification_check)=0
BEGIN
  ALTER TABLE notifications.email_notifications DROP CONSTRAINT CK_email_notifications_type;
  -- The expression is trusted database catalog metadata, never user input.
  DECLARE @extend_notification_check NVARCHAR(MAX)=
    N'ALTER TABLE notifications.email_notifications WITH CHECK ADD CONSTRAINT CK_email_notifications_type CHECK (('
    +@prior_notification_check+N') OR notification_type=''whats_new_report'');';
  EXEC sys.sp_executesql @extend_notification_check;
END;
ALTER TABLE notifications.email_notifications CHECK CONSTRAINT CK_email_notifications_type;

DECLARE @installed_notification_check nvarchar(max);
SELECT @installed_notification_check=definition FROM sys.check_constraints
WHERE parent_object_id=OBJECT_ID(N'notifications.email_notifications') AND name=N'CK_email_notifications_type'
  AND is_disabled=0 AND is_not_trusted=0;
IF @installed_notification_check IS NULL OR EXISTS (
  SELECT 1 FROM (VALUES (N'administrative_reminder'),(N'blocked_task_reminder'),(N'task_reminder'),
    (N'overdue_alert'),(N'password_notification'),(N'task_status_notification'),(N'test_email'),
    (N'masters_report'),(N'whats_new_report')) required(notification_type)
  WHERE CHARINDEX(N''''+required.notification_type+N'''',@installed_notification_check)=0
)
  THROW 53405,N'whats_new_report outbox type verification failed.',1;

COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO

CREATE OR ALTER TRIGGER whats_new.TR_reports_append_only
ON whats_new.reports AFTER UPDATE, DELETE
AS BEGIN SET NOCOUNT ON; THROW 53410,N'whats_new.reports is append-only.',1; END;
GO
CREATE OR ALTER TRIGGER whats_new.TR_report_entries_append_only
ON whats_new.report_entries AFTER UPDATE, DELETE
AS BEGIN SET NOCOUNT ON; THROW 53411,N'whats_new.report_entries is append-only.',1; END;
GO
CREATE OR ALTER TRIGGER whats_new.TR_report_recipients_append_only
ON whats_new.report_recipients AFTER UPDATE, DELETE
AS BEGIN SET NOCOUNT ON; THROW 53412,N'whats_new.report_recipients is append-only.',1; END;
GO

IF OBJECT_ID(N'whats_new.TR_reports_append_only',N'TR') IS NULL
   OR OBJECT_ID(N'whats_new.TR_report_entries_append_only',N'TR') IS NULL
   OR OBJECT_ID(N'whats_new.TR_report_recipients_append_only',N'TR') IS NULL
  THROW 53406,N'whats_new report trigger verification failed.',1;
PRINT N'063 complete: whats_new reports and the whats_new_report outbox type are available.';
GO
