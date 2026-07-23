/*
  Portal SAG Web - Gate C/D / 014
  Correct phase-010 historical task projection. The certified snapshot has four
  terminal logical tasks whose historical client/domain/target hierarchy is
  incomplete. Migration 010 detected missing targets, but did not classify a
  missing declared domain or hierarchy mismatch as a historical orphan.

  This migration changes only the versioned loader procedure. No source,
  staging, operational, or checkpoint rows are deleted.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() <> N'PortalSAGWeb' THROW 51400, N'Wrong database.', 1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT) <> 15
  THROW 51401, N'This migration is certified for SQL Server 2019 (major version 15).', 1;
IF NOT EXISTS
(
  SELECT 1 FROM migration.schema_migrations
  WHERE migration_version='013' AND succeeded=1
)
  THROW 51402, N'Migration 013 must be recorded before migration 014.', 1;
IF OBJECT_ID(N'migration.usp_load_operational_scheduling_workflow',N'P') IS NULL
  THROW 51403, N'The phase-010 scheduling/workflow loader is missing.', 1;

DECLARE @definition NVARCHAR(MAX)=OBJECT_DEFINITION(OBJECT_ID(N'migration.usp_load_operational_scheduling_workflow'));
IF @definition IS NULL THROW 51404, N'Unable to read the phase-010 loader definition.', 1;
SET @definition=REPLACE(@definition,NCHAR(13)+NCHAR(10),NCHAR(10));

DECLARE @old_fragment NVARCHAR(MAX)=
  N'CASE WHEN p.target_type=''domain'' AND target_domain.domain_key IS NULL THEN 1'+NCHAR(10)+
  N'           WHEN p.target_type=''database'' AND database_record.database_key IS NULL THEN 1 ELSE 0 END,';
DECLARE @new_fragment NVARCHAR(MAX)=
  N'CASE WHEN client.client_key IS NULL OR domain_record.domain_key IS NULL THEN 1'+NCHAR(10)+
  N'           WHEN p.target_type=''domain'' AND target_domain.domain_key IS NULL THEN 1'+NCHAR(10)+
  N'           WHEN p.target_type=''database'' AND (database_record.database_key IS NULL'+NCHAR(10)+
  N'                OR database_record.domain_key <> domain_record.domain_key'+NCHAR(10)+
  N'                OR database_record.client_key <> client.client_key) THEN 1 ELSE 0 END,';

IF CHARINDEX(@new_fragment,@definition)>0
BEGIN
  PRINT N'014 already applied: historical hierarchy gaps are classified as orphans.';
  GOTO Migration014Complete;
END;

IF CHARINDEX(@old_fragment,@definition)=0
  THROW 51405, N'The phase-010 loader does not match the reviewed pre-014 definition.', 1;
IF CHARINDEX(@old_fragment,@definition,CHARINDEX(@old_fragment,@definition)+1)>0
  THROW 51406, N'The reviewed pre-014 fragment occurs more than once.', 1;

DECLARE @patched_definition NVARCHAR(MAX)=REPLACE(@definition,@old_fragment,@new_fragment);
DECLARE @header_create_position INT=CHARINDEX(N'CREATE',UPPER(@patched_definition));
DECLARE @header_procedure_position INT=CHARINDEX(N'PROCEDURE',UPPER(@patched_definition));
IF @header_create_position NOT BETWEEN 1 AND 10
   OR @header_procedure_position<=@header_create_position
  THROW 51409, N'The stored procedure header is not the reviewed CREATE PROCEDURE form.', 1;

/* OBJECT_DEFINITION normalizes CREATE OR ALTER modules back to CREATE. */
SET @patched_definition=STUFF(@patched_definition,@header_create_position,LEN(N'CREATE'),N'ALTER');

BEGIN TRY
  BEGIN TRANSACTION;
  EXEC sys.sp_executesql @patched_definition;

  DECLARE @verified_definition NVARCHAR(MAX)=OBJECT_DEFINITION(OBJECT_ID(N'migration.usp_load_operational_scheduling_workflow'));
  SET @verified_definition=REPLACE(@verified_definition,NCHAR(13)+NCHAR(10),NCHAR(10));
  IF CHARINDEX(@new_fragment,@verified_definition)=0
    THROW 51407, N'The corrected historical-orphan projection was not installed.', 1;
  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;

Migration014Complete:
PRINT N'014 complete: historical task orphan projection corrected.';
