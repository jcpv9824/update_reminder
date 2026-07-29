/* Portal SAG Web - 027: protected SeaweedFS and external SQL connection metadata. SQL Server 2019. */
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() NOT IN (N'PortalSAGWeb',N'PortalSAGWeb-TEST')
  THROW 52700, N'Wrong database.', 1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT)<>15
  THROW 52701, N'This migration is certified for SQL Server 2019 (major version 15).', 1;
IF OBJECT_ID(N'migration.schema_migrations',N'U') IS NULL THROW 51271, N'Migration history is missing.', 1;
IF NOT EXISTS
(
  SELECT 1 FROM migration.schema_migrations
  WHERE migration_version='026' AND succeeded=1
)
  THROW 51272, N'Run migration 026 first.', 1;
IF OBJECT_ID(N'security.permissions',N'U') IS NULL THROW 51273, N'Security permission catalog is missing.', 1;
IF OBJECT_ID(N'settings.email_settings',N'U') IS NULL THROW 51274, N'Settings schema is missing.', 1;
GO

BEGIN TRANSACTION;

DECLARE @integration_permissions TABLE
(
  permission_key NVARCHAR(240) NOT NULL,
  action_key NVARCHAR(80) NOT NULL,
  label NVARCHAR(200) NOT NULL
);

INSERT @integration_permissions(permission_key,action_key,label)
VALUES
  (N'configuration.integrations.view',N'view',N'Ver'),
  (N'configuration.integrations.edit_object_storage',N'edit_object_storage',N'Configurar Almacenamiento'),
  (N'configuration.integrations.test_object_storage',N'test_object_storage',N'Probar Almacenamiento'),
  (N'configuration.integrations.create_database',N'create_database',N'Crear Conexión de Base'),
  (N'configuration.integrations.edit_database',N'edit_database',N'Editar Conexión de Base'),
  (N'configuration.integrations.delete_database',N'delete_database',N'Eliminar Conexión de Base'),
  (N'configuration.integrations.test_database',N'test_database',N'Probar Conexión de Base');

UPDATE permission_record
SET module_key=N'configuration',
    option_key=N'integrations',
    action_key=source.action_key,
    label=source.label,
    description=N'Conexiones / '+source.label,
    active=1
FROM security.permissions AS permission_record
JOIN @integration_permissions AS source
  ON source.permission_key=permission_record.permission_key;

INSERT security.permissions
  (permission_key,module_key,option_key,action_key,label,description,active)
SELECT source.permission_key,N'configuration',N'integrations',source.action_key,
  source.label,N'Conexiones / '+source.label,1
FROM @integration_permissions AS source
WHERE NOT EXISTS
(
  SELECT 1 FROM security.permissions AS permission_record
  WHERE permission_record.permission_key=source.permission_key
);

INSERT security.role_permissions(role_id,permission_key,granted_at,granted_by)
SELECT N'super_admin',source.permission_key,SYSUTCDATETIME(),N'migration-027'
FROM @integration_permissions AS source
WHERE NOT EXISTS
(
  SELECT 1 FROM security.role_permissions AS role_permission
  WHERE role_permission.role_id=N'super_admin'
    AND role_permission.permission_key=source.permission_key
);

IF OBJECT_ID(N'settings.object_storage_connections',N'U') IS NULL
BEGIN
  CREATE TABLE settings.object_storage_connections
  (
    object_storage_connection_key BIGINT IDENTITY(1,1) NOT NULL,
    source_id                     NVARCHAR(150) NOT NULL,
    provider                      VARCHAR(30) NOT NULL,
    display_name                  NVARCHAR(160) NOT NULL,
    endpoint_url                  NVARCHAR(500) NOT NULL,
    signing_region                NVARCHAR(100) NOT NULL,
    bucket_name                   NVARCHAR(255) NOT NULL,
    force_path_style              BIT NOT NULL
      CONSTRAINT DF_object_storage_connections_path_style DEFAULT(1),
    access_key_secret_name        NVARCHAR(127) NULL,
    secret_key_secret_name        NVARCHAR(127) NULL,
    credentials_configured        BIT NOT NULL
      CONSTRAINT DF_object_storage_connections_credentials DEFAULT(0),
    active                        BIT NOT NULL
      CONSTRAINT DF_object_storage_connections_active DEFAULT(1),
    last_test_succeeded           BIT NULL,
    last_tested_at                DATETIME2(3) NULL,
    last_tested_by                NVARCHAR(150) NULL,
    last_test_message             NVARCHAR(300) NULL,
    created_at                    DATETIME2(3) NOT NULL
      CONSTRAINT DF_object_storage_connections_created_at DEFAULT SYSUTCDATETIME(),
    created_by                    NVARCHAR(150) NOT NULL,
    updated_at                    DATETIME2(3) NOT NULL
      CONSTRAINT DF_object_storage_connections_updated_at DEFAULT SYSUTCDATETIME(),
    updated_by                    NVARCHAR(150) NOT NULL,
    row_version                   ROWVERSION NOT NULL,
    CONSTRAINT PK_object_storage_connections
      PRIMARY KEY CLUSTERED(object_storage_connection_key),
    CONSTRAINT UQ_object_storage_connections_source UNIQUE(source_id),
    CONSTRAINT UQ_object_storage_connections_provider UNIQUE(provider),
    CONSTRAINT CK_object_storage_connections_provider
      CHECK(provider='seaweedfs'),
    CONSTRAINT CK_object_storage_connections_endpoint
      CHECK(endpoint_url LIKE N'https://%'),
    CONSTRAINT CK_object_storage_connections_credentials
      CHECK
      (
        (credentials_configured=0 AND access_key_secret_name IS NULL AND secret_key_secret_name IS NULL)
        OR
        (credentials_configured=1 AND access_key_secret_name IS NOT NULL AND secret_key_secret_name IS NOT NULL)
      ),
    CONSTRAINT CK_object_storage_connections_test
      CHECK
      (
        (last_tested_at IS NULL AND last_test_succeeded IS NULL AND last_tested_by IS NULL)
        OR
        (last_tested_at IS NOT NULL AND last_test_succeeded IS NOT NULL AND last_tested_by IS NOT NULL)
      )
  );
END;

IF OBJECT_ID(N'settings.external_database_connections',N'U') IS NULL
BEGIN
  CREATE TABLE settings.external_database_connections
  (
    external_database_connection_key BIGINT IDENTITY(1,1) NOT NULL,
    source_id                        NVARCHAR(150) NOT NULL,
    display_name                     NVARCHAR(160) NOT NULL,
    purpose                          NVARCHAR(500) NULL,
    server_host                      NVARCHAR(255) NOT NULL,
    server_port                      INT NOT NULL
      CONSTRAINT DF_external_database_connections_port DEFAULT(1433),
    database_name                    NVARCHAR(128) NOT NULL,
    login_name                       NVARCHAR(128) NOT NULL,
    password_secret_name             NVARCHAR(127) NULL,
    password_configured              BIT NOT NULL
      CONSTRAINT DF_external_database_connections_password DEFAULT(0),
    encrypt_connection               BIT NOT NULL
      CONSTRAINT DF_external_database_connections_encrypt DEFAULT(1),
    active                           BIT NOT NULL
      CONSTRAINT DF_external_database_connections_active DEFAULT(1),
    status                           VARCHAR(20) NOT NULL
      CONSTRAINT DF_external_database_connections_status DEFAULT('active'),
    last_test_succeeded              BIT NULL,
    last_tested_at                   DATETIME2(3) NULL,
    last_tested_by                   NVARCHAR(150) NULL,
    last_test_message                NVARCHAR(300) NULL,
    created_at                       DATETIME2(3) NOT NULL
      CONSTRAINT DF_external_database_connections_created_at DEFAULT SYSUTCDATETIME(),
    created_by                       NVARCHAR(150) NOT NULL,
    updated_at                       DATETIME2(3) NOT NULL
      CONSTRAINT DF_external_database_connections_updated_at DEFAULT SYSUTCDATETIME(),
    updated_by                       NVARCHAR(150) NOT NULL,
    deleted_at                       DATETIME2(3) NULL,
    deleted_by                       NVARCHAR(150) NULL,
    row_version                      ROWVERSION NOT NULL,
    CONSTRAINT PK_external_database_connections
      PRIMARY KEY CLUSTERED(external_database_connection_key),
    CONSTRAINT UQ_external_database_connections_source UNIQUE(source_id),
    CONSTRAINT CK_external_database_connections_port
      CHECK(server_port BETWEEN 1 AND 65535),
    CONSTRAINT CK_external_database_connections_encrypt
      CHECK(encrypt_connection=1),
    CONSTRAINT CK_external_database_connections_status
      CHECK
      (
        (status='active' AND active=1 AND deleted_at IS NULL AND deleted_by IS NULL)
        OR
        (status='inactive' AND active=0 AND deleted_at IS NULL AND deleted_by IS NULL)
        OR
        (status='deleted' AND active=0 AND deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
      ),
    CONSTRAINT CK_external_database_connections_password
      CHECK
      (
        (password_configured=0 AND password_secret_name IS NULL)
        OR
        (password_configured=1 AND password_secret_name IS NOT NULL)
      ),
    CONSTRAINT CK_external_database_connections_test
      CHECK
      (
        (last_tested_at IS NULL AND last_test_succeeded IS NULL AND last_tested_by IS NULL)
        OR
        (last_tested_at IS NOT NULL AND last_test_succeeded IS NOT NULL AND last_tested_by IS NOT NULL)
      )
  );
  CREATE INDEX IX_external_database_connections_active
    ON settings.external_database_connections(active,display_name,external_database_connection_key);
  CREATE UNIQUE INDEX UX_external_database_connections_active_name
    ON settings.external_database_connections(display_name)
    WHERE status<>'deleted';
END;

COMMIT TRANSACTION;
GO

IF (SELECT COUNT(*) FROM security.permissions
    WHERE permission_key LIKE N'configuration.integrations.%' AND active=1) <> 7
  THROW 51275, N'Integration permission catalog is incomplete.', 1;
IF NOT EXISTS
(
  SELECT 1 FROM security.role_permissions
  WHERE role_id=N'super_admin'
    AND permission_key=N'configuration.integrations.view'
)
  THROW 51276, N'Super admin integration grant is missing.', 1;
IF OBJECT_ID(N'settings.object_storage_connections',N'U') IS NULL
  THROW 51277, N'Object-storage connection table was not created.', 1;
IF OBJECT_ID(N'settings.external_database_connections',N'U') IS NULL
  THROW 51278, N'External-database connection table was not created.', 1;
GO

PRINT N'027 complete: protected integration metadata, permissions and test status are ready.';
PRINT N'Credential values remain in Key Vault and are never stored in SQL.';
GO
