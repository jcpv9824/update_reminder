/*
  Portal SAG Web - Gate C / 018
  Align licensing.license_modules.description with the existing API contract
  of 2,000 Unicode characters. Existing values are preserved.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() NOT IN (N'PortalSAGWeb',N'PortalSAGWeb-TEST')
  THROW 51800,N'Wrong database.',1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT)<>15
  THROW 51801,N'This migration is certified for SQL Server 2019 (major version 15).',1;
IF NOT EXISTS
(
  SELECT 1 FROM migration.schema_migrations
  WHERE migration_version='017' AND succeeded=1
)
  THROW 51802,N'Migration 017 must be recorded before migration 018.',1;
IF OBJECT_ID(N'licensing.license_modules',N'U') IS NULL
  THROW 51803,N'The licensing module table is missing.',1;

BEGIN TRANSACTION;

IF COL_LENGTH(N'licensing.license_modules',N'description')<4000
  ALTER TABLE licensing.license_modules ALTER COLUMN description NVARCHAR(2000) NULL;

IF COL_LENGTH(N'licensing.license_modules',N'description')<>4000
  THROW 51804,N'License module description length verification failed.',1;

COMMIT TRANSACTION;
PRINT N'018 complete: license module descriptions support 2,000 Unicode characters.';
GO
