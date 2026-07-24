/*
  Portal SAG Web - SQL Server 2019 / 025
  Remove sections from the active Public Downloads contract and introduce a
  separate Public Files aggregate whose endpoints render safe media inline.

  Historical section rows are retained as migration evidence. Existing download
  links remain compatible, while all new and edited downloads use no section.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() NOT IN (N'PortalSAGWeb',N'PortalSAGWeb-TEST')
  THROW 52500,N'Wrong database.',1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT)<>15
  THROW 52501,N'This migration is certified for SQL Server 2019 (major version 15).',1;
IF NOT EXISTS
(
  SELECT 1 FROM migration.schema_migrations
  WHERE migration_version='024' AND succeeded=1
)
  THROW 52502,N'Migration 024 must be recorded before migration 025.',1;
IF OBJECT_ID(N'content.public_download_documents',N'U') IS NULL
   OR OBJECT_ID(N'content.public_download_files',N'U') IS NULL
   OR OBJECT_ID(N'content.files',N'U') IS NULL
  THROW 52503,N'The content schema prerequisites are missing.',1;

BEGIN TRANSACTION;

/* Sections leave the runtime contract. The table remains read-only historical evidence. */
ALTER TABLE content.public_download_documents ALTER COLUMN section_key BIGINT NULL;

IF OBJECT_ID(N'content.public_files',N'U') IS NULL
BEGIN
  CREATE TABLE content.public_files
  (
    public_file_key             BIGINT IDENTITY(1,1) NOT NULL,
    source_id                   NVARCHAR(150) NOT NULL,
    asset_kind                  VARCHAR(20) NOT NULL,
    title                       NVARCHAR(240) NOT NULL,
    slug                        NVARCHAR(200) NOT NULL,
    slug_normalized             NVARCHAR(200) NOT NULL,
    description                 NVARCHAR(1000) NULL,
    active                      BIT NOT NULL,
    status                      VARCHAR(20) NOT NULL,
    created_at                  DATETIME2(3) NOT NULL,
    created_by                  NVARCHAR(150) NOT NULL,
    updated_at                  DATETIME2(3) NOT NULL,
    updated_by                  NVARCHAR(150) NOT NULL,
    deleted_at                  DATETIME2(3) NULL,
    deleted_by                  NVARCHAR(150) NULL,
    row_version                 ROWVERSION NOT NULL,
    CONSTRAINT PK_public_files PRIMARY KEY CLUSTERED (public_file_key),
    CONSTRAINT UQ_public_files_source_id UNIQUE (source_id),
    CONSTRAINT CK_public_files_kind CHECK (asset_kind IN ('image','video','pdf')),
    CONSTRAINT CK_public_files_status CHECK (status IN ('active','inactive','deleted')),
    CONSTRAINT CK_public_files_timestamps CHECK (updated_at>=created_at),
    CONSTRAINT CK_public_files_deleted CHECK
    (
      (status='deleted' AND active=0 AND deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
      OR
      (status<>'deleted' AND deleted_at IS NULL AND deleted_by IS NULL)
    )
  );
END;

IF OBJECT_ID(N'content.public_file_versions',N'U') IS NULL
BEGIN
  CREATE TABLE content.public_file_versions
  (
    public_file_key             BIGINT NOT NULL,
    version_no                 INT NOT NULL,
    file_key                    BIGINT NOT NULL,
    is_current                  BIT NOT NULL,
    created_at                  DATETIME2(3) NOT NULL
      CONSTRAINT DF_public_file_versions_created DEFAULT SYSUTCDATETIME(),
    created_by                  NVARCHAR(150) NOT NULL,
    CONSTRAINT PK_public_file_versions PRIMARY KEY CLUSTERED (public_file_key,version_no),
    CONSTRAINT FK_public_file_versions_public_file
      FOREIGN KEY (public_file_key) REFERENCES content.public_files(public_file_key),
    CONSTRAINT FK_public_file_versions_file
      FOREIGN KEY (file_key) REFERENCES content.files(file_key),
    CONSTRAINT CK_public_file_versions_version CHECK (version_no>=1)
  );
END;

IF NOT EXISTS
(
  SELECT 1 FROM sys.indexes
  WHERE object_id=OBJECT_ID(N'content.public_files')
    AND name=N'UX_public_files_slug_active'
)
  CREATE UNIQUE INDEX UX_public_files_slug_active
    ON content.public_files(slug_normalized)
    WHERE status<>'deleted';

IF NOT EXISTS
(
  SELECT 1 FROM sys.indexes
  WHERE object_id=OBJECT_ID(N'content.public_files')
    AND name=N'IX_public_files_status_kind'
)
  CREATE INDEX IX_public_files_status_kind
    ON content.public_files(status,asset_kind,public_file_key)
    INCLUDE (source_id,title,slug,active,updated_at);

IF NOT EXISTS
(
  SELECT 1 FROM sys.indexes
  WHERE object_id=OBJECT_ID(N'content.public_file_versions')
    AND name=N'UX_public_file_versions_current'
)
  CREATE UNIQUE INDEX UX_public_file_versions_current
    ON content.public_file_versions(public_file_key)
    WHERE is_current=1;

/* Retire the obsolete section actions without deleting permission history. */
UPDATE security.permissions
SET active=0,
    description=N'Retirado por migración 025: las descargas públicas ya no usan secciones.'
WHERE permission_key IN
(
  N'implementation.public_downloads.create_section',
  N'implementation.public_downloads.edit_section',
  N'implementation.public_downloads.delete_section'
);

UPDATE security.permissions
SET label=CASE action_key
      WHEN N'create_document' THEN N'Crear Archivo'
      WHEN N'edit_document' THEN N'Editar Archivo'
      WHEN N'delete_document' THEN N'Eliminar Archivo'
      ELSE label
    END,
    description=N'Descargas Públicas / '+CASE action_key
      WHEN N'create_document' THEN N'Crear Archivo'
      WHEN N'edit_document' THEN N'Editar Archivo'
      WHEN N'delete_document' THEN N'Eliminar Archivo'
      ELSE label
    END
WHERE permission_key IN
(
  N'implementation.public_downloads.create_document',
  N'implementation.public_downloads.edit_document',
  N'implementation.public_downloads.delete_document'
);

DECLARE @public_file_permissions TABLE
(
  permission_key NVARCHAR(160) NOT NULL,
  action_key NVARCHAR(80) NOT NULL,
  label NVARCHAR(200) NOT NULL
);

INSERT @public_file_permissions(permission_key,action_key,label)
VALUES
  (N'implementation.public_files.view',N'view',N'Ver'),
  (N'implementation.public_files.create_file',N'create_file',N'Crear Archivo'),
  (N'implementation.public_files.edit_file',N'edit_file',N'Editar Archivo'),
  (N'implementation.public_files.delete_file',N'delete_file',N'Eliminar Archivo'),
  (N'implementation.public_files.replace_file',N'replace_file',N'Reemplazar Archivo');

UPDATE permission_record
SET module_key=N'implementation',
    option_key=N'public_files',
    action_key=source_record.action_key,
    label=source_record.label,
    description=N'Archivos Públicos / '+source_record.label,
    active=1
FROM security.permissions AS permission_record
JOIN @public_file_permissions AS source_record
  ON source_record.permission_key=permission_record.permission_key;

INSERT security.permissions
  (permission_key,module_key,option_key,action_key,label,description,active)
SELECT source_record.permission_key,N'implementation',N'public_files',
  source_record.action_key,source_record.label,N'Archivos Públicos / '+source_record.label,1
FROM @public_file_permissions AS source_record
WHERE NOT EXISTS
(
  SELECT 1 FROM security.permissions AS permission_record
  WHERE permission_record.permission_key=source_record.permission_key
);

INSERT security.role_permissions(role_id,permission_key,granted_at,granted_by)
SELECT N'super_admin',source_record.permission_key,SYSUTCDATETIME(),N'migration_025'
FROM @public_file_permissions AS source_record
WHERE NOT EXISTS
(
  SELECT 1 FROM security.role_permissions AS role_permission
  WHERE role_permission.role_id=N'super_admin'
    AND role_permission.permission_key=source_record.permission_key
);

COMMIT TRANSACTION;
GO

CREATE OR ALTER VIEW content.v_public_files
AS
SELECT
  p.public_file_key,
  p.source_id,
  p.asset_kind,
  p.title,
  p.slug,
  p.description,
  p.active,
  p.status,
  f.storage_provider,
  f.storage_bucket,
  f.object_key,
  f.object_etag,
  f.original_name,
  f.mime_type,
  f.byte_count,
  f.content_sha256,
  version_record.version_no,
  p.created_at,
  p.updated_at,
  p.row_version
FROM content.public_files AS p
LEFT JOIN content.public_file_versions AS version_record
  ON version_record.public_file_key=p.public_file_key
 AND version_record.is_current=1
LEFT JOIN content.files AS f ON f.file_key=version_record.file_key;
GO

IF EXISTS
(
  SELECT 1 FROM security.permissions
  WHERE permission_key LIKE N'implementation.public_downloads.%section' AND active=1
)
  THROW 52504,N'An obsolete section permission remains active.',1;
IF (SELECT COUNT(*) FROM security.permissions WHERE option_key=N'public_files' AND active=1)<>5
  THROW 52505,N'The Archivos Públicos permission contract is incomplete.',1;
IF EXISTS
(
  SELECT 1 FROM security.permissions AS permission_record
  WHERE permission_record.option_key=N'public_files'
    AND permission_record.active=1
    AND NOT EXISTS
    (
      SELECT 1 FROM security.role_permissions AS role_permission
      WHERE role_permission.role_id=N'super_admin'
        AND role_permission.permission_key=permission_record.permission_key
    )
)
  THROW 52506,N'Super Administrador is missing an Archivos Públicos permission.',1;
IF COLUMNPROPERTY(OBJECT_ID(N'content.public_download_documents'),N'section_key',N'AllowsNull')<>1
  THROW 52507,N'Public-download sections are still mandatory.',1;

PRINT N'025 complete: downloads are sectionless and forced; inline public files use a separate aggregate.';
GO
