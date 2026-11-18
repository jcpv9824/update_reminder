/*
  Verified physical destinations and evidence-bound local catalog links.
  No assignments, origin writes, secrets, raw external identifiers or access
  changes are included. A protected identity fingerprint is supplied by the
  authorized verifier; equal names or URLs are not physical identity evidence.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'core.clients', N'U') IS NULL OR OBJECT_ID(N'core.domains', N'U') IS NULL
  OR OBJECT_ID(N'core.databases', N'U') IS NULL OR OBJECT_ID(N'core.database_access_profiles', N'U') IS NULL
  THROW 53600, N'Install the operational catalog before the physical target registry.', 1;

IF OBJECT_ID(N'core.catalog_physical_targets', N'U') IS NULL
BEGIN
  CREATE TABLE core.catalog_physical_targets
  (
    physical_target_key bigint IDENTITY(1,1) NOT NULL,
    target_id uniqueidentifier NOT NULL CONSTRAINT DF_catalog_physical_targets_id DEFAULT NEWID(),
    portal_environment varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
    target_kind varchar(20) COLLATE Latin1_General_100_BIN2 NOT NULL,
    identity_fingerprint binary(32) NOT NULL,
    database_name_fingerprint binary(32) NULL,
    created_at datetime2(3) NOT NULL CONSTRAINT DF_catalog_physical_targets_created DEFAULT SYSUTCDATETIME(),
    row_version rowversion NOT NULL,

    CONSTRAINT PK_catalog_physical_targets PRIMARY KEY CLUSTERED(physical_target_key),
    CONSTRAINT UQ_catalog_physical_targets_id UNIQUE(target_id),
    CONSTRAINT UQ_catalog_physical_targets_typed UNIQUE(physical_target_key,portal_environment,target_kind),
    CONSTRAINT UQ_catalog_physical_targets_identity UNIQUE(portal_environment,target_kind,identity_fingerprint),
    CONSTRAINT CK_catalog_physical_targets_environment CHECK (
      portal_environment IN ('qa','production') AND DATALENGTH(portal_environment)=LEN(portal_environment)),
    CONSTRAINT CK_catalog_physical_targets_kind CHECK (
      (target_kind='domain' AND DATALENGTH(target_kind)=6 AND database_name_fingerprint IS NULL)
      OR (target_kind='database' AND DATALENGTH(target_kind)=8 AND database_name_fingerprint IS NOT NULL))
  );
END;

IF OBJECT_ID(N'core.catalog_physical_target_links', N'U') IS NULL
BEGIN
  CREATE TABLE core.catalog_physical_target_links
  (
    physical_target_link_key bigint IDENTITY(1,1) NOT NULL,
    link_id uniqueidentifier NOT NULL CONSTRAINT DF_catalog_physical_target_links_id DEFAULT NEWID(),
    physical_target_key bigint NOT NULL,
    portal_environment varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
    target_kind varchar(20) COLLATE Latin1_General_100_BIN2 NOT NULL,
    client_key bigint NOT NULL,
    domain_key bigint NOT NULL,
    database_key bigint NULL,
    access_profile_key bigint NULL,
    access_profile_version binary(8) NULL,
    domain_route_fingerprint binary(32) NULL,
    proof_id uniqueidentifier NOT NULL,
    verified_by nvarchar(150) COLLATE Latin1_General_100_BIN2 NOT NULL,
    verified_at datetime2(3) NOT NULL,
    valid_until datetime2(3) NOT NULL,
    retired_at datetime2(3) NULL,
    row_version rowversion NOT NULL,

    CONSTRAINT PK_catalog_physical_target_links PRIMARY KEY CLUSTERED(physical_target_link_key),
    CONSTRAINT UQ_catalog_physical_target_links_id UNIQUE(link_id),
    CONSTRAINT UQ_catalog_physical_target_links_proof UNIQUE(proof_id),
    CONSTRAINT FK_catalog_physical_target_links_target FOREIGN KEY(physical_target_key,portal_environment,target_kind)
      REFERENCES core.catalog_physical_targets(physical_target_key,portal_environment,target_kind),
    CONSTRAINT FK_catalog_physical_target_links_domain FOREIGN KEY(domain_key,client_key)
      REFERENCES core.domains(domain_key,client_key),
    CONSTRAINT FK_catalog_physical_target_links_database FOREIGN KEY(database_key,domain_key,client_key)
      REFERENCES core.databases(database_key,domain_key,client_key),
    CONSTRAINT FK_catalog_physical_target_links_profile FOREIGN KEY(access_profile_key)
      REFERENCES core.database_access_profiles(access_profile_key),
    CONSTRAINT CK_catalog_physical_target_links_kind CHECK (
      (target_kind='domain' AND DATALENGTH(target_kind)=6 AND database_key IS NULL
        AND access_profile_key IS NULL AND access_profile_version IS NULL AND domain_route_fingerprint IS NOT NULL)
      OR (target_kind='database' AND DATALENGTH(target_kind)=8 AND database_key IS NOT NULL
        AND access_profile_key IS NOT NULL AND access_profile_version IS NOT NULL AND domain_route_fingerprint IS NULL)),
    CONSTRAINT CK_catalog_physical_target_links_environment CHECK (DATALENGTH(portal_environment)=LEN(portal_environment)),
    CONSTRAINT CK_catalog_physical_target_links_actor CHECK (LEN(LTRIM(RTRIM(verified_by)))>0),
    CONSTRAINT CK_catalog_physical_target_links_times CHECK (valid_until>verified_at
      AND (retired_at IS NULL OR retired_at>=verified_at))
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'core.catalog_physical_target_links')
  AND name=N'UX_catalog_physical_target_links_active_domain')
  CREATE UNIQUE INDEX UX_catalog_physical_target_links_active_domain
    ON core.catalog_physical_target_links(portal_environment,client_key,domain_key)
    WHERE retired_at IS NULL AND target_kind='domain';

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'core.catalog_physical_target_links')
  AND name=N'UX_catalog_physical_target_links_active_database')
  CREATE UNIQUE INDEX UX_catalog_physical_target_links_active_database
    ON core.catalog_physical_target_links(portal_environment,client_key,domain_key,database_key)
    WHERE retired_at IS NULL AND target_kind='database';

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'core.catalog_physical_target_links')
  AND name=N'IX_catalog_physical_target_links_active_target')
  CREATE INDEX IX_catalog_physical_target_links_active_target
    ON core.catalog_physical_target_links(physical_target_key,client_key,domain_key,database_key)
    INCLUDE(verified_at,valid_until,portal_environment,target_kind)
    WHERE retired_at IS NULL;

IF OBJECT_ID(N'core.TR_catalog_physical_targets_immutable', N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER core.TR_catalog_physical_targets_immutable
    ON core.catalog_physical_targets AFTER UPDATE, DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS (SELECT 1 FROM deleted)
        THROW 53601, N''A registered physical target identity is immutable.'', 1;
    END;';

IF OBJECT_ID(N'core.TR_catalog_physical_target_links_evidence', N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER core.TR_catalog_physical_target_links_evidence
    ON core.catalog_physical_target_links AFTER INSERT, UPDATE, DELETE AS
    BEGIN
      SET NOCOUNT ON;
      DECLARE @now datetime2(3)=SYSUTCDATETIME();

      -- Retire once, never replace evidence or delete its historical link.
      IF EXISTS (
        SELECT 1 FROM deleted AS o LEFT JOIN inserted AS n ON n.physical_target_link_key=o.physical_target_link_key
        WHERE n.physical_target_link_key IS NULL OR o.retired_at IS NOT NULL OR n.retired_at IS NULL OR n.retired_at>@now
          OR EXISTS (
            SELECT n.link_id,n.physical_target_key,n.portal_environment,n.target_kind,n.client_key,n.domain_key,
              n.database_key,n.access_profile_key,n.access_profile_version,n.domain_route_fingerprint,n.proof_id,
              n.verified_by,n.verified_at,n.valid_until
            EXCEPT
            SELECT o.link_id,o.physical_target_key,o.portal_environment,o.target_kind,o.client_key,o.domain_key,
              o.database_key,o.access_profile_key,o.access_profile_version,o.domain_route_fingerprint,o.proof_id,
              o.verified_by,o.verified_at,o.valid_until))
        THROW 53602, N''Physical target link evidence is immutable except for a one-time retirement.'', 1;

      -- At insertion require the current active logical hierarchy, and bind
      -- proof to endpoint evidence rather than ordinary version telemetry.
      IF EXISTS (
        SELECT 1 FROM inserted AS n
        LEFT JOIN deleted AS o ON o.physical_target_link_key=n.physical_target_link_key
        JOIN core.clients AS c WITH (UPDLOCK,HOLDLOCK) ON c.client_key=n.client_key
        JOIN core.domains AS d WITH (UPDLOCK,HOLDLOCK) ON d.domain_key=n.domain_key AND d.client_key=n.client_key
        JOIN core.catalog_physical_targets AS t WITH (HOLDLOCK) ON t.physical_target_key=n.physical_target_key
        LEFT JOIN core.databases AS db WITH (UPDLOCK,HOLDLOCK)
          ON db.database_key=n.database_key AND db.domain_key=n.domain_key AND db.client_key=n.client_key
        LEFT JOIN core.database_access_profiles AS p WITH (UPDLOCK,HOLDLOCK) ON p.access_profile_key=n.access_profile_key
        WHERE o.physical_target_link_key IS NULL AND (
          n.retired_at IS NOT NULL OR n.verified_at>@now OR n.valid_until<=@now
          OR c.status<>''active'' OR d.status<>''active''
          OR (n.target_kind=''domain'' AND n.domain_route_fingerprint<>
            HASHBYTES(''SHA2_256'',CONVERT(varbinary(max),N''portal-sag:web-route:v1|'')
              + CONVERT(binary(4),DATALENGTH(d.domain_name_normalized))
              + CONVERT(varbinary(max),d.domain_name_normalized)
              + CASE WHEN d.publishable_domain IS NULL THEN CONVERT(varbinary(max),0x00)
                ELSE CONVERT(varbinary(max),0x01) + CONVERT(binary(4),DATALENGTH(d.publishable_domain))
                  + CONVERT(varbinary(max),d.publishable_domain) END))
          OR (n.target_kind=''database'' AND (db.database_key IS NULL OR db.status<>''active''
            OR db.access_profile_key<>n.access_profile_key OR p.access_profile_key IS NULL
            OR p.active<>1 OR p.row_version<>n.access_profile_version
            OR t.database_name_fingerprint<>HASHBYTES(''SHA2_256'',CONVERT(varbinary(max),p.initial_catalog))))))
        THROW 53603, N''The physical target proof does not match the current catalog link.'', 1;
    END;';

-- A route edit permanently retires its authorization evidence. If an old
-- route is later restored, it must be verified again rather than revived.
IF OBJECT_ID(N'core.TR_domains_catalog_route_retirement', N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER core.TR_domains_catalog_route_retirement
    ON core.domains AFTER UPDATE AS
    BEGIN
      SET NOCOUNT ON;
      IF NOT (UPDATE(domain_name_normalized) OR UPDATE(publishable_domain)) RETURN;
      DECLARE @editedAt datetime2(3)=SYSUTCDATETIME();

      UPDATE link SET retired_at=@editedAt
      FROM core.catalog_physical_target_links AS link
      JOIN inserted AS n ON n.domain_key=link.domain_key
      JOIN deleted AS o ON o.domain_key=n.domain_key
      WHERE link.target_kind=''domain'' AND link.retired_at IS NULL
        AND (CONVERT(varbinary(max),n.domain_name_normalized)<>CONVERT(varbinary(max),o.domain_name_normalized)
          OR CONVERT(varbinary(max),n.publishable_domain)<>CONVERT(varbinary(max),o.publishable_domain)
          OR (n.publishable_domain IS NULL AND o.publishable_domain IS NOT NULL)
          OR (n.publishable_domain IS NOT NULL AND o.publishable_domain IS NULL));
    END;';
