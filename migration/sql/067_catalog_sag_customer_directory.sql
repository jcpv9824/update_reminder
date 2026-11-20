/* Optional names and scoped HMACs for the exact SAG v2 Customer revision.
   No raw NIT, connection data, backfill, old RPC change, or prior object ACL change. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns067 bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns067=1 BEGIN TRANSACTION;
  IF NOT ((DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb' AND DATALENGTH(DB_NAME())=24)
      OR (DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb-TEST' AND DATALENGTH(DB_NAME())=34))
    OR CAST(SERVERPROPERTY(N'ProductMajorVersion') AS int)<>15
    OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150
      AND is_read_only=0 AND collation_name COLLATE Latin1_General_100_BIN2=N'Modern_Spanish_CI_AS')
    THROW 56701,N'Expected the writable Portal database on SQL Server 2019 compatibility 150.',1;

  DECLARE @lock067 int;
  EXEC @lock067=sys.sp_getapplock @Resource=N'portal-sag:migration:067:sag-customer-directory',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock067<0 THROW 56702,N'Could not reserve migration 067.',1;

  DECLARE @dbo067 int=DATABASE_PRINCIPAL_ID(N'dbo'),@runtime067 int=DATABASE_PRINCIPAL_ID(N'portal_runtime'),
    @role067 int=DATABASE_PRINCIPAL_ID(N'portal_catalog_v2_publisher'),
    @delegate067 int=DATABASE_PRINCIPAL_ID(N'portal_catalog_v2_owner_delegate');
  IF (SELECT COUNT(*) FROM migration.schema_migrations WHERE migration_version IN ('055','064','066') AND succeeded=1)<>3
    OR @runtime067 IS NULL OR @role067 IS NULL
    OR OBJECT_ID(N'settings.publish_catalog_sag_v2_owner_with_database_names',N'P') IS NULL
    OR NOT EXISTS(SELECT 1 FROM sys.sql_modules WHERE execute_as_principal_id=@delegate067
      AND object_id=OBJECT_ID(N'settings.catalog_sag_v2_owner_database_names_internal',N'P'))
    OR NOT EXISTS(SELECT 1 FROM sys.database_principals WHERE principal_id=@delegate067
      AND type='S' AND authentication_type=0 AND name COLLATE Latin1_General_100_BIN2=N'portal_catalog_v2_owner_delegate')
    OR NOT EXISTS(SELECT 1 FROM sys.database_role_members WHERE member_principal_id=@delegate067 AND role_principal_id=@role067)
    OR EXISTS(SELECT 1 FROM sys.database_role_members WHERE member_principal_id=@delegate067 AND role_principal_id<>@role067)
    OR EXISTS(SELECT 1 FROM sys.database_permissions WHERE grantor_principal_id=@delegate067
      OR (grantee_principal_id=@delegate067 AND NOT (class=0 AND major_id=0 AND minor_id=0
        AND state='G' AND permission_name='CONNECT' AND grantor_principal_id=@dbo067)))
    OR EXISTS(SELECT 1 FROM sys.schemas WHERE principal_id=@delegate067)
    OR EXISTS(SELECT 1 FROM sys.objects WHERE principal_id=@delegate067)
    OR EXISTS(SELECT 1 FROM sys.database_principals WHERE owning_principal_id=@delegate067)
    THROW 56703,N'Expected the reviewed SAG publication and its existing no-login delegate.',1;

  IF OBJECT_ID(N'core.catalog_sag_customer_directory_rows',N'U') IS NULL
    CREATE TABLE core.catalog_sag_customer_directory_rows (
      revision_key bigint NOT NULL,
      source_record_id int NOT NULL,
      display_name nvarchar(512) COLLATE Latin1_General_100_BIN2 NULL,
      normalized_nit_token binary(32) NULL,
      CONSTRAINT PK_catalog_sag_customer_directory_rows PRIMARY KEY CLUSTERED(revision_key,source_record_id),
      CONSTRAINT FK_catalog_sag_customer_directory_rows_customer FOREIGN KEY(revision_key,source_record_id)
        REFERENCES core.catalog_customer_revision_rows(revision_key,source_record_id),
      CONSTRAINT CK_catalog_sag_customer_directory_rows_display CHECK (display_name IS NULL OR (DATALENGTH(display_name) BETWEEN 2 AND 1024
      AND DATALENGTH(display_name)=DATALENGTH(LTRIM(RTRIM(display_name)))
      AND display_name COLLATE Latin1_General_100_BIN2 NOT LIKE N'%['+NCHAR(1)+N'-'+NCHAR(31)+NCHAR(127)+N'-'+NCHAR(159)+N']%'
      AND CHARINDEX(N'\u0000',REPLACE(STRING_ESCAPE(display_name,'json') COLLATE Latin1_General_100_BIN2,N'\\',N''))=0
      AND display_name COLLATE Latin1_General_100_BIN2 NOT LIKE N'%['+NCHAR(8203)+N'-'+NCHAR(8207)+NCHAR(8234)+N'-'+NCHAR(8238)+NCHAR(8294)+N'-'+NCHAR(8297)+NCHAR(65279)+N']%'))
    );

  EXEC sys.sp_executesql N'CREATE OR ALTER TRIGGER core.TR_catalog_sag_customer_directory_rows_guard
  ON core.catalog_sag_customer_directory_rows AFTER INSERT,UPDATE,DELETE AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS(SELECT 1 FROM deleted)
    THROW 56705,N''SAG Customer directory history is immutable.'',1;
  IF EXISTS(
    SELECT 1 FROM inserted n
    JOIN core.catalog_customer_revision_rows c WITH(HOLDLOCK)
      ON c.revision_key=n.revision_key AND c.source_record_id=n.source_record_id
    JOIN core.catalog_customer_source_revisions r WITH(UPDLOCK,HOLDLOCK) ON r.revision_key=n.revision_key
    JOIN settings.catalog_source_bindings b WITH(HOLDLOCK) ON b.catalog_source_key=r.catalog_source_key
    LEFT JOIN settings.catalog_customer_revision_heads h WITH(HOLDLOCK)
      ON h.catalog_source_key=b.catalog_source_key AND h.revision_key=r.revision_key
    LEFT JOIN core.catalog_sag_company_location_seals s WITH(HOLDLOCK) ON s.revision_key=n.revision_key
    WHERE c.source_role<>''sag-admin''
      OR (n.normalized_nit_token IS NOT NULL AND (c.issuer IS NULL OR c.issuer<>''CO''
        OR c.document_type IS NULL OR c.document_type<>''NIT'' OR DATALENGTH(c.document_type)<>3 OR c.document_number_token IS NULL))
      OR b.source_role<>''sag-admin'' OR b.source_state<>''active''
      OR b.contract_version COLLATE Latin1_General_100_BIN2<>''sag_admin_v2'' OR DATALENGTH(b.contract_version)<>12
      OR r.source_role<>''sag-admin'' OR r.has_sag_inventory_evidence<>1 OR r.expected_sag_company_rows IS NULL
      OR r.binding_version<>b.row_version OR b.validated_profile_version IS NULL OR r.profile_version<>b.validated_profile_version
      OR h.revision_key IS NULL OR h.attempt_status<>''succeeded'' OR h.attempt_ordinal<>r.attempt_ordinal
      OR r.sealed_at IS NULL OR r.sealed_at>SYSUTCDATETIME() OR r.verified_until<=SYSUTCDATETIME()
      OR s.revision_key IS NOT NULL
      OR ISNULL(APPLOCK_MODE(N''public'',N''portal-sag:catalog-customer-publication:''+b.portal_environment,N''Transaction''),N''NoLock'')<>N''Exclusive''
  ) THROW 56705,N''SAG Customer directory requires the exact unsealed publication companion.'',1;
END;';

  EXEC sys.sp_executesql N'CREATE OR ALTER PROCEDURE settings.catalog_sag_v2_owner_directory_internal
  @environment varchar(32), @sourceId uniqueidentifier, @jobId uniqueidentifier,@workerId uniqueidentifier,
  @leaseToken uniqueidentifier,@attempt int,@bindingVersion varbinary(32),@profileVersion varbinary(32),
  @matchKeyVersion smallint,@vaultSecretVersion varbinary(64),@keyVerifier varbinary(64),@attemptOrdinal bigint,
  @customerCount int,@companyCount int,@customers nvarchar(max),@companies nvarchar(max),@targets nvarchar(max),
  @databaseNames nvarchar(max),@directoryRows nvarchar(max)
WITH EXECUTE AS ''portal_catalog_v2_owner_delegate''
AS
BEGIN
  SET NOCOUNT ON;
  IF @@TRANCOUNT<>0 OR (@@OPTIONS & 2)<>0
    THROW 55309,N''SAG v2 publication requires an independent transaction.'',1;
  IF @@NESTLEVEL<>2 OR ORIGINAL_LOGIN() COLLATE Latin1_General_100_BIN2<>N''SAGWebDev''
    OR DATALENGTH(ORIGINAL_LOGIN())<>18
    OR USER_NAME() COLLATE Latin1_General_100_BIN2<>N''portal_catalog_v2_owner_delegate''
    OR ISNULL(IS_ROLEMEMBER(N''portal_catalog_v2_publisher''),0)<>1 OR @environment IS NULL OR NOT (
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

  -- This is an exhaustive set only for names the source parser could validate;
  -- an absent Company conveys no claim. Check the pre-coercion JSON shape.
  IF @databaseNames IS NULL OR DATALENGTH(@databaseNames)>41943040 OR ISJSON(@databaseNames)<>1
    OR LEFT(@databaseNames,1)<>N''['' OR RIGHT(@databaseNames,1)<>N'']''
    THROW 56604,N''Invalid SAG Company database-name metadata.'',1;
  IF (SELECT COUNT_BIG(*) FROM OPENJSON(@databaseNames))>@companyCount
    THROW 56604,N''Invalid SAG Company database-name metadata.'',1;
  IF EXISTS(
    SELECT 1 FROM OPENJSON(@databaseNames) item CROSS APPLY (
      SELECT COUNT_BIG(*) AS total,COUNT(DISTINCT f.[key] COLLATE Latin1_General_100_BIN2) AS distinct_keys,
        SUM(CASE WHEN (
          f.[key] COLLATE Latin1_General_100_BIN2=N''companyRecordId'' AND DATALENGTH(f.[key])=30
          AND f.[type]=2 AND DATALENGTH(f.[value]) BETWEEN 2 AND 22
          AND TRY_CONVERT(int,CONVERT(nvarchar(11),f.[value])) IS NOT NULL
          AND f.[value] COLLATE Latin1_General_100_BIN2=CONVERT(nvarchar(11),TRY_CONVERT(int,CONVERT(nvarchar(11),f.[value]))) COLLATE Latin1_General_100_BIN2
          AND DATALENGTH(f.[value])=DATALENGTH(CONVERT(nvarchar(11),TRY_CONVERT(int,CONVERT(nvarchar(11),f.[value]))))
        ) OR (
          f.[key] COLLATE Latin1_General_100_BIN2=N''databaseName'' AND DATALENGTH(f.[key])=24
          AND f.[type]=1 AND DATALENGTH(f.[value]) BETWEEN 2 AND 256
        ) THEN 0 ELSE 1 END) AS invalid
      FROM OPENJSON(CASE WHEN item.[type]=5 THEN item.[value] ELSE N''{}'' END) f
    ) fields
    WHERE item.[type]<>5 OR fields.total<>2 OR fields.distinct_keys<>2 OR fields.invalid<>0
  )
    THROW 56604,N''Invalid SAG Company database-name metadata.'',1;

  DECLARE @nameRows table(company_record_id int NOT NULL,database_name nvarchar(128) COLLATE Latin1_General_100_BIN2 NOT NULL);
  INSERT @nameRows(company_record_id,database_name)
    SELECT companyRecordId,databaseName FROM OPENJSON(@databaseNames) WITH(companyRecordId int,databaseName nvarchar(128));
  IF EXISTS(SELECT company_record_id FROM @nameRows GROUP BY company_record_id HAVING COUNT_BIG(*)<>1)
    OR EXISTS(SELECT 1 FROM @nameRows WHERE NOT (DATALENGTH(database_name) BETWEEN 2 AND 256
      AND DATALENGTH(database_name)=DATALENGTH(LTRIM(RTRIM(database_name)))
      AND database_name COLLATE Latin1_General_100_BIN2 LIKE N''%[A-Za-z0-9]%''
      AND CONVERT(varbinary(256),TRANSLATE(database_name COLLATE Latin1_General_100_BIN2,
        N''ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_ .-'',REPLICATE(N''X'',66)))
        =CONVERT(varbinary(256),REPLICATE(N''X'',DATALENGTH(database_name)/2))))
    OR EXISTS(SELECT n.company_record_id FROM @nameRows n EXCEPT
      SELECT t.company_record_id FROM @targetRows t WHERE t.observation_state=''candidate'')
    THROW 56604,N''Invalid SAG Company database-name metadata.'',1;

  -- Parse all exact Customer ids, not a subset; an explicitly null display
  -- name or comparison token must not let a revision omit its identity row.
  IF @customerCount IS NULL OR @customerCount NOT BETWEEN 0 AND 100000
    OR @directoryRows IS NULL OR DATALENGTH(@directoryRows)>33554432 OR ISJSON(@directoryRows)<>1
    OR LEFT(@directoryRows,1)<>N''['' OR RIGHT(@directoryRows,1)<>N'']''
    THROW 56704,N''Invalid SAG Customer directory evidence.'',1;
  IF (SELECT COUNT_BIG(*) FROM OPENJSON(@directoryRows))<>@customerCount
    THROW 56704,N''Invalid SAG Customer directory evidence.'',1;

  IF EXISTS(
    SELECT 1 FROM OPENJSON(@directoryRows) item CROSS APPLY (
      SELECT COUNT_BIG(*) AS total,COUNT(DISTINCT f.[key] COLLATE Latin1_General_100_BIN2) AS distinct_keys,
        SUM(CASE WHEN (
          f.[key] COLLATE Latin1_General_100_BIN2=N''sourceRecordId'' AND DATALENGTH(f.[key])=28
          AND f.[type]=2 AND DATALENGTH(f.[value]) BETWEEN 2 AND 22
          AND TRY_CONVERT(int,CONVERT(nvarchar(11),f.[value])) IS NOT NULL
          AND f.[value] COLLATE Latin1_General_100_BIN2=CONVERT(nvarchar(11),TRY_CONVERT(int,CONVERT(nvarchar(11),f.[value]))) COLLATE Latin1_General_100_BIN2
          AND DATALENGTH(f.[value])=DATALENGTH(CONVERT(nvarchar(11),TRY_CONVERT(int,CONVERT(nvarchar(11),f.[value]))))
        ) OR (
          f.[key] COLLATE Latin1_General_100_BIN2=N''displayName'' AND DATALENGTH(f.[key])=22
          AND (f.[type]=0 OR (f.[type]=1 AND DATALENGTH(f.[value]) BETWEEN 2 AND 1024))
        ) OR (
          f.[key] COLLATE Latin1_General_100_BIN2=N''normalizedNitToken'' AND DATALENGTH(f.[key])=36
          AND (f.[type]=0 OR (f.[type]=1 AND DATALENGTH(f.[value])=128
            AND f.[value] COLLATE Latin1_General_100_BIN2 NOT LIKE N''%[^0-9a-f]%''))
        ) THEN 0 ELSE 1 END) AS invalid
      FROM OPENJSON(CASE WHEN item.[type]=5 THEN item.[value] ELSE N''{}'' END) f
    ) fields
    WHERE item.[type]<>5 OR fields.total<>3 OR fields.distinct_keys<>3 OR fields.invalid<>0
  )
    THROW 56704,N''Invalid SAG Customer directory evidence.'',1;

  DECLARE @directory table(position int NOT NULL PRIMARY KEY,source_record_id int NOT NULL,
    display_name nvarchar(512) COLLATE Latin1_General_100_BIN2 NULL,normalized_nit_token binary(32) NULL);
  INSERT @directory(position,source_record_id,display_name,normalized_nit_token)
    SELECT CONVERT(int,item.[key]),v.sourceRecordId,v.displayName,CONVERT(binary(32),v.normalizedNitToken,2)
    FROM OPENJSON(@directoryRows) item
    CROSS APPLY OPENJSON(item.[value]) WITH(sourceRecordId int,displayName nvarchar(512),normalizedNitToken varchar(64)) v;
  IF EXISTS(SELECT 1 FROM (
    SELECT source_record_id,LAG(source_record_id) OVER(ORDER BY position) AS previous_id FROM @directory
  ) d WHERE d.previous_id>=d.source_record_id)
    OR EXISTS(SELECT 1 FROM @directory WHERE display_name IS NOT NULL AND NOT (DATALENGTH(display_name) BETWEEN 2 AND 1024
      AND DATALENGTH(display_name)=DATALENGTH(LTRIM(RTRIM(display_name)))
      AND display_name COLLATE Latin1_General_100_BIN2 NOT LIKE N''%[''+NCHAR(1)+N''-''+NCHAR(31)+NCHAR(127)+N''-''+NCHAR(159)+N'']%''
      AND CHARINDEX(N''\u0000'',REPLACE(STRING_ESCAPE(display_name,''json'') COLLATE Latin1_General_100_BIN2,N''\\'',N''''))=0
      AND display_name COLLATE Latin1_General_100_BIN2 NOT LIKE N''%[''+NCHAR(8203)+N''-''+NCHAR(8207)+NCHAR(8234)+N''-''+NCHAR(8238)+NCHAR(8294)+N''-''+NCHAR(8297)+NCHAR(65279)+N'']%''))
    THROW 56704,N''Invalid SAG Customer directory evidence.'',1;

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

    -- Existing publication has checked the canonical Customer payload and exact
    -- count. Require set equality and CO:NIT context even for superseded jobs.
    IF EXISTS(SELECT d.source_record_id FROM @directory d EXCEPT
      SELECT c.sourceRecordId FROM OPENJSON(@customers) WITH(sourceRecordId int) c)
      OR EXISTS(SELECT c.sourceRecordId FROM OPENJSON(@customers) WITH(sourceRecordId int) c EXCEPT
        SELECT d.source_record_id FROM @directory d)
      OR EXISTS(SELECT 1 FROM @directory d JOIN OPENJSON(@customers) WITH(sourceRecordId int,issuer nvarchar(2),
        documentType nvarchar(32),token nvarchar(64)) c ON c.sourceRecordId=d.source_record_id
        WHERE d.normalized_nit_token IS NOT NULL AND (c.issuer IS NULL OR c.issuer COLLATE Latin1_General_100_BIN2<>N''CO''
          OR DATALENGTH(c.issuer)<>4 OR c.documentType IS NULL OR c.documentType COLLATE Latin1_General_100_BIN2<>N''NIT''
          OR DATALENGTH(c.documentType)<>6 OR c.token IS NULL))
      THROW 56704,N''Invalid SAG Customer directory evidence.'',1;

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
        AND r.sealed_at IS NOT NULL AND r.has_sag_inventory_evidence=1 AND r.expected_sag_company_rows=@companyCount
        AND r.expected_rows=@customerCount;
      IF @revisionKey IS NULL
        THROW 55509,N''Exact published Company revision unavailable.'',1;
      INSERT core.catalog_sag_company_location_observations(revision_key,company_record_id,observation_state,location_token)
      SELECT @revisionKey,company_record_id,observation_state,location_token FROM @targetRows;
      INSERT core.catalog_sag_company_database_names(revision_key,company_record_id,database_name)
      SELECT @revisionKey,company_record_id,database_name FROM @nameRows;

      INSERT core.catalog_sag_customer_directory_rows(revision_key,source_record_id,display_name,normalized_nit_token)
      SELECT @revisionKey,source_record_id,display_name,normalized_nit_token FROM @directory;

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

  EXEC sys.sp_executesql N'CREATE OR ALTER PROCEDURE settings.publish_catalog_sag_v2_owner_with_directory
  @environment varchar(32), @sourceId uniqueidentifier, @jobId uniqueidentifier,@workerId uniqueidentifier,
  @leaseToken uniqueidentifier,@attempt int,@bindingVersion varbinary(32),@profileVersion varbinary(32),
  @matchKeyVersion smallint,@vaultSecretVersion varbinary(64),@keyVerifier varbinary(64),@attemptOrdinal bigint,
  @customerCount int,@companyCount int,@customers nvarchar(max),@companies nvarchar(max),@targets nvarchar(max),
  @databaseNames nvarchar(max),@directoryRows nvarchar(max)
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
    THROW 56706,N''SAG Customer directory publication is not available.'',1;
  BEGIN TRY
    EXEC settings.catalog_sag_v2_owner_directory_internal
      @environment=@environment,@sourceId=@sourceId,@jobId=@jobId,@workerId=@workerId,@leaseToken=@leaseToken,
      @attempt=@attempt,@bindingVersion=@bindingVersion,@profileVersion=@profileVersion,@matchKeyVersion=@matchKeyVersion,
      @vaultSecretVersion=@vaultSecretVersion,@keyVerifier=@keyVerifier,@attemptOrdinal=@attemptOrdinal,
      @customerCount=@customerCount,@companyCount=@companyCount,@customers=@customers,@companies=@companies,
      @targets=@targets,@databaseNames=@databaseNames,@directoryRows=@directoryRows;
  END TRY
  BEGIN CATCH
    -- Never relay conversion errors containing source values.
    THROW 56706,N''SAG Customer directory publication is not available.'',1;
  END CATCH;
END;';

  DECLARE @table067 int=OBJECT_ID(N'core.catalog_sag_customer_directory_rows',N'U'),
    @inner067 int=OBJECT_ID(N'settings.catalog_sag_v2_owner_directory_internal',N'P'),
    @outer067 int=OBJECT_ID(N'settings.publish_catalog_sag_v2_owner_with_directory',N'P');
  DECLARE @objects067 table(object_id int NULL);
  INSERT @objects067 VALUES
    (@table067),(@inner067),(@outer067),
    (OBJECT_ID(N'core.TR_catalog_sag_customer_directory_rows_guard',N'TR')),
    (OBJECT_ID(N'settings.catalog_sag_v2_transition_internal',N'P')),
    (OBJECT_ID(N'settings.catalog_source_bindings',N'U')),
    (OBJECT_ID(N'settings.catalog_customer_revision_heads',N'U')),
    (OBJECT_ID(N'core.catalog_customer_source_revisions',N'U')),
    (OBJECT_ID(N'core.catalog_customer_revision_rows',N'U')),
    (OBJECT_ID(N'core.catalog_sag_company_location_observations',N'U')),
    (OBJECT_ID(N'core.catalog_sag_company_database_names',N'U')),
    (OBJECT_ID(N'core.catalog_sag_company_location_seals',N'U')),
    (OBJECT_ID(N'core.TR_catalog_sag_company_location_observations_guard',N'TR')),
    (OBJECT_ID(N'core.TR_catalog_sag_company_database_names_guard',N'TR')),
    (OBJECT_ID(N'core.TR_catalog_sag_company_location_seals_stamp',N'TR'));
  IF EXISTS(SELECT 1 FROM @objects067 expected LEFT JOIN sys.objects o ON o.object_id=expected.object_id
      LEFT JOIN sys.schemas s ON s.schema_id=o.schema_id
      WHERE o.object_id IS NULL OR COALESCE(o.principal_id,s.principal_id,-1)<>@dbo067)
    OR (SELECT COUNT(*) FROM sys.columns WHERE object_id=@table067)<>4
    OR NOT EXISTS(SELECT 1 FROM sys.columns WHERE object_id=@table067 AND name=N'display_name'
      AND system_type_id=231 AND max_length=1024 AND is_nullable=1 AND collation_name=N'Latin1_General_100_BIN2')
    OR NOT EXISTS(SELECT 1 FROM sys.columns WHERE object_id=@table067 AND name=N'normalized_nit_token'
      AND system_type_id=173 AND max_length=32 AND is_nullable=1)
    OR NOT EXISTS(SELECT 1 FROM sys.check_constraints WHERE parent_object_id=@table067
      AND name=N'CK_catalog_sag_customer_directory_rows_display' AND is_disabled=0 AND is_not_trusted=0)
    OR NOT EXISTS(SELECT 1 FROM sys.key_constraints WHERE parent_object_id=@table067
      AND name=N'PK_catalog_sag_customer_directory_rows' AND type='PK')
    OR NOT EXISTS(SELECT 1 FROM sys.foreign_keys WHERE parent_object_id=@table067 AND is_disabled=0 AND is_not_trusted=0
      AND name=N'FK_catalog_sag_customer_directory_rows_customer' AND referenced_object_id=OBJECT_ID(N'core.catalog_customer_revision_rows',N'U'))
    OR EXISTS(SELECT 1 FROM sys.database_permissions WHERE class=1 AND major_id IN (@inner067,@outer067))
    OR EXISTS(SELECT 1 FROM sys.database_permissions WHERE class=1 AND major_id=@table067 AND NOT (
      minor_id=0 AND grantor_principal_id=@dbo067 AND (
        (grantee_principal_id=@runtime067 AND state='G' AND permission_name='SELECT')
        OR (grantee_principal_id IN (@runtime067,@role067) AND state='D' AND permission_name IN ('INSERT','UPDATE','DELETE')))))
    THROW 56703,N'The SAG Customer directory chain or object permissions are not valid.',1;

  -- New object only; preserve every pre-existing object ACL and role membership.
  GRANT SELECT ON OBJECT::core.catalog_sag_customer_directory_rows TO portal_runtime;
  DENY INSERT,UPDATE,DELETE ON OBJECT::core.catalog_sag_customer_directory_rows TO portal_runtime;
  DENY INSERT,UPDATE,DELETE ON OBJECT::core.catalog_sag_customer_directory_rows TO portal_catalog_v2_publisher;
  IF (SELECT COUNT(*) FROM sys.database_permissions WHERE class=1 AND major_id=@table067)<>7
    THROW 56703,N'The SAG Customer directory object ACL is not narrowly scoped.',1;

  IF @owns067=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns067=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
