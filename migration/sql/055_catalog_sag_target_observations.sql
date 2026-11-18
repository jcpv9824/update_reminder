/* Immutable, HMAC-only Company location observations. No backfill, enrollment,
   physical identity proof, operational links, or changes to installed RPCs. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns055 bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns055=1 BEGIN TRANSACTION;
  IF NOT ((DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb' AND DATALENGTH(DB_NAME())=24)
      OR (DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb-TEST' AND DATALENGTH(DB_NAME())=34))
    OR CAST(SERVERPROPERTY('ProductMajorVersion') AS int)<>15
    OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150
      AND collation_name=N'Modern_Spanish_CI_AS')
    THROW 55501,N'Expected Portal database on SQL Server 2019 compatibility level 150.',1;

  DECLARE @lock055 int;
  EXEC @lock055=sys.sp_getapplock @Resource=N'portal-sag:migration:055:sag-target-observations',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock055<0 THROW 55502,N'Could not reserve the target observation migration.',1;
  IF OBJECT_ID(N'core.catalog_sql_target_instance_identities',N'U') IS NULL
    OR OBJECT_ID(N'core.catalog_sag_company_revision_rows',N'U') IS NULL
    OR OBJECT_ID(N'core.PK_catalog_sag_company_revision_rows',N'PK') IS NULL
    OR OBJECT_ID(N'core.TR_catalog_sag_company_revision_seal',N'TR') IS NULL
    OR OBJECT_ID(N'settings.catalog_sag_v2_transition_internal',N'P') IS NULL
    OR OBJECT_ID(N'settings.publish_catalog_sag_v2_revision',N'P') IS NULL
    OR COL_LENGTH(N'core.catalog_customer_source_revisions',N'expected_sag_company_rows') IS NULL
    OR DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NULL
    OR NOT EXISTS (SELECT 1 FROM sys.database_principals
      WHERE name=N'portal_catalog_v2_publisher' AND [type]='R' AND owning_principal_id=DATABASE_PRINCIPAL_ID(N'dbo'))
    THROW 55503,N'Install the reviewed catalog prerequisites and dedicated role first.',1;

  IF OBJECT_ID(N'core.catalog_sag_company_location_observations',N'U') IS NULL
    CREATE TABLE core.catalog_sag_company_location_observations (
      revision_key bigint NOT NULL,
      company_record_id int NOT NULL,
      observation_state varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,
      location_token binary(32) NULL,
      format_version tinyint NOT NULL CONSTRAINT DF_catalog_sag_location_observations_format DEFAULT 1,
      CONSTRAINT PK_catalog_sag_company_location_observations PRIMARY KEY CLUSTERED(revision_key,company_record_id),
      CONSTRAINT FK_catalog_sag_company_location_observations_company FOREIGN KEY(revision_key,company_record_id)
        REFERENCES core.catalog_sag_company_revision_rows(revision_key,company_record_id),
      CONSTRAINT CK_catalog_sag_location_observations_token CHECK (
        format_version=1 AND (
          (observation_state='candidate' AND DATALENGTH(observation_state)=9 AND location_token IS NOT NULL)
          OR (observation_state='unverified' AND DATALENGTH(observation_state)=10 AND location_token IS NULL)))
    );

  IF OBJECT_ID(N'core.catalog_sag_company_location_seals',N'U') IS NULL
    CREATE TABLE core.catalog_sag_company_location_seals (
      revision_key bigint NOT NULL,
      expected_company_rows int NOT NULL,
      sealed_at datetime2(3) NOT NULL,
      CONSTRAINT PK_catalog_sag_company_location_seals PRIMARY KEY CLUSTERED(revision_key),
      CONSTRAINT FK_catalog_sag_company_location_seals_revision FOREIGN KEY(revision_key)
        REFERENCES core.catalog_customer_source_revisions(revision_key),
      CONSTRAINT CK_catalog_sag_company_location_seals_count CHECK (expected_company_rows BETWEEN 0 AND 100000)
    );

  -- The revision lock serializes each observation insert against installation
  -- of its companion seal. The FK prevents non-Company rows and the PK prevents duplicates.
  EXEC sys.sp_executesql N'CREATE OR ALTER TRIGGER core.TR_catalog_sag_company_location_observations_guard
    ON core.catalog_sag_company_location_observations AFTER INSERT,UPDATE,DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS(SELECT 1 FROM deleted)
        THROW 55504,N''Company location observation history is immutable.'',1;
      IF EXISTS(SELECT 1 FROM (SELECT DISTINCT revision_key FROM inserted) x
        JOIN core.catalog_customer_source_revisions r WITH (UPDLOCK,HOLDLOCK) ON r.revision_key=x.revision_key
        LEFT JOIN core.catalog_sag_company_location_seals s WITH (HOLDLOCK) ON s.revision_key=x.revision_key
        WHERE r.expected_sag_company_rows IS NULL OR r.source_role<>''sag-admin'' OR r.has_sag_inventory_evidence<>1
          OR r.sealed_at IS NULL OR r.sealed_at>SYSUTCDATETIME() OR r.verified_until<=SYSUTCDATETIME()
          OR s.revision_key IS NOT NULL)
        THROW 55505,N''Company location observations require an eligible revision with no companion seal.'',1;
    END;';

  EXEC sys.sp_executesql N'CREATE OR ALTER TRIGGER core.TR_catalog_sag_company_location_seals_stamp
    ON core.catalog_sag_company_location_seals INSTEAD OF INSERT AS
    BEGIN
      SET NOCOUNT ON;
      DECLARE @sealedAt datetime2(3)=SYSUTCDATETIME();
      IF EXISTS(SELECT 1 FROM inserted n
        LEFT JOIN core.catalog_customer_source_revisions r WITH (UPDLOCK,HOLDLOCK) ON r.revision_key=n.revision_key
        WHERE r.expected_sag_company_rows IS NULL OR r.source_role<>''sag-admin'' OR r.has_sag_inventory_evidence<>1
          OR r.sealed_at IS NULL OR r.sealed_at>@sealedAt
          OR r.verified_until<=@sealedAt OR n.expected_company_rows IS NULL
          OR n.expected_company_rows<>r.expected_sag_company_rows
          OR n.expected_company_rows<>(SELECT COUNT_BIG(*) FROM core.catalog_sag_company_location_observations o WITH (HOLDLOCK)
            WHERE o.revision_key=n.revision_key))
        THROW 55506,N''Cannot seal an incomplete, ineligible or expired Company location population.'',1;
      INSERT core.catalog_sag_company_location_seals(revision_key,expected_company_rows,sealed_at)
      SELECT revision_key,expected_company_rows,@sealedAt FROM inserted;
    END;';

  EXEC sys.sp_executesql N'CREATE OR ALTER TRIGGER core.TR_catalog_sag_company_location_seals_immutable
    ON core.catalog_sag_company_location_seals AFTER UPDATE,DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS(SELECT 1 FROM deleted)
        THROW 55507,N''Company location seals are immutable.'',1;
    END;';

  EXEC sys.sp_executesql N'CREATE OR ALTER PROCEDURE settings.publish_catalog_sag_v2_with_targets
  @environment varchar(32), @sourceId uniqueidentifier, @jobId uniqueidentifier,@workerId uniqueidentifier,
  @leaseToken uniqueidentifier,@attempt int,@bindingVersion varbinary(32),@profileVersion varbinary(32),
  @matchKeyVersion smallint,@vaultSecretVersion varbinary(64),@keyVerifier varbinary(64),@attemptOrdinal bigint,
  @customerCount int,@companyCount int,@customers nvarchar(max),@companies nvarchar(max),@targets nvarchar(max)
AS
BEGIN
  SET NOCOUNT ON;
  IF @@TRANCOUNT<>0 OR (@@OPTIONS & 2)<>0
    THROW 55309,N''SAG v2 publication requires an independent transaction.'',1;
  IF ISNULL(IS_ROLEMEMBER(N''portal_catalog_v2_publisher''),0)<>1 OR @environment IS NULL OR NOT (
      (@environment COLLATE Latin1_General_100_BIN2=''qa'' AND DATALENGTH(@environment)=2
        AND DB_NAME() COLLATE Latin1_General_100_BIN2=N''PortalSAGWeb-TEST'' AND DATALENGTH(DB_NAME())=34)
      OR (@environment COLLATE Latin1_General_100_BIN2=''production'' AND DATALENGTH(@environment)=10
        AND DB_NAME() COLLATE Latin1_General_100_BIN2=N''PortalSAGWeb'' AND DATALENGTH(DB_NAME())=24))
    THROW 55307,N''SAG v2 publication authorization or lease unavailable.'',1;

  IF @companyCount IS NULL OR @companyCount NOT BETWEEN 0 AND 100000
    OR @targets IS NULL OR DATALENGTH(@targets)>25165824
    OR ISJSON(@targets)<>1 OR LEFT(LTRIM(@targets),1)<>N''[''
    THROW 55508,N''Invalid SAG Company location observations.'',1;
  IF (SELECT COUNT_BIG(*) FROM OPENJSON(@targets))<>@companyCount
    THROW 55508,N''Invalid SAG Company location observations.'',1;

  -- Inspect the original shape before parsing scalars: length checks prevent
  -- truncation, key padding, numeric aliases, or duplicate/unknown fields.
  IF EXISTS (
    SELECT 1 FROM OPENJSON(@targets) item
    CROSS APPLY (
      SELECT COUNT_BIG(*) AS total,COUNT(DISTINCT f.[key] COLLATE Latin1_General_100_BIN2) AS distinct_keys,
        SUM(CASE WHEN (
          f.[key] COLLATE Latin1_General_100_BIN2=N''companyRecordId'' AND DATALENGTH(f.[key])=30
          AND f.[type]=2 AND DATALENGTH(f.[value]) BETWEEN 2 AND 22
          AND TRY_CONVERT(int,CONVERT(nvarchar(11),f.[value])) IS NOT NULL
          AND f.[value] COLLATE Latin1_General_100_BIN2=CONVERT(nvarchar(11),TRY_CONVERT(int,CONVERT(nvarchar(11),f.[value])))
            COLLATE Latin1_General_100_BIN2
          AND DATALENGTH(f.[value])=DATALENGTH(CONVERT(nvarchar(11),TRY_CONVERT(int,CONVERT(nvarchar(11),f.[value]))))
        ) OR (
          f.[key] COLLATE Latin1_General_100_BIN2=N''state'' AND DATALENGTH(f.[key])=10 AND f.[type]=1
          AND ((f.[value] COLLATE Latin1_General_100_BIN2=N''candidate'' AND DATALENGTH(f.[value])=18)
            OR (f.[value] COLLATE Latin1_General_100_BIN2=N''unverified'' AND DATALENGTH(f.[value])=20))
        ) OR (
          f.[key] COLLATE Latin1_General_100_BIN2=N''locationToken'' AND DATALENGTH(f.[key])=26
          AND (f.[type]=0 OR (f.[type]=1 AND DATALENGTH(f.[value])=128
            AND f.[value] COLLATE Latin1_General_100_BIN2 NOT LIKE N''%[^0-9a-f]%'' ))
        ) THEN 0 ELSE 1 END) AS invalid
      FROM OPENJSON(CASE WHEN item.[type]=5 THEN item.[value] ELSE N''{}'' END) f
    ) fields
    WHERE item.[type]<>5 OR fields.total<>3 OR fields.distinct_keys<>3 OR fields.invalid<>0
  )
    THROW 55508,N''Invalid SAG Company location observations.'',1;

  DECLARE @targetRows table(position int NOT NULL PRIMARY KEY,company_record_id int NOT NULL,
    observation_state varchar(10) COLLATE Latin1_General_100_BIN2 NOT NULL,location_token binary(32) NULL,
    has_token bit NOT NULL);
  INSERT @targetRows(position,company_record_id,observation_state,location_token,has_token)
  SELECT CONVERT(int,item.[key]),v.companyRecordId,v.[state],TRY_CONVERT(binary(32),v.locationToken,2),
    CONVERT(bit,CASE WHEN v.locationToken IS NULL THEN 0 ELSE 1 END)
  FROM OPENJSON(@targets) item CROSS APPLY OPENJSON(item.[value]) WITH (
    companyRecordId int,[state] varchar(10),locationToken varchar(64)) v;
  IF EXISTS (SELECT 1 FROM (
    SELECT company_record_id,observation_state,location_token,has_token,
      LAG(company_record_id) OVER(ORDER BY position) AS previous_company_id FROM @targetRows
  ) o WHERE o.previous_company_id>=o.company_record_id
    OR (o.observation_state=''candidate'' AND o.location_token IS NULL)
    OR (o.observation_state=''unverified'' AND o.has_token=1))
    THROW 55508,N''Invalid SAG Company location observations.'',1;

  SET XACT_ABORT ON;
  SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
  DECLARE @result varchar(12),@jobStatus varchar(12),@reservedOrdinal bigint,@observedAt datetime2(3),
    @leaseUntil datetime2(3),@successFreshUntil datetime2(3),@revisionKey bigint;
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

    -- The core has already checked canonical Company rows and exact counts.
    -- Even for superseded jobs reject a different target set, without attaching
    -- anything to the winner (which may be a metadata-only 053 revision).
    IF EXISTS(SELECT t.company_record_id FROM @targetRows t EXCEPT
      SELECT c.companyRecordId FROM OPENJSON(@companies) WITH(companyRecordId int) c)
      THROW 55508,N''Invalid SAG Company location observations.'',1;

    IF @result=''published'' AND @jobStatus=''succeeded''
    BEGIN
      SELECT @revisionKey=r.revision_key
      FROM settings.catalog_source_bindings b WITH (HOLDLOCK)
      JOIN settings.catalog_customer_revision_heads h WITH (HOLDLOCK) ON h.catalog_source_key=b.catalog_source_key
      JOIN core.catalog_customer_source_revisions r WITH (UPDLOCK,HOLDLOCK)
        ON r.catalog_source_key=b.catalog_source_key AND r.revision_key=h.revision_key
      WHERE b.source_id=@sourceId AND b.portal_environment COLLATE Latin1_General_100_BIN2=@environment COLLATE Latin1_General_100_BIN2
        AND DATALENGTH(b.portal_environment)=DATALENGTH(@environment) AND b.source_role=''sag-admin''
        AND b.contract_version COLLATE Latin1_General_100_BIN2=''sag_admin_v2'' AND DATALENGTH(b.contract_version)=12
        AND b.source_state=''active'' AND b.row_version=@bindingVersion AND b.validated_profile_version=@profileVersion
        AND h.attempt_status=''succeeded'' AND h.attempt_ordinal=@attemptOrdinal AND r.attempt_ordinal=@attemptOrdinal
        AND r.source_role=''sag-admin'' AND r.binding_version=@bindingVersion AND r.profile_version=@profileVersion
        AND r.match_key_version=@matchKeyVersion AND r.observed_at=@observedAt AND r.verified_until=@successFreshUntil
        AND r.sealed_at IS NOT NULL AND r.has_sag_inventory_evidence=1 AND r.expected_sag_company_rows=@companyCount;
      IF @revisionKey IS NULL
        THROW 55509,N''Exact published Company revision unavailable.'',1;
      INSERT core.catalog_sag_company_location_observations(revision_key,company_record_id,observation_state,location_token)
      SELECT @revisionKey,company_record_id,observation_state,location_token FROM @targetRows;
      -- Non-null input is just a placeholder; the trigger stamps server time.
      INSERT core.catalog_sag_company_location_seals(revision_key,expected_company_rows,sealed_at)
      VALUES(@revisionKey,@companyCount,SYSUTCDATETIME());
    END
    ELSE IF @result IS NULL OR @result<>''superseded'' OR @jobStatus IS NULL OR @jobStatus NOT IN (''succeeded'',''cancelled'')
      THROW 55509,N''Unexpected SAG publication result.'',1;

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

  DECLARE @objects055 table(object_id int NULL);
  INSERT @objects055 VALUES
    (OBJECT_ID(N'settings.publish_catalog_sag_v2_with_targets',N'P')),
    (OBJECT_ID(N'settings.catalog_sag_v2_transition_internal',N'P')),
    (OBJECT_ID(N'settings.catalog_source_bindings',N'U')),
    (OBJECT_ID(N'settings.catalog_customer_revision_heads',N'U')),
    (OBJECT_ID(N'core.catalog_customer_source_revisions',N'U')),
    (OBJECT_ID(N'core.catalog_sag_company_revision_rows',N'U')),
    (OBJECT_ID(N'core.catalog_sag_company_location_observations',N'U')),
    (OBJECT_ID(N'core.catalog_sag_company_location_seals',N'U')),
    (OBJECT_ID(N'core.TR_catalog_sag_company_location_observations_guard',N'TR')),
    (OBJECT_ID(N'core.TR_catalog_sag_company_location_seals_stamp',N'TR')),
    (OBJECT_ID(N'core.TR_catalog_sag_company_location_seals_immutable',N'TR'));
  IF EXISTS(SELECT 1 FROM @objects055 expected
    LEFT JOIN sys.objects o ON o.object_id=expected.object_id
    LEFT JOIN sys.schemas s ON s.schema_id=o.schema_id
    WHERE o.object_id IS NULL OR COALESCE(o.principal_id,s.principal_id,-1)<>DATABASE_PRINCIPAL_ID(N'dbo'))
    THROW 55510,N'The SAG target observation ownership chain is incomplete.',1;

  DENY SELECT,INSERT,UPDATE,DELETE ON OBJECT::core.catalog_sag_company_location_observations TO portal_runtime;
  DENY SELECT,INSERT,UPDATE,DELETE ON OBJECT::core.catalog_sag_company_location_seals TO portal_runtime;
  DENY SELECT,INSERT,UPDATE,DELETE ON OBJECT::core.catalog_sag_company_location_observations TO portal_catalog_v2_publisher;
  DENY SELECT,INSERT,UPDATE,DELETE ON OBJECT::core.catalog_sag_company_location_seals TO portal_catalog_v2_publisher;
  REVOKE EXECUTE ON OBJECT::settings.publish_catalog_sag_v2_with_targets FROM public;
  DENY EXECUTE ON OBJECT::settings.publish_catalog_sag_v2_with_targets TO portal_runtime;
  GRANT EXECUTE ON OBJECT::settings.publish_catalog_sag_v2_with_targets TO portal_catalog_v2_publisher;

  IF @owns055=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns055=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
