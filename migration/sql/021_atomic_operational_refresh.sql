/*
  Portal SAG Web - Gate D/F / 021
  Allow immutable Blob objects to be referenced by multiple migration runs and
  provide one atomic replacement of reloadable operational data.

  The procedure never changes database users, roles or grants. It preserves
  SQL-native audit rows that are not present in the selected Cosmos snapshot.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() NOT IN (N'PortalSAGWeb',N'PortalSAGWeb-TEST')
  THROW 52100,N'Wrong database.',1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT)<>15
  THROW 52101,N'This migration is certified for SQL Server 2019 (major version 15).',1;
IF NOT EXISTS
(
  SELECT 1 FROM migration.schema_migrations
  WHERE migration_version='020' AND succeeded=1
)
  THROW 52102,N'Migration 020 must be recorded before migration 021.',1;
IF OBJECT_ID(N'migration.file_transfers',N'U') IS NULL
   OR OBJECT_ID(N'migration.usp_load_operational_settings_content_notifications_audit',N'P') IS NULL
  THROW 52103,N'The operational migration control objects are missing.',1;

BEGIN TRANSACTION;

IF EXISTS
(
  SELECT 1
  FROM sys.key_constraints
  WHERE parent_object_id=OBJECT_ID(N'migration.file_transfers')
    AND name=N'UQ_file_transfers_blob'
)
  ALTER TABLE migration.file_transfers DROP CONSTRAINT UQ_file_transfers_blob;

IF NOT EXISTS
(
  SELECT 1
  FROM sys.indexes
  WHERE object_id=OBJECT_ID(N'migration.file_transfers')
    AND name=N'UX_file_transfers_run_blob'
)
  CREATE UNIQUE INDEX UX_file_transfers_run_blob
    ON migration.file_transfers(run_key,blob_container,blob_name);

COMMIT TRANSACTION;
GO

CREATE OR ALTER PROCEDURE migration.usp_replace_operational_from_validated_run
  @run_key BIGINT
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;

  IF TRY_CONVERT(INT,SESSION_CONTEXT(N'portal_production_refresh_authorized'))<>1
    THROW 52110,N'The production operational refresh session is not authorized.',1;

  IF NOT EXISTS
  (
    SELECT 1
    FROM migration.migration_runs
    WHERE run_key=@run_key
      AND status='validated'
      AND source_environment='cosmos-production'
      AND schema_version='020'
      AND source_document_count=staged_document_count
      AND critical_error_count=0
  )
    THROW 52111,N'The selected production migration run is not a validated schema-020 snapshot.',1;

  EXEC migration.usp_assert_operational_load_ready @run_key;

  DECLARE @expected_file_count BIGINT=
      (SELECT COUNT_BIG(*) FROM migration.stage_print_formats WHERE run_key=@run_key)
    + (SELECT COUNT_BIG(*) FROM migration.stage_public_downloads WHERE run_key=@run_key AND record_type='document');

  IF @expected_file_count<>39
    THROW 52112,N'The selected run does not have the certified 39-file contract.',1;
  IF (SELECT COUNT_BIG(*) FROM migration.file_transfers WHERE run_key=@run_key)<>@expected_file_count
     OR EXISTS (SELECT 1 FROM migration.file_transfers WHERE run_key=@run_key AND status<>'verified')
    THROW 52113,N'Every current-snapshot Blob object must be verified before the operational refresh.',1;

  DECLARE @preserved_sql_audit TABLE
  (
    source_id NVARCHAR(150) NOT NULL PRIMARY KEY,
    entity_type NVARCHAR(100) NOT NULL,
    entity_source_id NVARCHAR(260) NOT NULL,
    client_name_snapshot NVARCHAR(200) NULL,
    domain_name_snapshot NVARCHAR(500) NULL,
    company_name_snapshot NVARCHAR(240) NULL,
    action NVARCHAR(160) NOT NULL,
    performed_by NVARCHAR(150) NOT NULL,
    performed_by_email NVARCHAR(254) NULL,
    performed_at DATETIME2(3) NOT NULL,
    before_json NVARCHAR(MAX) NULL,
    after_json NVARCHAR(MAX) NULL,
    metadata_json NVARCHAR(MAX) NULL,
    schema_version SMALLINT NOT NULL,
    data_classification VARCHAR(20) NOT NULL
  );

  INSERT @preserved_sql_audit
    (source_id,entity_type,entity_source_id,client_name_snapshot,domain_name_snapshot,
     company_name_snapshot,action,performed_by,performed_by_email,performed_at,
     before_json,after_json,metadata_json,schema_version,data_classification)
  SELECT
    a.source_id,a.entity_type,a.entity_source_id,a.client_name_snapshot,a.domain_name_snapshot,
    a.company_name_snapshot,a.action,a.performed_by,a.performed_by_email,a.performed_at,
    a.before_json,a.after_json,a.metadata_json,a.schema_version,a.data_classification
  FROM audit.audit_logs AS a
  LEFT JOIN migration.stage_audit_logs AS source_audit
    ON source_audit.run_key=@run_key AND source_audit.source_id=a.source_id
  WHERE source_audit.source_id IS NULL;

  IF EXISTS
  (
    SELECT 1
    FROM audit.audit_logs AS a
    LEFT JOIN migration.stage_audit_logs AS source_audit
      ON source_audit.run_key=@run_key AND source_audit.source_id=a.source_id
    WHERE source_audit.source_id IS NULL
      AND (a.client_key IS NOT NULL OR a.domain_key IS NOT NULL)
  )
    THROW 52114,N'A SQL-native audit row with a business foreign key requires an explicit remapping decision.',1;

  DECLARE @application_lock_result INT;

  BEGIN TRY
    SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
    BEGIN TRANSACTION;

    EXEC @application_lock_result=sys.sp_getapplock
      @Resource=N'PortalSAGWeb:production-operational-refresh',
      @LockMode=N'Exclusive',
      @LockOwner=N'Transaction',
      @LockTimeout=0;
    IF @application_lock_result<0
      THROW 52115,N'Another production operational refresh is already active.',1;

    DELETE FROM migration.operational_load_phases WHERE run_key=@run_key;
    DELETE FROM migration.reconciliation_counts
    WHERE run_key=@run_key AND reconciliation_code LIKE N'operational[_]%';
    UPDATE migration.raw_documents
    SET processing_status='validated',processing_error_code=NULL
    WHERE run_key=@run_key;

    DISABLE TRIGGER audit.TR_audit_logs_append_only ON audit.audit_logs;
    DISABLE TRIGGER workflow.TR_task_status_history_append_only ON workflow.task_status_history;
    DISABLE TRIGGER notifications.TR_notification_attempts_append_only ON notifications.email_notification_attempts;
    DISABLE TRIGGER content.TR_print_format_source_assignments_rules ON content.print_format_source_assignments;
    DISABLE TRIGGER content.TR_print_formats_source_consistency ON content.print_formats;

    DELETE FROM audit.audit_logs;

    DELETE FROM notifications.email_notification_attempts;
    DELETE FROM notifications.email_notification_recipients;
    DELETE FROM notifications.email_notifications;

    DELETE FROM content.print_format_files;
    DELETE FROM content.print_format_source_assignments;
    DELETE FROM content.print_formats;
    DELETE FROM content.print_format_sources;
    DELETE FROM content.public_download_files;
    DELETE FROM content.public_download_documents;
    DELETE FROM content.public_download_sections;
    DELETE FROM content.files;

    DELETE FROM settings.administrative_reminder_recipients;
    DELETE FROM settings.administrative_reminders;
    DELETE FROM settings.alert_recipient_emails;
    DELETE FROM settings.alert_recipient_roles;
    DELETE FROM settings.blocked_reminder_days;
    DELETE FROM settings.default_reminder_days;
    DELETE FROM settings.overdue_alert_weekdays;
    DELETE FROM settings.email_settings;

    DELETE FROM workflow.task_reminder_recipients;
    DELETE FROM workflow.task_reminders;
    DELETE FROM workflow.task_overdue_alerts;
    DELETE FROM workflow.task_source_aliases;
    DELETE FROM workflow.task_sources;
    DELETE FROM workflow.task_status_history;
    DELETE FROM workflow.task_assignees;
    DELETE FROM workflow.update_tasks;

    DELETE FROM scheduling.scope_databases;
    DELETE FROM scheduling.scope_domains;
    DELETE FROM scheduling.scope_groups;
    DELETE FROM scheduling.licensing_excluded_databases;
    DELETE FROM scheduling.licensing_excluded_domains;
    DELETE FROM scheduling.licensing_scope_modules;
    DELETE FROM scheduling.licensing_scope;
    DELETE FROM scheduling.schedule_reminder_days;
    DELETE FROM scheduling.schedule_reminder_emails;
    DELETE FROM scheduling.schedule_reminder_settings;
    DELETE FROM scheduling.schedule_assignees;
    DELETE FROM scheduling.schedule_targets;
    DELETE FROM scheduling.schedule_weekdays;
    DELETE FROM scheduling.update_schedules;

    DELETE FROM licensing.license_assignments;
    DELETE FROM licensing.license_modules;

    DELETE FROM core.database_assignees;
    DELETE FROM core.databases;
    DELETE FROM core.database_access_profiles;
    DELETE FROM core.domain_assignees;
    DELETE FROM core.domains;
    DELETE FROM core.clients;

    DELETE FROM security.auth_sessions;
    DELETE FROM security.rate_limits;
    DELETE FROM security.user_roles;
    DELETE FROM security.users;

    ENABLE TRIGGER audit.TR_audit_logs_append_only ON audit.audit_logs;
    ENABLE TRIGGER workflow.TR_task_status_history_append_only ON workflow.task_status_history;
    ENABLE TRIGGER notifications.TR_notification_attempts_append_only ON notifications.email_notification_attempts;
    ENABLE TRIGGER content.TR_print_format_source_assignments_rules ON content.print_format_source_assignments;
    ENABLE TRIGGER content.TR_print_formats_source_consistency ON content.print_formats;

    EXEC migration.usp_load_operational_security_core_licensing @run_key;
    EXEC migration.usp_load_operational_scheduling_workflow @run_key;
    EXEC migration.usp_load_operational_settings_content_notifications_audit @run_key;

    INSERT audit.audit_logs
      (source_id,entity_type,entity_source_id,client_key,client_name_snapshot,domain_key,
       domain_name_snapshot,company_name_snapshot,action,performed_by,performed_by_email,
       performed_at,before_json,after_json,metadata_json,schema_version,data_classification)
    SELECT
      preserved.source_id,preserved.entity_type,preserved.entity_source_id,NULL,
      preserved.client_name_snapshot,NULL,preserved.domain_name_snapshot,
      preserved.company_name_snapshot,preserved.action,preserved.performed_by,
      preserved.performed_by_email,preserved.performed_at,preserved.before_json,
      preserved.after_json,preserved.metadata_json,preserved.schema_version,
      preserved.data_classification
    FROM @preserved_sql_audit AS preserved
    WHERE NOT EXISTS
      (SELECT 1 FROM audit.audit_logs AS current_audit WHERE current_audit.source_id=preserved.source_id);

    DELETE FROM migration.reconciliation_counts
    WHERE run_key=@run_key AND reconciliation_code=N'operational_refresh:preserved_sql_audit';
    INSERT migration.reconciliation_counts
      (run_key,reconciliation_code,source_count,target_count)
    SELECT
      @run_key,N'operational_refresh:preserved_sql_audit',
      (SELECT COUNT_BIG(*) FROM @preserved_sql_audit),
      COUNT_BIG(*)
    FROM audit.audit_logs AS current_audit
    JOIN @preserved_sql_audit AS preserved ON preserved.source_id=current_audit.source_id;

    IF EXISTS
    (
      SELECT 1 FROM migration.reconciliation_counts
      WHERE run_key=@run_key
        AND reconciliation_code=N'operational_refresh:preserved_sql_audit'
        AND reconciled=0
    )
      THROW 52116,N'SQL-native audit preservation did not reconcile.',1;

    IF NOT EXISTS
    (
      SELECT 1 FROM migration.migration_runs
      WHERE run_key=@run_key AND status='completed' AND critical_error_count=0
    )
      THROW 52117,N'The operational refresh did not reach the completed checkpoint.',1;

    COMMIT TRANSACTION;
  END TRY
  BEGIN CATCH
    IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
    THROW;
  END CATCH;

  SELECT
    r.run_key,r.status,r.source_document_count,r.staged_document_count,
    (SELECT COUNT_BIG(*) FROM security.users) AS user_count,
    (SELECT COUNT_BIG(*) FROM core.clients) AS client_count,
    (SELECT COUNT_BIG(*) FROM core.domains) AS domain_count,
    (SELECT COUNT_BIG(*) FROM core.databases) AS database_count,
    (SELECT COUNT_BIG(*) FROM scheduling.update_schedules) AS schedule_count,
    (SELECT COUNT_BIG(*) FROM workflow.update_tasks) AS task_count,
    (SELECT COUNT_BIG(*) FROM audit.audit_logs) AS audit_count,
    (SELECT COUNT_BIG(*) FROM migration.file_transfers WHERE run_key=@run_key AND status='linked') AS linked_file_count
  FROM migration.migration_runs AS r
  WHERE r.run_key=@run_key;
END;
GO

PRINT N'021 complete: per-run Blob reuse and atomic operational refresh are available.';
GO
