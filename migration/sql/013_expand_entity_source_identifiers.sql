/*
  Portal SAG Web - Gate C/D / 013
  Expand audit and notification entity-reference capacity after the certified
  snapshot proved that generated entity IDs can exceed 150 characters
  (observed maximum: 156; 452 audit records exceed the former contract).

  The raw load and failed stage-projection evidence are preserved. The four
  columns use the same 260-character source-identifier contract as tasks.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() <> N'PortalSAGWeb' THROW 51300, N'Wrong database.', 1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT) <> 15
  THROW 51301, N'This DDL is certified for SQL Server 2019 (major version 15).', 1;
IF NOT EXISTS
(
  SELECT 1 FROM migration.schema_migrations
  WHERE migration_version='012' AND succeeded=1
)
  THROW 51302, N'Migration 012 must be recorded before migration 013.', 1;

IF EXISTS (SELECT 1 FROM migration.stage_audit_logs WHERE DATALENGTH(entity_source_id)/2 > 260)
   OR EXISTS (SELECT 1 FROM migration.stage_email_notifications WHERE DATALENGTH(entity_source_id)/2 > 260)
   OR EXISTS (SELECT 1 FROM audit.audit_logs WHERE DATALENGTH(entity_source_id)/2 > 260)
   OR EXISTS (SELECT 1 FROM notifications.email_notifications WHERE DATALENGTH(entity_source_id)/2 > 260)
  THROW 51303, N'An existing entity source identifier exceeds the new 260-character contract.', 1;

IF COL_LENGTH(N'migration.stage_audit_logs',N'entity_source_id') = 520
   AND COL_LENGTH(N'migration.stage_email_notifications',N'entity_source_id') = 520
   AND COL_LENGTH(N'audit.audit_logs',N'entity_source_id') = 520
   AND COL_LENGTH(N'notifications.email_notifications',N'entity_source_id') = 520
BEGIN
  PRINT N'013 already applied: entity source identifier capacity is 260 characters.';
  GOTO Migration013Complete;
END;

IF COL_LENGTH(N'migration.stage_audit_logs',N'entity_source_id') <> 300
   OR COL_LENGTH(N'migration.stage_email_notifications',N'entity_source_id') <> 300
   OR COL_LENGTH(N'audit.audit_logs',N'entity_source_id') <> 300
   OR COL_LENGTH(N'notifications.email_notifications',N'entity_source_id') <> 300
  THROW 51304, N'Unexpected entity identifier column width; refusing a partial structural rewrite.', 1;

BEGIN TRY
  BEGIN TRANSACTION;

  DROP INDEX IX_audit_logs_entity ON audit.audit_logs;
  DROP INDEX IX_notifications_entity ON notifications.email_notifications;

  ALTER TABLE migration.stage_audit_logs
    ALTER COLUMN entity_source_id NVARCHAR(260) NULL;
  ALTER TABLE migration.stage_email_notifications
    ALTER COLUMN entity_source_id NVARCHAR(260) NULL;
  ALTER TABLE audit.audit_logs
    ALTER COLUMN entity_source_id NVARCHAR(260) NOT NULL;
  ALTER TABLE notifications.email_notifications
    ALTER COLUMN entity_source_id NVARCHAR(260) NULL;

  CREATE INDEX IX_audit_logs_entity
    ON audit.audit_logs(entity_type, entity_source_id, performed_at DESC, audit_log_key DESC);
  CREATE INDEX IX_notifications_entity
    ON notifications.email_notifications(entity_type, entity_source_id, created_at DESC)
    WHERE entity_source_id IS NOT NULL;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;

Migration013Complete:
PRINT N'013 complete: entity source identifier capacity expanded to 260 characters.';
