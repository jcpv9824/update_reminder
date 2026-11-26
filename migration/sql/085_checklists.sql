/* Portal SAG Web - Checklists, SQL Server 2019 / compatibility 150.
   Additive only: six new tables, three permission keys; no customer or checklist seed data.
   Status and identity transitions are owned by the transaction in the repository. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET QUOTED_IDENTIFIER ON;
SET NUMERIC_ROUNDABORT OFF;

IF DB_NAME() NOT IN (N'PortalSAGWeb-TEST',N'PortalSAGWeb')
  THROW 53550, N'085 may only run on a designated Portal SAG Web database.', 1;
IF CONVERT(int,SERVERPROPERTY(N'ProductMajorVersion'))<15
   OR (SELECT compatibility_level FROM sys.databases WHERE database_id=DB_ID())<150
  THROW 53551, N'085 requires SQL Server 2019 or later at compatibility level 150 or higher.', 1;
IF (SELECT COUNT(*) FROM migration.schema_migrations WHERE migration_version IN ('002','003','007','033') AND succeeded=1)<>4
   OR SCHEMA_ID(N'implementation') IS NULL OR DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NULL
   OR OBJECT_ID(N'core.catalog_customer_ids',N'U') IS NULL OR OBJECT_ID(N'security.users',N'U') IS NULL
   OR NOT EXISTS (SELECT 1 FROM security.roles WHERE role_id=N'super_admin' AND active=1 AND protected_role=1)
  THROW 53552, N'085 requires the implementation schema, ERP customer IDs, runtime role and protected administrator.', 1;

BEGIN TRY
BEGIN TRANSACTION;

DECLARE @ddl_lock int;
EXEC @ddl_lock=sys.sp_getapplock @Resource=N'PortalSAGWeb:migration:085', @LockMode=N'Exclusive',
  @LockOwner=N'Transaction', @LockTimeout=30000;
IF @ddl_lock<0 THROW 53553, N'Could not acquire the migration 085 lock.', 1;

DECLARE @found int=(SELECT COUNT(*) FROM sys.tables WHERE schema_id=SCHEMA_ID(N'implementation') AND name IN
  (N'checklist_templates',N'checklist_template_versions',N'checklist_template_points',
   N'implementation_checklists',N'implementation_checklist_points',N'implementation_checklist_evidence'));
IF @found NOT IN (0,6)
  THROW 53554, N'Partial Checklists schema detected. Review the target without writes.', 1;

IF @found=0
BEGIN
  CREATE TABLE implementation.checklist_templates
  (
    id uniqueidentifier NOT NULL CONSTRAINT DF_checklist_templates_id DEFAULT NEWSEQUENTIALID(),
    name nvarchar(150) COLLATE Modern_Spanish_CI_AI NOT NULL,
    created_by bigint NOT NULL,
    created_at datetime2(3) NOT NULL CONSTRAINT DF_checklist_templates_created DEFAULT SYSUTCDATETIME(),
    updated_at datetime2(3) NOT NULL CONSTRAINT DF_checklist_templates_updated DEFAULT SYSUTCDATETIME(),
    deleted_at datetime2(3) NULL,
    deleted_by bigint NULL,
    row_version rowversion NOT NULL,
    CONSTRAINT PK_checklist_templates PRIMARY KEY CLUSTERED(id),
    CONSTRAINT FK_checklist_templates_creator FOREIGN KEY(created_by) REFERENCES security.users(user_key),
    CONSTRAINT FK_checklist_templates_deleter FOREIGN KEY(deleted_by) REFERENCES security.users(user_key),
    CONSTRAINT CK_checklist_templates_name CHECK (LEN(name)>0 AND DATALENGTH(name)=DATALENGTH(LTRIM(RTRIM(name)))),
    CONSTRAINT CK_checklist_templates_deleted CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
  );
  CREATE UNIQUE NONCLUSTERED INDEX UX_checklist_templates_active_name
    ON implementation.checklist_templates(name) WHERE deleted_at IS NULL;

  CREATE TABLE implementation.checklist_template_versions
  (
    id uniqueidentifier NOT NULL CONSTRAINT DF_checklist_versions_id DEFAULT NEWSEQUENTIALID(),
    template_id uniqueidentifier NOT NULL,
    number int NOT NULL,
    status varchar(12) COLLATE Latin1_General_100_BIN2 NOT NULL,
    requires_environment bit NOT NULL CONSTRAINT DF_checklist_versions_environment DEFAULT (0),
    created_by bigint NOT NULL,
    created_at datetime2(3) NOT NULL CONSTRAINT DF_checklist_versions_created DEFAULT SYSUTCDATETIME(),
    updated_at datetime2(3) NOT NULL CONSTRAINT DF_checklist_versions_updated DEFAULT SYSUTCDATETIME(),
    published_at datetime2(3) NULL,
    published_by bigint NULL,
    deleted_at datetime2(3) NULL,
    deleted_by bigint NULL,
    row_version rowversion NOT NULL,
    CONSTRAINT PK_checklist_versions PRIMARY KEY CLUSTERED(id),
    CONSTRAINT UQ_checklist_versions_template_environment UNIQUE(template_id,id,requires_environment),
    CONSTRAINT FK_checklist_versions_template FOREIGN KEY(template_id) REFERENCES implementation.checklist_templates(id),
    CONSTRAINT FK_checklist_versions_creator FOREIGN KEY(created_by) REFERENCES security.users(user_key),
    CONSTRAINT FK_checklist_versions_publisher FOREIGN KEY(published_by) REFERENCES security.users(user_key),
    CONSTRAINT FK_checklist_versions_deleter FOREIGN KEY(deleted_by) REFERENCES security.users(user_key),
    CONSTRAINT CK_checklist_versions_number CHECK (number>0),
    CONSTRAINT CK_checklist_versions_published CHECK (
      (status='editing' AND published_at IS NULL AND published_by IS NULL)
      OR (status IN ('current','frozen') AND published_at IS NOT NULL AND published_by IS NOT NULL)),
    CONSTRAINT CK_checklist_versions_deleted CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
  );
  CREATE UNIQUE NONCLUSTERED INDEX UX_checklist_versions_active_number
    ON implementation.checklist_template_versions(template_id,number) WHERE deleted_at IS NULL;
  CREATE UNIQUE NONCLUSTERED INDEX UX_checklist_versions_active_current
    ON implementation.checklist_template_versions(template_id) WHERE deleted_at IS NULL AND status='current';
  CREATE UNIQUE NONCLUSTERED INDEX UX_checklist_versions_active_editing
    ON implementation.checklist_template_versions(template_id) WHERE deleted_at IS NULL AND status='editing';

  CREATE TABLE implementation.checklist_template_points
  (
    id uniqueidentifier NOT NULL CONSTRAINT DF_checklist_template_points_id DEFAULT NEWSEQUENTIALID(),
    version_id uniqueidentifier NOT NULL,
    position int NOT NULL,
    title nvarchar(200) NOT NULL,
    detail nvarchar(1000) NULL,
    created_at datetime2(3) NOT NULL CONSTRAINT DF_checklist_template_points_created DEFAULT SYSUTCDATETIME(),
    updated_at datetime2(3) NOT NULL CONSTRAINT DF_checklist_template_points_updated DEFAULT SYSUTCDATETIME(),
    deleted_at datetime2(3) NULL,
    deleted_by bigint NULL,
    row_version rowversion NOT NULL,
    CONSTRAINT PK_checklist_template_points PRIMARY KEY CLUSTERED(id),
    CONSTRAINT UQ_checklist_template_points_version_position UNIQUE(version_id,id,position),
    CONSTRAINT FK_checklist_template_points_version FOREIGN KEY(version_id) REFERENCES implementation.checklist_template_versions(id),
    CONSTRAINT FK_checklist_template_points_deleter FOREIGN KEY(deleted_by) REFERENCES security.users(user_key),
    CONSTRAINT CK_checklist_template_points_position CHECK (position BETWEEN 1 AND 100),
    CONSTRAINT CK_checklist_template_points_title CHECK (LEN(title)>0),
    CONSTRAINT CK_checklist_template_points_detail CHECK (detail IS NULL OR LEN(LTRIM(RTRIM(detail)))>0),
    CONSTRAINT CK_checklist_template_points_deleted CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
  );
  CREATE UNIQUE NONCLUSTERED INDEX UX_checklist_template_points_active_position
    ON implementation.checklist_template_points(version_id,position) WHERE deleted_at IS NULL;

  CREATE TABLE implementation.implementation_checklists
  (
    id uniqueidentifier NOT NULL CONSTRAINT DF_implementation_checklists_id DEFAULT NEWSEQUENTIALID(),
    client_id uniqueidentifier NOT NULL,
    client_name_snapshot nvarchar(200) NOT NULL,
    template_id uniqueidentifier NOT NULL,
    version_id uniqueidentifier NOT NULL,
    requires_environment bit NOT NULL,
    environment varchar(12) COLLATE Latin1_General_100_BIN2 NULL,
    -- '' is the internal key for NULL; allowed non-NULL environments are checked below.
    environment_key AS ISNULL(environment,CONVERT(varchar(12),'')) PERSISTED,
    status varchar(12) COLLATE Latin1_General_100_BIN2 NOT NULL CONSTRAINT DF_implementation_checklists_status DEFAULT ('in_progress'),
    owner_user_id bigint NOT NULL,
    created_by bigint NOT NULL,
    created_at datetime2(3) NOT NULL CONSTRAINT DF_implementation_checklists_created DEFAULT SYSUTCDATETIME(),
    updated_at datetime2(3) NOT NULL CONSTRAINT DF_implementation_checklists_updated DEFAULT SYSUTCDATETIME(),
    completed_at datetime2(3) NULL,
    completed_by bigint NULL,
    deleted_at datetime2(3) NULL,
    deleted_by bigint NULL,
    row_version rowversion NOT NULL,
    CONSTRAINT PK_implementation_checklists PRIMARY KEY CLUSTERED(id),
    CONSTRAINT UQ_implementation_checklists_version UNIQUE(id,version_id),
    CONSTRAINT FK_implementation_checklists_client FOREIGN KEY(client_id) REFERENCES core.catalog_customer_ids(customer_id),
    CONSTRAINT FK_implementation_checklists_version FOREIGN KEY(template_id,version_id,requires_environment)
      REFERENCES implementation.checklist_template_versions(template_id,id,requires_environment),
    CONSTRAINT FK_implementation_checklists_owner FOREIGN KEY(owner_user_id) REFERENCES security.users(user_key),
    CONSTRAINT FK_implementation_checklists_creator FOREIGN KEY(created_by) REFERENCES security.users(user_key),
    CONSTRAINT FK_implementation_checklists_completer FOREIGN KEY(completed_by) REFERENCES security.users(user_key),
    CONSTRAINT FK_implementation_checklists_deleter FOREIGN KEY(deleted_by) REFERENCES security.users(user_key),
    CONSTRAINT CK_implementation_checklists_client_name CHECK (LEN(client_name_snapshot)>0),
    CONSTRAINT CK_implementation_checklists_environment CHECK ((requires_environment=0 AND environment IS NULL)
      OR (requires_environment=1 AND environment IS NOT NULL AND environment IN ('testing','production','demo'))),
    CONSTRAINT CK_implementation_checklists_completed CHECK (
      (status='in_progress' AND completed_at IS NULL AND completed_by IS NULL)
      OR (status='completed' AND completed_at IS NOT NULL AND completed_by IS NOT NULL)),
    CONSTRAINT CK_implementation_checklists_deleted CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
  );
  CREATE UNIQUE NONCLUSTERED INDEX UX_implementation_checklists_active_progress
    ON implementation.implementation_checklists(client_id,template_id,environment_key)
    WHERE deleted_at IS NULL AND status='in_progress';
  CREATE NONCLUSTERED INDEX IX_implementation_checklists_active_version
    ON implementation.implementation_checklists(template_id,version_id) INCLUDE(deleted_at) WHERE deleted_at IS NULL;
  CREATE NONCLUSTERED INDEX IX_implementation_checklists_active_list
    ON implementation.implementation_checklists(status,created_at DESC,id) INCLUDE(deleted_at) WHERE deleted_at IS NULL;

  CREATE TABLE implementation.implementation_checklist_points
  (
    checklist_id uniqueidentifier NOT NULL,
    template_point_id uniqueidentifier NOT NULL,
    version_id uniqueidentifier NOT NULL,
    position int NOT NULL,
    checked bit NOT NULL CONSTRAINT DF_implementation_checklist_points_checked DEFAULT (0),
    notes_json nvarchar(max) NULL,
    checked_at datetime2(3) NULL,
    checked_by bigint NULL,
    created_at datetime2(3) NOT NULL CONSTRAINT DF_implementation_checklist_points_created DEFAULT SYSUTCDATETIME(),
    updated_at datetime2(3) NOT NULL CONSTRAINT DF_implementation_checklist_points_updated DEFAULT SYSUTCDATETIME(),
    row_version rowversion NOT NULL,
    CONSTRAINT PK_implementation_checklist_points PRIMARY KEY CLUSTERED(checklist_id,template_point_id),
    CONSTRAINT UQ_implementation_checklist_points_position UNIQUE(checklist_id,position),
    CONSTRAINT FK_implementation_checklist_points_checklist FOREIGN KEY(checklist_id,version_id)
      REFERENCES implementation.implementation_checklists(id,version_id),
    CONSTRAINT FK_implementation_checklist_points_version FOREIGN KEY(version_id,template_point_id,position)
      REFERENCES implementation.checklist_template_points(version_id,id,position),
    CONSTRAINT FK_implementation_checklist_points_checker FOREIGN KEY(checked_by) REFERENCES security.users(user_key),
    CONSTRAINT CK_implementation_checklist_points_mark CHECK ((checked_at IS NULL AND checked_by IS NULL AND checked=0)
      OR (checked_at IS NOT NULL AND checked_by IS NOT NULL)),
    CONSTRAINT CK_implementation_checklist_points_notes CHECK (notes_json IS NULL OR ISJSON(notes_json)=1)
  );

  CREATE TABLE implementation.implementation_checklist_evidence
  (
    id uniqueidentifier NOT NULL CONSTRAINT DF_implementation_checklist_evidence_id DEFAULT NEWSEQUENTIALID(),
    checklist_id uniqueidentifier NOT NULL,
    template_point_id uniqueidentifier NOT NULL,
    kind varchar(8) COLLATE Latin1_General_100_BIN2 NOT NULL,
    url nvarchar(2000) NULL,
    [text] nvarchar(2000) NULL,
    storage_provider varchar(12) COLLATE Latin1_General_100_BIN2 NULL,
    storage_container nvarchar(255) NULL, -- S3 bucket or Azure container; no signed URL.
    storage_key nvarchar(1024) NULL,
    file_name nvarchar(255) NULL,
    content_type nvarchar(255) NULL,
    size_bytes bigint NULL,
    storage_sha256 binary(32) NULL,
    verified_at datetime2(3) NULL,
    cleanup_lease_id uniqueidentifier NULL,
    cleanup_lease_until datetime2(3) NULL,
    storage_deleted_at datetime2(3) NULL,
    status varchar(8) COLLATE Latin1_General_100_BIN2 NOT NULL CONSTRAINT DF_checklist_evidence_status DEFAULT ('pending'),
    created_by bigint NOT NULL,
    created_at datetime2(3) NOT NULL CONSTRAINT DF_checklist_evidence_created DEFAULT SYSUTCDATETIME(),
    updated_at datetime2(3) NOT NULL CONSTRAINT DF_checklist_evidence_updated DEFAULT SYSUTCDATETIME(),
    deleted_at datetime2(3) NULL,
    deleted_by bigint NULL,
    row_version rowversion NOT NULL,
    CONSTRAINT PK_implementation_checklist_evidence PRIMARY KEY CLUSTERED(id),
    CONSTRAINT FK_checklist_evidence_point FOREIGN KEY(checklist_id,template_point_id)
      REFERENCES implementation.implementation_checklist_points(checklist_id,template_point_id),
    CONSTRAINT FK_checklist_evidence_creator FOREIGN KEY(created_by) REFERENCES security.users(user_key),
    CONSTRAINT FK_checklist_evidence_deleter FOREIGN KEY(deleted_by) REFERENCES security.users(user_key),
    CONSTRAINT CK_checklist_evidence_status CHECK (status IN ('pending','saved')),
    CONSTRAINT CK_checklist_evidence_payload CHECK (
      (kind IN ('link','text') AND ((kind='link' AND url IS NOT NULL AND LEN(url)>0 AND [text] IS NULL)
        OR (kind='text' AND [text] IS NOT NULL AND LEN([text])>0 AND url IS NULL))
        AND storage_provider IS NULL AND storage_container IS NULL AND storage_key IS NULL
        AND file_name IS NULL AND content_type IS NULL AND size_bytes IS NULL
        AND storage_sha256 IS NULL AND verified_at IS NULL)
      OR (kind IN ('image','video','file') AND url IS NULL AND [text] IS NULL
        AND storage_provider IS NOT NULL AND storage_provider IN ('s3','azure_blob')
        AND storage_container IS NOT NULL AND LEN(storage_container)>0
        AND storage_key IS NOT NULL AND storage_key COLLATE Latin1_General_100_BIN2 LIKE N'checklists/'+LOWER(CONVERT(nvarchar(36),id))+N'/payload.%'
        AND LEN(storage_key)>56 AND file_name IS NOT NULL AND LEN(file_name)>0
        AND content_type IS NOT NULL AND LEN(content_type)>0 AND size_bytes IS NOT NULL AND size_bytes>0
        AND storage_sha256 IS NOT NULL AND (status='pending' OR verified_at IS NOT NULL))),
    CONSTRAINT CK_checklist_evidence_cleanup CHECK (
      (cleanup_lease_id IS NULL AND cleanup_lease_until IS NULL AND storage_deleted_at IS NULL)
      OR (kind IN ('image','video','file') AND status='pending' AND deleted_at IS NOT NULL AND
        ((cleanup_lease_id IS NOT NULL AND cleanup_lease_until IS NOT NULL AND storage_deleted_at IS NULL)
         OR (cleanup_lease_id IS NULL AND cleanup_lease_until IS NULL AND storage_deleted_at IS NOT NULL)))),
    CONSTRAINT CK_checklist_evidence_deleted CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
  );
  CREATE NONCLUSTERED INDEX IX_checklist_evidence_active_point
    ON implementation.implementation_checklist_evidence(checklist_id,template_point_id,status) INCLUDE(deleted_at) WHERE deleted_at IS NULL;
  CREATE NONCLUSTERED INDEX IX_checklist_evidence_pending_age
    ON implementation.implementation_checklist_evidence(created_at,id) INCLUDE(deleted_at,cleanup_lease_until) WHERE status='pending' AND storage_deleted_at IS NULL;

  -- Narrow object-level grants support all Checklists repositories; deletions are logical.
  GRANT SELECT,INSERT,UPDATE ON OBJECT::implementation.checklist_templates TO portal_runtime;
  GRANT SELECT,INSERT,UPDATE ON OBJECT::implementation.checklist_template_versions TO portal_runtime;
  GRANT SELECT,INSERT,UPDATE ON OBJECT::implementation.checklist_template_points TO portal_runtime;
  GRANT SELECT,INSERT,UPDATE ON OBJECT::implementation.implementation_checklists TO portal_runtime;
  GRANT SELECT,INSERT,UPDATE ON OBJECT::implementation.implementation_checklist_points TO portal_runtime;
  GRANT SELECT,INSERT,UPDATE ON OBJECT::implementation.implementation_checklist_evidence TO portal_runtime;
  DENY DELETE ON OBJECT::implementation.checklist_templates TO portal_runtime;
  DENY DELETE ON OBJECT::implementation.checklist_template_versions TO portal_runtime;
  DENY DELETE ON OBJECT::implementation.checklist_template_points TO portal_runtime;
  DENY DELETE ON OBJECT::implementation.implementation_checklists TO portal_runtime;
  DENY DELETE ON OBJECT::implementation.implementation_checklist_points TO portal_runtime;
  DENY DELETE ON OBJECT::implementation.implementation_checklist_evidence TO portal_runtime;

  DECLARE @permissions TABLE (permission_key nvarchar(160) NOT NULL PRIMARY KEY,
    module_key nvarchar(80) NOT NULL, option_key nvarchar(100) NOT NULL,
    action_key nvarchar(80) NOT NULL, label nvarchar(200) NOT NULL);
  INSERT @permissions(permission_key,module_key,option_key,action_key,label) VALUES
    (N'implementation.checklists.view',N'implementation',N'checklists',N'view',N'Ver'),
    (N'implementation.checklists.create',N'implementation',N'checklists',N'create',N'Crear Checklist'),
    (N'configuration.checklist_templates.view',N'configuration',N'checklist_templates',N'view',N'Entrar (ver, crear y editar plantillas y versiones)');

  -- Fail closed on unexpected preexisting definitions; do not rewrite ordinary grants.
  INSERT security.permissions(permission_key,module_key,option_key,action_key,label,description,active)
  SELECT permission_key,module_key,option_key,action_key,label,N'Checklists / '+label,1 FROM @permissions;
  INSERT security.role_permissions(role_id,permission_key,granted_by)
  SELECT N'super_admin',permission_key,N'migration-085' FROM @permissions;
END;

IF (SELECT COUNT(*) FROM sys.indexes WHERE has_filter=1 AND is_unique=1 AND is_disabled=0 AND
    ((object_id=OBJECT_ID(N'implementation.checklist_templates') AND name=N'UX_checklist_templates_active_name') OR
     (object_id=OBJECT_ID(N'implementation.checklist_template_versions') AND name IN
       (N'UX_checklist_versions_active_number',N'UX_checklist_versions_active_current',N'UX_checklist_versions_active_editing')) OR
     (object_id=OBJECT_ID(N'implementation.checklist_template_points') AND name=N'UX_checklist_template_points_active_position') OR
     (object_id=OBJECT_ID(N'implementation.implementation_checklists') AND name=N'UX_implementation_checklists_active_progress')))<>6
   OR (SELECT COUNT(*) FROM security.role_permissions AS rp JOIN security.permissions AS p ON p.permission_key=rp.permission_key
       WHERE rp.role_id=N'super_admin' AND p.active=1 AND p.permission_key IN
       (N'implementation.checklists.view',N'implementation.checklists.create',N'configuration.checklist_templates.view'))<>3
  THROW 53555, N'085 failed its postconditions: required unique indexes or protected grants are missing.', 1;

COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;

PRINT N'085 complete: Checklists schema and permission catalog.';
