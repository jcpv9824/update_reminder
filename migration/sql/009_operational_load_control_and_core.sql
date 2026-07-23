/*
  Portal SAG Web - Gate D / 009
  Operational-load control, private-file transfer ledger, and the first
  transactional load phase (roles, users, clients, domains, databases and
  licensing). SQL Server 2019.

  This script creates objects only. It does not execute a migration run.
  Legacy auth sessions and rate-limit windows are deliberately not loaded;
  cutover starts with an empty session/rate-limit boundary.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() <> N'PortalSAGWeb' THROW 51090, N'Wrong database.', 1;
IF OBJECT_ID(N'migration.usp_project_raw_to_stage', N'P') IS NULL THROW 51091, N'Run 008 first.', 1;
GO

BEGIN TRANSACTION;

CREATE TABLE migration.operational_load_phases
(
  run_key                    BIGINT NOT NULL,
  phase_code                 VARCHAR(60) NOT NULL,
  status                     VARCHAR(20) NOT NULL,
  started_at                 DATETIME2(3) NOT NULL CONSTRAINT DF_operational_load_phases_started DEFAULT SYSUTCDATETIME(),
  completed_at               DATETIME2(3) NULL,
  source_count               BIGINT NULL,
  target_count               BIGINT NULL,
  details                    NVARCHAR(2000) NULL,
  executed_by                NVARCHAR(150) NOT NULL CONSTRAINT DF_operational_load_phases_executed_by DEFAULT ORIGINAL_LOGIN(),
  row_version                ROWVERSION NOT NULL,
  CONSTRAINT PK_operational_load_phases PRIMARY KEY CLUSTERED (run_key, phase_code),
  CONSTRAINT FK_operational_load_phases_run FOREIGN KEY (run_key) REFERENCES migration.migration_runs(run_key),
  CONSTRAINT CK_operational_load_phases_status CHECK (status IN ('running','completed','failed','aborted')),
  CONSTRAINT CK_operational_load_phases_counts CHECK (
    (source_count IS NULL OR source_count >= 0) AND (target_count IS NULL OR target_count >= 0)
  ),
  CONSTRAINT CK_operational_load_phases_completed CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE TABLE migration.file_transfers
(
  run_key                    BIGINT NOT NULL,
  source_container           NVARCHAR(100) NOT NULL,
  source_id                  NVARCHAR(150) NOT NULL,
  file_slot                  VARCHAR(30) NOT NULL,
  original_name              NVARCHAR(260) NOT NULL,
  mime_type                  NVARCHAR(160) NOT NULL,
  expected_byte_count        BIGINT NOT NULL,
  expected_sha256            BINARY(32) NOT NULL,
  blob_container             NVARCHAR(63) NOT NULL,
  blob_name                  NVARCHAR(1024) NOT NULL,
  status                     VARCHAR(20) NOT NULL CONSTRAINT DF_file_transfers_status DEFAULT ('planned'),
  blob_etag                  NVARCHAR(200) NULL,
  attempt_count              INT NOT NULL CONSTRAINT DF_file_transfers_attempts DEFAULT (0),
  planned_at                 DATETIME2(3) NOT NULL CONSTRAINT DF_file_transfers_planned DEFAULT SYSUTCDATETIME(),
  uploaded_at                DATETIME2(3) NULL,
  verified_at                DATETIME2(3) NULL,
  linked_at                  DATETIME2(3) NULL,
  last_error                 NVARCHAR(2000) NULL,
  row_version                ROWVERSION NOT NULL,
  CONSTRAINT PK_file_transfers PRIMARY KEY CLUSTERED (run_key, source_container, source_id, file_slot),
  CONSTRAINT UQ_file_transfers_blob UNIQUE (blob_container, blob_name),
  CONSTRAINT FK_file_transfers_run FOREIGN KEY (run_key) REFERENCES migration.migration_runs(run_key),
  CONSTRAINT FK_file_transfers_raw FOREIGN KEY (run_key, source_container, source_id)
    REFERENCES migration.raw_documents(run_key, source_container, source_id),
  CONSTRAINT CK_file_transfers_source CHECK (
    (source_container = N'formatosImpresion' AND file_slot = 'pdf') OR
    (source_container = N'publicDownloads' AND file_slot = 'document')
  ),
  CONSTRAINT CK_file_transfers_size CHECK (expected_byte_count > 0),
  CONSTRAINT CK_file_transfers_attempts CHECK (attempt_count >= 0),
  CONSTRAINT CK_file_transfers_status CHECK (status IN ('planned','uploading','uploaded','verified','linked','failed')),
  CONSTRAINT CK_file_transfers_https_name CHECK (LEN(LTRIM(RTRIM(blob_name))) > 0),
  CONSTRAINT CK_file_transfers_timestamps CHECK (
    (uploaded_at IS NULL OR uploaded_at >= planned_at) AND
    (verified_at IS NULL OR uploaded_at IS NOT NULL AND verified_at >= uploaded_at) AND
    (linked_at IS NULL OR verified_at IS NOT NULL AND linked_at >= verified_at)
  )
);

CREATE INDEX IX_file_transfers_run_status
  ON migration.file_transfers(run_key, status, source_container, source_id)
  INCLUDE (expected_byte_count, expected_sha256, blob_container, blob_name);

COMMIT TRANSACTION;
GO

CREATE OR ALTER PROCEDURE migration.usp_assert_operational_load_ready
  @run_key BIGINT
AS
BEGIN
  SET NOCOUNT ON;

  IF NOT EXISTS
  (
    SELECT 1
    FROM migration.migration_runs
    WHERE run_key = @run_key AND status IN ('validated','loading')
  )
    THROW 51100, N'The migration run must be validated or already loading.', 1;

  IF EXISTS
  (
    SELECT 1
    FROM migration.validation_results
    WHERE run_key = @run_key AND resolution_status NOT IN ('resolved','accepted')
  )
    THROW 51101, N'All validation findings must be resolved or explicitly accepted.', 1;

  IF (SELECT COUNT_BIG(*) FROM migration.reconciliation_counts
      WHERE run_key = @run_key AND reconciliation_code LIKE N'stage_count:%') <> 17
    THROW 51102, N'All 17 staging reconciliations are required.', 1;

  IF EXISTS
  (
    SELECT 1
    FROM migration.reconciliation_counts
    WHERE run_key = @run_key AND reconciliation_code LIKE N'stage_count:%' AND reconciled = 0
  )
    THROW 51103, N'At least one staging reconciliation failed.', 1;

  IF EXISTS
  (
    SELECT 1
    FROM migration.migration_runs AS r
    WHERE r.run_key = @run_key
      AND (r.source_document_count IS NULL OR r.staged_document_count <> r.source_document_count)
  )
    THROW 51104, N'Raw/staged document counts are incomplete.', 1;
END;
GO

CREATE OR ALTER PROCEDURE migration.usp_register_file_transfer_plan
  @run_key BIGINT,
  @source_container NVARCHAR(100),
  @source_id NVARCHAR(150),
  @file_slot VARCHAR(30),
  @original_name NVARCHAR(260),
  @mime_type NVARCHAR(160),
  @expected_byte_count BIGINT,
  @expected_sha256 BINARY(32),
  @blob_container NVARCHAR(63),
  @blob_name NVARCHAR(1024)
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;

  EXEC migration.usp_assert_operational_load_ready @run_key;

  IF @expected_byte_count <= 0 OR @expected_sha256 IS NULL
    THROW 51110, N'File size and SHA-256 are required.', 1;
  IF @source_container NOT IN (N'formatosImpresion', N'publicDownloads')
    THROW 51111, N'Unsupported file source container.', 1;
  IF NOT EXISTS
  (
    SELECT 1 FROM migration.raw_documents
    WHERE run_key=@run_key AND source_container=@source_container AND source_id=@source_id
  )
    THROW 51112, N'The source document does not exist in this migration run.', 1;

  BEGIN TRANSACTION;

  IF EXISTS
  (
    SELECT 1 FROM migration.file_transfers WITH (UPDLOCK, HOLDLOCK)
    WHERE run_key=@run_key AND source_container=@source_container AND source_id=@source_id AND file_slot=@file_slot
      AND status IN ('uploaded','verified','linked')
  )
    THROW 51113, N'An uploaded file plan is immutable.', 1;

  IF EXISTS
  (
    SELECT 1 FROM migration.file_transfers WITH (UPDLOCK, HOLDLOCK)
    WHERE run_key=@run_key AND source_container=@source_container AND source_id=@source_id AND file_slot=@file_slot
  )
  BEGIN
    UPDATE migration.file_transfers
    SET original_name=@original_name, mime_type=@mime_type,
        expected_byte_count=@expected_byte_count, expected_sha256=@expected_sha256,
        blob_container=@blob_container, blob_name=@blob_name, status='planned',
        blob_etag=NULL, uploaded_at=NULL, verified_at=NULL, linked_at=NULL, last_error=NULL
    WHERE run_key=@run_key AND source_container=@source_container AND source_id=@source_id AND file_slot=@file_slot;
  END
  ELSE
  BEGIN
    INSERT migration.file_transfers
      (run_key, source_container, source_id, file_slot, original_name, mime_type,
       expected_byte_count, expected_sha256, blob_container, blob_name)
    VALUES
      (@run_key, @source_container, @source_id, @file_slot, @original_name, @mime_type,
       @expected_byte_count, @expected_sha256, @blob_container, @blob_name);
  END;

  IF @source_container=N'formatosImpresion'
    UPDATE migration.stage_print_formats
    SET pdf_byte_count=@expected_byte_count, pdf_sha256=@expected_sha256
    WHERE run_key=@run_key AND source_id=@source_id;
  ELSE
    UPDATE migration.stage_public_downloads
    SET file_byte_count=@expected_byte_count, file_sha256=@expected_sha256
    WHERE run_key=@run_key AND source_id=@source_id AND record_type='document';

  IF @@ROWCOUNT <> 1 THROW 51114, N'The staged file owner was not found or was not a document.', 1;

  COMMIT TRANSACTION;
END;
GO

CREATE OR ALTER PROCEDURE migration.usp_mark_file_transfer_verified
  @run_key BIGINT,
  @source_container NVARCHAR(100),
  @source_id NVARCHAR(150),
  @file_slot VARCHAR(30),
  @actual_byte_count BIGINT,
  @actual_sha256 BINARY(32),
  @blob_etag NVARCHAR(200)
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;

  UPDATE migration.file_transfers WITH (UPDLOCK, SERIALIZABLE)
  SET attempt_count=attempt_count+1,
      status=CASE WHEN expected_byte_count=@actual_byte_count AND expected_sha256=@actual_sha256 THEN 'verified' ELSE 'failed' END,
      blob_etag=@blob_etag,
      uploaded_at=COALESCE(uploaded_at, SYSUTCDATETIME()),
      verified_at=CASE WHEN expected_byte_count=@actual_byte_count AND expected_sha256=@actual_sha256 THEN SYSUTCDATETIME() ELSE NULL END,
      last_error=CASE WHEN expected_byte_count=@actual_byte_count AND expected_sha256=@actual_sha256
        THEN NULL ELSE N'Uploaded object did not match the planned byte count and SHA-256.' END
  WHERE run_key=@run_key AND source_container=@source_container AND source_id=@source_id AND file_slot=@file_slot
    AND status IN ('planned','uploading','uploaded','failed');

  IF @@ROWCOUNT <> 1 THROW 51120, N'The file transfer was not found or is already immutable.', 1;
  IF EXISTS
  (
    SELECT 1 FROM migration.file_transfers
    WHERE run_key=@run_key AND source_container=@source_container AND source_id=@source_id AND file_slot=@file_slot
      AND status='failed'
  )
    THROW 51121, N'Uploaded object verification failed.', 1;
END;
GO

CREATE OR ALTER PROCEDURE migration.usp_load_operational_security_core_licensing
  @run_key BIGINT
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;

  DECLARE @phase_code VARCHAR(60)='security_core_licensing';
  DECLARE @now DATETIME2(3)=SYSUTCDATETIME();
  DECLARE @source_count BIGINT;
  DECLARE @target_count BIGINT;

  EXEC migration.usp_assert_operational_load_ready @run_key;

  IF EXISTS
  (
    SELECT 1 FROM migration.operational_load_phases
    WHERE run_key=@run_key AND phase_code=@phase_code AND status='completed'
  )
  BEGIN
    SELECT run_key, phase_code, status, source_count, target_count, completed_at
    FROM migration.operational_load_phases
    WHERE run_key=@run_key AND phase_code=@phase_code;
    RETURN;
  END;

  IF EXISTS (SELECT 1 FROM security.users)
     OR EXISTS (SELECT 1 FROM core.clients)
     OR EXISTS (SELECT 1 FROM core.domains)
     OR EXISTS (SELECT 1 FROM core.databases)
     OR EXISTS (SELECT 1 FROM licensing.license_modules)
     OR EXISTS (SELECT 1 FROM licensing.license_assignments)
    THROW 51130, N'The first operational phase requires an empty operational target.', 1;

  SELECT @source_count=COUNT_BIG(*)
  FROM migration.raw_documents
  WHERE run_key=@run_key
    AND source_container IN (N'users',N'roles',N'clients',N'domains',N'databases',N'licenseModules',N'licenseAssignments');

  IF EXISTS (SELECT 1 FROM migration.operational_load_phases WHERE run_key=@run_key AND phase_code=@phase_code)
    UPDATE migration.operational_load_phases
    SET status='running', started_at=@now, completed_at=NULL, source_count=@source_count,
        target_count=NULL, details=N'Transactional retry started.', executed_by=ORIGINAL_LOGIN()
    WHERE run_key=@run_key AND phase_code=@phase_code;
  ELSE
    INSERT migration.operational_load_phases(run_key, phase_code, status, started_at, source_count, details)
    VALUES(@run_key, @phase_code, 'running', @now, @source_count, N'Transactional operational load started.');

  BEGIN TRY
    BEGIN TRANSACTION;

    /* Seeded roles remain authoritative; source roles may add metadata and permissions. */
    ;WITH role_source AS
    (
      SELECT
        CASE s.source_id
          WHEN N'admin' THEN N'super_admin'
          WHEN N'formatos_impresion.admin' THEN N'print_formats_admin'
          WHEN N'client_manager' THEN N'client_operations_manager'
          WHEN N'viewer' THEN N'audit_viewer'
          WHEN N'public_downloads.admin' THEN N'public_downloads_manager'
          ELSE s.source_id END AS role_id,
        s.name, s.active, s.system_role, s.protected_role,
        s.domain_task_visibility, s.database_task_visibility,
        r.raw_json,
        ROW_NUMBER() OVER
        (
          PARTITION BY CASE s.source_id
            WHEN N'admin' THEN N'super_admin'
            WHEN N'formatos_impresion.admin' THEN N'print_formats_admin'
            WHEN N'client_manager' THEN N'client_operations_manager'
            WHEN N'viewer' THEN N'audit_viewer'
            WHEN N'public_downloads.admin' THEN N'public_downloads_manager'
            ELSE s.source_id END
          ORDER BY s.source_id
        ) AS row_number
      FROM migration.stage_roles AS s
      JOIN migration.raw_documents AS r
        ON r.run_key=s.run_key AND r.source_container=N'roles' AND r.source_id=s.source_id
      WHERE s.run_key=@run_key
    )
    INSERT security.roles
      (role_id, name, active, system_role, protected_role, domain_task_visibility,
       database_task_visibility, created_at, created_by, updated_at, updated_by)
    SELECT role_id, COALESCE(NULLIF(LTRIM(RTRIM(name)),N''), role_id), COALESCE(active,1),
      CASE WHEN role_id=N'super_admin' THEN 1 ELSE COALESCE(system_role,0) END,
      CASE WHEN role_id=N'super_admin' THEN 1 ELSE COALESCE(protected_role,0) END,
      CASE WHEN domain_task_visibility IN ('none','assigned','all') THEN domain_task_visibility ELSE 'none' END,
      CASE WHEN database_task_visibility IN ('none','assigned','all') THEN database_task_visibility ELSE 'none' END,
      COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(raw_json,'$.createdAt'),127),@now),
      COALESCE(NULLIF(JSON_VALUE(raw_json,'$.createdBy'),N''),N'migration'),
      COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(raw_json,'$.updatedAt'),127),
               TRY_CONVERT(DATETIME2(3),JSON_VALUE(raw_json,'$.createdAt'),127),@now),
      COALESCE(NULLIF(JSON_VALUE(raw_json,'$.updatedBy'),N''),NULLIF(JSON_VALUE(raw_json,'$.createdBy'),N''),N'migration')
    FROM role_source AS source_role
    WHERE row_number=1 AND NOT EXISTS (SELECT 1 FROM security.roles AS target_role WHERE target_role.role_id=source_role.role_id);

    ;WITH role_permissions AS
    (
      SELECT DISTINCT
        CASE s.source_id
          WHEN N'admin' THEN N'super_admin'
          WHEN N'formatos_impresion.admin' THEN N'print_formats_admin'
          WHEN N'client_manager' THEN N'client_operations_manager'
          WHEN N'viewer' THEN N'audit_viewer'
          WHEN N'public_downloads.admin' THEN N'public_downloads_manager'
          ELSE s.source_id END AS role_id,
        permissions.permission_key
      FROM migration.stage_roles AS s
      CROSS APPLY OPENJSON(COALESCE(s.permissions_json,N'[]'))
        WITH (permission_key NVARCHAR(160) '$') AS permissions
      WHERE s.run_key=@run_key
    )
    INSERT security.role_permissions(role_id, permission_key, granted_at, granted_by)
    SELECT source_permission.role_id, source_permission.permission_key, @now, N'migration'
    FROM role_permissions AS source_permission
    JOIN security.roles AS target_role ON target_role.role_id=source_permission.role_id
    JOIN security.permissions AS target_permission ON target_permission.permission_key=source_permission.permission_key
    WHERE NOT EXISTS
    (
      SELECT 1 FROM security.role_permissions AS existing
      WHERE existing.role_id=source_permission.role_id AND existing.permission_key=source_permission.permission_key
    );

    INSERT security.users
      (source_id, display_name, email, email_normalized, active, password_hash,
       password_updated_at, password_expires_at, must_change_password, token_version,
       last_login_at, password_reset_token_hash, password_reset_expires_at,
       password_reset_used_at, created_at, created_by, updated_at, updated_by)
    SELECT s.source_id, LTRIM(RTRIM(s.display_name)), LTRIM(RTRIM(s.email)), LOWER(LTRIM(RTRIM(s.email))),
      COALESCE(s.active,1), JSON_VALUE(r.raw_json,'$.passwordHash'),
      TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.passwordUpdatedAt'),127),
      TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.passwordExpiresAt'),127),
      CASE JSON_VALUE(r.raw_json,'$.mustChangePassword') WHEN 'true' THEN 1 ELSE 0 END,
      COALESCE(TRY_CONVERT(INT,JSON_VALUE(r.raw_json,'$.tokenVersion')),0) + 1,
      TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.lastLoginAt'),127),
      JSON_VALUE(r.raw_json,'$.passwordResetTokenHash'),
      TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.passwordResetExpiresAt'),127),
      TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.passwordResetUsedAt'),127),
      COALESCE(s.created_at,@now),
      COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration'),
      CASE WHEN COALESCE(s.updated_at,s.created_at,@now) < COALESCE(s.created_at,@now)
        THEN COALESCE(s.created_at,@now) ELSE COALESCE(s.updated_at,s.created_at,@now) END,
      COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.updatedBy'),N''),NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration')
    FROM migration.stage_users AS s
    JOIN migration.raw_documents AS r
      ON r.run_key=s.run_key AND r.source_container=N'users' AND r.source_id=s.source_id
    WHERE s.run_key=@run_key;

    ;WITH user_role_source AS
    (
      SELECT DISTINCT s.source_id AS user_source_id,
        CASE role_values.role_id
          WHEN N'admin' THEN N'super_admin'
          WHEN N'formatos_impresion.admin' THEN N'print_formats_admin'
          WHEN N'client_manager' THEN N'client_operations_manager'
          WHEN N'viewer' THEN N'audit_viewer'
          WHEN N'public_downloads.admin' THEN N'public_downloads_manager'
          ELSE role_values.role_id END AS role_id
      FROM migration.stage_users AS s
      CROSS APPLY OPENJSON(COALESCE(s.roles_json,N'[]')) WITH (role_id NVARCHAR(80) '$') AS role_values
      WHERE s.run_key=@run_key
    )
    INSERT security.user_roles(user_key, role_id, assigned_at, assigned_by)
    SELECT target_user.user_key, target_role.role_id, @now, N'migration'
    FROM user_role_source AS source_role
    JOIN security.users AS target_user ON target_user.source_id=source_role.user_source_id
    JOIN security.roles AS target_role ON target_role.role_id=source_role.role_id;

    INSERT core.clients
      (source_id, external_id, name, name_normalized, status, notes, created_at, created_by,
       updated_at, updated_by, deleted_at, deleted_by)
    SELECT s.source_id, NULLIF(LTRIM(RTRIM(s.external_id)),N''), LTRIM(RTRIM(s.name)), LOWER(LTRIM(RTRIM(s.name))),
      CASE WHEN s.status IN ('active','inactive','deleted') THEN s.status ELSE 'active' END,
      NULLIF(LTRIM(RTRIM(JSON_VALUE(r.raw_json,'$.notes'))),N''), COALESCE(s.created_at,@now),
      COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration'),
      CASE WHEN COALESCE(s.updated_at,s.created_at,@now) < COALESCE(s.created_at,@now)
        THEN COALESCE(s.created_at,@now) ELSE COALESCE(s.updated_at,s.created_at,@now) END,
      COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.updatedBy'),N''),NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration'),
      CASE WHEN s.status='deleted' THEN COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.deletedAt'),127),s.updated_at,s.created_at,@now)
        ELSE TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.deletedAt'),127) END,
      JSON_VALUE(r.raw_json,'$.deletedBy')
    FROM migration.stage_clients AS s
    JOIN migration.raw_documents AS r
      ON r.run_key=s.run_key AND r.source_container=N'clients' AND r.source_id=s.source_id
    WHERE s.run_key=@run_key;

    INSERT core.domains
      (source_id, client_key, client_name_snapshot, domain_name, domain_name_normalized,
       publishable_domain, environment_id, current_web_version, status, notes,
       last_updated_at, last_updated_by, created_at, created_by, updated_at, updated_by,
       deleted_at, deleted_by)
    SELECT s.source_id, client.client_key, COALESCE(JSON_VALUE(r.raw_json,'$.clientName'),client.name),
      LTRIM(RTRIM(s.domain_name)),
      LOWER(LEFT(LTRIM(RTRIM(s.domain_name)),LEN(LTRIM(RTRIM(s.domain_name)))-PATINDEX(N'%[^/]%',REVERSE(LTRIM(RTRIM(s.domain_name))))+1)),
      LTRIM(RTRIM(s.domain_name)),
      LOWER(s.environment_id), NULLIF(LTRIM(RTRIM(JSON_VALUE(r.raw_json,'$.currentWebVersion'))),N''),
      CASE WHEN s.status IN ('active','inactive','deleted') THEN s.status ELSE 'active' END,
      NULLIF(LTRIM(RTRIM(JSON_VALUE(r.raw_json,'$.notes'))),N''),
      TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.lastUpdatedAt'),127), JSON_VALUE(r.raw_json,'$.lastUpdatedBy'),
      COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now),
      COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration'),
      CASE WHEN COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.updatedAt'),127),
                         TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now)
                     < COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now)
        THEN COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now)
        ELSE COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.updatedAt'),127),
                      TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now) END,
      COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.updatedBy'),N''),NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration'),
      CASE WHEN s.status='deleted' THEN COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.deletedAt'),127),
            TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.updatedAt'),127),@now)
        ELSE TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.deletedAt'),127) END,
      JSON_VALUE(r.raw_json,'$.deletedBy')
    FROM migration.stage_domains AS s
    JOIN core.clients AS client ON client.source_id=s.client_source_id
    JOIN migration.raw_documents AS r
      ON r.run_key=s.run_key AND r.source_container=N'domains' AND r.source_id=s.source_id
    WHERE s.run_key=@run_key;

    INSERT core.domain_assignees(domain_key,user_key,assigned_at,assigned_by)
    SELECT DISTINCT domain_record.domain_key,user_record.user_key,@now,N'migration'
    FROM migration.stage_domains AS s
    CROSS APPLY OPENJSON(COALESCE(s.assigned_user_ids_json,N'[]')) WITH (user_source_id NVARCHAR(150) '$') AS assignee
    JOIN core.domains AS domain_record ON domain_record.source_id=s.source_id
    JOIN security.users AS user_record ON user_record.source_id=assignee.user_source_id
    WHERE s.run_key=@run_key;

    ;WITH profile_source AS
    (
      SELECT s.source_id, LTRIM(RTRIM(s.server_host_port)) AS server_host_port,
        LTRIM(RTRIM(s.initial_catalog)) AS initial_catalog, LTRIM(RTRIM(s.sql_user_id)) AS sql_user_id,
        LTRIM(RTRIM(s.password_secret_name)) AS password_secret_name,
        HASHBYTES('SHA2_256',CONVERT(VARBINARY(MAX),
          LOWER(LTRIM(RTRIM(s.server_host_port)))+NCHAR(0)+LOWER(LTRIM(RTRIM(s.initial_catalog)))+NCHAR(0)+LOWER(LTRIM(RTRIM(s.sql_user_id))))) AS fingerprint,
        CASE WHEN s.status='deleted' THEN CONVERT(BIT,0) ELSE CONVERT(BIT,1) END AS active,
        r.raw_json
      FROM migration.stage_databases AS s
      JOIN migration.raw_documents AS r
        ON r.run_key=s.run_key AND r.source_container=N'databases' AND r.source_id=s.source_id
      WHERE s.run_key=@run_key
    )
    INSERT core.database_access_profiles
      (source_id,server_host_port,initial_catalog,sql_user_id,password_secret_name,connection_fingerprint,active,
       created_at,created_by,updated_at,updated_by)
    SELECT source_id,server_host_port,initial_catalog,sql_user_id,password_secret_name,fingerprint,active,
      COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(raw_json,'$.createdAt'),127),@now),
      COALESCE(NULLIF(JSON_VALUE(raw_json,'$.createdBy'),N''),N'migration'),
      COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(raw_json,'$.updatedAt'),127),
               TRY_CONVERT(DATETIME2(3),JSON_VALUE(raw_json,'$.createdAt'),127),@now),
      COALESCE(NULLIF(JSON_VALUE(raw_json,'$.updatedBy'),N''),NULLIF(JSON_VALUE(raw_json,'$.createdBy'),N''),N'migration')
    FROM profile_source;

    INSERT core.databases
      (source_id,client_key,client_name_snapshot,domain_key,domain_name_snapshot,access_profile_key,
       company_name,company_name_normalized,environment_id,current_db_version,status,notes,
       last_updated_at,last_updated_by,created_at,created_by,updated_at,updated_by,deleted_at,deleted_by)
    SELECT s.source_id,client.client_key,COALESCE(JSON_VALUE(r.raw_json,'$.clientName'),client.name),
      domain_record.domain_key,COALESCE(JSON_VALUE(r.raw_json,'$.domainName'),domain_record.domain_name),profile.access_profile_key,
      LTRIM(RTRIM(s.company_name)),LOWER(LTRIM(RTRIM(s.company_name))),LOWER(s.environment_id),
      NULLIF(LTRIM(RTRIM(JSON_VALUE(r.raw_json,'$.currentDbVersion'))),N''),
      CASE WHEN s.status IN ('active','inactive','deleted') THEN s.status ELSE 'active' END,
      NULLIF(LTRIM(RTRIM(JSON_VALUE(r.raw_json,'$.notes'))),N''),
      TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.lastUpdatedAt'),127),JSON_VALUE(r.raw_json,'$.lastUpdatedBy'),
      COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now),
      COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration'),
      COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.updatedAt'),127),
               TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now),
      COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.updatedBy'),N''),NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration'),
      CASE WHEN s.status='deleted' THEN COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.deletedAt'),127),
            TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.updatedAt'),127),@now)
        ELSE TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.deletedAt'),127) END,
      JSON_VALUE(r.raw_json,'$.deletedBy')
    FROM migration.stage_databases AS s
    JOIN core.clients AS client ON client.source_id=s.client_source_id
    JOIN core.domains AS domain_record ON domain_record.source_id=s.domain_source_id AND domain_record.client_key=client.client_key
    JOIN migration.raw_documents AS r
      ON r.run_key=s.run_key AND r.source_container=N'databases' AND r.source_id=s.source_id
    JOIN core.database_access_profiles AS profile ON profile.source_id=s.source_id
    WHERE s.run_key=@run_key;

    INSERT core.database_assignees(database_key,user_key,assigned_at,assigned_by)
    SELECT DISTINCT database_record.database_key,user_record.user_key,@now,N'migration'
    FROM migration.stage_databases AS s
    CROSS APPLY OPENJSON(COALESCE(s.assigned_user_ids_json,N'[]')) WITH (user_source_id NVARCHAR(150) '$') AS assignee
    JOIN core.databases AS database_record ON database_record.source_id=s.source_id
    JOIN security.users AS user_record ON user_record.source_id=assignee.user_source_id
    WHERE s.run_key=@run_key;

    INSERT licensing.license_modules
      (source_id,name,name_normalized,code,code_normalized,description,status,active_legacy,notes,
       created_at,created_by,updated_at,updated_by,deleted_at,deleted_by)
    SELECT s.source_id,LTRIM(RTRIM(s.name)),LOWER(LTRIM(RTRIM(s.name))),
      NULLIF(UPPER(LTRIM(RTRIM(s.code))),N''),NULLIF(UPPER(LTRIM(RTRIM(s.code))),N''),
      NULLIF(LTRIM(RTRIM(JSON_VALUE(r.raw_json,'$.description'))),N''),
      CASE WHEN s.status IN ('active','inactive','deleted') THEN s.status WHEN s.active=0 THEN 'inactive' ELSE 'active' END,
      s.active,NULLIF(LTRIM(RTRIM(JSON_VALUE(r.raw_json,'$.notes'))),N''),
      COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now),
      COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration'),
      COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.updatedAt'),127),
               TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now),
      COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.updatedBy'),N''),NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration'),
      CASE WHEN s.status='deleted' THEN COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.deletedAt'),127),
            TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.updatedAt'),127),@now)
        ELSE TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.deletedAt'),127) END,
      JSON_VALUE(r.raw_json,'$.deletedBy')
    FROM migration.stage_license_modules AS s
    JOIN migration.raw_documents AS r
      ON r.run_key=s.run_key AND r.source_container=N'licenseModules' AND r.source_id=s.source_id
    WHERE s.run_key=@run_key;

    INSERT licensing.license_assignments
      (source_id,module_key,module_name_snapshot,module_code_snapshot,target_type,
       client_key,domain_key,database_key,environment_id,status,active_legacy,
       created_at,created_by,updated_at,updated_by,deleted_at,deleted_by)
    SELECT s.source_id,module_record.module_key,
      COALESCE(JSON_VALUE(r.raw_json,'$.moduleName'),module_record.name),
      COALESCE(JSON_VALUE(r.raw_json,'$.moduleCode'),module_record.code),
      s.target_type,
      CASE WHEN s.target_type='client' THEN client.client_key END,
      CASE WHEN s.target_type='domain' THEN domain_record.domain_key END,
      CASE WHEN s.target_type='database' THEN database_record.database_key END,
      s.environment_id,
      CASE WHEN s.status IN ('active','inactive','deleted') THEN s.status
           WHEN JSON_VALUE(r.raw_json,'$.active')='false' THEN 'inactive' ELSE 'active' END,
      CASE JSON_VALUE(r.raw_json,'$.active') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END,
      COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now),
      COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration'),
      COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.updatedAt'),127),
               TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.createdAt'),127),@now),
      COALESCE(NULLIF(JSON_VALUE(r.raw_json,'$.updatedBy'),N''),NULLIF(JSON_VALUE(r.raw_json,'$.createdBy'),N''),N'migration'),
      CASE WHEN s.status='deleted' THEN COALESCE(TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.deletedAt'),127),@now)
        ELSE TRY_CONVERT(DATETIME2(3),JSON_VALUE(r.raw_json,'$.deletedAt'),127) END,
      JSON_VALUE(r.raw_json,'$.deletedBy')
    FROM migration.stage_license_assignments AS s
    JOIN licensing.license_modules AS module_record ON module_record.source_id=s.module_source_id
    LEFT JOIN core.clients AS client ON client.source_id=COALESCE(s.client_source_id,s.target_source_id)
    LEFT JOIN core.domains AS domain_record ON domain_record.source_id=COALESCE(s.domain_source_id,s.target_source_id)
    LEFT JOIN core.databases AS database_record ON database_record.source_id=COALESCE(s.database_source_id,s.target_source_id)
    JOIN migration.raw_documents AS r
      ON r.run_key=s.run_key AND r.source_container=N'licenseAssignments' AND r.source_id=s.source_id
    WHERE s.run_key=@run_key;

    ;WITH embedded_client_licenses AS
    (
      SELECT DISTINCT client.client_key,client.source_id AS client_source_id,module_record.module_key,
        module_record.source_id AS module_source_id,module_record.name,module_record.code,
        source_client.created_at,source_client.updated_at,raw_client.raw_json
      FROM migration.stage_clients AS source_client
      CROSS APPLY OPENJSON(COALESCE(source_client.license_module_ids_json,N'[]'))
        WITH (module_source_id NVARCHAR(150) '$') AS embedded
      JOIN core.clients AS client ON client.source_id=source_client.source_id
      JOIN licensing.license_modules AS module_record ON module_record.source_id=embedded.module_source_id
      JOIN migration.raw_documents AS raw_client
        ON raw_client.run_key=source_client.run_key AND raw_client.source_container=N'clients' AND raw_client.source_id=source_client.source_id
      WHERE source_client.run_key=@run_key
    )
    INSERT licensing.license_assignments
      (source_id,module_key,module_name_snapshot,module_code_snapshot,target_type,client_key,
       environment_id,status,active_legacy,created_at,created_by,updated_at,updated_by)
    SELECT N'embedded-client-license:'+CONVERT(VARCHAR(64),HASHBYTES('SHA2_256',CONVERT(VARBINARY(MAX),
        source_license.client_source_id+NCHAR(0)+source_license.module_source_id)),2),
      source_license.module_key,source_license.name,source_license.code,'client',source_license.client_key,
      NULL,'active',1,COALESCE(source_license.created_at,@now),
      COALESCE(NULLIF(JSON_VALUE(source_license.raw_json,'$.createdBy'),N''),N'migration'),
      COALESCE(source_license.updated_at,source_license.created_at,@now),
      COALESCE(NULLIF(JSON_VALUE(source_license.raw_json,'$.updatedBy'),N''),
               NULLIF(JSON_VALUE(source_license.raw_json,'$.createdBy'),N''),N'migration')
    FROM embedded_client_licenses AS source_license
    WHERE NOT EXISTS
    (
      SELECT 1 FROM licensing.license_assignments AS existing
      WHERE existing.module_key=source_license.module_key AND existing.client_key=source_license.client_key
        AND existing.target_type='client' AND existing.environment_id IS NULL AND existing.status<>'deleted'
    );

    UPDATE migration.raw_documents
    SET processing_status='loaded', processing_error_code=NULL
    WHERE run_key=@run_key
      AND source_container IN (N'users',N'roles',N'clients',N'domains',N'databases',N'licenseModules',N'licenseAssignments');

    SELECT @target_count=
      (SELECT COUNT_BIG(*) FROM security.users)+
      (SELECT COUNT_BIG(*) FROM core.clients)+
      (SELECT COUNT_BIG(*) FROM core.domains)+
      (SELECT COUNT_BIG(*) FROM core.databases)+
      (SELECT COUNT_BIG(*) FROM licensing.license_modules)+
      (SELECT COUNT_BIG(*) FROM licensing.license_assignments);

    DELETE FROM migration.reconciliation_counts
    WHERE run_key=@run_key AND reconciliation_code LIKE N'operational_core:%';

    INSERT migration.reconciliation_counts(run_key,reconciliation_code,source_count,target_count)
    SELECT @run_key,N'operational_core:users',COUNT_BIG(*),(SELECT COUNT_BIG(*) FROM security.users)
      FROM migration.stage_users WHERE run_key=@run_key
    UNION ALL SELECT @run_key,N'operational_core:clients',COUNT_BIG(*),(SELECT COUNT_BIG(*) FROM core.clients)
      FROM migration.stage_clients WHERE run_key=@run_key
    UNION ALL SELECT @run_key,N'operational_core:domains',COUNT_BIG(*),(SELECT COUNT_BIG(*) FROM core.domains)
      FROM migration.stage_domains WHERE run_key=@run_key
    UNION ALL SELECT @run_key,N'operational_core:databases',COUNT_BIG(*),(SELECT COUNT_BIG(*) FROM core.databases)
      FROM migration.stage_databases WHERE run_key=@run_key
    UNION ALL SELECT @run_key,N'operational_core:license_modules',COUNT_BIG(*),(SELECT COUNT_BIG(*) FROM licensing.license_modules)
      FROM migration.stage_license_modules WHERE run_key=@run_key;

    IF EXISTS
    (
      SELECT 1 FROM migration.reconciliation_counts
      WHERE run_key=@run_key AND reconciliation_code LIKE N'operational_core:%' AND reconciled=0
    )
      THROW 51131, N'Operational core reconciliation failed.', 1;

    UPDATE migration.migration_runs SET status='loading',completed_at=NULL WHERE run_key=@run_key;
    UPDATE migration.operational_load_phases
    SET status='completed',completed_at=SYSUTCDATETIME(),target_count=@target_count,
        details=N'Roles/users/core/licensing loaded. Legacy sessions and rate limits intentionally excluded.'
    WHERE run_key=@run_key AND phase_code=@phase_code;

    COMMIT TRANSACTION;
  END TRY
  BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    UPDATE migration.operational_load_phases
    SET status='failed',completed_at=SYSUTCDATETIME(),details=LEFT(ERROR_MESSAGE(),2000)
    WHERE run_key=@run_key AND phase_code=@phase_code;
    THROW;
  END CATCH;

  SELECT run_key,phase_code,status,source_count,target_count,completed_at
  FROM migration.operational_load_phases
  WHERE run_key=@run_key AND phase_code=@phase_code;
END;
GO

PRINT N'009 complete: operational control, file ledger and security/core/licensing loader created.';
GO
