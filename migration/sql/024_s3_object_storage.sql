/*
  Portal SAG Web - production SQL / 024
  Add provider-neutral S3/MinIO object locators while preserving legacy Azure
  Blob locators until every object has been transferred and reconciled.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() NOT IN (N'PortalSAGWeb',N'PortalSAGWeb-TEST')
  THROW 52400,N'Wrong database.',1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT)<>15
  THROW 52401,N'This migration is certified for SQL Server 2019 (major version 15).',1;
IF NOT EXISTS
(
  SELECT 1 FROM migration.schema_migrations
  WHERE migration_version='023' AND succeeded=1
)
  THROW 52402,N'Migration 023 must be recorded before migration 024.',1;
IF OBJECT_ID(N'content.files',N'U') IS NULL
  THROW 52403,N'The content.files table is missing.',1;

BEGIN TRANSACTION;

IF COL_LENGTH(N'content.files',N'storage_bucket') IS NULL
  ALTER TABLE content.files ADD storage_bucket NVARCHAR(255) NULL;
IF COL_LENGTH(N'content.files',N'object_key') IS NULL
  ALTER TABLE content.files ADD object_key NVARCHAR(1024) NULL;
IF COL_LENGTH(N'content.files',N'object_etag') IS NULL
  ALTER TABLE content.files ADD object_etag NVARCHAR(200) NULL;

/* Defer compilation until the provider-neutral columns exist. SQL Server
   otherwise binds this UPDATE before executing the preceding ALTER TABLEs. */
EXEC sys.sp_executesql N'
  UPDATE content.files
  SET storage_bucket=storage_container,
      object_key=blob_name
  WHERE storage_provider=''azure_blob''
    AND (storage_bucket IS NULL OR object_key IS NULL);';

IF OBJECT_ID(N'content.UQ_files_blob',N'UQ') IS NOT NULL
  ALTER TABLE content.files DROP CONSTRAINT UQ_files_blob;
IF OBJECT_ID(N'content.CK_files_provider',N'C') IS NOT NULL
  ALTER TABLE content.files DROP CONSTRAINT CK_files_provider;
IF OBJECT_ID(N'content.CK_files_storage_locator',N'C') IS NOT NULL
  ALTER TABLE content.files DROP CONSTRAINT CK_files_storage_locator;
IF OBJECT_ID(N'content.DF_files_provider',N'D') IS NOT NULL
  ALTER TABLE content.files DROP CONSTRAINT DF_files_provider;

ALTER TABLE content.files ALTER COLUMN storage_container NVARCHAR(100) NULL;
ALTER TABLE content.files ALTER COLUMN blob_name NVARCHAR(1024) NULL;

ALTER TABLE content.files
  ADD CONSTRAINT DF_files_provider DEFAULT ('s3') FOR storage_provider;

ALTER TABLE content.files WITH CHECK
  ADD CONSTRAINT CK_files_provider CHECK (storage_provider IN ('azure_blob','s3'));

EXEC sys.sp_executesql N'
  ALTER TABLE content.files WITH CHECK
    ADD CONSTRAINT CK_files_storage_locator CHECK
    (
      (
        storage_provider=''azure_blob''
        AND storage_container IS NOT NULL
        AND LEN(LTRIM(RTRIM(storage_container)))>0
        AND blob_name IS NOT NULL
        AND LEN(LTRIM(RTRIM(blob_name)))>0
      )
      OR
      (
        storage_provider=''s3''
        AND storage_bucket IS NOT NULL
        AND LEN(LTRIM(RTRIM(storage_bucket))) BETWEEN 3 AND 255
        AND object_key IS NOT NULL
        AND LEN(LTRIM(RTRIM(object_key)))>0
      )
    );';

IF NOT EXISTS
(
  SELECT 1 FROM sys.indexes
  WHERE object_id=OBJECT_ID(N'content.files') AND name=N'UX_files_azure_locator'
)
  CREATE UNIQUE INDEX UX_files_azure_locator
    ON content.files(storage_container,blob_name)
    WHERE storage_provider='azure_blob' AND storage_container IS NOT NULL AND blob_name IS NOT NULL;

IF NOT EXISTS
(
  SELECT 1 FROM sys.indexes
  WHERE object_id=OBJECT_ID(N'content.files') AND name=N'UX_files_s3_locator'
)
  EXEC sys.sp_executesql N'
    CREATE UNIQUE INDEX UX_files_s3_locator
      ON content.files(storage_bucket,object_key)
      WHERE storage_provider=''s3'' AND storage_bucket IS NOT NULL AND object_key IS NOT NULL;';

ALTER TABLE content.files CHECK CONSTRAINT CK_files_provider;
ALTER TABLE content.files CHECK CONSTRAINT CK_files_storage_locator;

IF EXISTS
(
  SELECT 1 FROM sys.check_constraints
  WHERE parent_object_id=OBJECT_ID(N'content.files')
    AND name IN (N'CK_files_provider',N'CK_files_storage_locator')
    AND (is_disabled=1 OR is_not_trusted=1)
)
  THROW 52404,N'Object-storage constraints are disabled or untrusted.',1;

COMMIT TRANSACTION;
PRINT N'024 complete: S3/MinIO object locators are available; legacy Azure locators are preserved for transfer.';
GO
