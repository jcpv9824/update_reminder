/*
  Portal SAG Web - Gate D/F / 022
  Ensure the atomic operational refresh invokes the migration-015 final loader
  that populates and reconciles the print-format/source many-to-many bridge.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() NOT IN (N'PortalSAGWeb',N'PortalSAGWeb-TEST')
  THROW 52200,N'Wrong database.',1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT)<>15
  THROW 52201,N'This migration is certified for SQL Server 2019 (major version 15).',1;
IF NOT EXISTS
(
  SELECT 1 FROM migration.schema_migrations
  WHERE migration_version='021' AND succeeded=1
)
  THROW 52202,N'Migration 021 must be recorded before migration 022.',1;
IF OBJECT_ID(N'migration.usp_replace_operational_from_validated_run',N'P') IS NULL
   OR OBJECT_ID(N'migration.usp_load_operational_final_with_print_sources',N'P') IS NULL
   OR OBJECT_ID(N'migration.usp_load_print_format_source_assignments',N'P') IS NULL
  THROW 52203,N'The atomic refresh or multi-source print-format loaders are missing.',1;
IF OBJECT_DEFINITION(OBJECT_ID(N'migration.usp_load_print_format_source_assignments'))
     NOT LIKE N'%operational_final:print_format_source_assignments%'
  THROW 52204,N'The print-format source assignment reconciliation is not installed.',1;

BEGIN TRANSACTION;

DECLARE @refresh_definition NVARCHAR(MAX)=
  OBJECT_DEFINITION(OBJECT_ID(N'migration.usp_replace_operational_from_validated_run'));

IF @refresh_definition NOT LIKE N'%EXEC migration.usp_load_operational_final_with_print_sources @run_key;%'
BEGIN
  IF @refresh_definition NOT LIKE N'%EXEC migration.usp_load_operational_settings_content_notifications_audit @run_key;%'
    THROW 52205,N'The atomic refresh definition does not match the reviewed migration-021 contract.',1;

  SET @refresh_definition=REPLACE(
    @refresh_definition,
    N'EXEC migration.usp_load_operational_settings_content_notifications_audit @run_key;',
    N'EXEC migration.usp_load_operational_final_with_print_sources @run_key;'
  );
  DECLARE @procedure_keyword INT=CHARINDEX(N'PROCEDURE',@refresh_definition);
  IF @procedure_keyword=0
    THROW 52207,N'The atomic refresh procedure header is invalid.',1;
  SET @refresh_definition=N'ALTER '+SUBSTRING(@refresh_definition,@procedure_keyword,LEN(@refresh_definition));
  EXEC sys.sp_executesql @refresh_definition;
END;

IF OBJECT_DEFINITION(OBJECT_ID(N'migration.usp_replace_operational_from_validated_run'))
     NOT LIKE N'%EXEC migration.usp_load_operational_final_with_print_sources @run_key;%'
  THROW 52206,N'The atomic refresh did not adopt the multi-source final loader.',1;

COMMIT TRANSACTION;
PRINT N'022 complete: atomic refresh includes print-format/source assignments.';
GO
