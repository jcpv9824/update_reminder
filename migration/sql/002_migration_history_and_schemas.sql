/*
  Portal SAG Web - Gate C / 002
  Schemas and migration-control backbone for SQL Server 2019.

  STATUS: LOCAL BUILD SCRIPT. TEST IN A DISPOSABLE DATABASE FIRST.
  This script does not contain credentials and does not grant db_owner.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() <> N'PortalSAGWeb'
  THROW 51020, N'Execute this script only in a database named PortalSAGWeb.', 1;
GO

IF CAST(SERVERPROPERTY('ProductMajorVersion') AS INT) <> 15
  THROW 51021, N'This DDL is certified for SQL Server 2019 (major version 15).', 1;
GO

IF (SELECT compatibility_level FROM sys.databases WHERE database_id = DB_ID()) <> 150
  THROW 51022, N'PortalSAGWeb must use compatibility level 150.', 1;
GO

DECLARE @schemas TABLE (schema_name SYSNAME NOT NULL PRIMARY KEY);
INSERT @schemas(schema_name)
VALUES
  (N'security'), (N'core'), (N'licensing'), (N'scheduling'),
  (N'workflow'), (N'settings'), (N'content'), (N'notifications'),
  (N'audit'), (N'implementation'), (N'migration');

DECLARE @schema SYSNAME;
DECLARE @create_schema_sql NVARCHAR(400);
DECLARE schema_cursor CURSOR LOCAL FAST_FORWARD FOR
  SELECT schema_name FROM @schemas ORDER BY schema_name;

OPEN schema_cursor;
FETCH NEXT FROM schema_cursor INTO @schema;
WHILE @@FETCH_STATUS = 0
BEGIN
  IF SCHEMA_ID(@schema) IS NULL
  BEGIN
    SET @create_schema_sql = N'CREATE SCHEMA ' + QUOTENAME(@schema) + N' AUTHORIZATION dbo;';
    EXEC sys.sp_executesql @create_schema_sql;
  END;
  FETCH NEXT FROM schema_cursor INTO @schema;
END
CLOSE schema_cursor;
DEALLOCATE schema_cursor;
GO

IF OBJECT_ID(N'migration.schema_migrations', N'U') IS NULL
BEGIN
  CREATE TABLE migration.schema_migrations
  (
    migration_version          VARCHAR(40) NOT NULL,
    script_name                NVARCHAR(260) NOT NULL,
    script_sha256              BINARY(32) NOT NULL,
    applied_at                 DATETIME2(3) NOT NULL CONSTRAINT DF_schema_migrations_applied_at DEFAULT SYSUTCDATETIME(),
    applied_by                 NVARCHAR(150) NOT NULL CONSTRAINT DF_schema_migrations_applied_by DEFAULT ORIGINAL_LOGIN(),
    duration_ms                BIGINT NULL,
    succeeded                  BIT NOT NULL,
    error_number               INT NULL,
    error_message              NVARCHAR(2000) NULL,
    CONSTRAINT PK_schema_migrations PRIMARY KEY CLUSTERED (migration_version),
    CONSTRAINT UQ_schema_migrations_script UNIQUE (script_name),
    CONSTRAINT CK_schema_migrations_duration CHECK (duration_ms IS NULL OR duration_ms >= 0)
  );
END;
GO

IF OBJECT_ID(N'migration.migration_runs', N'U') IS NULL
BEGIN
  CREATE TABLE migration.migration_runs
  (
    run_key                    BIGINT IDENTITY(1,1) NOT NULL,
    public_id                  UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_migration_runs_public_id DEFAULT NEWSEQUENTIALID(),
    snapshot_name              NVARCHAR(260) NOT NULL,
    snapshot_sha256            BINARY(32) NULL,
    source_environment         NVARCHAR(80) NOT NULL,
    application_version        NVARCHAR(80) NULL,
    schema_version             VARCHAR(40) NOT NULL,
    status                     VARCHAR(30) NOT NULL,
    started_at                 DATETIME2(3) NOT NULL CONSTRAINT DF_migration_runs_started_at DEFAULT SYSUTCDATETIME(),
    completed_at               DATETIME2(3) NULL,
    source_document_count      BIGINT NULL,
    staged_document_count      BIGINT NULL,
    loaded_record_count        BIGINT NULL,
    critical_error_count       INT NOT NULL CONSTRAINT DF_migration_runs_critical DEFAULT (0),
    warning_count              INT NOT NULL CONSTRAINT DF_migration_runs_warning DEFAULT (0),
    initiated_by               NVARCHAR(150) NOT NULL,
    notes                      NVARCHAR(2000) NULL,
    row_version                ROWVERSION NOT NULL,
    CONSTRAINT PK_migration_runs PRIMARY KEY CLUSTERED (run_key),
    CONSTRAINT UQ_migration_runs_public_id UNIQUE (public_id),
    CONSTRAINT CK_migration_runs_status CHECK (status IN ('created','staging','validating','loading','validated','completed','failed','aborted')),
    CONSTRAINT CK_migration_runs_counts CHECK (
      source_document_count IS NULL OR source_document_count >= 0
    ),
    CONSTRAINT CK_migration_runs_completed CHECK (completed_at IS NULL OR completed_at >= started_at)
  );
END;
GO

IF OBJECT_ID(N'migration.raw_documents', N'U') IS NULL
BEGIN
  CREATE TABLE migration.raw_documents
  (
    run_key                    BIGINT NOT NULL,
    source_container           NVARCHAR(100) NOT NULL,
    source_id                  NVARCHAR(150) NOT NULL,
    source_partition_key       NVARCHAR(300) NULL,
    raw_json                   NVARCHAR(MAX) NOT NULL,
    document_sha256            BINARY(32) NOT NULL,
    source_etag                NVARCHAR(150) NULL,
    source_ts                  BIGINT NULL,
    staged_at                  DATETIME2(3) NOT NULL CONSTRAINT DF_raw_documents_staged_at DEFAULT SYSUTCDATETIME(),
    processing_status          VARCHAR(20) NOT NULL CONSTRAINT DF_raw_documents_status DEFAULT ('staged'),
    processing_error_code      NVARCHAR(100) NULL,
    CONSTRAINT PK_raw_documents PRIMARY KEY CLUSTERED (run_key, source_container, source_id),
    CONSTRAINT FK_raw_documents_run FOREIGN KEY (run_key) REFERENCES migration.migration_runs(run_key),
    CONSTRAINT CK_raw_documents_json CHECK (ISJSON(raw_json) = 1),
    CONSTRAINT CK_raw_documents_status CHECK (processing_status IN ('staged','validated','loaded','rejected'))
  );
END;
GO

IF OBJECT_ID(N'migration.validation_results', N'U') IS NULL
BEGIN
  CREATE TABLE migration.validation_results
  (
    validation_result_key      BIGINT IDENTITY(1,1) NOT NULL,
    run_key                    BIGINT NOT NULL,
    rule_code                  NVARCHAR(160) NOT NULL,
    severity                   VARCHAR(10) NOT NULL,
    source_container           NVARCHAR(100) NULL,
    source_id_hash             BINARY(32) NULL,
    expected_summary           NVARCHAR(1000) NULL,
    actual_summary             NVARCHAR(1000) NULL,
    resolution_status          VARCHAR(20) NOT NULL CONSTRAINT DF_validation_results_resolution DEFAULT ('open'),
    resolution_note            NVARCHAR(2000) NULL,
    approved_by                NVARCHAR(150) NULL,
    approved_at                DATETIME2(3) NULL,
    created_at                 DATETIME2(3) NOT NULL CONSTRAINT DF_validation_results_created_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_validation_results PRIMARY KEY CLUSTERED (validation_result_key),
    CONSTRAINT FK_validation_results_run FOREIGN KEY (run_key) REFERENCES migration.migration_runs(run_key),
    CONSTRAINT CK_validation_results_severity CHECK (severity IN ('info','warning','critical')),
    CONSTRAINT CK_validation_results_resolution CHECK (resolution_status IN ('open','accepted','resolved','rejected'))
  );
END;
GO

IF OBJECT_ID(N'migration.reconciliation_counts', N'U') IS NULL
BEGIN
  CREATE TABLE migration.reconciliation_counts
  (
    run_key                    BIGINT NOT NULL,
    reconciliation_code       NVARCHAR(160) NOT NULL,
    source_count               BIGINT NOT NULL,
    target_count               BIGINT NOT NULL,
    source_hash                BINARY(32) NULL,
    target_hash                BINARY(32) NULL,
    reconciled                 AS CONVERT(BIT, CASE WHEN source_count = target_count AND (source_hash = target_hash OR source_hash IS NULL AND target_hash IS NULL) THEN 1 ELSE 0 END) PERSISTED,
    checked_at                 DATETIME2(3) NOT NULL CONSTRAINT DF_reconciliation_counts_checked DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_reconciliation_counts PRIMARY KEY CLUSTERED (run_key, reconciliation_code),
    CONSTRAINT FK_reconciliation_counts_run FOREIGN KEY (run_key) REFERENCES migration.migration_runs(run_key),
    CONSTRAINT CK_reconciliation_counts_nonnegative CHECK (source_count >= 0 AND target_count >= 0)
  );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'migration.validation_results') AND name = N'IX_validation_results_run_severity')
  CREATE INDEX IX_validation_results_run_severity
    ON migration.validation_results(run_key, severity, resolution_status, validation_result_key);
GO

PRINT N'002 complete: schemas and migration-control tables are present.';
GO
