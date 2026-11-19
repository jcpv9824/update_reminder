/* Owner-compatible ERP publication on the existing catalog-only SQL path.
   Only a no-login module delegate and fixed stored procedures are created.
   Existing users, grants, denials and migrations are unchanged. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns065 bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns065=1 BEGIN TRANSACTION;
  IF NOT ((DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb' AND DATALENGTH(DB_NAME())=24)
      OR (DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb-TEST' AND DATALENGTH(DB_NAME())=34))
    OR CAST(SERVERPROPERTY(N'ProductMajorVersion') AS int)<>15
    OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150
      AND is_read_only=0 AND collation_name COLLATE Latin1_General_100_BIN2=N'Modern_Spanish_CI_AS')
    THROW 56501,N'Expected the writable Portal database on SQL Server 2019 compatibility 150.',1;
  DECLARE @lock065 int;
  EXEC @lock065=sys.sp_getapplock @Resource=N'portal-sag:migration:065:erp-owner-publisher',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock065<0 THROW 56502,N'Could not reserve migration 065.',1;
  IF NOT EXISTS(SELECT 1 FROM migration.schema_migrations WHERE migration_version='064' AND succeeded=1)
    THROW 56503,N'Expected the installed owner publisher migration 064.',1;

  IF DATABASE_PRINCIPAL_ID(N'portal_catalog_erp_owner_delegate') IS NULL
    CREATE USER [portal_catalog_erp_owner_delegate] WITHOUT LOGIN;
  DECLARE @delegate065 int=DATABASE_PRINCIPAL_ID(N'portal_catalog_erp_owner_delegate'),@dbo065 int=DATABASE_PRINCIPAL_ID(N'dbo');
  IF NOT EXISTS(SELECT 1 FROM sys.database_principals WHERE principal_id=@delegate065
      AND type='S' AND authentication_type=0 AND name COLLATE Latin1_General_100_BIN2=N'portal_catalog_erp_owner_delegate')
    OR EXISTS(SELECT 1 FROM sys.database_role_members WHERE member_principal_id=@delegate065)
    OR EXISTS(SELECT 1 FROM sys.database_permissions WHERE grantor_principal_id=@delegate065
      OR (grantee_principal_id=@delegate065 AND NOT (class=0 AND major_id=0 AND minor_id=0
        AND state='G' AND permission_name='CONNECT' AND grantor_principal_id=@dbo065)))
    OR EXISTS(SELECT 1 FROM sys.schemas WHERE principal_id=@delegate065)
    OR EXISTS(SELECT 1 FROM sys.objects WHERE principal_id=@delegate065)
    OR EXISTS(SELECT 1 FROM sys.database_principals WHERE owning_principal_id=@delegate065)
    THROW 56503,N'The ERP owner module delegate must be an unprivileged no-login user.',1;

  EXEC sys.sp_executesql N'CREATE OR ALTER PROCEDURE settings.catalog_erp_owner_dispatch_internal
  @operation char(1),
  @environment varchar(32), @sourceId uniqueidentifier, @jobId uniqueidentifier, @workerId uniqueidentifier,
  @leaseToken uniqueidentifier, @attempt int, @bindingVersion varbinary(32), @profileVersion varbinary(32),
  @matchKeyVersion smallint, @vaultSecretVersion varbinary(64), @keyVerifier varbinary(64),
  @attemptOrdinal bigint=NULL, @observedAt datetime2(3)=NULL, @rowCount int=NULL, @rows nvarchar(max)=NULL
WITH EXECUTE AS ''portal_catalog_erp_owner_delegate''
AS
BEGIN
  SET NOCOUNT ON;
  IF @@NESTLEVEL<>2 OR @@TRANCOUNT<>0 OR (@@OPTIONS & 2)<>0
    OR ORIGINAL_LOGIN() COLLATE Latin1_General_100_BIN2<>N''SAGWebDev'' OR DATALENGTH(ORIGINAL_LOGIN())<>18
    OR USER_NAME() COLLATE Latin1_General_100_BIN2<>N''portal_catalog_erp_owner_delegate''
    OR @environment IS NULL OR NOT (
      (@environment COLLATE Latin1_General_100_BIN2=''qa'' AND DATALENGTH(@environment)=2
        AND DB_NAME() COLLATE Latin1_General_100_BIN2=N''PortalSAGWeb-TEST'' AND DATALENGTH(DB_NAME())=34)
      OR (@environment COLLATE Latin1_General_100_BIN2=''production'' AND DATALENGTH(@environment)=10
        AND DB_NAME() COLLATE Latin1_General_100_BIN2=N''PortalSAGWeb'' AND DATALENGTH(DB_NAME())=24))
    OR @operation IS NULL OR @operation COLLATE Latin1_General_100_BIN2 NOT IN (''R'',''P'',''F'')
    OR @sourceId IS NULL OR @jobId IS NULL OR @workerId IS NULL OR @leaseToken IS NULL
    OR @attempt IS NULL OR @attempt NOT BETWEEN 1 AND 5
    OR ISNULL(DATALENGTH(@bindingVersion),0)<>8 OR ISNULL(DATALENGTH(@profileVersion),0)<>8
    OR @matchKeyVersion IS NULL OR @matchKeyVersion<=0
    OR ISNULL(DATALENGTH(@vaultSecretVersion),0)<>16 OR ISNULL(DATALENGTH(@keyVerifier),0)<>32
    OR (@operation IN (''P'',''F'') AND (@attemptOrdinal IS NULL OR @attemptOrdinal<=0 OR @observedAt IS NULL))
    THROW 56504,N''ERP owner publication is unavailable.'',1;

  SET XACT_ABORT ON;
  SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
  DECLARE @result varchar(11),@jobStatus varchar(12),@event varchar(12),@leaseUntil datetime2(3),
    @jobKey bigint,@sourceKey bigint,@reserved bigint,@reservedAt datetime2(3),@requestedAt datetime2(3),
    @claimedAt datetime2(3),@bindingScope nvarchar(80),@now datetime2(3),@freshUntil datetime2(3),
    @successFreshUntil datetime2(3),@revisionKey bigint,@headOrdinal bigint,@headMatchVersion smallint,
    @hadHead bit=0,@lockCode int,
    @resource nvarchar(255)=N''portal-sag:catalog-customer-publication:''+@environment;

  BEGIN TRY
    BEGIN TRANSACTION;
    EXEC @lockCode=sys.sp_getapplock @Resource=@resource,@LockMode=N''Exclusive'',
      @LockOwner=N''Transaction'',@DbPrincipal=N''public'',@LockTimeout=5000;
    IF @lockCode<0 THROW 56505,N''ERP publication authorization or lease unavailable.'',1;

    SELECT @jobKey=j.job_key,@sourceKey=b.catalog_source_key,@leaseUntil=j.lease_expires_at,
      @reserved=j.attempt_ordinal,@requestedAt=j.requested_at,@bindingScope=b.issuer_scope
    FROM settings.catalog_source_refresh_jobs j WITH (UPDLOCK,HOLDLOCK)
    JOIN settings.catalog_source_bindings b WITH (UPDLOCK,HOLDLOCK) ON b.catalog_source_key=j.catalog_source_key
    JOIN settings.external_database_connections p WITH (UPDLOCK,HOLDLOCK)
      ON p.external_database_connection_key=b.external_database_connection_key
    JOIN settings.catalog_match_key_registry k WITH (HOLDLOCK)
      ON k.portal_environment=j.portal_environment AND k.match_key_version=j.match_key_version
    WHERE j.job_id=@jobId AND j.worker_id=@workerId AND j.lease_token=@leaseToken AND j.attempt_no=@attempt
      AND j.job_status=''processing'' AND j.finished_at IS NULL
      AND j.portal_environment=@environment AND b.portal_environment COLLATE Latin1_General_100_BIN2=@environment COLLATE Latin1_General_100_BIN2
      AND DATALENGTH(b.portal_environment)=DATALENGTH(@environment) AND b.source_id=@sourceId
      AND b.source_role COLLATE Latin1_General_100_BIN2=''erp-customers'' AND DATALENGTH(b.source_role)=13
      AND b.contract_version COLLATE Latin1_General_100_BIN2=''erp_v1'' AND DATALENGTH(b.contract_version)=6
      AND b.source_state=''active'' AND b.validated_at<=SYSUTCDATETIME()
      AND j.binding_version=@bindingVersion AND b.row_version=@bindingVersion
      AND j.profile_version=@profileVersion AND b.validated_profile_version=@profileVersion AND p.row_version=@profileVersion
      AND p.active=1 AND p.status=''active'' AND p.encrypt_connection=1 AND p.password_configured=1
      AND j.match_key_version=@matchKeyVersion AND k.vault_secret_version=@vaultSecretVersion AND k.key_verifier=@keyVerifier;

    SET @now=SYSUTCDATETIME();
    IF @jobKey IS NULL OR @leaseUntil IS NULL OR @leaseUntil<=@now OR @bindingScope IS NULL
      OR DATALENGTH(@bindingScope) NOT BETWEEN 8 AND 70
      OR @bindingScope COLLATE Latin1_General_100_BIN2 NOT LIKE N''[A-Z][A-Z]:[A-Z]%''
      OR REPLACE(SUBSTRING(@bindingScope,4,32),N''-'',N'''') COLLATE Latin1_General_100_BIN2 LIKE N''%[^A-Z0-9_]%''
      THROW 56505,N''ERP publication authorization or lease unavailable.'',1;

    SELECT @claimedAt=occurred_at FROM settings.catalog_source_refresh_attempts WITH (HOLDLOCK)
      WHERE job_key=@jobKey AND attempt_no=@attempt AND event_kind=''claimed'';
    IF @claimedAt IS NULL OR @claimedAt<@requestedAt OR @claimedAt>@now
      THROW 56505,N''ERP publication authorization or lease unavailable.'',1;
    IF @reserved IS NOT NULL
    BEGIN
      SELECT @reservedAt=occurred_at FROM settings.catalog_source_refresh_attempts WITH (HOLDLOCK)
        WHERE job_key=@jobKey AND attempt_no=@attempt AND event_kind=''reserved'' AND attempt_ordinal=@reserved;
      IF @reservedAt IS NULL OR @reservedAt<@claimedAt OR @reservedAt>@now
        THROW 56505,N''ERP publication authorization or lease unavailable.'',1;
    END;

    IF @operation=''R''
    BEGIN
      IF @reserved IS NULL
      BEGIN
        SET @reserved=NEXT VALUE FOR settings.catalog_customer_attempt_sequence;
        SET @reservedAt=SYSUTCDATETIME();
        UPDATE settings.catalog_source_refresh_jobs SET attempt_ordinal=@reserved
          WHERE job_key=@jobKey AND attempt_ordinal IS NULL AND lease_expires_at>SYSUTCDATETIME();
        IF @@ROWCOUNT<>1 THROW 56505,N''ERP publication authorization or lease unavailable.'',1;
        INSERT settings.catalog_source_refresh_attempts(job_key,attempt_no,attempt_ordinal,event_kind,occurred_at)
          VALUES(@jobKey,@attempt,@reserved,''reserved'',@reservedAt);
      END;
    END
    ELSE
    BEGIN
      -- Only SQL''s reservation clock can establish freshness. The worker clock
      -- must be near the fenced attempt and can never extend its lifetime.
      IF @reserved IS NULL OR @attemptOrdinal<>@reserved
        OR @observedAt<DATEADD(second,-10,@claimedAt) OR @observedAt>DATEADD(second,10,@reservedAt)
        THROW 56505,N''ERP publication authorization or lease unavailable.'',1;
      SET @freshUntil=DATEADD(minute,30,@reservedAt);
      SELECT @hadHead=1,@headOrdinal=h.attempt_ordinal,@headMatchVersion=r.match_key_version
      FROM settings.catalog_customer_revision_heads h WITH (UPDLOCK,HOLDLOCK)
      LEFT JOIN core.catalog_customer_source_revisions r WITH (HOLDLOCK) ON r.revision_key=h.revision_key
      WHERE h.catalog_source_key=@sourceKey;
      SET @result=CASE WHEN @attemptOrdinal<=@headOrdinal OR @matchKeyVersion<@headMatchVersion THEN ''superseded''
        WHEN @operation=''P'' THEN ''published'' ELSE ''failed'' END;

      IF @result=''published''
      BEGIN
        IF @rows IS NULL OR @rowCount IS NULL OR @rowCount NOT BETWEEN 0 AND 100000
          OR DATALENGTH(@rows)>33554432 OR ISJSON(@rows)<>1 OR LEFT(@rows,1)<>N''['' OR RIGHT(@rows,1)<>N'']''
          THROW 56506,N''Invalid ERP publication payload.'',1;
        IF (SELECT COUNT_BIG(*) FROM OPENJSON(@rows))<>@rowCount
          THROW 56506,N''Invalid ERP publication payload.'',1;
        DECLARE @shape table(key_name nvarchar(32) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY,
          json_type tinyint NOT NULL,nullable bit NOT NULL,max_bytes int NOT NULL);
        INSERT @shape VALUES(N''sourceRecordId'',2,0,22),(N''issuer'',1,1,4),(N''documentType'',1,1,64),
          (N''token'',1,1,128),(N''officialName'',1,1,1024),(N''activeCode'',1,1,2),(N''allocationId'',1,0,72);

        -- Reject silent truncation, duplicate/missing fields, nonobjects, and
        -- type changes before OPENJSON WITH performs any coercion.
        IF EXISTS(SELECT 1 FROM OPENJSON(@rows) item CROSS APPLY (
          SELECT COUNT_BIG(*) AS total,COUNT(DISTINCT s.key_name) AS matching,
            SUM(CASE WHEN s.key_name IS NOT NULL AND ((f.[type]=0 AND s.nullable=1)
              OR (f.[type]=s.json_type AND DATALENGTH(f.[value])<=s.max_bytes AND (s.json_type<>2 OR (
                TRY_CONVERT(int,CONVERT(nvarchar(11),f.[value])) IS NOT NULL
                AND f.[value] COLLATE Latin1_General_100_BIN2
                  =CONVERT(nvarchar(11),TRY_CONVERT(int,CONVERT(nvarchar(11),f.[value]))) COLLATE Latin1_General_100_BIN2
                AND DATALENGTH(f.[value])=DATALENGTH(CONVERT(nvarchar(11),TRY_CONVERT(int,CONVERT(nvarchar(11),f.[value]))))))))
              THEN 0 ELSE 1 END) AS invalid
          FROM OPENJSON(CASE WHEN item.[type]=5 THEN item.[value] ELSE N''{}'' END) f
          LEFT JOIN @shape s ON s.key_name=f.[key] COLLATE Latin1_General_100_BIN2 AND DATALENGTH(s.key_name)=DATALENGTH(f.[key])
        ) sig WHERE item.[type]<>5 OR sig.total<>7 OR sig.matching<>7 OR sig.invalid<>0)
          THROW 56506,N''Invalid ERP publication payload.'',1;

        DECLARE @erpInput table(
          source_record_id int NOT NULL PRIMARY KEY,issuer nvarchar(2) COLLATE Latin1_General_100_BIN2 NULL,
          document_type nvarchar(32) COLLATE Latin1_General_100_BIN2 NULL,token_text nvarchar(64) COLLATE Latin1_General_100_BIN2 NULL,
          token binary(32) NULL,official_name nvarchar(512) NULL,active_code nvarchar(1) COLLATE Latin1_General_100_BIN2 NULL,
          supplied_allocation nvarchar(36) COLLATE Latin1_General_100_BIN2 NOT NULL,allocation_id uniqueidentifier NULL,
          catalog_customer_key bigint NULL);
        INSERT @erpInput(source_record_id,issuer,document_type,token_text,official_name,active_code,supplied_allocation)
        SELECT sourceRecordId,issuer,documentType,token,officialName,activeCode,allocationId
        FROM OPENJSON(@rows) WITH(sourceRecordId int,issuer nvarchar(2),documentType nvarchar(32),token nvarchar(64),
          officialName nvarchar(512),activeCode nvarchar(1),allocationId nvarchar(36));

        IF EXISTS(SELECT 1 FROM @erpInput i WHERE
          DATALENGTH(supplied_allocation)<>72 OR TRY_CONVERT(uniqueidentifier,supplied_allocation) IS NULL
          OR LOWER(CONVERT(nvarchar(36),TRY_CONVERT(uniqueidentifier,supplied_allocation))) COLLATE Latin1_General_100_BIN2<>supplied_allocation
          OR (active_code IS NOT NULL AND (DATALENGTH(active_code)<>2 OR active_code NOT IN (N''S'',N''N'')))
          OR (official_name IS NOT NULL AND (DATALENGTH(official_name)=0
            OR DATALENGTH(official_name)<>DATALENGTH(LTRIM(RTRIM(official_name)))
            OR official_name COLLATE Latin1_General_100_BIN2 LIKE N''%[''+NCHAR(1)+N''-''+NCHAR(31)+NCHAR(127)+N''-''+NCHAR(159)+N'']%''))
          OR (token_text IS NULL AND (issuer IS NOT NULL OR document_type IS NOT NULL))
          OR (token_text IS NOT NULL AND (DATALENGTH(token_text)<>128 OR token_text LIKE N''%[^0-9a-f]%''
            OR issuer IS NULL OR document_type IS NULL
            OR DATALENGTH(CONCAT(issuer,N'':'',document_type))<>DATALENGTH(@bindingScope)
            OR CONCAT(issuer,N'':'',document_type) COLLATE Latin1_General_100_BIN2<>@bindingScope COLLATE Latin1_General_100_BIN2)))
          THROW 56506,N''Invalid ERP publication payload.'',1;
        UPDATE @erpInput SET token=CONVERT(binary(32),token_text,2) WHERE token_text IS NOT NULL;

        IF EXISTS(SELECT 1 FROM settings.catalog_source_bindings b
          JOIN settings.catalog_customer_revision_heads h ON h.catalog_source_key=b.catalog_source_key
          JOIN core.catalog_customer_source_revisions r ON r.revision_key=h.revision_key
          WHERE b.portal_environment COLLATE Latin1_General_100_BIN2=@environment COLLATE Latin1_General_100_BIN2
            AND DATALENGTH(b.portal_environment)=DATALENGTH(@environment)
            AND b.source_role=''erp-customers'' AND b.source_state=''active'' AND r.match_key_version<>@matchKeyVersion)
          THROW 56507,N''ERP protected identity requires reconciliation.'',1;

        DECLARE @erpMatches table(source_record_id int NOT NULL PRIMARY KEY,min_customer bigint NULL,max_customer bigint NULL);
        INSERT @erpMatches(source_record_id,min_customer,max_customer)
        SELECT i.source_record_id,MIN(rr.catalog_customer_key),MAX(rr.catalog_customer_key)
        FROM @erpInput i
        JOIN core.catalog_customer_revision_rows rr ON rr.source_role=''erp-customers''
          AND rr.issuer=CONVERT(char(2),i.issuer) COLLATE Latin1_General_100_BIN2
          AND rr.document_type=CONVERT(varchar(32),i.document_type) COLLATE Latin1_General_100_BIN2
          AND rr.document_number_token=i.token
        JOIN core.catalog_customer_source_revisions r ON r.revision_key=rr.revision_key
          AND r.match_key_version=@matchKeyVersion AND r.sealed_at IS NOT NULL
        JOIN settings.catalog_source_bindings b ON b.catalog_source_key=r.catalog_source_key
          AND b.portal_environment COLLATE Latin1_General_100_BIN2=@environment COLLATE Latin1_General_100_BIN2
          AND DATALENGTH(b.portal_environment)=DATALENGTH(@environment)
        GROUP BY i.source_record_id;
        IF EXISTS(SELECT 1 FROM @erpMatches WHERE min_customer<>max_customer)
          THROW 56507,N''ERP protected identity requires reconciliation.'',1;
        UPDATE i SET catalog_customer_key=m.min_customer
          FROM @erpInput i JOIN @erpMatches m ON m.source_record_id=i.source_record_id;

        ;WITH history AS (
          SELECT rr.source_record_id,rr.catalog_customer_key,rr.document_number_token,
            ROW_NUMBER() OVER(PARTITION BY rr.source_record_id ORDER BY r.revision_key DESC) AS position
          FROM core.catalog_customer_revision_rows rr
          JOIN core.catalog_customer_source_revisions r ON r.revision_key=rr.revision_key
          JOIN @erpInput i ON i.source_record_id=rr.source_record_id AND i.token IS NULL AND i.catalog_customer_key IS NULL
          WHERE r.catalog_source_key=@sourceKey AND r.binding_version=@bindingVersion AND r.profile_version=@profileVersion
            AND r.match_key_version=@matchKeyVersion AND r.sealed_at IS NOT NULL)
        UPDATE i SET catalog_customer_key=h.catalog_customer_key
          FROM @erpInput i JOIN history h ON h.source_record_id=i.source_record_id
          WHERE h.position=1 AND h.document_number_token IS NULL;

        -- Allocate once per new protected identity and once per unmatched
        -- source row. Do not accept an allocation chosen by the caller.
        UPDATE @erpInput SET allocation_id=NEWID() WHERE catalog_customer_key IS NULL;
        ;WITH allocations AS (
          SELECT issuer,document_type,token,MIN(source_record_id) AS representative
          FROM @erpInput WHERE token IS NOT NULL AND catalog_customer_key IS NULL GROUP BY issuer,document_type,token)
        UPDATE i SET allocation_id=rep.allocation_id
          FROM @erpInput i JOIN allocations g ON g.issuer=i.issuer AND g.document_type=i.document_type AND g.token=i.token
          JOIN @erpInput rep ON rep.source_record_id=g.representative
          WHERE i.catalog_customer_key IS NULL;
        INSERT core.catalog_customer_ids(customer_id)
          SELECT DISTINCT allocation_id FROM @erpInput WHERE catalog_customer_key IS NULL;
        UPDATE i SET catalog_customer_key=c.catalog_customer_key
          FROM @erpInput i JOIN core.catalog_customer_ids c ON c.customer_id=i.allocation_id
          WHERE i.catalog_customer_key IS NULL;

        INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,
          match_key_version,attempt_ordinal,expected_rows,expected_scopes,observed_at,verified_until)
        VALUES(@sourceKey,''erp-customers'',@bindingVersion,@profileVersion,@matchKeyVersion,@attemptOrdinal,@rowCount,0,@reservedAt,@freshUntil);
        SET @revisionKey=CONVERT(bigint,SCOPE_IDENTITY());
        INSERT core.catalog_customer_revision_rows(revision_key,source_role,source_record_id,catalog_customer_key,
          official_name,active_code,issuer,document_type,document_number_token)
        SELECT @revisionKey,''erp-customers'',source_record_id,catalog_customer_key,
          official_name,CONVERT(char(1),active_code),CONVERT(char(2),issuer),CONVERT(varchar(32),document_type),token
        FROM @erpInput;
        SET @now=SYSUTCDATETIME();
        IF @now>=@freshUntil OR @now>=@leaseUntil THROW 56505,N''ERP publication authorization or lease unavailable.'',1;
        UPDATE core.catalog_customer_source_revisions SET sealed_at=@now WHERE revision_key=@revisionKey;
      END;

      IF @result IN (''published'',''failed'')
      BEGIN
        SET @now=SYSUTCDATETIME();
        IF @now>=@leaseUntil THROW 56505,N''ERP publication authorization or lease unavailable.'',1;
        DECLARE @headStatus varchar(10)=CASE WHEN @result=''published'' THEN ''succeeded'' ELSE ''failed'' END;
        IF @hadHead=0
          INSERT settings.catalog_customer_revision_heads(catalog_source_key,revision_key,attempt_status,attempted_at,attempt_ordinal)
            VALUES(@sourceKey,@revisionKey,@headStatus,@now,@attemptOrdinal);
        ELSE IF @result=''published''
          UPDATE settings.catalog_customer_revision_heads SET revision_key=@revisionKey,attempt_status=@headStatus,
            attempted_at=@now,attempt_ordinal=@attemptOrdinal WHERE catalog_source_key=@sourceKey;
        ELSE
          UPDATE settings.catalog_customer_revision_heads SET attempt_status=@headStatus,
            attempted_at=@now,attempt_ordinal=@attemptOrdinal WHERE catalog_source_key=@sourceKey;

        DECLARE @metadata nvarchar(max)=(SELECT @environment AS environment,''erp-customers'' AS sourceRole,
          ''erp_v1'' AS contractVersion,@result AS status FOR JSON PATH,WITHOUT_ARRAY_WRAPPER);
        INSERT audit.audit_logs(source_id,entity_type,entity_source_id,action,performed_by,performed_by_email,performed_at,
          metadata_json,schema_version,data_classification)
        VALUES(CONCAT(N''audit_'',LOWER(CONVERT(char(36),NEWID()))),N''catalog_source_binding'',LOWER(CONVERT(char(36),@sourceId)),
          CASE WHEN @result=''published'' THEN N''catalog_source_refreshed'' ELSE N''catalog_source_refresh_failed'' END,
          N''system:catalog-refresh'',N''system'',@now,@metadata,1,''confidential'');
      END;

      -- Failure recording leaves the exact claim for the existing generic
      -- retry handler. Only publication owns the job transition, atomically.
      IF @operation=''P''
      BEGIN
        SET @now=SYSUTCDATETIME();
        SET @event=CASE WHEN @result=''published'' THEN ''succeeded'' ELSE ''superseded'' END;
        SELECT @successFreshUntil=r.verified_until FROM settings.catalog_customer_revision_heads h WITH (HOLDLOCK)
          JOIN core.catalog_customer_source_revisions r WITH (HOLDLOCK)
            ON r.revision_key=h.revision_key AND r.catalog_source_key=h.catalog_source_key
          WHERE h.catalog_source_key=@sourceKey AND h.attempt_status=''succeeded'' AND h.attempt_ordinal=r.attempt_ordinal
            AND ((@result=''published'' AND h.attempt_ordinal=@attemptOrdinal)
              OR (@result=''superseded'' AND h.attempt_ordinal>@attemptOrdinal))
            AND h.attempted_at<=@now AND r.source_role=''erp-customers''
            AND r.binding_version=@bindingVersion AND r.profile_version=@profileVersion AND r.match_key_version=@matchKeyVersion
            AND r.sealed_at<=@now AND r.observed_at<=@now AND r.verified_until>@now;
        IF @result=''published'' AND @successFreshUntil IS NULL
          THROW 56505,N''ERP publication authorization or lease unavailable.'',1;
        SET @jobStatus=CASE WHEN @successFreshUntil IS NOT NULL THEN ''succeeded'' ELSE ''cancelled'' END;
        UPDATE settings.catalog_source_refresh_jobs SET job_status=@jobStatus,updated_at=@now,finished_at=@now,
          attempt_ordinal=NULL,worker_id=NULL,lease_token=NULL,lease_expires_at=NULL
          WHERE job_key=@jobKey AND job_status=''processing'' AND finished_at IS NULL AND attempt_no=@attempt
            AND worker_id=@workerId AND lease_token=@leaseToken AND attempt_ordinal=@attemptOrdinal AND lease_expires_at>SYSUTCDATETIME();
        IF @@ROWCOUNT<>1 THROW 56505,N''ERP publication authorization or lease unavailable.'',1;
        INSERT settings.catalog_source_refresh_attempts(job_key,attempt_no,attempt_ordinal,event_kind,occurred_at)
          VALUES(@jobKey,@attempt,@attemptOrdinal,@event,@now);
      END;
    END;

    IF @leaseUntil<=SYSUTCDATETIME() OR (@jobStatus=''succeeded'' AND @successFreshUntil<=SYSUTCDATETIME())
      THROW 56505,N''ERP publication authorization or lease unavailable.'',1;
    COMMIT TRANSACTION;
  END TRY
  BEGIN CATCH
    IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
    -- SQL conversion/constraint errors may contain original payload values.
    THROW 56508,N''ERP owner publication failed safely.'',1;
  END CATCH;
  IF @operation=''R'' SELECT CONVERT(varchar(19),@reserved) AS attemptOrdinal;
  ELSE SELECT @result AS result;
END;';

  EXEC sys.sp_executesql N'CREATE OR ALTER PROCEDURE settings.reserve_catalog_erp_owner_attempt
  @environment varchar(32), @sourceId uniqueidentifier, @jobId uniqueidentifier, @workerId uniqueidentifier,
  @leaseToken uniqueidentifier, @attempt int, @bindingVersion varbinary(32), @profileVersion varbinary(32),
  @matchKeyVersion smallint, @vaultSecretVersion varbinary(64), @keyVerifier varbinary(64)
AS
BEGIN
  SET NOCOUNT ON;
  IF ORIGINAL_LOGIN() COLLATE Latin1_General_100_BIN2<>N''SAGWebDev'' OR DATALENGTH(ORIGINAL_LOGIN())<>18
    OR SUSER_SNAME() COLLATE Latin1_General_100_BIN2<>N''SAGWebDev'' OR DATALENGTH(SUSER_SNAME())<>18
    OR USER_NAME() COLLATE Latin1_General_100_BIN2<>N''SAGWebDev'' OR DATALENGTH(USER_NAME())<>18
    OR ISNULL(IS_SRVROLEMEMBER(N''sysadmin''),1)<>0 OR ISNULL(IS_ROLEMEMBER(N''db_owner''),0)<>1
    OR ISNULL(HAS_PERMS_BY_NAME(DB_NAME(),N''DATABASE'',N''CONTROL''),0)<>1
    OR @environment IS NULL OR NOT (
      (@environment COLLATE Latin1_General_100_BIN2=''qa'' AND DATALENGTH(@environment)=2
        AND DB_NAME() COLLATE Latin1_General_100_BIN2=N''PortalSAGWeb-TEST'' AND DATALENGTH(DB_NAME())=34)
      OR (@environment COLLATE Latin1_General_100_BIN2=''production'' AND DATALENGTH(@environment)=10
        AND DB_NAME() COLLATE Latin1_General_100_BIN2=N''PortalSAGWeb'' AND DATALENGTH(DB_NAME())=24))
    THROW 56504,N''ERP owner publication is unavailable.'',1;
  EXEC settings.catalog_erp_owner_dispatch_internal
    @operation=''R'',@environment=@environment,@sourceId=@sourceId,@jobId=@jobId,
    @workerId=@workerId,@leaseToken=@leaseToken,@attempt=@attempt,
    @bindingVersion=@bindingVersion,@profileVersion=@profileVersion,@matchKeyVersion=@matchKeyVersion,
    @vaultSecretVersion=@vaultSecretVersion,@keyVerifier=@keyVerifier;
END;';

  EXEC sys.sp_executesql N'CREATE OR ALTER PROCEDURE settings.publish_catalog_erp_owner
  @environment varchar(32), @sourceId uniqueidentifier, @jobId uniqueidentifier, @workerId uniqueidentifier,
  @leaseToken uniqueidentifier, @attempt int, @bindingVersion varbinary(32), @profileVersion varbinary(32),
  @matchKeyVersion smallint, @vaultSecretVersion varbinary(64), @keyVerifier varbinary(64), @attemptOrdinal bigint, @observedAt datetime2(3), @rowCount int, @rows nvarchar(max)
AS
BEGIN
  SET NOCOUNT ON;
  IF ORIGINAL_LOGIN() COLLATE Latin1_General_100_BIN2<>N''SAGWebDev'' OR DATALENGTH(ORIGINAL_LOGIN())<>18
    OR SUSER_SNAME() COLLATE Latin1_General_100_BIN2<>N''SAGWebDev'' OR DATALENGTH(SUSER_SNAME())<>18
    OR USER_NAME() COLLATE Latin1_General_100_BIN2<>N''SAGWebDev'' OR DATALENGTH(USER_NAME())<>18
    OR ISNULL(IS_SRVROLEMEMBER(N''sysadmin''),1)<>0 OR ISNULL(IS_ROLEMEMBER(N''db_owner''),0)<>1
    OR ISNULL(HAS_PERMS_BY_NAME(DB_NAME(),N''DATABASE'',N''CONTROL''),0)<>1
    OR @environment IS NULL OR NOT (
      (@environment COLLATE Latin1_General_100_BIN2=''qa'' AND DATALENGTH(@environment)=2
        AND DB_NAME() COLLATE Latin1_General_100_BIN2=N''PortalSAGWeb-TEST'' AND DATALENGTH(DB_NAME())=34)
      OR (@environment COLLATE Latin1_General_100_BIN2=''production'' AND DATALENGTH(@environment)=10
        AND DB_NAME() COLLATE Latin1_General_100_BIN2=N''PortalSAGWeb'' AND DATALENGTH(DB_NAME())=24))
    THROW 56504,N''ERP owner publication is unavailable.'',1;
  EXEC settings.catalog_erp_owner_dispatch_internal
    @operation=''P'',@environment=@environment,@sourceId=@sourceId,@jobId=@jobId,
    @workerId=@workerId,@leaseToken=@leaseToken,@attempt=@attempt,
    @bindingVersion=@bindingVersion,@profileVersion=@profileVersion,@matchKeyVersion=@matchKeyVersion,
    @vaultSecretVersion=@vaultSecretVersion,@keyVerifier=@keyVerifier,@attemptOrdinal=@attemptOrdinal,@observedAt=@observedAt,
    @rowCount=@rowCount,@rows=@rows;
END;';

  EXEC sys.sp_executesql N'CREATE OR ALTER PROCEDURE settings.fail_catalog_erp_owner_attempt
  @environment varchar(32), @sourceId uniqueidentifier, @jobId uniqueidentifier, @workerId uniqueidentifier,
  @leaseToken uniqueidentifier, @attempt int, @bindingVersion varbinary(32), @profileVersion varbinary(32),
  @matchKeyVersion smallint, @vaultSecretVersion varbinary(64), @keyVerifier varbinary(64), @attemptOrdinal bigint, @observedAt datetime2(3)
AS
BEGIN
  SET NOCOUNT ON;
  IF ORIGINAL_LOGIN() COLLATE Latin1_General_100_BIN2<>N''SAGWebDev'' OR DATALENGTH(ORIGINAL_LOGIN())<>18
    OR SUSER_SNAME() COLLATE Latin1_General_100_BIN2<>N''SAGWebDev'' OR DATALENGTH(SUSER_SNAME())<>18
    OR USER_NAME() COLLATE Latin1_General_100_BIN2<>N''SAGWebDev'' OR DATALENGTH(USER_NAME())<>18
    OR ISNULL(IS_SRVROLEMEMBER(N''sysadmin''),1)<>0 OR ISNULL(IS_ROLEMEMBER(N''db_owner''),0)<>1
    OR ISNULL(HAS_PERMS_BY_NAME(DB_NAME(),N''DATABASE'',N''CONTROL''),0)<>1
    OR @environment IS NULL OR NOT (
      (@environment COLLATE Latin1_General_100_BIN2=''qa'' AND DATALENGTH(@environment)=2
        AND DB_NAME() COLLATE Latin1_General_100_BIN2=N''PortalSAGWeb-TEST'' AND DATALENGTH(DB_NAME())=34)
      OR (@environment COLLATE Latin1_General_100_BIN2=''production'' AND DATALENGTH(@environment)=10
        AND DB_NAME() COLLATE Latin1_General_100_BIN2=N''PortalSAGWeb'' AND DATALENGTH(DB_NAME())=24))
    THROW 56504,N''ERP owner publication is unavailable.'',1;
  EXEC settings.catalog_erp_owner_dispatch_internal
    @operation=''F'',@environment=@environment,@sourceId=@sourceId,@jobId=@jobId,
    @workerId=@workerId,@leaseToken=@leaseToken,@attempt=@attempt,
    @bindingVersion=@bindingVersion,@profileVersion=@profileVersion,@matchKeyVersion=@matchKeyVersion,
    @vaultSecretVersion=@vaultSecretVersion,@keyVerifier=@keyVerifier,@attemptOrdinal=@attemptOrdinal,@observedAt=@observedAt;
END;';

  -- Static, same-owner references confer no direct rights on the delegate.
  -- Fail closed if the exact module/table/sequence ownership chain is different.
  DECLARE @objects065 table(object_id int NULL);
  INSERT @objects065 VALUES
    (OBJECT_ID(N'settings.catalog_erp_owner_dispatch_internal',N'P')),
    (OBJECT_ID(N'settings.reserve_catalog_erp_owner_attempt',N'P')),
    (OBJECT_ID(N'settings.publish_catalog_erp_owner',N'P')),
    (OBJECT_ID(N'settings.fail_catalog_erp_owner_attempt',N'P')),
    (OBJECT_ID(N'settings.catalog_source_bindings',N'U')),
    (OBJECT_ID(N'settings.external_database_connections',N'U')),
    (OBJECT_ID(N'settings.catalog_match_key_registry',N'U')),
    (OBJECT_ID(N'settings.catalog_source_refresh_jobs',N'U')),
    (OBJECT_ID(N'settings.catalog_source_refresh_attempts',N'U')),
    (OBJECT_ID(N'settings.catalog_customer_attempt_sequence',N'SO')),
    (OBJECT_ID(N'settings.catalog_customer_revision_heads',N'U')),
    (OBJECT_ID(N'settings.catalog_source_head_events',N'U')),
    (OBJECT_ID(N'core.catalog_customer_ids',N'U')),
    (OBJECT_ID(N'core.catalog_customer_source_revisions',N'U')),
    (OBJECT_ID(N'core.catalog_customer_revision_rows',N'U')),
    (OBJECT_ID(N'audit.audit_logs',N'U'));
  IF EXISTS(SELECT 1 FROM @objects065 expected LEFT JOIN sys.objects o ON o.object_id=expected.object_id
      LEFT JOIN sys.schemas s ON s.schema_id=o.schema_id
      WHERE o.object_id IS NULL OR COALESCE(o.principal_id,s.principal_id,-1)<>@dbo065)
    OR EXISTS(SELECT 1 FROM sys.database_permissions WHERE class=1 AND major_id IN (
      OBJECT_ID(N'settings.catalog_erp_owner_dispatch_internal',N'P'),
      OBJECT_ID(N'settings.reserve_catalog_erp_owner_attempt',N'P'),
      OBJECT_ID(N'settings.publish_catalog_erp_owner',N'P'),
      OBJECT_ID(N'settings.fail_catalog_erp_owner_attempt',N'P')))
    THROW 56503,N'The ERP static ownership chain is incomplete or has explicit grants.',1;
  IF @owns065=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns065=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
