/* Optional owner-compatible SAG publisher entry points. The 053/055 contracts
   remain the only writers. No permission or role membership of any existing
   login/user is changed; this migration creates only a no-login module delegate. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @owns064 bit=CASE WHEN @@TRANCOUNT=0 THEN 1 ELSE 0 END;
BEGIN TRY
  IF @owns064=1 BEGIN TRANSACTION;
  IF NOT ((DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb' AND DATALENGTH(DB_NAME())=24)
      OR (DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb-TEST' AND DATALENGTH(DB_NAME())=34))
    OR CAST(SERVERPROPERTY(N'ProductMajorVersion') AS int)<>15
    OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150
      AND is_read_only=0 AND collation_name COLLATE Latin1_General_100_BIN2=N'Modern_Spanish_CI_AS')
    THROW 56401,N'Expected the writable Portal database on SQL Server 2019 compatibility 150.',1;

  DECLARE @lock064 int;
  EXEC @lock064=sys.sp_getapplock @Resource=N'portal-sag:migration:064:sag-owner-publisher',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock064<0 THROW 56402,N'Could not reserve migration 064.',1;

  IF NOT EXISTS(SELECT 1 FROM migration.schema_migrations WHERE migration_version='059' AND succeeded=1)
    OR DATABASE_PRINCIPAL_ID(N'portal_catalog_v2_publisher') IS NULL
    OR OBJECT_ID(N'settings.reserve_catalog_sag_v2_attempt',N'P') IS NULL
    OR OBJECT_ID(N'settings.publish_catalog_sag_v2_with_targets',N'P') IS NULL
    OR OBJECT_ID(N'settings.fail_catalog_sag_v2_attempt',N'P') IS NULL
    THROW 56403,N'Expected the installed SAG v2 publisher and migration 059.',1;

  IF DATABASE_PRINCIPAL_ID(N'portal_catalog_v2_owner_delegate') IS NULL
    CREATE USER [portal_catalog_v2_owner_delegate] WITHOUT LOGIN;

  DECLARE @delegate int=DATABASE_PRINCIPAL_ID(N'portal_catalog_v2_owner_delegate'),
    @publisherRole int=DATABASE_PRINCIPAL_ID(N'portal_catalog_v2_publisher');
  IF NOT EXISTS(SELECT 1 FROM sys.database_principals WHERE principal_id=@delegate
      AND type='S' AND authentication_type=0 AND name COLLATE Latin1_General_100_BIN2=N'portal_catalog_v2_owner_delegate')
    OR EXISTS(SELECT 1 FROM sys.database_role_members WHERE member_principal_id=@delegate AND role_principal_id<>@publisherRole)
    -- CREATE USER records its ordinary database CONNECT grant even for a
    -- WITHOUT LOGIN principal. Accept only that implicit, non-delegable row.
    OR EXISTS(SELECT 1 FROM sys.database_permissions WHERE grantor_principal_id=@delegate
      OR (grantee_principal_id=@delegate AND NOT (class=0 AND major_id=0 AND minor_id=0
        AND state='G' AND permission_name='CONNECT' AND grantor_principal_id=DATABASE_PRINCIPAL_ID(N'dbo'))))
    OR EXISTS(SELECT 1 FROM sys.schemas WHERE principal_id=@delegate)
    OR EXISTS(SELECT 1 FROM sys.objects WHERE principal_id=@delegate)
    OR EXISTS(SELECT 1 FROM sys.database_principals WHERE owning_principal_id=@delegate)
    THROW 56404,N'The SAG owner module delegate must be an unprivileged no-login user.',1;
  IF NOT EXISTS(SELECT 1 FROM sys.database_role_members WHERE member_principal_id=@delegate AND role_principal_id=@publisherRole)
    ALTER ROLE [portal_catalog_v2_publisher] ADD MEMBER [portal_catalog_v2_owner_delegate];

  -- Module-level execution context is reverted by SQL Server even on error or
  -- cancellation. The inner module checks original login and target independently.
  EXEC sys.sp_executesql N'CREATE OR ALTER PROCEDURE settings.catalog_sag_v2_owner_dispatch_internal
  @operation char(1), @environment varchar(32), @sourceId uniqueidentifier, @jobId uniqueidentifier,
  @workerId uniqueidentifier, @leaseToken uniqueidentifier, @attempt int, @bindingVersion varbinary(32),
  @profileVersion varbinary(32), @matchKeyVersion smallint, @vaultSecretVersion varbinary(64),
  @keyVerifier varbinary(64), @attemptOrdinal bigint=NULL, @customerCount int=NULL, @companyCount int=NULL,
  @customers nvarchar(max)=NULL, @companies nvarchar(max)=NULL, @targets nvarchar(max)=NULL
WITH EXECUTE AS ''portal_catalog_v2_owner_delegate''
AS
BEGIN
  SET NOCOUNT ON;
  IF ORIGINAL_LOGIN() COLLATE Latin1_General_100_BIN2<>N''SAGWebDev'' OR DATALENGTH(ORIGINAL_LOGIN())<>18
    OR USER_NAME() COLLATE Latin1_General_100_BIN2<>N''portal_catalog_v2_owner_delegate''
    OR ISNULL(IS_ROLEMEMBER(N''portal_catalog_v2_publisher''),0)<>1
    OR @environment IS NULL OR NOT (
      (@environment COLLATE Latin1_General_100_BIN2=''qa'' AND DATALENGTH(@environment)=2
        AND DB_NAME() COLLATE Latin1_General_100_BIN2=N''PortalSAGWeb-TEST'' AND DATALENGTH(DB_NAME())=34)
      OR (@environment COLLATE Latin1_General_100_BIN2=''production'' AND DATALENGTH(@environment)=10
        AND DB_NAME() COLLATE Latin1_General_100_BIN2=N''PortalSAGWeb'' AND DATALENGTH(DB_NAME())=24))
    THROW 56405,N''SAG owner publisher is unavailable.'',1;

  IF @operation COLLATE Latin1_General_100_BIN2=''R''
    EXEC settings.reserve_catalog_sag_v2_attempt
      @environment=@environment,@sourceId=@sourceId,@jobId=@jobId,@workerId=@workerId,@leaseToken=@leaseToken,
      @attempt=@attempt,@bindingVersion=@bindingVersion,@profileVersion=@profileVersion,@matchKeyVersion=@matchKeyVersion,
      @vaultSecretVersion=@vaultSecretVersion,@keyVerifier=@keyVerifier;
  ELSE IF @operation COLLATE Latin1_General_100_BIN2=''P''
    EXEC settings.publish_catalog_sag_v2_with_targets
      @environment=@environment,@sourceId=@sourceId,@jobId=@jobId,@workerId=@workerId,@leaseToken=@leaseToken,
      @attempt=@attempt,@bindingVersion=@bindingVersion,@profileVersion=@profileVersion,@matchKeyVersion=@matchKeyVersion,
      @vaultSecretVersion=@vaultSecretVersion,@keyVerifier=@keyVerifier,@attemptOrdinal=@attemptOrdinal,
      @customerCount=@customerCount,@companyCount=@companyCount,@customers=@customers,@companies=@companies,@targets=@targets;
  ELSE IF @operation COLLATE Latin1_General_100_BIN2=''F''
    EXEC settings.fail_catalog_sag_v2_attempt
      @environment=@environment,@sourceId=@sourceId,@jobId=@jobId,@workerId=@workerId,@leaseToken=@leaseToken,
      @attempt=@attempt,@bindingVersion=@bindingVersion,@profileVersion=@profileVersion,@matchKeyVersion=@matchKeyVersion,
      @vaultSecretVersion=@vaultSecretVersion,@keyVerifier=@keyVerifier,@attemptOrdinal=@attemptOrdinal;
  ELSE THROW 56405,N''SAG owner publisher is unavailable.'',1;
END;';

  EXEC sys.sp_executesql N'CREATE OR ALTER PROCEDURE settings.reserve_catalog_sag_v2_owner_attempt
  @environment varchar(32), @sourceId uniqueidentifier, @jobId uniqueidentifier,@workerId uniqueidentifier,
  @leaseToken uniqueidentifier,@attempt int,@bindingVersion varbinary(32),@profileVersion varbinary(32),
  @matchKeyVersion smallint,@vaultSecretVersion varbinary(64),@keyVerifier varbinary(64)
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
    THROW 56405,N''SAG owner publisher is unavailable.'',1;
  EXEC settings.catalog_sag_v2_owner_dispatch_internal @operation=''R'',
    @environment=@environment,@sourceId=@sourceId,@jobId=@jobId,@workerId=@workerId,@leaseToken=@leaseToken,
    @attempt=@attempt,@bindingVersion=@bindingVersion,@profileVersion=@profileVersion,@matchKeyVersion=@matchKeyVersion,
    @vaultSecretVersion=@vaultSecretVersion,@keyVerifier=@keyVerifier;
END;';

  EXEC sys.sp_executesql N'CREATE OR ALTER PROCEDURE settings.publish_catalog_sag_v2_owner_with_targets
  @environment varchar(32), @sourceId uniqueidentifier, @jobId uniqueidentifier,@workerId uniqueidentifier,
  @leaseToken uniqueidentifier,@attempt int,@bindingVersion varbinary(32),@profileVersion varbinary(32),
  @matchKeyVersion smallint,@vaultSecretVersion varbinary(64),@keyVerifier varbinary(64),@attemptOrdinal bigint,
  @customerCount int,@companyCount int,@customers nvarchar(max),@companies nvarchar(max),@targets nvarchar(max)
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
    THROW 56405,N''SAG owner publisher is unavailable.'',1;
  EXEC settings.catalog_sag_v2_owner_dispatch_internal @operation=''P'',
    @environment=@environment,@sourceId=@sourceId,@jobId=@jobId,@workerId=@workerId,@leaseToken=@leaseToken,
    @attempt=@attempt,@bindingVersion=@bindingVersion,@profileVersion=@profileVersion,@matchKeyVersion=@matchKeyVersion,
    @vaultSecretVersion=@vaultSecretVersion,@keyVerifier=@keyVerifier,@attemptOrdinal=@attemptOrdinal,
    @customerCount=@customerCount,@companyCount=@companyCount,@customers=@customers,@companies=@companies,@targets=@targets;
END;';

  EXEC sys.sp_executesql N'CREATE OR ALTER PROCEDURE settings.fail_catalog_sag_v2_owner_attempt
  @environment varchar(32), @sourceId uniqueidentifier, @jobId uniqueidentifier,@workerId uniqueidentifier,
  @leaseToken uniqueidentifier,@attempt int,@bindingVersion varbinary(32),@profileVersion varbinary(32),
  @matchKeyVersion smallint,@vaultSecretVersion varbinary(64),@keyVerifier varbinary(64),@attemptOrdinal bigint
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
    THROW 56405,N''SAG owner publisher is unavailable.'',1;
  EXEC settings.catalog_sag_v2_owner_dispatch_internal @operation=''F'',
    @environment=@environment,@sourceId=@sourceId,@jobId=@jobId,@workerId=@workerId,@leaseToken=@leaseToken,
    @attempt=@attempt,@bindingVersion=@bindingVersion,@profileVersion=@profileVersion,@matchKeyVersion=@matchKeyVersion,
    @vaultSecretVersion=@vaultSecretVersion,@keyVerifier=@keyVerifier,@attemptOrdinal=@attemptOrdinal;
END;';

  IF EXISTS(SELECT 1 FROM sys.database_permissions WHERE class=1 AND major_id IN (
      OBJECT_ID(N'settings.catalog_sag_v2_owner_dispatch_internal',N'P'),
      OBJECT_ID(N'settings.reserve_catalog_sag_v2_owner_attempt',N'P'),
      OBJECT_ID(N'settings.publish_catalog_sag_v2_owner_with_targets',N'P'),
      OBJECT_ID(N'settings.fail_catalog_sag_v2_owner_attempt',N'P')))
    THROW 56406,N'The SAG owner publisher entry points must have no explicit grants.',1;
  IF @owns064=1 COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @owns064=1 AND XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
