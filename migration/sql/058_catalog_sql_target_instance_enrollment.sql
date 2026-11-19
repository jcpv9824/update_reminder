/* Private writer for 054. No application role can execute it directly.
   The trusted server caller must first certify the exact report-only profile
   via strict TLS, the approved instance registry and a database GUID probe.
   Neither this migration nor its procedure opens a remote connection. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns058 bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns058=1 BEGIN TRANSACTION;
  IF NOT ((DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb' AND DATALENGTH(DB_NAME())=24)
      OR (DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb-TEST' AND DATALENGTH(DB_NAME())=34))
    OR CAST(SERVERPROPERTY('ProductMajorVersion') AS int)<>15
    OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150
      AND collation_name=N'Modern_Spanish_CI_AS')
    THROW 55801,N'Expected Portal database on SQL Server 2019 compatibility level 150.',1;

  DECLARE @lock058 int;
  EXEC @lock058=sys.sp_getapplock @Resource=N'portal-sag:migration:058:sql-target-instance-enrollment',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock058<0 THROW 55802,N'Could not reserve SQL target instance enrollment migration.',1;

  IF DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NULL
    OR OBJECT_ID(N'core.UQ_catalog_sql_target_instance_identities_proof',N'UQ') IS NULL
    OR EXISTS(SELECT 1 FROM (VALUES
      (OBJECT_ID(N'core.TR_catalog_sql_target_instance_identities_insert',N'TR')),
      (OBJECT_ID(N'core.TR_catalog_sql_target_instance_identities_immutable',N'TR'))
    ) mandatory(object_id) LEFT JOIN sys.triggers t ON t.object_id=mandatory.object_id
    WHERE t.object_id IS NULL OR t.is_disabled=1)
    OR (SELECT COUNT(*) FROM sys.database_permissions
      WHERE class=1 AND major_id=OBJECT_ID(N'core.catalog_sql_target_instance_identities',N'U') AND minor_id=0
        AND grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime')
        AND permission_name IN (N'INSERT',N'UPDATE',N'DELETE') AND state='D')<>3
    THROW 55803,N'Expected the immutable 054 custody and its existing direct runtime write denies.',1;

  EXEC sys.sp_executesql N'CREATE OR ALTER PROCEDURE settings.enroll_catalog_sql_target_instance_internal
    @environment varchar(32),@actorId nvarchar(150),
    @physicalLinkId uniqueidentifier,@physicalTargetId uniqueidentifier,@operationalProfileVersion varbinary(32),
    @reportConnectionId nvarchar(150),@reportProfileVersion varbinary(32),@reportRouteFingerprint varbinary(64),
    @trustedInstanceId uniqueidentifier,@verifiedDatabaseGuid uniqueidentifier,@identityFingerprint varbinary(64),
    @proofId uniqueidentifier,@verifiedAt datetime2(3),@validUntil datetime2(3),@result varchar(32) OUTPUT
  AS
  BEGIN
    SET NOCOUNT ON;
    SET @result=''invalid-proof'';
    IF @@TRANCOUNT<>1 OR XACT_STATE()<>1 OR (@@OPTIONS & 2)<>0
      OR NOT EXISTS(SELECT 1 FROM sys.dm_exec_sessions WHERE session_id=@@SPID AND transaction_isolation_level=4)
      RETURN;

    DECLARE @zero uniqueidentifier=''00000000-0000-0000-0000-000000000000'';
    IF @environment IS NULL OR NOT (
        (@environment COLLATE Latin1_General_100_BIN2=''qa'' AND DATALENGTH(@environment)=2
          AND DB_NAME() COLLATE Latin1_General_100_BIN2=N''PortalSAGWeb-TEST'' AND DATALENGTH(DB_NAME())=34)
        OR (@environment COLLATE Latin1_General_100_BIN2=''production'' AND DATALENGTH(@environment)=10
          AND DB_NAME() COLLATE Latin1_General_100_BIN2=N''PortalSAGWeb'' AND DATALENGTH(DB_NAME())=24))
      OR @actorId IS NULL OR LEN(@actorId)=0 OR DATALENGTH(@actorId)<>DATALENGTH(LTRIM(RTRIM(@actorId)))
      OR @reportConnectionId IS NULL OR LEN(@reportConnectionId)=0
      OR DATALENGTH(@reportConnectionId)<>DATALENGTH(LTRIM(RTRIM(@reportConnectionId)))
      OR @physicalLinkId IS NULL OR @physicalLinkId=@zero OR @physicalTargetId IS NULL OR @physicalTargetId=@zero
      OR @operationalProfileVersion IS NULL OR DATALENGTH(@operationalProfileVersion)<>8
      OR @reportProfileVersion IS NULL OR DATALENGTH(@reportProfileVersion)<>8
      OR @reportRouteFingerprint IS NULL OR DATALENGTH(@reportRouteFingerprint)<>32
      OR @trustedInstanceId IS NULL OR @trustedInstanceId=@zero OR @verifiedDatabaseGuid IS NULL OR @verifiedDatabaseGuid=@zero
      OR @identityFingerprint IS NULL OR DATALENGTH(@identityFingerprint)<>32 OR @proofId IS NULL OR @proofId=@zero
      OR @verifiedAt IS NULL OR @validUntil IS NULL OR @validUntil<=@verifiedAt
      OR DATEDIFF_BIG(millisecond,@verifiedAt,@validUntil)>300000
      RETURN;

    -- Exact bytes of fingerprintCatalogSqlTarget v1: the fixed JSON array
    -- contains ASCII only; the observed database GUID never leaves this stack.
    DECLARE @computedIdentity binary(32)=HASHBYTES(''SHA2_256'',CONVERT(varbinary(max),CONCAT(
      ''["portal-sag/catalog-physical-target/v1","database","'',LOWER(CONVERT(char(36),@trustedInstanceId)),
      ''","'',LOWER(CONVERT(char(36),@verifiedDatabaseGuid)),''"]'')));
    IF @computedIdentity<>@identityFingerprint RETURN;

    BEGIN TRY
      -- 027 grants this exact Conexiones triad to the protected super_admin.
      -- Recheck both the active account and those live persisted grants.
      IF NOT EXISTS(SELECT 1
        FROM security.users u WITH (HOLDLOCK)
        JOIN security.user_roles ur WITH (HOLDLOCK) ON ur.user_key=u.user_key
        JOIN security.roles r WITH (HOLDLOCK) ON r.role_id=ur.role_id
        WHERE u.source_id=@actorId AND u.active=1
          AND u.source_id COLLATE Latin1_General_100_BIN2=@actorId COLLATE Latin1_General_100_BIN2
          AND DATALENGTH(u.source_id)=DATALENGTH(@actorId)
          AND r.role_id COLLATE Latin1_General_100_BIN2=N''super_admin''
          AND DATALENGTH(r.role_id)=DATALENGTH(N''super_admin'')
          AND r.active=1 AND r.system_role=1 AND r.protected_role=1
          AND 3=(SELECT COUNT(*) FROM (VALUES(N''configuration.integrations.view''),
              (N''configuration.integrations.test_database''),(N''configuration.integrations.edit_database'')) required(permission_key)
            JOIN security.permissions p WITH (HOLDLOCK)
              ON p.permission_key=required.permission_key AND p.active=1
              AND p.permission_key COLLATE Latin1_General_100_BIN2=required.permission_key COLLATE Latin1_General_100_BIN2
              AND DATALENGTH(p.permission_key)=DATALENGTH(required.permission_key)
            JOIN security.role_permissions rp WITH (HOLDLOCK) ON rp.role_id=r.role_id AND rp.permission_key=p.permission_key))
      BEGIN
        SET @result=''authority-changed'';
        RETURN;
      END;

      DECLARE @now datetime2(3)=SYSUTCDATETIME();
      IF @verifiedAt>@now OR @validUntil<=@now
      BEGIN
        SET @result=''proof-stale'';
        RETURN;
      END;

      DECLARE @targetKey bigint,@nameFingerprint binary(32),@linkExpiry datetime2(3),@connectionKey bigint;
      SELECT @targetKey=t.physical_target_key,@nameFingerprint=t.database_name_fingerprint,@linkExpiry=l.valid_until
      FROM core.catalog_physical_targets t WITH (UPDLOCK,HOLDLOCK)
      JOIN core.catalog_physical_target_links l WITH (HOLDLOCK)
        ON l.physical_target_key=t.physical_target_key AND l.portal_environment=t.portal_environment
        AND l.target_kind=t.target_kind AND l.link_id=@physicalLinkId AND l.retired_at IS NULL
        AND l.verified_at<=@verifiedAt AND l.valid_until>@now
      JOIN core.clients c WITH (HOLDLOCK) ON c.client_key=l.client_key AND c.status=''active''
      JOIN core.domains d WITH (HOLDLOCK)
        ON d.domain_key=l.domain_key AND d.client_key=l.client_key AND d.status=''active''
      JOIN core.databases db WITH (HOLDLOCK)
        ON db.database_key=l.database_key AND db.domain_key=l.domain_key AND db.client_key=l.client_key AND db.status=''active''
      JOIN core.database_access_profiles ap WITH (HOLDLOCK)
        ON ap.access_profile_key=l.access_profile_key AND ap.access_profile_key=db.access_profile_key AND ap.active=1
        AND ap.row_version=l.access_profile_version AND ap.row_version=@operationalProfileVersion
      WHERE t.target_id=@physicalTargetId AND t.portal_environment=@environment COLLATE Latin1_General_100_BIN2
        AND DATALENGTH(t.portal_environment)=DATALENGTH(@environment) AND t.target_kind=''database''
        AND t.created_at<=@verifiedAt AND t.identity_fingerprint=@computedIdentity
        AND t.database_name_fingerprint=HASHBYTES(''SHA2_256'',CONVERT(varbinary(max),ap.initial_catalog));
      IF @targetKey IS NULL
      BEGIN
        SET @result=''reference-changed'';
        RETURN;
      END;

      -- Handoff v1: UTF-16LE prefix/source strings, each length framed by
      -- four big-endian bytes; port is an unsigned-range four-byte integer.
      -- No route or login material is returned or stored by the procedure.
      SELECT @connectionKey=p.external_database_connection_key
      FROM settings.external_database_connections p WITH (HOLDLOCK)
      WHERE p.source_id=@reportConnectionId
        AND p.source_id COLLATE Latin1_General_100_BIN2=@reportConnectionId COLLATE Latin1_General_100_BIN2
        AND DATALENGTH(p.source_id)=DATALENGTH(@reportConnectionId) AND p.row_version=@reportProfileVersion
        AND p.active=1 AND p.status=''active'' AND p.encrypt_connection=1 AND p.password_configured=1
        AND p.updated_at<=@verifiedAt
        AND @nameFingerprint=HASHBYTES(''SHA2_256'',CONVERT(varbinary(max),p.database_name))
        AND @reportRouteFingerprint=HASHBYTES(''SHA2_256'',
          CONVERT(varbinary(max),N''portal-sag:report-enrollment-route:v1|'')
          + CONVERT(binary(4),DATALENGTH(p.server_host)) + CONVERT(varbinary(max),p.server_host)
          + CONVERT(binary(4),p.server_port)
          + CONVERT(binary(4),DATALENGTH(p.database_name)) + CONVERT(varbinary(max),p.database_name));
      IF @connectionKey IS NULL
        OR EXISTS(SELECT 1 FROM settings.catalog_source_bindings b WITH (HOLDLOCK)
          WHERE b.external_database_connection_key=@connectionKey AND b.source_state=''active'')
        OR EXISTS(SELECT 1 FROM settings.catalog_reporting_profiles rp WITH (HOLDLOCK)
          WHERE rp.external_database_connection_key=@connectionKey
            AND (rp.physical_target_key<>@targetKey OR rp.portal_environment<>@environment COLLATE Latin1_General_100_BIN2))
      BEGIN
        SET @result=''reference-changed'';
        RETURN;
      END;

      DECLARE @previousInstance uniqueidentifier,@proofTarget bigint;
      SELECT @previousInstance=i.trusted_instance_id
      FROM core.catalog_sql_target_instance_identities i WITH (UPDLOCK,HOLDLOCK)
      WHERE i.physical_target_key=@targetKey;
      SELECT @proofTarget=i.physical_target_key
      FROM core.catalog_sql_target_instance_identities i WITH (UPDLOCK,HOLDLOCK)
      WHERE i.proof_id=@proofId;
      IF @proofTarget IS NOT NULL AND @proofTarget<>@targetKey
      BEGIN
        SET @result=''proof-replayed'';
        RETURN;
      END;
      IF @previousInstance IS NOT NULL AND @previousInstance<>@trustedInstanceId
      BEGIN
        SET @result=''instance-conflict'';
        RETURN;
      END;
      IF @proofTarget IS NULL AND (
        EXISTS(SELECT 1 FROM core.catalog_physical_target_links WITH (HOLDLOCK) WHERE proof_id=@proofId)
        OR EXISTS(SELECT 1 FROM settings.catalog_reporting_profiles WITH (HOLDLOCK) WHERE proof_id=@proofId))
      BEGIN
        SET @result=''proof-replayed'';
        RETURN;
      END;

      -- Recheck after all lock waits. The caller must retain this transaction
      -- and fence the proof deadline before reporting success/committing.
      SET @now=SYSUTCDATETIME();
      IF @verifiedAt>@now OR @validUntil<=@now OR @linkExpiry<@validUntil
      BEGIN
        SET @result=''proof-stale'';
        RETURN;
      END;
      IF @previousInstance IS NOT NULL
      BEGIN
        SET @result=''already-enrolled'';
        RETURN;
      END;

      INSERT core.catalog_sql_target_instance_identities(physical_target_key,portal_environment,target_kind,trusted_instance_id,proof_id)
      VALUES(@targetKey,@environment,''database'',@trustedInstanceId,@proofId);
      SET @result=''enrolled'';
    END TRY
    BEGIN CATCH
      -- Do not return the engine error, inputs, route or keys. The exclusive
      -- transaction owner must rollback on this result or a failed XACT_STATE.
      SET @result=''unavailable'';
    END CATCH;
  END;';

  DECLARE @owned058 table(object_id int NULL);
  INSERT @owned058 VALUES
    (OBJECT_ID(N'settings.enroll_catalog_sql_target_instance_internal',N'P')),
    (OBJECT_ID(N'core.catalog_sql_target_instance_identities',N'U')),
    (OBJECT_ID(N'core.catalog_physical_targets',N'U')),
    (OBJECT_ID(N'core.catalog_physical_target_links',N'U')),
    (OBJECT_ID(N'core.clients',N'U')),
    (OBJECT_ID(N'core.domains',N'U')),
    (OBJECT_ID(N'core.databases',N'U')),
    (OBJECT_ID(N'core.database_access_profiles',N'U')),
    (OBJECT_ID(N'settings.external_database_connections',N'U')),
    (OBJECT_ID(N'settings.catalog_source_bindings',N'U')),
    (OBJECT_ID(N'settings.catalog_reporting_profiles',N'U')),
    (OBJECT_ID(N'security.users',N'U')),
    (OBJECT_ID(N'security.user_roles',N'U')),
    (OBJECT_ID(N'security.roles',N'U')),
    (OBJECT_ID(N'security.permissions',N'U')),
    (OBJECT_ID(N'security.role_permissions',N'U'));
  IF EXISTS(SELECT 1 FROM @owned058 expected
    LEFT JOIN sys.objects o ON o.object_id=expected.object_id
    LEFT JOIN sys.schemas s ON s.schema_id=o.schema_id
    WHERE o.object_id IS NULL OR COALESCE(o.principal_id,s.principal_id,-1)<>DATABASE_PRINCIPAL_ID(N'dbo'))
    THROW 55804,N'The SQL target instance enrollment static ownership chain is incomplete.',1;

  DENY EXECUTE ON OBJECT::settings.enroll_catalog_sql_target_instance_internal TO public;
  IF EXISTS(SELECT 1 FROM sys.database_permissions WHERE class=1
    AND major_id=OBJECT_ID(N'settings.enroll_catalog_sql_target_instance_internal',N'P') AND state IN ('G','W'))
    THROW 55805,N'Unexpected direct grant on the private SQL instance enrollment procedure.',1;
  IF @owns058=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns058=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
