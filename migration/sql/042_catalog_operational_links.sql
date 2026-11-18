/*
  Explicit correspondence between a catalog customer's opaque identity and an
  operational customer/target. No automatic enrollment, names, or secrets.
  A stable link is independent of each append-only approval and of the
  previously installed physical-target proof.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns042Transaction bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
IF @owns042Transaction=1 BEGIN TRANSACTION;

IF OBJECT_ID(N'core.catalog_customer_revision_rows',N'U') IS NULL
  OR OBJECT_ID(N'core.catalog_physical_target_links',N'U') IS NULL
  OR OBJECT_ID(N'settings.catalog_sag_license_module_approvals',N'U') IS NULL
  THROW 54200,N'Install the preceding catalog migrations before operational links.',1;

IF OBJECT_ID(N'core.catalog_operational_owners',N'U') IS NULL
BEGIN
  CREATE TABLE core.catalog_operational_owners (
    owner_key bigint IDENTITY(1,1) NOT NULL PRIMARY KEY,
    portal_environment varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
    catalog_customer_key bigint NOT NULL REFERENCES core.catalog_customer_ids(catalog_customer_key),
    client_key bigint NOT NULL REFERENCES core.clients(client_key),
    registered_by nvarchar(150) NOT NULL,
    registered_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
    retired_at datetime2(3) NULL,
    CONSTRAINT UQ_catalog_operational_owners_scope UNIQUE(owner_key,portal_environment,client_key),
    CONSTRAINT CK_catalog_operational_owners_environment CHECK (
      (portal_environment='qa' AND DATALENGTH(portal_environment)=2)
      OR (portal_environment='production' AND DATALENGTH(portal_environment)=10)),
    CONSTRAINT CK_catalog_operational_owners_lifetime CHECK (
      LEN(LTRIM(RTRIM(registered_by)))>0 AND (retired_at IS NULL OR retired_at>=registered_at))
  );
  CREATE UNIQUE INDEX UX_catalog_operational_owner_customer
    ON core.catalog_operational_owners(portal_environment,catalog_customer_key) WHERE retired_at IS NULL;
  CREATE UNIQUE INDEX UX_catalog_operational_owner_client
    ON core.catalog_operational_owners(portal_environment,client_key) WHERE retired_at IS NULL;
END;

IF OBJECT_ID(N'core.catalog_operational_links',N'U') IS NULL
BEGIN
  CREATE TABLE core.catalog_operational_links (
    link_key bigint IDENTITY(1,1) NOT NULL PRIMARY KEY,
    link_id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() UNIQUE,
    owner_key bigint NOT NULL,
    portal_environment varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
    client_key bigint NOT NULL,
    domain_key bigint NOT NULL,
    database_key bigint NULL,
    catalog_source_key bigint NOT NULL,
    source_role varchar(15) NOT NULL DEFAULT 'erp-customers',
    source_record_id int NOT NULL,
    target_kind varchar(20) COLLATE Latin1_General_100_BIN2 NOT NULL,
    link_environment varchar(20) COLLATE Latin1_General_100_BIN2 NOT NULL,
    registered_by nvarchar(150) NOT NULL,
    registered_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
    retired_at datetime2(3) NULL,
    CONSTRAINT FK_catalog_operational_links_owner FOREIGN KEY(owner_key,portal_environment,client_key)
      REFERENCES core.catalog_operational_owners(owner_key,portal_environment,client_key),
    CONSTRAINT FK_catalog_operational_links_source FOREIGN KEY(catalog_source_key,source_role)
      REFERENCES settings.catalog_source_bindings(catalog_source_key,source_role),
    CONSTRAINT FK_catalog_operational_links_domain FOREIGN KEY(domain_key,client_key)
      REFERENCES core.domains(domain_key,client_key),
    CONSTRAINT FK_catalog_operational_links_database FOREIGN KEY(database_key,domain_key,client_key)
      REFERENCES core.databases(database_key,domain_key,client_key),
    CONSTRAINT CK_catalog_operational_links_source CHECK (
      source_role COLLATE Latin1_General_100_BIN2='erp-customers' AND DATALENGTH(source_role)=13),
    CONSTRAINT CK_catalog_operational_links_target CHECK (
      (database_key IS NULL AND target_kind='domain' AND DATALENGTH(target_kind)=6)
      OR (database_key IS NOT NULL AND target_kind='database' AND DATALENGTH(target_kind)=8)),
    CONSTRAINT CK_catalog_operational_links_environment CHECK (
      link_environment IN ('production','test','demo') AND DATALENGTH(link_environment)=LEN(link_environment)
      AND DATALENGTH(portal_environment)=LEN(portal_environment)),
    CONSTRAINT CK_catalog_operational_links_lifetime CHECK (
      LEN(LTRIM(RTRIM(registered_by)))>0 AND (retired_at IS NULL OR retired_at>=registered_at))
  );
  CREATE UNIQUE INDEX UX_catalog_operational_link_edge ON core.catalog_operational_links(
    owner_key,domain_key,database_key,catalog_source_key,source_record_id,link_environment)
    WHERE retired_at IS NULL;
  CREATE INDEX IX_catalog_operational_links_owner ON core.catalog_operational_links(owner_key,retired_at);
END;

IF OBJECT_ID(N'core.catalog_operational_link_approvals',N'U') IS NULL
BEGIN
  CREATE TABLE core.catalog_operational_link_approvals (
    link_key bigint NOT NULL REFERENCES core.catalog_operational_links(link_key),
    binding_version binary(8) NOT NULL,
    profile_version binary(8) NOT NULL,
    revision_key bigint NOT NULL REFERENCES core.catalog_customer_source_revisions(revision_key),
    approval_reference varchar(80) COLLATE Latin1_General_100_BIN2 NOT NULL,
    approved_by nvarchar(150) NOT NULL,
    approved_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_catalog_operational_link_approvals PRIMARY KEY(link_key,binding_version,profile_version),
    CONSTRAINT CK_catalog_operational_link_approvals_metadata CHECK (
      LEN(LTRIM(RTRIM(approved_by)))>0 AND approval_reference LIKE '[A-Za-z0-9]%'
      AND approval_reference NOT LIKE '%[^A-Za-z0-9._-]%' AND DATALENGTH(approval_reference)=LEN(approval_reference))
  );
END;

IF OBJECT_ID(N'core.TR_catalog_operational_owner_register',N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER core.TR_catalog_operational_owner_register
    ON core.catalog_operational_owners INSTEAD OF INSERT AS
  BEGIN
    SET NOCOUNT ON;
    IF EXISTS(SELECT 1 FROM inserted WHERE retired_at IS NOT NULL)
      THROW 54205,N''An operational owner cannot be registered as retired.'',1;
    DECLARE @registeredAt datetime2(3)=SYSUTCDATETIME();
    INSERT core.catalog_operational_owners(portal_environment,catalog_customer_key,client_key,registered_by,registered_at)
    SELECT portal_environment,catalog_customer_key,client_key,registered_by,@registeredAt FROM inserted;
  END;';

IF OBJECT_ID(N'core.TR_catalog_operational_link_register',N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER core.TR_catalog_operational_link_register
    ON core.catalog_operational_links INSTEAD OF INSERT AS
  BEGIN
    SET NOCOUNT ON;
    IF EXISTS(SELECT 1 FROM inserted WHERE retired_at IS NOT NULL)
      THROW 54206,N''An operational link cannot be registered as retired.'',1;
    DECLARE @registeredAt datetime2(3)=SYSUTCDATETIME();
    INSERT core.catalog_operational_links(link_id,owner_key,portal_environment,client_key,domain_key,database_key,
      catalog_source_key,source_role,source_record_id,target_kind,link_environment,registered_by,registered_at)
    SELECT COALESCE(link_id,NEWID()),owner_key,portal_environment,client_key,domain_key,database_key,
      catalog_source_key,source_role,source_record_id,target_kind,link_environment,registered_by,@registeredAt FROM inserted;
  END;';

IF OBJECT_ID(N'core.TR_catalog_operational_owner_retire',N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER core.TR_catalog_operational_owner_retire
    ON core.catalog_operational_owners INSTEAD OF UPDATE, DELETE AS
  BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM deleted o LEFT JOIN inserted n ON n.owner_key=o.owner_key
      WHERE n.owner_key IS NULL OR n.retired_at IS NULL OR o.retired_at IS NOT NULL
        OR EXISTS(SELECT n.portal_environment,n.catalog_customer_key,n.client_key,n.registered_by,n.registered_at
          EXCEPT SELECT o.portal_environment,o.catalog_customer_key,o.client_key,o.registered_by,o.registered_at))
      THROW 54201,N''An operational owner can only be retired once.'',1;
    UPDATE o SET retired_at=SYSUTCDATETIME()
    FROM core.catalog_operational_owners o JOIN inserted n ON n.owner_key=o.owner_key
    WHERE o.retired_at IS NULL;
    IF @@ROWCOUNT<>(SELECT COUNT(*) FROM inserted) THROW 54201,N''The operational owner is already retired.'',1;
  END;';

IF OBJECT_ID(N'core.TR_catalog_operational_link_retire',N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER core.TR_catalog_operational_link_retire
    ON core.catalog_operational_links INSTEAD OF UPDATE, DELETE AS
  BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM deleted o LEFT JOIN inserted n ON n.link_key=o.link_key
      WHERE n.link_key IS NULL OR n.retired_at IS NULL OR o.retired_at IS NOT NULL
        OR EXISTS(SELECT n.link_id,n.owner_key,n.portal_environment,n.client_key,n.domain_key,n.database_key,
          n.catalog_source_key,n.source_role,n.source_record_id,n.target_kind,n.link_environment,n.registered_by,n.registered_at
          EXCEPT SELECT o.link_id,o.owner_key,o.portal_environment,o.client_key,o.domain_key,o.database_key,
          o.catalog_source_key,o.source_role,o.source_record_id,o.target_kind,o.link_environment,o.registered_by,o.registered_at))
      THROW 54202,N''An operational link can only be retired once.'',1;
    UPDATE o SET retired_at=SYSUTCDATETIME()
    FROM core.catalog_operational_links o JOIN inserted n ON n.link_key=o.link_key
    WHERE o.retired_at IS NULL;
    IF @@ROWCOUNT<>(SELECT COUNT(*) FROM inserted) THROW 54202,N''The operational link is already retired.'',1;
  END;';

-- Internal evidence only. Listing this view does not certify population completeness,
-- caller visibility, matching SAG licenses, or physical target authorization.
EXEC sys.sp_executesql N'CREATE OR ALTER VIEW core.catalog_operational_link_evidence AS
  SELECT l.link_key,l.link_id,l.owner_key,l.portal_environment,l.client_key,l.domain_key,l.database_key,
    l.catalog_source_key,b.source_id AS catalog_source_id,l.source_record_id,l.target_kind,l.link_environment,
    o.catalog_customer_key,l.retired_at,o.retired_at AS owner_retired_at,
    r.revision_key,b.row_version AS binding_version,p.row_version AS profile_version,r.verified_until,
    CASE WHEN r.revision_key IS NOT NULL THEN ''verified'' ELSE ''unverifiable'' END AS evidence_state
  FROM core.catalog_operational_links l
  JOIN core.catalog_operational_owners o ON o.owner_key=l.owner_key
  JOIN core.clients c ON c.client_key=l.client_key
  JOIN core.domains d ON d.domain_key=l.domain_key AND d.client_key=l.client_key
  LEFT JOIN core.databases db ON db.database_key=l.database_key AND db.client_key=l.client_key AND db.domain_key=l.domain_key
  JOIN settings.catalog_source_bindings b ON b.catalog_source_key=l.catalog_source_key
  JOIN settings.external_database_connections p ON p.external_database_connection_key=b.external_database_connection_key
  LEFT JOIN settings.catalog_customer_revision_heads h ON h.catalog_source_key=b.catalog_source_key
  LEFT JOIN core.catalog_operational_link_approvals a ON a.link_key=l.link_key
    AND a.binding_version=b.row_version AND a.profile_version=p.row_version
  OUTER APPLY (
    SELECT v.revision_key,v.verified_until FROM core.catalog_customer_source_revisions v
    JOIN core.catalog_customer_revision_rows rr ON rr.revision_key=v.revision_key
      AND rr.source_record_id=l.source_record_id AND rr.catalog_customer_key=o.catalog_customer_key AND rr.active_code=''S''
    WHERE l.retired_at IS NULL AND o.retired_at IS NULL AND c.status=''active'' AND d.status=''active''
      AND ((l.target_kind=''domain'' AND d.environment_id COLLATE Latin1_General_100_BIN2=l.link_environment)
        OR (l.target_kind=''database'' AND db.status=''active'' AND db.environment_id COLLATE Latin1_General_100_BIN2=l.link_environment))
      AND b.portal_environment COLLATE Latin1_General_100_BIN2=l.portal_environment AND b.source_role=''erp-customers''
      AND b.source_state=''active'' AND b.contract_version=''erp_v1'' AND b.validated_at<=SYSUTCDATETIME()
      AND b.validated_profile_version=p.row_version AND p.status=''active'' AND p.active=1 AND p.encrypt_connection=1 AND p.password_configured=1
      AND h.attempt_status=''succeeded'' AND h.attempted_at<=SYSUTCDATETIME()
      AND a.approved_at<=SYSUTCDATETIME() AND v.revision_key=h.revision_key AND v.catalog_source_key=b.catalog_source_key
      AND v.binding_version=b.row_version AND v.profile_version=p.row_version AND v.sealed_at<=SYSUTCDATETIME()
      AND v.verified_until>SYSUTCDATETIME() AND v.revision_key>=a.revision_key
  ) r;';

IF OBJECT_ID(N'core.TR_catalog_operational_approval_stamp',N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER core.TR_catalog_operational_approval_stamp
    ON core.catalog_operational_link_approvals INSTEAD OF INSERT AS
  BEGIN
    SET NOCOUNT ON;
    DECLARE @now datetime2(3)=SYSUTCDATETIME();
    IF EXISTS (SELECT 1 FROM inserted n WHERE NOT EXISTS (
      SELECT 1 FROM core.catalog_operational_links l WITH (HOLDLOCK)
      JOIN core.catalog_operational_owners o WITH (HOLDLOCK) ON o.owner_key=l.owner_key
      JOIN core.clients c WITH (HOLDLOCK) ON c.client_key=l.client_key AND c.status=''active''
      JOIN core.domains d WITH (HOLDLOCK) ON d.domain_key=l.domain_key AND d.client_key=l.client_key AND d.status=''active''
      LEFT JOIN core.databases db WITH (HOLDLOCK) ON db.database_key=l.database_key
      JOIN settings.catalog_source_bindings b WITH (HOLDLOCK) ON b.catalog_source_key=l.catalog_source_key
      JOIN settings.external_database_connections p WITH (HOLDLOCK) ON p.external_database_connection_key=b.external_database_connection_key
      JOIN settings.catalog_customer_revision_heads h WITH (HOLDLOCK) ON h.catalog_source_key=b.catalog_source_key
      JOIN core.catalog_customer_source_revisions r WITH (HOLDLOCK) ON r.revision_key=h.revision_key AND r.catalog_source_key=b.catalog_source_key
      JOIN core.catalog_customer_revision_rows rr ON rr.revision_key=r.revision_key
        AND rr.source_record_id=l.source_record_id AND rr.catalog_customer_key=o.catalog_customer_key AND rr.active_code=''S''
      WHERE l.link_key=n.link_key AND l.retired_at IS NULL AND o.retired_at IS NULL
        AND ((l.target_kind=''domain'' AND d.environment_id COLLATE Latin1_General_100_BIN2=l.link_environment)
          OR (l.target_kind=''database'' AND db.status=''active'' AND db.environment_id COLLATE Latin1_General_100_BIN2=l.link_environment))
        AND b.portal_environment COLLATE Latin1_General_100_BIN2=l.portal_environment AND b.source_role=''erp-customers''
        AND b.source_state=''active'' AND b.contract_version=''erp_v1'' AND b.validated_at<=@now
        AND b.row_version=n.binding_version AND b.validated_profile_version=p.row_version AND p.row_version=n.profile_version
        AND p.status=''active'' AND p.active=1 AND p.encrypt_connection=1 AND p.password_configured=1
        AND h.attempt_status=''succeeded'' AND h.attempted_at<=@now AND r.revision_key=n.revision_key
        AND r.binding_version=b.row_version AND r.profile_version=p.row_version AND r.sealed_at<=@now AND r.verified_until>@now
    ))
      THROW 54203,N''Approval requires a current certified source record for this exact operational owner and target.'',1;
    -- The evidence checks may have waited on another transaction. Recheck the
    -- expiry and stamp after those locks are held, not using the arrival time.
    SET @now=SYSUTCDATETIME();
    IF EXISTS(SELECT 1 FROM inserted n JOIN core.catalog_customer_source_revisions r ON r.revision_key=n.revision_key
      WHERE r.verified_until<=@now)
      THROW 54203,N''The certified source revision expired during approval.'',1;
    INSERT core.catalog_operational_link_approvals(link_key,binding_version,profile_version,revision_key,approval_reference,approved_by,approved_at)
    SELECT link_key,binding_version,profile_version,revision_key,approval_reference,approved_by,@now FROM inserted;
  END;';

IF OBJECT_ID(N'core.TR_catalog_operational_approval_immutable',N'TR') IS NULL
  EXEC sys.sp_executesql N'CREATE TRIGGER core.TR_catalog_operational_approval_immutable
    ON core.catalog_operational_link_approvals AFTER UPDATE, DELETE AS
  BEGIN
    SET NOCOUNT ON;
    IF EXISTS(SELECT 1 FROM deleted) THROW 54204,N''An operational link approval is immutable.'',1;
  END;';

IF DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NOT NULL
BEGIN
  DENY INSERT,UPDATE,DELETE ON OBJECT::core.catalog_operational_owners TO portal_runtime;
  DENY INSERT,UPDATE,DELETE ON OBJECT::core.catalog_operational_links TO portal_runtime;
  DENY INSERT,UPDATE,DELETE ON OBJECT::core.catalog_operational_link_approvals TO portal_runtime;
END;

IF @owns042Transaction=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  -- An ambient transaction belongs to the caller, which receives the error.
  IF @owns042Transaction=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
