/* Portal SAG Web - 029: la opción «Agregar logo a la compañía» pasa a ser
   «Almacenamiento de archivos y logo». SQL Server 2019.
   Solo cambia etiquetas y descripciones de los dos permisos existentes.
   Las claves no cambian, así que los roles que ya tenían la opción la conservan.
   No crea tablas: el módulo no guarda bucket, llaves, usuario ni contraseña de SQL. */
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() NOT IN (N'PortalSAGWeb',N'PortalSAGWeb-TEST')
  THROW 52900, N'Wrong database.', 1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT)<>15
  THROW 52901, N'This migration is certified for SQL Server 2019 (major version 15).', 1;
IF OBJECT_ID(N'migration.schema_migrations',N'U') IS NULL THROW 52902, N'Migration history is missing.', 1;
IF NOT EXISTS
(
  SELECT 1 FROM migration.schema_migrations
  WHERE migration_version='028' AND succeeded=1
)
  THROW 52903, N'Run migration 028 first.', 1;
IF (SELECT COUNT(*) FROM security.permissions
    WHERE permission_key IN (N'implementation.company_logo.view',N'implementation.company_logo.upload')) <> 2
  THROW 52904, N'Company logo permissions from 028 are missing.', 1;
GO

BEGIN TRANSACTION;

UPDATE security.permissions
SET label=N'Ver',
    description=N'Almacenamiento de archivos y logo / Ver'
WHERE permission_key=N'implementation.company_logo.view';

UPDATE security.permissions
SET label=N'Configurar Almacenamiento y Subir Logo',
    description=N'Almacenamiento de archivos y logo / Configurar Almacenamiento y Subir Logo'
WHERE permission_key=N'implementation.company_logo.upload';

COMMIT TRANSACTION;
GO

IF NOT EXISTS (SELECT 1 FROM security.permissions
    WHERE permission_key=N'implementation.company_logo.upload'
      AND label=N'Configurar Almacenamiento y Subir Logo' AND active=1)
  THROW 52905, N'Company storage permission label was not updated.', 1;
IF (SELECT COUNT(*) FROM security.permissions
    WHERE permission_key LIKE N'implementation.company[_]logo.%'
      AND description LIKE N'Almacenamiento de archivos y logo / %' AND active=1) <> 2
  THROW 52906, N'Company storage permission descriptions are incomplete.', 1;
GO

PRINT N'029 complete: Implementación / Almacenamiento de archivos y logo labels are ready.';
GO
