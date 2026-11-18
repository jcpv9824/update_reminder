[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SessionDirectory)

$ErrorActionPreference='Stop'
$session=(Resolve-Path -LiteralPath $SessionDirectory).Path
$descriptor=Get-Content -Raw -LiteralPath (Join-Path $session 'active.json') | ConvertFrom-Json
if($descriptor.database -cne 'PortalSAGWeb-TEST' -or $descriptor.environment -cne 'qa'){
  throw 'This rehearsal requires the PortalSAGWeb-TEST session.'
}
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$compiled=Join-Path $root 'api/dist/src/lib/catalogOnceClosureSql.js'
if(!(Test-Path -LiteralPath $compiled)){throw 'Build the API candidate before rehearsing SQL closure eligibility.'}
$query=(& node -e 'process.stdout.write(require(process.argv[1]).readCatalogOnceClosureProofSql);' $compiled) -join [Environment]::NewLine
if($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($query) -or
  $query -match '(?im)^\s*(INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|CREATE|EXEC(?:UTE)?)\b'){
  throw 'Expected a read-only compiled closure proof statement.'
}
$literal="DECLARE @proofSql nvarchar(max)=N'"+$query.Replace("'","''")+"';"
$body=@'
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR @@TRANCOUNT<>0
  THROW 54970,N'Unexpected QA closure rehearsal target.',1;
IF OBJECT_ID(N'scheduling.catalog_once_observations',N'U') IS NULL
  THROW 54971,N'The observed ledger must be installed first.',1;
DECLARE @key bigint=9223372036854775807,@passed int=0,@scenario int=1,@lock int;
-- Prove both past- and future-day binding without using any live data or
-- masking SQL compilation errors with an early no-lock guard.
DECLARE @day date=CONVERT(date,DATEADD(hour,-5,SYSUTCDATETIME()));
DECLARE @taskDate date,@resource nvarchar(255);
DECLARE @result table (scheduleId nvarchar(150),scheduleVersion char(16),clientId nvarchar(150));
IF EXISTS(SELECT 1 FROM scheduling.catalog_once_observations WHERE observation_key=@key)
  THROW 54972,N'Reserved QA observation key is not absent.',1;
BEGIN TRY
  WHILE @scenario<=3
  BEGIN
    SET @taskDate=DATEADD(day,CASE WHEN @scenario=2 THEN 2 ELSE -2 END,@day);
    BEGIN TRANSACTION;
    IF @scenario<>3
    BEGIN
      SET @resource=N'portal.catalog-task.v1:database:'+CONVERT(char(10),@taskDate,23);
      EXEC @lock=sys.sp_getapplock @Resource=@resource,@LockMode=N'Exclusive',
        @LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=1000;
      IF @lock<0 THROW 54973,N'Could not reserve the QA task day lock.',1;
      SET @resource=N'portal.catalog-task.v1:domain:'+CONVERT(char(10),@taskDate,23);
      EXEC @lock=sys.sp_getapplock @Resource=@resource,@LockMode=N'Exclusive',
        @LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=1000;
      IF @lock<0 THROW 54973,N'Could not reserve the QA task day lock.',1;
    END;
    DELETE FROM @result;
    INSERT @result EXEC sys.sp_executesql @proofSql,
      N'@portalEnvironment varchar(10),@taskDate date,@observationKey bigint','qa',@taskDate,@key;
    IF EXISTS(SELECT 1 FROM @result) THROW 54974,N'Unsafe closure proof for an absent observation.',1;
    ROLLBACK TRANSACTION;
    SET @passed+=1;
    SET @scenario+=1;
  END;
  SELECT @passed AS passed,0 AS error_number,0 AS error_case,0 AS error_line;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  SELECT @passed AS passed,ERROR_NUMBER() AS error_number,@scenario AS error_case,ERROR_LINE() AS error_line;
END CATCH;
'@
$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
$response=(& $invoke -SessionDirectory $session -Sql ($literal+[Environment]::NewLine+$body) -Mode write -TimeoutSeconds 35 -MaxRows 1) |
  ConvertFrom-Json -Depth 14
$sets=@($response.resultSets)
$row=if($sets.Count){$sets[-1].rows[0]}else{$null}
if(!$response.success -or $row.passed -ne 3 -or $row.error_number -ne 0){
  throw "QA closure binding failed (SQL number: $([int]$row.error_number); case: $([int]$row.error_case); line: $([int]$row.error_line))."
}
$row | Select-Object passed,error_number,error_case | ConvertTo-Json -Compress
