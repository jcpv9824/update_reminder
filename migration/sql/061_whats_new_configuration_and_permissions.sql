/* Portal SAG Web - SQL Server 2019 / 061 — DRAFT, NOT APPLIED
   Qué hay de nuevo: esquema whats_new, configuración (interruptor público y
   catálogo de acciones requeridas), claves de permiso y roles sugeridos.
   - No hay menú de referencia: las rutas se escriben a mano (decisión del
     propietario, segunda ronda).
   - Las claves nuevas se conceden solo a super_admin. Los roles sugeridos se
     crean si no existen, sin asignarlos a nadie. Ningún rol ni permiso
     existente cambia. Reejecutable. */
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() NOT IN (N'PortalSAGWeb',N'PortalSAGWeb-TEST')
  THROW 53200,N'Wrong database.',1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT)<>15
  THROW 53201,N'This migration is certified for SQL Server 2019 (major version 15).',1;
IF (SELECT compatibility_level FROM sys.databases WHERE database_id=DB_ID())<>150
  THROW 53212,N'Compatibility level 150 is required.',1;
IF OBJECT_ID(N'migration.schema_migrations',N'U') IS NULL
  THROW 53202,N'Migration history is missing.',1;
IF NOT EXISTS (SELECT 1 FROM migration.schema_migrations WHERE migration_version='060' AND succeeded=1)
  THROW 53203,N'Run migration 060 first.',1;
IF OBJECT_ID(N'security.permissions',N'U') IS NULL OR OBJECT_ID(N'security.roles',N'U') IS NULL
  THROW 53204,N'Security permission catalog is missing.',1;
IF DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NULL OR DATABASE_PRINCIPAL_ID(N'portal_migrator') IS NULL
  THROW 53205,N'Database roles portal_runtime and portal_migrator are required.',1;
GO

IF SCHEMA_ID(N'whats_new') IS NULL
  EXEC(N'CREATE SCHEMA whats_new AUTHORIZATION dbo;');
GO

BEGIN TRY
BEGIN TRANSACTION;

GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::whats_new TO portal_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::whats_new TO portal_migrator;
-- portal_reporting no recibe nada del esquema.

IF OBJECT_ID(N'whats_new.settings',N'U') IS NULL
BEGIN
  CREATE TABLE whats_new.settings
  (
    settings_key    TINYINT       NOT NULL,
    public_enabled  BIT           NOT NULL CONSTRAINT DF_whats_new_settings_public DEFAULT (0),
    updated_at      DATETIME2(3)  NOT NULL CONSTRAINT DF_whats_new_settings_updated DEFAULT SYSUTCDATETIME(),
    updated_by      NVARCHAR(150) NOT NULL,
    row_version     ROWVERSION    NOT NULL,
    CONSTRAINT PK_whats_new_settings PRIMARY KEY CLUSTERED (settings_key),
    CONSTRAINT CK_whats_new_settings_single CHECK (settings_key=1)
  );
END;

IF NOT EXISTS (SELECT 1 FROM whats_new.settings WHERE settings_key=1)
  INSERT whats_new.settings(settings_key,public_enabled,updated_by) VALUES (1,0,N'migration-061');

IF OBJECT_ID(N'whats_new.action_catalog',N'U') IS NULL
BEGIN
  CREATE TABLE whats_new.action_catalog
  (
    action_catalog_key BIGINT IDENTITY(1,1) NOT NULL,
    source_id          NVARCHAR(150) NOT NULL,
    code               VARCHAR(40)   NOT NULL,
    label              NVARCHAR(120) NOT NULL,
    sort_order         SMALLINT      NOT NULL,
    active             BIT           NOT NULL CONSTRAINT DF_action_catalog_active DEFAULT (1),
    is_other           BIT           NOT NULL CONSTRAINT DF_action_catalog_other DEFAULT (0),
    created_at         DATETIME2(3)  NOT NULL CONSTRAINT DF_action_catalog_created DEFAULT SYSUTCDATETIME(),
    created_by         NVARCHAR(150) NOT NULL,
    updated_at         DATETIME2(3)  NOT NULL CONSTRAINT DF_action_catalog_updated DEFAULT SYSUTCDATETIME(),
    updated_by         NVARCHAR(150) NOT NULL,
    row_version        ROWVERSION    NOT NULL,
    CONSTRAINT PK_action_catalog PRIMARY KEY CLUSTERED (action_catalog_key),
    CONSTRAINT UQ_action_catalog_source_id UNIQUE (source_id),
    CONSTRAINT UQ_action_catalog_code UNIQUE (code),
    CONSTRAINT CK_action_catalog_code CHECK (code NOT LIKE '%[^a-z0-9_]%' AND LEN(code)>=2),
    CONSTRAINT CK_action_catalog_label CHECK (LEN(LTRIM(RTRIM(label)))>0),
    CONSTRAINT CK_action_catalog_sort CHECK (sort_order BETWEEN 1 AND 999)
  );
  CREATE UNIQUE INDEX UX_action_catalog_one_other ON whats_new.action_catalog(is_other) WHERE is_other=1;
END;

IF NOT EXISTS (SELECT 1 FROM whats_new.action_catalog WHERE code='leer_reglas')
  INSERT whats_new.action_catalog(source_id,code,label,sort_order,is_other,created_by,updated_by)
  VALUES (N'whats-new-action-leer-reglas','leer_reglas',N'Leer las reglas de negocio',1,0,N'migration-061',N'migration-061');
IF NOT EXISTS (SELECT 1 FROM whats_new.action_catalog WHERE code='dar_permiso')
  INSERT whats_new.action_catalog(source_id,code,label,sort_order,is_other,created_by,updated_by)
  VALUES (N'whats-new-action-dar-permiso','dar_permiso',N'Dar permiso a la opción',2,0,N'migration-061',N'migration-061');
IF NOT EXISTS (SELECT 1 FROM whats_new.action_catalog WHERE code='probar_opciones')
  INSERT whats_new.action_catalog(source_id,code,label,sort_order,is_other,created_by,updated_by)
  VALUES (N'whats-new-action-probar-opciones','probar_opciones',N'Probar estas opciones o módulos',3,0,N'migration-061',N'migration-061');
IF NOT EXISTS (SELECT 1 FROM whats_new.action_catalog WHERE code='otro')
  INSERT whats_new.action_catalog(source_id,code,label,sort_order,is_other,created_by,updated_by)
  VALUES (N'whats-new-action-otro','otro',N'Otro',4,1,N'migration-061',N'migration-061');

DECLARE @whats_new_permissions TABLE
(
  permission_key NVARCHAR(160) NOT NULL,
  module_key     NVARCHAR(80)  NOT NULL,
  action_key     NVARCHAR(80)  NOT NULL,
  label          NVARCHAR(200) NOT NULL
);
INSERT @whats_new_permissions(permission_key,module_key,action_key,label)
VALUES (N'updates.whats_new.view',N'updates',N'view',N'Ver');
INSERT @whats_new_permissions(permission_key,module_key,action_key,label)
VALUES (N'updates.whats_new.author',N'updates',N'author',N'Crear y editar entradas');
INSERT @whats_new_permissions(permission_key,module_key,action_key,label)
VALUES (N'updates.whats_new.test',N'updates',N'test',N'Probar entradas');
INSERT @whats_new_permissions(permission_key,module_key,action_key,label)
VALUES (N'updates.whats_new.publish_client',N'updates',N'publish_client',N'Publicar a clientes');
INSERT @whats_new_permissions(permission_key,module_key,action_key,label)
VALUES (N'updates.whats_new.report',N'updates',N'report',N'Enviar reportes');
INSERT @whats_new_permissions(permission_key,module_key,action_key,label)
VALUES (N'updates.whats_new.view_all',N'updates',N'view_all',N'Ver todas (lectura)');
INSERT @whats_new_permissions(permission_key,module_key,action_key,label)
VALUES (N'configuration.whats_new.view',N'configuration',N'view',N'Ver');
INSERT @whats_new_permissions(permission_key,module_key,action_key,label)
VALUES (N'configuration.whats_new.manage',N'configuration',N'manage',N'Administrar');

UPDATE permission_record
SET module_key=source_record.module_key,
    option_key=N'whats_new',
    action_key=source_record.action_key,
    label=source_record.label,
    description=N'Qué hay de nuevo / '+source_record.label,
    active=1
FROM security.permissions AS permission_record
JOIN @whats_new_permissions AS source_record ON source_record.permission_key=permission_record.permission_key;

INSERT security.permissions(permission_key,module_key,option_key,action_key,label,description,active)
SELECT source_record.permission_key,source_record.module_key,N'whats_new',source_record.action_key,
  source_record.label,N'Qué hay de nuevo / '+source_record.label,1
FROM @whats_new_permissions AS source_record
WHERE NOT EXISTS
(
  SELECT 1 FROM security.permissions AS permission_record
  WHERE permission_record.permission_key=source_record.permission_key
);

INSERT security.role_permissions(role_id,permission_key,granted_at,granted_by)
SELECT N'super_admin',source_record.permission_key,SYSUTCDATETIME(),N'migration-061'
FROM @whats_new_permissions AS source_record
WHERE NOT EXISTS
(
  SELECT 1 FROM security.role_permissions AS role_permission
  WHERE role_permission.role_id=N'super_admin' AND role_permission.permission_key=source_record.permission_key
);

/* Roles sugeridos: se crean solo si no existen; no son de sistema y no se
   asignan. Si ya existen (editados por un administrador) no se tocan. */
DECLARE @suggested_roles TABLE (role_id NVARCHAR(80) NOT NULL, name NVARCHAR(160) NOT NULL);
INSERT @suggested_roles(role_id,name) VALUES (N'whats_new_developer',N'Desarrollador · Qué hay de nuevo');
INSERT @suggested_roles(role_id,name) VALUES (N'whats_new_support',N'Asesor de Soporte · Qué hay de nuevo');
INSERT @suggested_roles(role_id,name) VALUES (N'whats_new_reader',N'Consulta · Qué hay de nuevo');

DECLARE @suggested_grants TABLE (role_id NVARCHAR(80) NOT NULL, permission_key NVARCHAR(160) NOT NULL);
INSERT @suggested_grants(role_id,permission_key) VALUES (N'whats_new_developer',N'updates.whats_new.view');
INSERT @suggested_grants(role_id,permission_key) VALUES (N'whats_new_developer',N'updates.whats_new.author');
INSERT @suggested_grants(role_id,permission_key) VALUES (N'whats_new_support',N'updates.whats_new.view');
INSERT @suggested_grants(role_id,permission_key) VALUES (N'whats_new_support',N'updates.whats_new.test');
INSERT @suggested_grants(role_id,permission_key) VALUES (N'whats_new_support',N'updates.whats_new.publish_client');
INSERT @suggested_grants(role_id,permission_key) VALUES (N'whats_new_support',N'updates.whats_new.report');
INSERT @suggested_grants(role_id,permission_key) VALUES (N'whats_new_reader',N'updates.whats_new.view');
INSERT @suggested_grants(role_id,permission_key) VALUES (N'whats_new_reader',N'updates.whats_new.view_all');
INSERT @suggested_grants(role_id,permission_key) VALUES (N'whats_new_reader',N'updates.whats_new.report');

DECLARE @new_roles TABLE (role_id NVARCHAR(80) NOT NULL);
INSERT security.roles
  (role_id,name,active,system_role,protected_role,domain_task_visibility,database_task_visibility,
   created_at,created_by,updated_at,updated_by)
OUTPUT INSERTED.role_id INTO @new_roles(role_id)
SELECT suggested.role_id,suggested.name,1,0,0,'none','none',
  SYSUTCDATETIME(),N'migration-061',SYSUTCDATETIME(),N'migration-061'
FROM @suggested_roles AS suggested
WHERE NOT EXISTS (SELECT 1 FROM security.roles AS existing WHERE existing.role_id=suggested.role_id)
  AND NOT EXISTS (SELECT 1 FROM security.roles AS existing WHERE existing.name=suggested.name);

INSERT security.role_permissions(role_id,permission_key,granted_at,granted_by)
SELECT grant_row.role_id,grant_row.permission_key,SYSUTCDATETIME(),N'migration-061'
FROM @suggested_grants AS grant_row
JOIN @new_roles AS created_role ON created_role.role_id=grant_row.role_id;

IF (SELECT COUNT(*) FROM security.permissions WHERE option_key=N'whats_new' AND active=1) <> 8
  THROW 53206,N'The whats_new permission catalog is incomplete.',1;
IF EXISTS
(
  SELECT 1 FROM @whats_new_permissions AS expected
  WHERE NOT EXISTS
  (
    SELECT 1 FROM security.role_permissions
    WHERE role_id=N'super_admin' AND permission_key=expected.permission_key
  )
)
  THROW 53207,N'Super Administrador is missing a whats_new permission.',1;
IF NOT EXISTS (SELECT 1 FROM whats_new.action_catalog WHERE active=1)
  THROW 53208,N'At least one required action must stay active.',1;

COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO

/* Siempre debe quedar al menos una acción requerida activa (QA-18). */
CREATE OR ALTER TRIGGER whats_new.TR_action_catalog_keep_one_active
ON whats_new.action_catalog
AFTER UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF NOT EXISTS (SELECT 1 FROM whats_new.action_catalog WHERE active=1)
    THROW 53210,N'At least one required action must stay active.',1;
  IF EXISTS (SELECT 1 FROM deleted AS previous_row LEFT JOIN inserted AS current_row
               ON current_row.action_catalog_key=previous_row.action_catalog_key
             WHERE current_row.action_catalog_key IS NULL)
    THROW 53211,N'Required actions are deactivated, never deleted.',1;
END;
GO

IF OBJECT_ID(N'whats_new.TR_action_catalog_keep_one_active',N'TR') IS NULL
  THROW 53209,N'Action catalog trigger verification failed.',1;
PRINT N'061 complete: whats_new configuration, permissions and suggested roles are ready.';
GO
