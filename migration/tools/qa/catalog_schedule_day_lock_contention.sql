/* No persistent operations: exact Portal QA, rollback-only application lock probe. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR DATALENGTH(DB_NAME())<>34
  OR CAST(SERVERPROPERTY(N'ProductMajorVersion') AS int)<>15 OR @@TRANCOUNT<>0
  OR @fixtureMode IS NULL OR @fixtureMode COLLATE Latin1_General_100_BIN2 NOT IN ('H','P','R')
  OR @daysAgo IS NULL OR @daysAgo NOT BETWEEN 211 AND 999
  THROW 58295,N'Expected the bounded Portal QA application lock rehearsal.',1;
DECLARE @dayText char(10)=CONVERT(char(10),DATEADD(day,-@daysAgo,CONVERT(date,DATEADD(hour,-5,SYSUTCDATETIME()))),23),
  @databaseResource nvarchar(255),@domainResource nvarchar(255),@databaseResult int,@domainResult int;
SET @databaseResource=N'portal.catalog-task.v1:database:'+@dayText;
SET @domainResource=N'portal.catalog-task.v1:domain:'+@dayText;
DECLARE @observed datetime2(3),@released datetime2(3);
BEGIN TRY
  BEGIN TRANSACTION;
  EXEC @databaseResult=sys.sp_getapplock @Resource=@databaseResource,@LockMode=N'Exclusive',
    @LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=0;
  EXEC @domainResult=sys.sp_getapplock @Resource=@domainResource,@LockMode=N'Exclusive',
    @LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=0;
  SET @observed=SYSUTCDATETIME();
  IF @fixtureMode='H'
  BEGIN
    IF @databaseResult<0 OR @domainResult<0 THROW 58296,N'The holder could not reserve both QA dates.',1;
    WAITFOR DELAY '00:00:14';
  END;
  IF @fixtureMode='R' AND (@databaseResult<0 OR @domainResult<0)
    THROW 58297,N'At least one QA lock did not become available after rollback.',1;
  ROLLBACK TRANSACTION;
  SET @released=SYSUTCDATETIME();
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
SELECT DB_NAME() AS targetDatabase,@dayText AS businessDate,@@SPID AS connectionId,
  @databaseResult AS databaseResult,@domainResult AS domainResult,
  DATEDIFF_BIG(millisecond,CONVERT(datetime2(3),'19700101',112),@observed) AS observedUtcMs,
  DATEDIFF_BIG(millisecond,CONVERT(datetime2(3),'19700101',112),@released) AS releasedUtcMs,
  CONVERT(bit,1) AS rolledBack;
