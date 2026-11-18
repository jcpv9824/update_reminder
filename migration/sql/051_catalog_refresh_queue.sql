/* Durable, version-pinned Catalog refresh requests. No changes to source bindings or profiles. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns051Transaction bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns051Transaction=1 BEGIN TRANSACTION;
  IF DB_NAME() NOT IN(N'PortalSAGWeb',N'PortalSAGWeb-TEST')
    OR CAST(SERVERPROPERTY('ProductMajorVersion') AS int)<>15
    OR (SELECT compatibility_level FROM sys.databases WHERE database_id=DB_ID())<>150
    THROW 55101,N'This migration requires the Portal SQL Server 2019 compatibility 150 target.',1;
  DECLARE @lock051 int;
  EXEC @lock051=sys.sp_getapplock @Resource=N'portal-sag:migration:051:refresh-queue',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock051<0 THROW 55100,N'Could not reserve the catalog refresh queue migration.',1;
  IF OBJECT_ID(N'settings.catalog_source_bindings',N'U') IS NULL
    OR OBJECT_ID(N'settings.catalog_match_key_registry',N'U') IS NULL
    OR OBJECT_ID(N'settings.catalog_source_head_events',N'U') IS NULL
    OR DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NULL
    THROW 55101,N'Install the prerequisite catalog migrations and runtime role first.',1;

  IF OBJECT_ID(N'settings.catalog_source_refresh_jobs',N'U') IS NULL
    CREATE TABLE settings.catalog_source_refresh_jobs (
      job_key bigint IDENTITY(1,1) NOT NULL,
      job_id uniqueidentifier NOT NULL CONSTRAINT DF_catalog_refresh_job_id DEFAULT NEWID(),
      catalog_source_key bigint NOT NULL,
      portal_environment varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
      binding_version binary(8) NOT NULL,
      profile_version binary(8) NOT NULL,
      match_key_version smallint NOT NULL,
      provenance varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
      requested_by nvarchar(150) NULL,
      job_status varchar(12) COLLATE Latin1_General_100_BIN2 NOT NULL,
      attempt_no tinyint NOT NULL CONSTRAINT DF_catalog_refresh_job_attempt DEFAULT 0,
      attempt_ordinal bigint NULL,
      requested_at datetime2(3) NOT NULL,
      updated_at datetime2(3) NOT NULL,
      available_at datetime2(3) NOT NULL,
      finished_at datetime2(3) NULL,
      worker_id uniqueidentifier NULL,
      lease_token uniqueidentifier NULL,
      lease_expires_at datetime2(3) NULL,
      CONSTRAINT PK_catalog_source_refresh_jobs PRIMARY KEY CLUSTERED(job_key),
      CONSTRAINT UQ_catalog_source_refresh_jobs_id UNIQUE(job_id),
      CONSTRAINT FK_catalog_source_refresh_jobs_source FOREIGN KEY(catalog_source_key)
        REFERENCES settings.catalog_source_bindings(catalog_source_key),
      CONSTRAINT CK_catalog_refresh_job_environment CHECK(
        (portal_environment='qa' AND DATALENGTH(portal_environment)=2)
        OR (portal_environment='production' AND DATALENGTH(portal_environment)=10)),
      CONSTRAINT CK_catalog_refresh_job_match_key CHECK(match_key_version>0),
      CONSTRAINT CK_catalog_refresh_job_provenance CHECK(
        (provenance='request' AND requested_by IS NOT NULL AND LEN(requested_by)>0)
        OR (provenance='timer' AND requested_by IS NULL)),
      CONSTRAINT CK_catalog_refresh_job_attempt CHECK(attempt_no BETWEEN 0 AND 5
        AND (attempt_ordinal IS NULL OR (attempt_ordinal>0 AND attempt_no>0))
        AND (job_status<>'queued' OR attempt_no=0)
        AND (job_status<>'retry' OR attempt_no BETWEEN 1 AND 4)
        AND (job_status<>'processing' OR attempt_no BETWEEN 1 AND 5)),
      CONSTRAINT CK_catalog_refresh_job_status CHECK(
        (job_status='processing' AND worker_id IS NOT NULL AND lease_token IS NOT NULL
          AND lease_expires_at IS NOT NULL AND finished_at IS NULL)
        OR (job_status IN ('queued','retry') AND worker_id IS NULL AND lease_token IS NULL
          AND lease_expires_at IS NULL AND finished_at IS NULL AND attempt_ordinal IS NULL)
        OR (job_status IN ('succeeded','failed','cancelled') AND worker_id IS NULL AND lease_token IS NULL
          AND lease_expires_at IS NULL AND finished_at IS NOT NULL AND attempt_ordinal IS NULL)),
      CONSTRAINT CK_catalog_refresh_job_dates CHECK(updated_at>=requested_at AND available_at>=requested_at
        AND (finished_at IS NULL OR finished_at=updated_at))
    );

  IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'settings.catalog_source_refresh_jobs')
    AND name=N'UX_catalog_source_refresh_jobs_open')
    CREATE UNIQUE INDEX UX_catalog_source_refresh_jobs_open
      ON settings.catalog_source_refresh_jobs(catalog_source_key) WHERE finished_at IS NULL;
  IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'settings.catalog_source_refresh_jobs')
    AND name=N'IX_catalog_source_refresh_jobs_claim')
    CREATE INDEX IX_catalog_source_refresh_jobs_claim ON settings.catalog_source_refresh_jobs
      (portal_environment, available_at, job_key) INCLUDE (catalog_source_key,job_status,attempt_no,lease_expires_at,finished_at)
      WHERE finished_at IS NULL;
  IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'settings.catalog_source_refresh_jobs')
    AND name=N'IX_catalog_source_refresh_jobs_latest')
    CREATE INDEX IX_catalog_source_refresh_jobs_latest ON settings.catalog_source_refresh_jobs(catalog_source_key,job_key DESC)
      INCLUDE (job_status,updated_at,finished_at,binding_version,profile_version,match_key_version);

  IF OBJECT_ID(N'settings.catalog_source_refresh_attempts',N'U') IS NULL
    CREATE TABLE settings.catalog_source_refresh_attempts (
      attempt_event_key bigint IDENTITY(1,1) NOT NULL,
      job_key bigint NOT NULL,
      attempt_no tinyint NOT NULL,
      event_kind varchar(12) COLLATE Latin1_General_100_BIN2 NOT NULL,
      attempt_ordinal bigint NULL,
      occurred_at datetime2(3) NOT NULL,
      CONSTRAINT PK_catalog_source_refresh_attempts PRIMARY KEY CLUSTERED(attempt_event_key),
      CONSTRAINT FK_catalog_source_refresh_attempts_job FOREIGN KEY(job_key)
        REFERENCES settings.catalog_source_refresh_jobs(job_key),
      CONSTRAINT UQ_catalog_source_refresh_attempts_event UNIQUE(job_key,attempt_no,event_kind),
      CONSTRAINT CK_catalog_refresh_event_kind CHECK(event_kind IN
        ('claimed','reserved','succeeded','superseded','retry','failed','stale','expired')),
      CONSTRAINT CK_catalog_refresh_event_attempt CHECK(attempt_no BETWEEN 0 AND 5
        AND (attempt_no>0 OR event_kind='stale') AND (attempt_ordinal IS NULL OR attempt_ordinal>0))
    );

  EXEC(N'CREATE OR ALTER TRIGGER settings.tr_catalog_source_refresh_attempts_immutable
    ON settings.catalog_source_refresh_attempts INSTEAD OF UPDATE,DELETE AS
    BEGIN SET NOCOUNT ON; THROW 55102,N''Catalog refresh attempt history is immutable.'',1; END;');
  GRANT SELECT, INSERT, UPDATE ON OBJECT::settings.catalog_source_refresh_jobs TO portal_runtime;
  GRANT SELECT, INSERT ON OBJECT::settings.catalog_source_refresh_attempts TO portal_runtime;
  DENY DELETE ON OBJECT::settings.catalog_source_refresh_jobs TO portal_runtime;
  DENY UPDATE, DELETE ON OBJECT::settings.catalog_source_refresh_attempts TO portal_runtime;

  IF @owns051Transaction=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns051Transaction=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
