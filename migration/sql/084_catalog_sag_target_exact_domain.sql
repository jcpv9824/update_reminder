/* Tighten current reads to the same exact SAG domain as historical 073 and
   preserve binary rowversion bytes in the historical population digest.
   Do not rewrite observations, physical targets or permission grants. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
DECLARE @owns084 bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns084=1 BEGIN TRANSACTION;
  IF NOT ((DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb' AND DATALENGTH(DB_NAME())=24)
      OR (DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb-TEST' AND DATALENGTH(DB_NAME())=34))
    OR CAST(SERVERPROPERTY('ProductMajorVersion') AS int)<>15
    OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150
      AND collation_name=N'Modern_Spanish_CI_AS')
    THROW 58401,N'Expected Portal database on SQL Server 2019 compatibility level 150.',1;

  DECLARE @lock084 int;
  EXEC @lock084=sys.sp_getapplock @Resource=N'portal-sag:migration:084:sag-target-exact-domain',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock084<0 THROW 58402,N'Could not reserve the exact SAG target domain migration.',1;

  DECLARE @targets084 table(ordinal int PRIMARY KEY,name nvarchar(256) NOT NULL,object_id int NULL,baseline binary(32) NOT NULL);
  INSERT @targets084 VALUES
    (1,N'settings.verify_catalog_sag_target_link_internal',OBJECT_ID(N'settings.verify_catalog_sag_target_link_internal',N'P'),
      0xDD6034B584A7496F2986E50A326060CB031898B25A9F234BDBF2CAE85722DE52),
    (2,N'settings.read_catalog_sag_target_link_candidates',OBJECT_ID(N'settings.read_catalog_sag_target_link_candidates',N'P'),
      0xC3168FF411F03975D478AEFD855B68D168A18396B9F08C7316990D00AED7A65B),
    (3,N'settings.verify_catalog_historical_schedule_company_locations',OBJECT_ID(N'settings.verify_catalog_historical_schedule_company_locations',N'P'),
      0xB30142F210F5DEE25AFDDC27FF6EB952DD2B50108BD1DB2F70AFD2D1C2699C16);
  IF OBJECT_ID(N'settings.verify_catalog_sag_target_link',N'P') IS NULL
    OR EXISTS(SELECT 1 FROM @targets084 target
      LEFT JOIN sys.objects o ON o.object_id=target.object_id
      LEFT JOIN sys.schemas s ON s.schema_id=o.schema_id
      LEFT JOIN sys.sql_modules m ON m.object_id=o.object_id
      WHERE o.object_id IS NULL OR COALESCE(o.principal_id,s.principal_id,-1)<>DATABASE_PRINCIPAL_ID(N'dbo')
        OR m.definition IS NULL OR m.execute_as_principal_id IS NOT NULL OR m.uses_native_compilation=1
        OR m.uses_ansi_nulls<>1 OR m.uses_quoted_identifier<>1
        OR EXISTS(SELECT 1 FROM sys.crypt_properties c WHERE c.class=1 AND c.major_id=o.object_id))
    THROW 58403,N'Expected the unsigned same-owner SAG modules from migrations 056, 057 and 073.',1;

  DECLARE @anchor084 nvarchar(256)=N'AND sag_customer.environment_kind=ol.link_environment AND DATALENGTH(sag_customer.environment_kind)=DATALENGTH(ol.link_environment)';
  -- Match the existing 073 HTTPS/domain policy, using only stored canonical
  -- Portal and sealed SAG evidence. The lexical and byte checks fail closed.
  DECLARE @predicate084 nvarchar(1000)=N'
      AND EXISTS (
        SELECT 1
        FROM (VALUES(CASE WHEN LEFT(LOWER(dm.domain_name_normalized),8)=N''https://''
          THEN SUBSTRING(dm.domain_name_normalized,9,500) END)) raw_route(label)
        CROSS APPLY (VALUES(CASE WHEN RIGHT(raw_route.label,1)=N''/''
          THEN LEFT(raw_route.label,CASE WHEN LEN(raw_route.label)>0 THEN LEN(raw_route.label)-1 ELSE 0 END)
          ELSE raw_route.label END)) route(label)
        WHERE sag_customer.domain_candidate COLLATE Latin1_General_100_BIN2=LOWER(route.label) COLLATE Latin1_General_100_BIN2
          AND DATALENGTH(sag_customer.domain_candidate)=LEN(route.label)
          AND DATALENGTH(route.label)=2*LEN(route.label))';
  -- SQL Server 2019 does not honor the hex style for a native rowversion
  -- converted straight to char. Preserve both binary(8) revision pins.
  DECLARE @historicalAnchor084 nvarchar(256)=N'LOWER(CONVERT(char(16),b.row_version,2)),LOWER(CONVERT(char(16),p.row_version,2))';
  DECLARE @historicalReplacement084 nvarchar(256)=N'LOWER(CONVERT(char(16),CONVERT(binary(8),b.row_version),2)),LOWER(CONVERT(char(16),CONVERT(binary(8),p.row_version),2))';
  -- Catalog definitions are normalized only for comparisons; preserve the
  -- stored body and header besides each unique, reviewed replacement.
  DECLARE @ordinal084 int=1,@name084 nvarchar(256),@id084 int,
    @definition084 nvarchar(max),@normalized084 nvarchar(max),@prefix084 nvarchar(300),@position084 int,
    @baseline084 binary(32),@old084 nvarchar(256),@new084 nvarchar(1256),@fixed084 nvarchar(1256),@patched084 int;
  WHILE @ordinal084<=3
  BEGIN
    SELECT @name084=name,@id084=object_id,@baseline084=baseline FROM @targets084 WHERE ordinal=@ordinal084;
    SET @old084=CASE WHEN @ordinal084=3 THEN @historicalAnchor084 ELSE @anchor084 END;
    SET @new084=CASE WHEN @ordinal084=3 THEN @historicalReplacement084 ELSE @anchor084+@predicate084 END;
    SET @fixed084=REPLACE(@new084,NCHAR(13),N'');
    SET @definition084=OBJECT_DEFINITION(@id084);
    -- SQL Server 2019 persists CREATE OR ALTER as a padded CREATE and ALTER
    -- as plain CREATE. Normalize only exact supported headers for the hash.
    SELECT @prefix084=prefix FROM (VALUES
      (N'CREATE   PROCEDURE '+@name084),(N'CREATE PROCEDURE '+@name084),
      (N'ALTER PROCEDURE '+@name084),(N'CREATE OR ALTER PROCEDURE '+@name084)
    ) AS header(prefix) WHERE LEFT(@definition084,LEN(prefix)) COLLATE Latin1_General_100_BIN2=prefix;
    IF @prefix084 IS NULL THROW 58404,N'Unexpected SAG runtime procedure header.',1;
    SET @normalized084=REPLACE(
      STUFF(@definition084,1,LEN(@prefix084),N'CREATE OR ALTER PROCEDURE '+@name084),NCHAR(13),N'');
    SET @patched084=CHARINDEX(@fixed084,@normalized084 COLLATE Latin1_General_100_BIN2);
    IF @patched084>0 SET @normalized084=STUFF(@normalized084,@patched084,LEN(@fixed084),@old084);
    IF HASHBYTES('SHA2_256',@normalized084)<>@baseline084
      THROW 58406,N'The installed SAG runtime module differs from the reviewed predecessor.',1;
    IF @patched084=0
    BEGIN
      SET @position084=CHARINDEX(@old084,@definition084 COLLATE Latin1_General_100_BIN2);
      IF @position084=0 OR CHARINDEX(@old084,@definition084 COLLATE Latin1_General_100_BIN2,@position084+1)<>0
        THROW 58405,N'The expected SAG evidence expression is missing or ambiguous.',1;
      SET @definition084=STUFF(@definition084,@position084,LEN(@old084),@new084);
      SET @definition084=STUFF(@definition084,1,LEN(@prefix084),N'ALTER PROCEDURE '+@name084);
      EXEC sys.sp_executesql @definition084;
    END;
    SET @prefix084=NULL;
    SET @ordinal084+=1;
  END;

  IF EXISTS (SELECT 1 FROM @targets084 WHERE CHARINDEX(
      CASE WHEN ordinal=3 THEN @historicalReplacement084 ELSE @anchor084+REPLACE(@predicate084,NCHAR(13),N'') END,
      REPLACE(OBJECT_DEFINITION(object_id),NCHAR(13),N'') COLLATE Latin1_General_100_BIN2)=0)
    THROW 58407,N'Missing reviewed SAG evidence expression.',1;
  IF @owns084=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns084=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
