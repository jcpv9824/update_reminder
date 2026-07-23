/*
  Portal SAG Web - Gate C/D / 012
  Expand source identifier capacity after the certified snapshot proved that
  generated update-task IDs can exceed 150 characters (observed maximum: 156).

  This migration preserves the failed/resumable raw import evidence. It widens
  the complete indexed/FK chain to 260 characters and recreates every affected
  key/index inside one transaction.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() <> N'PortalSAGWeb' THROW 51200, N'Wrong database.', 1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT) <> 15
  THROW 51201, N'This DDL is certified for SQL Server 2019 (major version 15).', 1;
IF NOT EXISTS
(
  SELECT 1 FROM migration.schema_migrations
  WHERE migration_version='011' AND succeeded=1
)
  THROW 51202, N'Migration 011 must be recorded before migration 012.', 1;

IF EXISTS (SELECT 1 FROM migration.raw_documents WHERE DATALENGTH(source_id)/2 > 260)
   OR EXISTS (SELECT 1 FROM migration.file_transfers WHERE DATALENGTH(source_id)/2 > 260)
   OR EXISTS (SELECT 1 FROM migration.stage_update_tasks WHERE DATALENGTH(source_id)/2 > 260)
   OR EXISTS (SELECT 1 FROM workflow.update_tasks WHERE DATALENGTH(source_id)/2 > 260)
   OR EXISTS (SELECT 1 FROM workflow.task_source_aliases WHERE DATALENGTH(alias_source_id)/2 > 260)
  THROW 51203, N'An existing source identifier exceeds the new 260-character contract.', 1;

IF COL_LENGTH(N'migration.raw_documents',N'source_id') = 520
   AND COL_LENGTH(N'migration.file_transfers',N'source_id') = 520
   AND COL_LENGTH(N'migration.stage_update_tasks',N'source_id') = 520
   AND COL_LENGTH(N'workflow.update_tasks',N'source_id') = 520
   AND COL_LENGTH(N'workflow.task_source_aliases',N'alias_source_id') = 520
BEGIN
  PRINT N'012 already applied: source identifier capacity is 260 characters.';
  GOTO Migration012Complete;
END;

IF COL_LENGTH(N'migration.raw_documents',N'source_id') <> 300
   OR COL_LENGTH(N'migration.file_transfers',N'source_id') <> 300
   OR COL_LENGTH(N'migration.stage_update_tasks',N'source_id') <> 300
   OR COL_LENGTH(N'workflow.update_tasks',N'source_id') <> 300
   OR COL_LENGTH(N'workflow.task_source_aliases',N'alias_source_id') <> 300
  THROW 51204, N'Unexpected identifier column width; refusing a partial structural rewrite.', 1;

BEGIN TRY
  BEGIN TRANSACTION;

  ALTER TABLE migration.file_transfers DROP CONSTRAINT FK_file_transfers_raw;
  DROP INDEX IX_file_transfers_run_status ON migration.file_transfers;
  ALTER TABLE migration.file_transfers DROP CONSTRAINT PK_file_transfers;

  DROP INDEX IX_raw_documents_container ON migration.raw_documents;
  ALTER TABLE migration.raw_documents DROP CONSTRAINT PK_raw_documents;

  ALTER TABLE migration.stage_update_tasks DROP CONSTRAINT PK_stage_update_tasks;

  DROP INDEX IX_update_tasks_operational ON workflow.update_tasks;
  ALTER TABLE workflow.update_tasks DROP CONSTRAINT UQ_update_tasks_source_id;

  ALTER TABLE workflow.task_source_aliases DROP CONSTRAINT PK_task_source_aliases;

  ALTER TABLE migration.raw_documents ALTER COLUMN source_id NVARCHAR(260) NOT NULL;
  ALTER TABLE migration.file_transfers ALTER COLUMN source_id NVARCHAR(260) NOT NULL;
  ALTER TABLE migration.stage_update_tasks ALTER COLUMN source_id NVARCHAR(260) NOT NULL;
  ALTER TABLE workflow.update_tasks ALTER COLUMN source_id NVARCHAR(260) NOT NULL;
  ALTER TABLE workflow.task_source_aliases ALTER COLUMN alias_source_id NVARCHAR(260) NOT NULL;

  ALTER TABLE migration.raw_documents ADD CONSTRAINT PK_raw_documents
    PRIMARY KEY CLUSTERED (run_key, source_container, source_id);
  CREATE INDEX IX_raw_documents_container
    ON migration.raw_documents(run_key, source_container, processing_status, source_id);

  ALTER TABLE migration.file_transfers ADD CONSTRAINT PK_file_transfers
    PRIMARY KEY CLUSTERED (run_key, source_container, source_id, file_slot);
  ALTER TABLE migration.file_transfers WITH CHECK ADD CONSTRAINT FK_file_transfers_raw
    FOREIGN KEY (run_key, source_container, source_id)
    REFERENCES migration.raw_documents(run_key, source_container, source_id);
  ALTER TABLE migration.file_transfers CHECK CONSTRAINT FK_file_transfers_raw;
  CREATE INDEX IX_file_transfers_run_status
    ON migration.file_transfers(run_key, status, source_container, source_id)
    INCLUDE (expected_byte_count, expected_sha256, blob_container, blob_name);

  ALTER TABLE migration.stage_update_tasks ADD CONSTRAINT PK_stage_update_tasks
    PRIMARY KEY CLUSTERED (run_key, source_id);

  ALTER TABLE workflow.update_tasks ADD CONSTRAINT UQ_update_tasks_source_id UNIQUE (source_id);
  CREATE INDEX IX_update_tasks_operational
    ON workflow.update_tasks(status, task_date, target_type, task_key)
    INCLUDE (source_id, client_key, domain_key, database_key, assigned_role, target_name_snapshot, is_historical_orphan);

  ALTER TABLE workflow.task_source_aliases ADD CONSTRAINT PK_task_source_aliases
    PRIMARY KEY CLUSTERED (alias_source_id);

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;

Migration012Complete:
PRINT N'012 complete: source identifier capacity expanded to 260 characters.';
