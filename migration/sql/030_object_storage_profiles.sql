/* Portal SAG Web 030: guardar la base operativa del prefijo de objetos y
   permitir que un perfil deshabilitado conserve campos adicionales vacíos.
   Solo metadatos; no toca secretos, archivos, permisos ni proveedor activo. */
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() NOT IN (N'PortalSAGWeb',N'PortalSAGWeb-TEST')
  THROW 53000, N'Wrong database.', 1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS int) <> 15
  THROW 53001, N'This migration requires SQL Server 2019.', 1;
IF OBJECT_ID(N'migration.schema_migrations',N'U') IS NULL
  THROW 53002, N'Migration history is missing.', 1;
IF NOT EXISTS (SELECT 1 FROM migration.schema_migrations WHERE migration_version='029' AND succeeded=1)
  THROW 53003, N'Run migration 029 first.', 1;
IF OBJECT_ID(N'settings.object_storage_connections',N'U') IS NULL
  THROW 53004, N'Object storage connections are missing.', 1;
GO

BEGIN TRANSACTION;

IF COL_LENGTH(N'settings.object_storage_connections', N'database_name') IS NULL
  ALTER TABLE settings.object_storage_connections ADD database_name NVARCHAR(128) NULL;

IF OBJECT_ID(N'settings.CK_object_storage_connections_endpoint', N'C') IS NOT NULL
  ALTER TABLE settings.object_storage_connections DROP CONSTRAINT CK_object_storage_connections_endpoint;

ALTER TABLE settings.object_storage_connections WITH CHECK
ADD CONSTRAINT CK_object_storage_connections_endpoint
  CHECK (endpoint_url LIKE N'https://%' OR (active=0 AND endpoint_url=N''));

IF OBJECT_ID(N'settings.CK_object_storage_connections_database', N'C') IS NULL
  EXEC(N'ALTER TABLE settings.object_storage_connections WITH CHECK
    ADD CONSTRAINT CK_object_storage_connections_database CHECK
    (database_name IS NULL OR database_name COLLATE Latin1_General_100_BIN2 IN
      (N''PortalSAGWeb'',N''PortalSAGWeb-TEST''))');

COMMIT TRANSACTION;
GO
