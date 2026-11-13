/* Portal SAG Web - 028: permisos de Implementación / Agregar logo a la compañía. SQL Server 2019.
   Solo agrega dos claves de permiso y las concede a super_admin. No crea tablas:
   el módulo no guarda bucket, llaves, base de datos ni imágenes en SQL. */
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() NOT IN (N'PortalSAGWeb',N'PortalSAGWeb-TEST')
  THROW 52800, N'Wrong database.', 1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT)<>15
  THROW 52801, N'This migration is certified for SQL Server 2019 (major version 15).', 1;
IF OBJECT_ID(N'migration.schema_migrations',N'U') IS NULL THROW 52802, N'Migration history is missing.', 1;
IF NOT EXISTS
(
  SELECT 1 FROM migration.schema_migrations
  WHERE migration_version='027' AND succeeded=1
)
  THROW 52803, N'Run migration 027 first.', 1;
IF OBJECT_ID(N'security.permissions',N'U') IS NULL THROW 52804, N'Security permission catalog is missing.', 1;
GO

BEGIN TRANSACTION;

DECLARE @company_logo_permissions TABLE
(
  permission_key NVARCHAR(240) NOT NULL,
  action_key NVARCHAR(80) NOT NULL,
  label NVARCHAR(200) NOT NULL
);

INSERT @company_logo_permissions(permission_key,action_key,label)
VALUES (N'implementation.company_logo.view',N'view',N'Ver');
INSERT @company_logo_permissions(permission_key,action_key,label)
VALUES (N'implementation.company_logo.upload',N'upload',N'Subir Logo y Generar SQL');

UPDATE permission_record
SET module_key=N'implementation',
    option_key=N'company_logo',
    action_key=source.action_key,
    label=source.label,
    description=N'Agregar logo a la compañía / '+source.label,
    active=1
FROM security.permissions AS permission_record
JOIN @company_logo_permissions AS source
  ON source.permission_key=permission_record.permission_key;

INSERT security.permissions
  (permission_key,module_key,option_key,action_key,label,description,active)
SELECT source.permission_key,N'implementation',N'company_logo',source.action_key,
  source.label,N'Agregar logo a la compañía / '+source.label,1
FROM @company_logo_permissions AS source
WHERE NOT EXISTS
(
  SELECT 1 FROM security.permissions AS permission_record
  WHERE permission_record.permission_key=source.permission_key
);

INSERT security.role_permissions(role_id,permission_key,granted_at,granted_by)
SELECT N'super_admin',source.permission_key,SYSUTCDATETIME(),N'migration-028'
FROM @company_logo_permissions AS source
WHERE NOT EXISTS
(
  SELECT 1 FROM security.role_permissions AS role_permission
  WHERE role_permission.role_id=N'super_admin'
    AND role_permission.permission_key=source.permission_key
);

COMMIT TRANSACTION;
GO

IF (SELECT COUNT(*) FROM security.permissions
    WHERE permission_key LIKE N'implementation.company[_]logo.%' AND active=1) <> 2
  THROW 52805, N'Company logo permission catalog is incomplete.', 1;
IF (SELECT COUNT(*) FROM security.role_permissions
    WHERE role_id=N'super_admin' AND permission_key LIKE N'implementation.company[_]logo.%') <> 2
  THROW 52806, N'Super admin company logo grant is missing.', 1;
GO

PRINT N'028 complete: Implementación / Agregar logo a la compañía permissions are ready.';
GO
