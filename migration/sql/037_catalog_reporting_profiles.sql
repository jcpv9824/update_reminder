/*
  Maps a verified local physical SQL destination to a separately configured
  count-only external profile and schema contract. The verification service
  proves the instance namespace and reproduces the target fingerprint; raw
  database GUIDs, endpoint data, credentials and user rows are not stored here.
  This migration creates no assignments, grants or external objects.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'core.catalog_physical_targets', N'U') IS NULL
  OR COL_LENGTH(N'core.catalog_physical_targets', N'database_name_fingerprint') IS NULL
  OR OBJECT_ID(N'core.catalog_physical_target_links', N'U') IS NULL
  OR OBJECT_ID(N'settings.external_database_connections', N'U') IS NULL
  THROW 53700, N'Install the external connections and physical target registry before reporting profiles.', 1;

IF OBJECT_ID(N'settings.catalog_reporting_profiles', N'U') IS NULL
BEGIN
  CREATE TABLE settings.catalog_reporting_profiles
  (
    catalog_reporting_profile_key bigint IDENTITY(1,1) NOT NULL,
    reporting_profile_id uniqueidentifier NOT NULL CONSTRAINT DF_catalog_reporting_profiles_id DEFAULT NEWID(),
    physical_target_key bigint NOT NULL,
    portal_environment varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
    target_kind varchar(20) COLLATE Latin1_General_100_BIN2 NOT NULL
      CONSTRAINT DF_catalog_reporting_profiles_kind DEFAULT 'database',
    external_database_connection_key bigint NOT NULL,
    verified_profile_version binary(8) NOT NULL,
    trusted_instance_id uniqueidentifier NOT NULL,
    verified_identity_fingerprint binary(32) NOT NULL,
    count_contract varchar(32) COLLATE Latin1_General_100_BIN2 NOT NULL,
    active_column varchar(128) COLLATE Latin1_General_100_BIN2 NULL,
    active_storage varchar(4) COLLATE Latin1_General_100_BIN2 NULL,
    active_bit bit NULL,
    active_text nvarchar(32) COLLATE Latin1_General_100_BIN2 NULL,
    inactive_text nvarchar(32) COLLATE Latin1_General_100_BIN2 NULL,
    proof_id uniqueidentifier NOT NULL,
    verified_by nvarchar(150) COLLATE Latin1_General_100_BIN2 NOT NULL,
    verified_at datetime2(3) NOT NULL,
    valid_until datetime2(3) NOT NULL,
    retired_at datetime2(3) NULL,
    retired_by nvarchar(150) COLLATE Latin1_General_100_BIN2 NULL,
    row_version rowversion NOT NULL,

    CONSTRAINT PK_catalog_reporting_profiles PRIMARY KEY CLUSTERED(catalog_reporting_profile_key),
    CONSTRAINT UQ_catalog_reporting_profiles_id UNIQUE(reporting_profile_id),
    CONSTRAINT UQ_catalog_reporting_profiles_proof UNIQUE(proof_id),
    CONSTRAINT FK_catalog_reporting_profiles_target FOREIGN KEY(physical_target_key,portal_environment,target_kind)
      REFERENCES core.catalog_physical_targets(physical_target_key,portal_environment,target_kind),
    CONSTRAINT FK_catalog_reporting_profiles_external FOREIGN KEY(external_database_connection_key)
      REFERENCES settings.external_database_connections(external_database_connection_key),
    CONSTRAINT CK_catalog_reporting_profiles_target CHECK (target_kind='database' AND DATALENGTH(target_kind)=8
      AND portal_environment IN ('qa','production') AND DATALENGTH(portal_environment)=LEN(portal_environment)),
    CONSTRAINT CK_catalog_reporting_profiles_instance CHECK (trusted_instance_id<>'00000000-0000-0000-0000-000000000000'),
    CONSTRAINT CK_catalog_reporting_profiles_contract CHECK (DATALENGTH(count_contract)=LEN(count_contract) AND (
      (count_contract='approved_aggregate_view_v1' AND active_column IS NULL AND active_storage IS NULL
        AND active_bit IS NULL AND active_text IS NULL AND inactive_text IS NULL)
      OR (count_contract='certified_usuarios_v1' AND active_column IS NOT NULL
        AND DATALENGTH(active_column)=LEN(active_column) AND active_column LIKE '[A-Za-z_]%'
        AND active_column NOT LIKE '%[^A-Za-z0-9_]%' AND active_storage IS NOT NULL
        AND DATALENGTH(active_storage)=LEN(active_storage) AND (
          (active_storage='bit' AND active_bit IS NOT NULL AND active_text IS NULL AND inactive_text IS NULL)
          OR (active_storage='text' AND active_bit IS NULL AND active_text IS NOT NULL AND inactive_text IS NOT NULL
            AND LEN(LTRIM(RTRIM(active_text)))>0 AND LEN(LTRIM(RTRIM(inactive_text)))>0
            AND (active_text<>inactive_text OR DATALENGTH(active_text)<>DATALENGTH(inactive_text))))))),
    CONSTRAINT CK_catalog_reporting_profiles_time CHECK (valid_until>verified_at AND LEN(LTRIM(RTRIM(verified_by)))>0
      AND ((retired_at IS NULL AND retired_by IS NULL)
        OR (retired_at IS NOT NULL AND retired_by IS NOT NULL AND LEN(LTRIM(RTRIM(retired_by)))>0
          AND retired_at>=verified_at)))
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'settings.catalog_reporting_profiles')
  AND name=N'UX_catalog_reporting_profiles_active_target')
  CREATE UNIQUE INDEX UX_catalog_reporting_profiles_active_target
    ON settings.catalog_reporting_profiles(portal_environment,physical_target_key)
    INCLUDE(reporting_profile_id,external_database_connection_key,verified_profile_version,valid_until,retired_at)
    WHERE retired_at IS NULL;

-- A connection profile designates one database and one environment. Reusing a
-- profile for an unrelated target or another environment requires a fresh one.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'settings.catalog_reporting_profiles')
  AND name=N'UX_catalog_reporting_profiles_active_connection')
  CREATE UNIQUE INDEX UX_catalog_reporting_profiles_active_connection
    ON settings.catalog_reporting_profiles(external_database_connection_key) WHERE retired_at IS NULL;

IF OBJECT_ID(N'settings.TR_catalog_reporting_profiles_evidence', N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER settings.TR_catalog_reporting_profiles_evidence
    ON settings.catalog_reporting_profiles AFTER INSERT, UPDATE, DELETE AS
    BEGIN
      SET NOCOUNT ON;
      DECLARE @now datetime2(3)=SYSUTCDATETIME();

      -- Keep the exact original proof and contract. Retirement is one-way;
      -- recertification is a fresh row and a new proof id.
      IF EXISTS (
        SELECT 1 FROM deleted AS o
        LEFT JOIN inserted AS n ON n.catalog_reporting_profile_key=o.catalog_reporting_profile_key
        WHERE n.catalog_reporting_profile_key IS NULL OR o.retired_at IS NOT NULL
          OR n.retired_at IS NULL OR n.retired_at>@now
          OR EXISTS (
            SELECT n.reporting_profile_id,n.physical_target_key,n.portal_environment,n.target_kind,
              n.external_database_connection_key,n.verified_profile_version,n.trusted_instance_id,n.verified_identity_fingerprint,
              n.count_contract,n.active_column,n.active_storage,n.active_bit,n.active_text,n.inactive_text,
              DATALENGTH(n.active_text),DATALENGTH(n.inactive_text),n.proof_id,n.verified_by,DATALENGTH(n.verified_by),
              n.verified_at,n.valid_until
            EXCEPT
            SELECT o.reporting_profile_id,o.physical_target_key,o.portal_environment,o.target_kind,
              o.external_database_connection_key,o.verified_profile_version,o.trusted_instance_id,o.verified_identity_fingerprint,
              o.count_contract,o.active_column,o.active_storage,o.active_bit,o.active_text,o.inactive_text,
              DATALENGTH(o.active_text),DATALENGTH(o.inactive_text),o.proof_id,o.verified_by,DATALENGTH(o.verified_by),
              o.verified_at,o.valid_until))
        THROW 53701, N''Reporting proof history is immutable except for a one-time retirement.'', 1;

      IF EXISTS (
        SELECT 1 FROM inserted AS n
        LEFT JOIN deleted AS o ON o.catalog_reporting_profile_key=n.catalog_reporting_profile_key
        JOIN core.catalog_physical_targets AS t WITH (HOLDLOCK)
          ON t.physical_target_key=n.physical_target_key AND t.portal_environment=n.portal_environment
          AND t.target_kind=n.target_kind
        JOIN settings.external_database_connections AS p WITH (UPDLOCK,HOLDLOCK)
          ON p.external_database_connection_key=n.external_database_connection_key
        WHERE o.catalog_reporting_profile_key IS NULL AND (
          n.retired_at IS NOT NULL OR n.verified_at>@now OR n.valid_until<=@now
          OR n.verified_identity_fingerprint<>t.identity_fingerprint OR t.database_name_fingerprint IS NULL
          OR t.database_name_fingerprint<>HASHBYTES(''SHA2_256'',CONVERT(varbinary(max),p.database_name))
          OR n.verified_profile_version<>p.row_version OR p.status<>''active'' OR p.active<>1
          OR p.encrypt_connection<>1 OR p.password_configured<>1
          OR NOT EXISTS (
            SELECT 1 FROM core.catalog_physical_target_links AS l WITH (HOLDLOCK)
            JOIN core.clients AS c WITH (HOLDLOCK) ON c.client_key=l.client_key
            JOIN core.domains AS d WITH (HOLDLOCK) ON d.domain_key=l.domain_key AND d.client_key=l.client_key
            JOIN core.databases AS db WITH (HOLDLOCK) ON db.database_key=l.database_key
              AND db.domain_key=l.domain_key AND db.client_key=l.client_key
            JOIN core.database_access_profiles AS operational WITH (HOLDLOCK)
              ON operational.access_profile_key=l.access_profile_key AND operational.access_profile_key=db.access_profile_key
            WHERE l.physical_target_key=t.physical_target_key AND l.portal_environment=t.portal_environment
              AND l.target_kind=''database'' AND l.retired_at IS NULL AND l.verified_at<=@now AND l.valid_until>@now
              AND c.status=''active'' AND d.status=''active'' AND db.status=''active''
              AND operational.active=1 AND operational.row_version=l.access_profile_version
              AND t.database_name_fingerprint=HASHBYTES(''SHA2_256'',CONVERT(varbinary(max),operational.initial_catalog))
          )))
        THROW 53702, N''The reporting proof does not match a current verified SQL target and profile.'', 1;
    END;';
