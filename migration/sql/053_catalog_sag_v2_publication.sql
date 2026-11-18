/* Dedicated, worker-only SAG v2 publication. No principals are enrolled by this patch. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns053 bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns053=1 BEGIN TRANSACTION;
  IF DB_NAME() NOT IN(N'PortalSAGWeb',N'PortalSAGWeb-TEST')
    OR CAST(SERVERPROPERTY('ProductMajorVersion') AS int)<>15
    OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150)
    THROW 55301,N'Expected Portal database on SQL Server 2019 compatibility level 150.',1;
  DECLARE @lock053 int;
  EXEC @lock053=sys.sp_getapplock @Resource=N'portal-sag:migration:053:sag-v2-publication',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock053<0 THROW 55302,N'Could not reserve the SAG v2 publisher migration.',1;
  IF COL_LENGTH(N'core.catalog_customer_source_revisions',N'expected_sag_company_rows') IS NULL
    OR OBJECT_ID(N'core.catalog_sag_company_revision_rows',N'U') IS NULL
    OR OBJECT_ID(N'settings.catalog_source_head_events',N'U') IS NULL
    OR OBJECT_ID(N'settings.catalog_source_refresh_attempts',N'U') IS NULL
    OR DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NULL
    THROW 55303,N'Install the prerequisite catalog migrations and runtime role first.',1;

  IF DATABASE_PRINCIPAL_ID(N'portal_catalog_v2_publisher') IS NULL
    CREATE ROLE portal_catalog_v2_publisher AUTHORIZATION dbo;
  IF NOT EXISTS(SELECT 1 FROM sys.database_principals
    WHERE name=N'portal_catalog_v2_publisher' AND [type]='R' AND owning_principal_id=DATABASE_PRINCIPAL_ID(N'dbo'))
    THROW 55310,N'The SAG v2 publisher role has an unexpected owner or type.',1;

  -- These fixed modules share a same-database static ownership chain. No EXECUTE AS,
  -- user-defined SQL text, runtime membership grant, or weakening of existing DENYs.

  EXEC sys.sp_executesql N'CREATE OR ALTER PROCEDURE settings.catalog_sag_v2_transition_internal
  @environment varchar(32), @sourceId uniqueidentifier, @jobId uniqueidentifier, @workerId uniqueidentifier,
  @leaseToken uniqueidentifier, @attempt int, @bindingVersion varbinary(32), @profileVersion varbinary(32),
  @matchKeyVersion smallint, @vaultSecretVersion varbinary(64), @keyVerifier varbinary(64),
  @action varchar(12), @attemptOrdinal bigint=NULL, @customerCount int=NULL, @companyCount int=NULL,
  @customers nvarchar(max)=NULL, @companies nvarchar(max)=NULL,
  @result varchar(12) OUTPUT, @jobStatus varchar(12) OUTPUT, @reservedOrdinal bigint OUTPUT,
  @observedAt datetime2(3) OUTPUT, @leaseUntil datetime2(3) OUTPUT, @successFreshUntil datetime2(3)=NULL OUTPUT
AS
BEGIN
  SET NOCOUNT ON;
  IF @@TRANCOUNT<>1 OR XACT_STATE()<>1 OR (@@OPTIONS & 2)<>0
    OR NOT EXISTS(SELECT 1 FROM sys.dm_exec_sessions WHERE session_id=@@SPID AND transaction_isolation_level=4)
    THROW 55304,N''A committable serializable publication transaction is required.'',1;
  IF @action IS NULL OR @action COLLATE Latin1_General_100_BIN2 NOT IN (''reserve'',''publish'',''fail'')
    OR DATALENGTH(@action)<>LEN(@action) OR @environment IS NULL OR NOT (
      (@environment COLLATE Latin1_General_100_BIN2=''qa'' AND DATALENGTH(@environment)=2)
      OR (@environment COLLATE Latin1_General_100_BIN2=''production'' AND DATALENGTH(@environment)=10))
    OR @sourceId IS NULL OR @jobId IS NULL OR @workerId IS NULL OR @leaseToken IS NULL
    OR @attempt IS NULL OR @attempt NOT BETWEEN 1 AND 5
    OR @bindingVersion IS NULL OR DATALENGTH(@bindingVersion)<>8
    OR @profileVersion IS NULL OR DATALENGTH(@profileVersion)<>8
    OR @matchKeyVersion IS NULL OR @matchKeyVersion<=0
    OR @vaultSecretVersion IS NULL OR DATALENGTH(@vaultSecretVersion)<>16
    OR @keyVerifier IS NULL OR DATALENGTH(@keyVerifier)<>32
    OR (@action IN (''publish'',''fail'') AND (@attemptOrdinal IS NULL OR @attemptOrdinal<=0))
    THROW 55305,N''Invalid SAG v2 publication context.'',1;

  DECLARE @resource nvarchar(255)=N''portal-sag:catalog-customer-publication:''+@environment,@lockCode int;
  EXEC @lockCode=sys.sp_getapplock @Resource=@resource,@LockMode=N''Exclusive'',@LockOwner=N''Transaction'',
    @DbPrincipal=N''public'',@LockTimeout=5000;
  IF @lockCode<0 THROW 55306,N''Catalog publication lock unavailable.'',1;

  SELECT @result=NULL,@jobStatus=NULL,@reservedOrdinal=NULL,@observedAt=NULL,@leaseUntil=NULL,@successFreshUntil=NULL;
  DECLARE @jobKey bigint,@sourceKey bigint,@requestedAt datetime2(3);
  SELECT @jobKey=j.job_key,@sourceKey=b.catalog_source_key,@leaseUntil=j.lease_expires_at,
    @reservedOrdinal=j.attempt_ordinal,@requestedAt=j.requested_at
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
    AND b.source_role COLLATE Latin1_General_100_BIN2=''sag-admin'' AND DATALENGTH(b.source_role)=9
    AND b.contract_version COLLATE Latin1_General_100_BIN2=''sag_admin_v2'' AND DATALENGTH(b.contract_version)=12
    AND b.source_state=''active'' AND b.validated_at<=SYSUTCDATETIME()
    AND j.binding_version=@bindingVersion AND b.row_version=@bindingVersion
    AND j.profile_version=@profileVersion AND b.validated_profile_version=@profileVersion AND p.row_version=@profileVersion
    AND p.active=1 AND p.status=''active'' AND p.encrypt_connection=1 AND p.password_configured=1
    AND j.match_key_version=@matchKeyVersion AND k.vault_secret_version=@vaultSecretVersion AND k.key_verifier=@keyVerifier;
  DECLARE @now datetime2(3)=SYSUTCDATETIME();
  IF @jobKey IS NULL OR @leaseUntil<=SYSUTCDATETIME()
    THROW 55307,N''SAG v2 publication authorization or lease unavailable.'',1;

  IF @reservedOrdinal IS NOT NULL
    SELECT @observedAt=occurred_at FROM settings.catalog_source_refresh_attempts WITH (HOLDLOCK)
    WHERE job_key=@jobKey AND attempt_no=@attempt AND event_kind=''reserved'' AND attempt_ordinal=@reservedOrdinal;
  IF @reservedOrdinal IS NOT NULL AND (@observedAt IS NULL OR @observedAt<@requestedAt OR @observedAt>@now)
    THROW 55307,N''SAG v2 publication authorization or lease unavailable.'',1;

  IF @action=''reserve''
  BEGIN
    IF @reservedOrdinal IS NULL
    BEGIN
      SET @reservedOrdinal=NEXT VALUE FOR settings.catalog_customer_attempt_sequence;
      SET @observedAt=SYSUTCDATETIME();
      UPDATE settings.catalog_source_refresh_jobs SET attempt_ordinal=@reservedOrdinal WHERE job_key=@jobKey;
      INSERT settings.catalog_source_refresh_attempts(job_key,attempt_no,attempt_ordinal,event_kind,occurred_at)
      VALUES(@jobKey,@attempt,@reservedOrdinal,''reserved'',@observedAt);
    END;
    IF @leaseUntil<=SYSUTCDATETIME()
      THROW 55307,N''SAG v2 publication authorization or lease unavailable.'',1;
    SET @result=''reserved'';
    SET @jobStatus=''processing'';
    RETURN;
  END;

  IF @reservedOrdinal IS NULL OR @attemptOrdinal<>@reservedOrdinal
    THROW 55307,N''SAG v2 publication authorization or lease unavailable.'',1;
  DECLARE @hadHead bit=0,@headOrdinal bigint,@headMatchVersion smallint,@revisionKey bigint,
    @freshUntil datetime2(3)=DATEADD(minute,30,@observedAt),@event varchar(12);
  SELECT @hadHead=1,@headOrdinal=h.attempt_ordinal,@headMatchVersion=r.match_key_version
  FROM settings.catalog_customer_revision_heads h WITH (UPDLOCK,HOLDLOCK)
  LEFT JOIN core.catalog_customer_source_revisions r WITH (HOLDLOCK) ON r.revision_key=h.revision_key
  WHERE h.catalog_source_key=@sourceKey;

  DECLARE @obsolete bit=CASE WHEN @attemptOrdinal<=@headOrdinal OR @matchKeyVersion<@headMatchVersion THEN 1 ELSE 0 END;
  IF @action=''fail''
    SET @result=CASE WHEN @obsolete=1 THEN ''superseded'' ELSE ''failed'' END;
  ELSE
  BEGIN
    IF @customerCount IS NULL OR @companyCount IS NULL OR @customerCount NOT BETWEEN 0 AND 100000
      OR @companyCount NOT BETWEEN 0 AND 100000 OR CONVERT(bigint,@customerCount)+@companyCount>100000
      OR @customers IS NULL OR @companies IS NULL
      OR DATALENGTH(@customers)+DATALENGTH(@companies)>16777216
      OR ISJSON(@customers)<>1 OR ISJSON(@companies)<>1
      OR LEFT(LTRIM(@customers),1)<>N''['' OR LEFT(LTRIM(@companies),1)<>N''[''
      THROW 55308,N''Invalid SAG v2 publication payload.'',1;
    IF (SELECT COUNT_BIG(*) FROM OPENJSON(@customers))<>@customerCount
      OR (SELECT COUNT_BIG(*) FROM OPENJSON(@companies))<>@companyCount
      THROW 55308,N''Invalid SAG v2 publication payload.'',1;

    -- Inspect original JSON property names/types/widths before performing any lossy conversion.
    DECLARE @shape table(kind char(1) NOT NULL,key_name nvarchar(32) COLLATE Latin1_General_100_BIN2 NOT NULL,
      json_type tinyint NOT NULL,nullable bit NOT NULL,max_bytes int NOT NULL,PRIMARY KEY(kind,key_name));
    INSERT @shape(kind,key_name,json_type,nullable,max_bytes) VALUES
      (''u'',N''sourceRecordId'',2,0,22),(''u'',N''issuer'',1,1,4),(''u'',N''documentType'',1,1,64),(''u'',N''token'',1,1,128),
      (''u'',N''domainCandidate'',1,1,506),(''u'',N''environmentKind'',1,0,20),(''u'',N''licenseCodes'',1,1,50),
      (''u'',N''testStartedOn'',1,1,20),(''u'',N''productionStartedOn'',1,1,20),(''u'',N''demoStartedOn'',1,1,20),
      (''c'',N''companyRecordId'',2,0,22),(''c'',N''customerRecordId'',2,1,22),(''c'',N''displayName'',1,1,1024),(''c'',N''isAvailable'',3,1,10);
    IF EXISTS(
      SELECT 1 FROM (
        SELECT ''u'' AS kind,[value],[type] FROM OPENJSON(@customers)
        UNION ALL SELECT ''c'',[value],[type] FROM OPENJSON(@companies)
      ) items
      CROSS APPLY (
        SELECT COUNT_BIG(*) AS total,COUNT(DISTINCT s.key_name) AS matching,
          SUM(CASE WHEN s.key_name IS NOT NULL AND (
            (field.[type]=0 AND s.nullable=1)
            OR (field.[type]=s.json_type AND DATALENGTH(field.[value])<=s.max_bytes
              AND (s.json_type<>2 OR (
                TRY_CONVERT(int,CONVERT(nvarchar(11),field.[value])) IS NOT NULL
                AND field.[value] COLLATE Latin1_General_100_BIN2
                  =CONVERT(nvarchar(11),TRY_CONVERT(int,CONVERT(nvarchar(11),field.[value]))) COLLATE Latin1_General_100_BIN2
                AND DATALENGTH(field.[value])
                  =DATALENGTH(CONVERT(nvarchar(11),TRY_CONVERT(int,CONVERT(nvarchar(11),field.[value])))))))
            ) THEN 0 ELSE 1 END) AS invalid
        FROM OPENJSON(CASE WHEN items.[type]=5 THEN items.[value] ELSE N''{}'' END) AS field
        LEFT JOIN @shape s ON s.kind=items.kind AND s.key_name=field.[key] COLLATE Latin1_General_100_BIN2
          AND DATALENGTH(s.key_name)=DATALENGTH(field.[key])
      ) signature
      WHERE items.[type]<>5 OR signature.total<>CASE WHEN items.kind=''u'' THEN 10 ELSE 4 END
        OR signature.matching<>signature.total OR signature.invalid<>0)
      THROW 55308,N''Invalid SAG v2 publication payload.'',1;

    -- A source record can retain an unclassified HMAC; scopes are never guessed.
    DECLARE @customerRows table(source_record_id int NOT NULL PRIMARY KEY,
      issuer nvarchar(2) COLLATE Latin1_General_100_BIN2 NULL,document_type nvarchar(32) COLLATE Latin1_General_100_BIN2 NULL,
      token nvarchar(64) COLLATE Latin1_General_100_BIN2 NULL,domain_candidate nvarchar(253) COLLATE Latin1_General_100_BIN2 NULL,
      environment_kind nvarchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,license_codes nvarchar(25) COLLATE Latin1_General_100_BIN2 NULL,
      test_on nvarchar(10) NULL,production_on nvarchar(10) NULL,demo_on nvarchar(10) NULL);
    INSERT @customerRows(source_record_id,issuer,document_type,token,domain_candidate,environment_kind,license_codes,test_on,production_on,demo_on)
    SELECT sourceRecordId,issuer,documentType,token,domainCandidate,environmentKind,licenseCodes,testStartedOn,productionStartedOn,demoStartedOn
    FROM OPENJSON(@customers) WITH(sourceRecordId int,issuer nvarchar(2),documentType nvarchar(32),token nvarchar(64),
      domainCandidate nvarchar(253),environmentKind nvarchar(10),licenseCodes nvarchar(25),testStartedOn nvarchar(10),
      productionStartedOn nvarchar(10),demoStartedOn nvarchar(10));
    DECLARE @businessDate date=CONVERT(date,DATEADD(hour,-5,@observedAt));
    IF EXISTS(
      SELECT 1 FROM @customerRows c WHERE
        (c.token IS NOT NULL AND (DATALENGTH(c.token)<>128 OR c.token LIKE N''%[^0-9a-f]%''))
        OR (c.issuer IS NULL AND c.document_type IS NOT NULL)
        OR (c.issuer IS NOT NULL AND (c.token IS NULL OR c.document_type IS NULL
          OR DATALENGTH(c.issuer)<>4 OR c.issuer NOT LIKE N''[A-Z][A-Z]''
          OR c.document_type NOT LIKE N''[A-Z0-9]%'' OR c.document_type LIKE N''%[^A-Z0-9_-]%''))
        OR c.environment_kind NOT IN (N''test'',N''production'',N''demo'',N''unknown'')
        OR DATALENGTH(c.environment_kind)<>2*LEN(c.environment_kind)
        OR (c.domain_candidate IS NOT NULL AND c.domain_candidate LIKE N''%[^a-z0-9.-]%'')
        OR (c.license_codes IS NOT NULL AND (c.license_codes LIKE N''%[^A-SU-Z]%''
          OR EXISTS(SELECT 1 FROM (VALUES(0),(1),(2),(3),(4)) a(n)
                CROSS JOIN (VALUES(0),(1),(2),(3),(4)) b(n)
                CROSS APPLY (VALUES(a.n*5+b.n+1)) position(n)
                WHERE position.n<LEN(c.license_codes)
                  AND SUBSTRING(c.license_codes,position.n,1)>=SUBSTRING(c.license_codes,position.n+1,1))))
        OR EXISTS(SELECT 1 FROM (VALUES(c.test_on),(c.production_on),(c.demo_on)) d(text_date)
          WHERE d.text_date IS NOT NULL AND (DATALENGTH(d.text_date)<>20
            OR TRY_CONVERT(date,d.text_date,23) IS NULL
            OR CONVERT(nvarchar(10),TRY_CONVERT(date,d.text_date,23),23) COLLATE Latin1_General_100_BIN2
                 <>d.text_date COLLATE Latin1_General_100_BIN2
            OR TRY_CONVERT(date,d.text_date,23)>@businessDate)))
      THROW 55308,N''Invalid SAG v2 publication payload.'',1;

    DECLARE @companyRows table(company_record_id int NOT NULL PRIMARY KEY,customer_record_id int NULL,
      display_name nvarchar(512) NULL,is_available bit NULL);
    INSERT @companyRows(company_record_id,customer_record_id,display_name,is_available)
      SELECT companyRecordId,customerRecordId,displayName,isAvailable
      FROM OPENJSON(@companies) WITH(companyRecordId int,customerRecordId int,displayName nvarchar(512),isAvailable bit);

    IF @obsolete=1 SET @result=''superseded'';
    ELSE
    BEGIN
      SET @now=SYSUTCDATETIME();
    IF @freshUntil<=@now OR @leaseUntil<=SYSUTCDATETIME()
      THROW 55307,N''SAG v2 publication authorization or lease unavailable.'',1;
    DECLARE @newRevision table(revision_key bigint NOT NULL);
    INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,match_key_version,
      attempt_ordinal,expected_rows,expected_scopes,observed_at,verified_until,has_sag_inventory_evidence,expected_sag_company_rows)
    OUTPUT inserted.revision_key INTO @newRevision
    VALUES(@sourceKey,''sag-admin'',@bindingVersion,@profileVersion,@matchKeyVersion,
      @attemptOrdinal,@customerCount,0,@observedAt,@freshUntil,1,@companyCount);
    SELECT @revisionKey=revision_key FROM @newRevision;
    INSERT core.catalog_customer_revision_rows(revision_key,source_role,source_record_id,issuer,document_type,document_number_token)
      SELECT @revisionKey,''sag-admin'',source_record_id,issuer,document_type,CONVERT(binary(32),token,2) FROM @customerRows;
    INSERT core.catalog_sag_revision_evidence(revision_key,source_record_id,domain_candidate,environment_kind,
      license_codes,test_started_on,production_started_on,demo_started_on)
      SELECT @revisionKey,source_record_id,domain_candidate,environment_kind,license_codes,
        CONVERT(date,test_on,23),CONVERT(date,production_on,23),CONVERT(date,demo_on,23) FROM @customerRows;
    -- Keep nullable and unmatched Customer IDs as source facts, not as operational links.
    INSERT core.catalog_sag_company_revision_rows(revision_key,company_record_id,customer_record_id,display_name,is_available)
      SELECT @revisionKey,company_record_id,customer_record_id,display_name,is_available FROM @companyRows;
    SET @now=SYSUTCDATETIME();
    IF @freshUntil<=@now OR @leaseUntil<=SYSUTCDATETIME()
      THROW 55307,N''SAG v2 publication authorization or lease unavailable.'',1;
    UPDATE core.catalog_customer_source_revisions SET sealed_at=@now WHERE revision_key=@revisionKey;
    SET @result=''published'';
    END;
  END;

  SET @now=SYSUTCDATETIME();
  IF @leaseUntil<=SYSUTCDATETIME() OR (@result=''published'' AND @freshUntil<=@now)
    THROW 55307,N''SAG v2 publication authorization or lease unavailable.'',1;

  IF @result IN (''published'',''failed'')
  BEGIN
    DECLARE @headStatus varchar(10)=CASE WHEN @result=''published'' THEN ''succeeded'' ELSE ''failed'' END;
    IF @hadHead=1
    BEGIN
      IF @result=''published''
        UPDATE settings.catalog_customer_revision_heads SET revision_key=@revisionKey,
          attempt_status=@headStatus,attempted_at=@now,attempt_ordinal=@attemptOrdinal WHERE catalog_source_key=@sourceKey;
      ELSE
        UPDATE settings.catalog_customer_revision_heads SET attempt_status=@headStatus,
          attempted_at=@now,attempt_ordinal=@attemptOrdinal WHERE catalog_source_key=@sourceKey;
    END
    ELSE
      INSERT settings.catalog_customer_revision_heads(catalog_source_key,revision_key,attempt_status,attempted_at,attempt_ordinal)
      VALUES(@sourceKey,@revisionKey,@headStatus,@now,@attemptOrdinal);

    DECLARE @metadata nvarchar(max)=(SELECT @environment AS environment,''sag-admin'' AS sourceRole,
      ''sag_admin_v2'' AS contractVersion,@result AS status FOR JSON PATH,WITHOUT_ARRAY_WRAPPER);
    INSERT audit.audit_logs(source_id,entity_type,entity_source_id,action,performed_by,performed_by_email,performed_at,
      metadata_json,schema_version,data_classification)
    VALUES(CONCAT(N''audit_'',LOWER(CONVERT(char(36),NEWID()))),N''catalog_source_binding'',LOWER(CONVERT(char(36),@sourceId)),
      CASE WHEN @result=''published'' THEN N''catalog_source_refreshed'' ELSE N''catalog_source_refresh_failed'' END,
      N''system:catalog-refresh'',N''system'',@now,@metadata,1,''confidential'');
  END;

  SET @now=SYSUTCDATETIME();
  IF @result=''published''
  BEGIN
    SET @jobStatus=''succeeded'';
    SET @event=''succeeded'';
    SET @successFreshUntil=@freshUntil;
  END
  ELSE IF @result=''failed''
  BEGIN
    SET @jobStatus=CASE WHEN @attempt>=5 THEN ''failed'' ELSE ''retry'' END;
    SET @event=@jobStatus;
  END
  ELSE
  BEGIN
    SET @event=''superseded'';
    SELECT @successFreshUntil=r.verified_until FROM settings.catalog_customer_revision_heads h WITH (HOLDLOCK)
      JOIN core.catalog_customer_source_revisions r WITH (HOLDLOCK)
        ON r.revision_key=h.revision_key AND r.catalog_source_key=h.catalog_source_key
      WHERE h.catalog_source_key=@sourceKey AND h.attempt_status=''succeeded''
        AND h.attempt_ordinal>@attemptOrdinal AND h.attempt_ordinal=r.attempt_ordinal AND h.attempted_at<=@now
        AND r.binding_version=@bindingVersion AND r.profile_version=@profileVersion AND r.match_key_version=@matchKeyVersion
        AND r.has_sag_inventory_evidence=1 AND r.expected_sag_company_rows IS NOT NULL
        AND r.sealed_at<=@now AND r.observed_at<=@now AND r.verified_until>@now;
    SET @jobStatus=CASE WHEN @successFreshUntil IS NOT NULL THEN ''succeeded'' ELSE ''cancelled'' END;
  END;
  UPDATE settings.catalog_source_refresh_jobs SET job_status=@jobStatus,updated_at=@now,
    finished_at=CASE WHEN @jobStatus=''retry'' THEN NULL ELSE @now END,
    available_at=CASE WHEN @jobStatus=''retry'' THEN DATEADD(second,
      CASE @attempt WHEN 1 THEN 30 WHEN 2 THEN 60 WHEN 3 THEN 120 WHEN 4 THEN 240 ELSE 300 END,@now) ELSE available_at END,
    attempt_ordinal=NULL,worker_id=NULL,lease_token=NULL,lease_expires_at=NULL
  WHERE job_key=@jobKey AND job_status=''processing'' AND finished_at IS NULL AND attempt_no=@attempt
    AND worker_id=@workerId AND lease_token=@leaseToken AND attempt_ordinal=@attemptOrdinal
    AND lease_expires_at>SYSUTCDATETIME();
  IF @@ROWCOUNT<>1 THROW 55307,N''SAG v2 publication authorization or lease unavailable.'',1;
  INSERT settings.catalog_source_refresh_attempts(job_key,attempt_no,attempt_ordinal,event_kind,occurred_at)
    VALUES(@jobKey,@attempt,@attemptOrdinal,@event,@now);
  IF @leaseUntil<=SYSUTCDATETIME() OR (@jobStatus=''succeeded'' AND (@successFreshUntil IS NULL OR @successFreshUntil<=SYSUTCDATETIME()))
    THROW 55307,N''SAG v2 publication authorization or lease unavailable.'',1;
END;';

  EXEC sys.sp_executesql N'CREATE OR ALTER PROCEDURE settings.reserve_catalog_sag_v2_attempt
  @environment varchar(32), @sourceId uniqueidentifier, @jobId uniqueidentifier,@workerId uniqueidentifier,
  @leaseToken uniqueidentifier,@attempt int,@bindingVersion varbinary(32),@profileVersion varbinary(32),
  @matchKeyVersion smallint,@vaultSecretVersion varbinary(64),@keyVerifier varbinary(64)
AS
BEGIN
  SET NOCOUNT ON;
  IF @@TRANCOUNT<>0 OR (@@OPTIONS & 2)<>0
    THROW 55309,N''SAG v2 publication requires an independent transaction.'',1;
  IF ISNULL(IS_ROLEMEMBER(N''portal_catalog_v2_publisher''),0)<>1
    THROW 55307,N''SAG v2 publication authorization or lease unavailable.'',1;
  SET XACT_ABORT ON;
  SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
  DECLARE @result varchar(12),@jobStatus varchar(12),@reservedOrdinal bigint,@observedAt datetime2(3),@leaseUntil datetime2(3);
  BEGIN TRY
    BEGIN TRANSACTION;
    EXEC settings.catalog_sag_v2_transition_internal
      @environment=@environment,@sourceId=@sourceId,@jobId=@jobId,@workerId=@workerId,
      @leaseToken=@leaseToken,@attempt=@attempt,@bindingVersion=@bindingVersion,@profileVersion=@profileVersion,
      @matchKeyVersion=@matchKeyVersion,@vaultSecretVersion=@vaultSecretVersion,@keyVerifier=@keyVerifier,
      @action=''reserve'',
      @result=@result OUTPUT,@jobStatus=@jobStatus OUTPUT,@reservedOrdinal=@reservedOrdinal OUTPUT,
      @observedAt=@observedAt OUTPUT,@leaseUntil=@leaseUntil OUTPUT;
    IF @leaseUntil IS NULL OR @leaseUntil<=SYSUTCDATETIME()
      THROW 55307,N''SAG v2 publication authorization or lease unavailable.'',1;
    COMMIT TRANSACTION;
  END TRY
  BEGIN CATCH
    IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
    THROW;
  END CATCH;
  SELECT CONVERT(varchar(19),@reservedOrdinal) AS attemptOrdinal,@observedAt AS observedAt;
END;';

  EXEC sys.sp_executesql N'CREATE OR ALTER PROCEDURE settings.publish_catalog_sag_v2_revision
  @environment varchar(32), @sourceId uniqueidentifier, @jobId uniqueidentifier,@workerId uniqueidentifier,
  @leaseToken uniqueidentifier,@attempt int,@bindingVersion varbinary(32),@profileVersion varbinary(32),
  @matchKeyVersion smallint,@vaultSecretVersion varbinary(64),@keyVerifier varbinary(64),@attemptOrdinal bigint,
  @customerCount int,@companyCount int,@customers nvarchar(max),@companies nvarchar(max)
AS
BEGIN
  SET NOCOUNT ON;
  IF @@TRANCOUNT<>0 OR (@@OPTIONS & 2)<>0
    THROW 55309,N''SAG v2 publication requires an independent transaction.'',1;
  IF ISNULL(IS_ROLEMEMBER(N''portal_catalog_v2_publisher''),0)<>1
    THROW 55307,N''SAG v2 publication authorization or lease unavailable.'',1;
  SET XACT_ABORT ON;
  SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
  DECLARE @result varchar(12),@jobStatus varchar(12),@reservedOrdinal bigint,@observedAt datetime2(3),
    @leaseUntil datetime2(3),@successFreshUntil datetime2(3);
  BEGIN TRY
    BEGIN TRANSACTION;
    EXEC settings.catalog_sag_v2_transition_internal
      @environment=@environment,@sourceId=@sourceId,@jobId=@jobId,@workerId=@workerId,
      @leaseToken=@leaseToken,@attempt=@attempt,@bindingVersion=@bindingVersion,@profileVersion=@profileVersion,
      @matchKeyVersion=@matchKeyVersion,@vaultSecretVersion=@vaultSecretVersion,@keyVerifier=@keyVerifier,
      @action=''publish'',@attemptOrdinal=@attemptOrdinal,
      @customerCount=@customerCount,@companyCount=@companyCount,@customers=@customers,@companies=@companies,
      @result=@result OUTPUT,@jobStatus=@jobStatus OUTPUT,@reservedOrdinal=@reservedOrdinal OUTPUT,
      @observedAt=@observedAt OUTPUT,@leaseUntil=@leaseUntil OUTPUT,@successFreshUntil=@successFreshUntil OUTPUT;
    IF @leaseUntil IS NULL OR @leaseUntil<=SYSUTCDATETIME()
      OR (@jobStatus=''succeeded'' AND (@successFreshUntil IS NULL OR @successFreshUntil<=SYSUTCDATETIME()))
      THROW 55307,N''SAG v2 publication authorization or lease unavailable.'',1;
    COMMIT TRANSACTION;
  END TRY
  BEGIN CATCH
    IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
    THROW;
  END CATCH;
  SELECT @result AS result,@jobStatus AS jobStatus;
END;';

  EXEC sys.sp_executesql N'CREATE OR ALTER PROCEDURE settings.fail_catalog_sag_v2_attempt
  @environment varchar(32), @sourceId uniqueidentifier, @jobId uniqueidentifier,@workerId uniqueidentifier,
  @leaseToken uniqueidentifier,@attempt int,@bindingVersion varbinary(32),@profileVersion varbinary(32),
  @matchKeyVersion smallint,@vaultSecretVersion varbinary(64),@keyVerifier varbinary(64),@attemptOrdinal bigint
AS
BEGIN
  SET NOCOUNT ON;
  IF @@TRANCOUNT<>0 OR (@@OPTIONS & 2)<>0
    THROW 55309,N''SAG v2 publication requires an independent transaction.'',1;
  IF ISNULL(IS_ROLEMEMBER(N''portal_catalog_v2_publisher''),0)<>1
    THROW 55307,N''SAG v2 publication authorization or lease unavailable.'',1;
  SET XACT_ABORT ON;
  SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
  DECLARE @result varchar(12),@jobStatus varchar(12),@reservedOrdinal bigint,@observedAt datetime2(3),
    @leaseUntil datetime2(3),@successFreshUntil datetime2(3);
  BEGIN TRY
    BEGIN TRANSACTION;
    EXEC settings.catalog_sag_v2_transition_internal
      @environment=@environment,@sourceId=@sourceId,@jobId=@jobId,@workerId=@workerId,
      @leaseToken=@leaseToken,@attempt=@attempt,@bindingVersion=@bindingVersion,@profileVersion=@profileVersion,
      @matchKeyVersion=@matchKeyVersion,@vaultSecretVersion=@vaultSecretVersion,@keyVerifier=@keyVerifier,
      @action=''fail'',@attemptOrdinal=@attemptOrdinal,
      @result=@result OUTPUT,@jobStatus=@jobStatus OUTPUT,@reservedOrdinal=@reservedOrdinal OUTPUT,
      @observedAt=@observedAt OUTPUT,@leaseUntil=@leaseUntil OUTPUT,@successFreshUntil=@successFreshUntil OUTPUT;
    IF @leaseUntil IS NULL OR @leaseUntil<=SYSUTCDATETIME()
      OR (@jobStatus=''succeeded'' AND (@successFreshUntil IS NULL OR @successFreshUntil<=SYSUTCDATETIME()))
      THROW 55307,N''SAG v2 publication authorization or lease unavailable.'',1;
    COMMIT TRANSACTION;
  END TRY
  BEGIN CATCH
    IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
    THROW;
  END CATCH;
  SELECT @result AS result,@jobStatus AS jobStatus;
END;';


  DECLARE @owned053 table(object_id int NULL);
  INSERT @owned053 VALUES
    (OBJECT_ID(N'settings.catalog_sag_v2_transition_internal',N'P')),
    (OBJECT_ID(N'settings.reserve_catalog_sag_v2_attempt',N'P')),
    (OBJECT_ID(N'settings.publish_catalog_sag_v2_revision',N'P')),
    (OBJECT_ID(N'settings.fail_catalog_sag_v2_attempt',N'P')),
    (OBJECT_ID(N'settings.catalog_source_bindings',N'U')),
    (OBJECT_ID(N'settings.external_database_connections',N'U')),
    (OBJECT_ID(N'settings.catalog_match_key_registry',N'U')),
    (OBJECT_ID(N'settings.catalog_source_refresh_jobs',N'U')),
    (OBJECT_ID(N'settings.catalog_source_refresh_attempts',N'U')),
    (OBJECT_ID(N'settings.catalog_customer_attempt_sequence',N'SO')),
    (OBJECT_ID(N'settings.catalog_customer_revision_heads',N'U')),
    (OBJECT_ID(N'settings.catalog_source_head_events',N'U')),
    (OBJECT_ID(N'core.catalog_customer_source_revisions',N'U')),
    (OBJECT_ID(N'core.catalog_customer_revision_rows',N'U')),
    (OBJECT_ID(N'core.catalog_customer_revision_scopes',N'U')),
    (OBJECT_ID(N'core.catalog_sag_revision_evidence',N'U')),
    (OBJECT_ID(N'core.catalog_sag_company_revision_rows',N'U')),
    (OBJECT_ID(N'audit.audit_logs',N'U'));
  IF EXISTS(SELECT 1 FROM @owned053 expected
    LEFT JOIN sys.objects o ON o.object_id=expected.object_id
    LEFT JOIN sys.schemas s ON s.schema_id=o.schema_id
    WHERE o.object_id IS NULL OR COALESCE(o.principal_id,s.principal_id,-1)<>DATABASE_PRINCIPAL_ID(N'dbo'))
    THROW 55310,N'The SAG v2 static ownership chain is incomplete.',1;

  REVOKE EXECUTE ON OBJECT::settings.catalog_sag_v2_transition_internal FROM public;
  REVOKE EXECUTE ON OBJECT::settings.catalog_sag_v2_transition_internal FROM portal_catalog_v2_publisher;
  DENY EXECUTE ON OBJECT::settings.catalog_sag_v2_transition_internal TO portal_runtime;
  REVOKE EXECUTE ON OBJECT::settings.reserve_catalog_sag_v2_attempt FROM public;
  DENY EXECUTE ON OBJECT::settings.reserve_catalog_sag_v2_attempt TO portal_runtime;
  GRANT EXECUTE ON OBJECT::settings.reserve_catalog_sag_v2_attempt TO portal_catalog_v2_publisher;
  REVOKE EXECUTE ON OBJECT::settings.publish_catalog_sag_v2_revision FROM public;
  DENY EXECUTE ON OBJECT::settings.publish_catalog_sag_v2_revision TO portal_runtime;
  GRANT EXECUTE ON OBJECT::settings.publish_catalog_sag_v2_revision TO portal_catalog_v2_publisher;
  REVOKE EXECUTE ON OBJECT::settings.fail_catalog_sag_v2_attempt FROM public;
  DENY EXECUTE ON OBJECT::settings.fail_catalog_sag_v2_attempt TO portal_runtime;
  GRANT EXECUTE ON OBJECT::settings.fail_catalog_sag_v2_attempt TO portal_catalog_v2_publisher;

  IF @owns053=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns053=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
