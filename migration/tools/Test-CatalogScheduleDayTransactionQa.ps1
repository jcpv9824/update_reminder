[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SessionDirectory)

$ErrorActionPreference='Stop'
$session=(Resolve-Path -LiteralPath $SessionDirectory).Path
$descriptor=Get-Content -LiteralPath (Join-Path $session 'active.json') -Raw | ConvertFrom-Json
if($descriptor.database -cne 'PortalSAGWeb-TEST' -or $descriptor.environment -cne 'qa'){
  throw 'This rehearsal requires an authorized PortalSAGWeb-TEST session.'
}
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
function Read-Literal([string]$File,[string]$Name){
  $source=Get-Content -LiteralPath (Join-Path $root $File) -Raw
  $delim=[regex]::Escape([string][char]96)
  $pattern='(?s)const '+[regex]::Escape($Name)+' = '+$delim+'(.*?)'+$delim+';'
  $statement=[regex]::Match($source,$pattern).Groups[1].Value
  if(!$statement -or $statement.Contains('${')){ throw "Expected the literal statement: $Name." }
  return $statement.Replace("'","''")
}
$lock=Read-Literal 'api/src/lib/catalogExecutionCoexistenceSql.ts' 'CATALOG_TASK_DAY_LOCK_SQL'
$clock=Read-Literal 'api/src/lib/catalogScheduleDayTransaction.ts' 'clockSql'
$prefix="DECLARE @lockSql nvarchar(max)=N'$lock',@clockSql nvarchar(max)=N'$clock';"
$fixture=@'
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR @@TRANCOUNT<>0
  THROW 54690,N'Unexpected QA rehearsal target.',1;
-- No persisted Portal records: the two provisional operations are represented
-- by rows in this connection-local table. Run the production lock/clock SQL.
DROP TABLE IF EXISTS #dayFenceFixture;
CREATE TABLE #dayFenceFixture(ordinal int NOT NULL PRIMARY KEY);
DECLARE @day date='2099-11-18',@case int=1,@passed int=0,@status varchar(10);
DECLARE @lockParams nvarchar(90)=N'@taskDate date,@targetType varchar(20)';
DECLARE @clockParams nvarchar(90)=N'@cutoffAt datetime2(3),@validUntil datetime2(3)';
DECLARE @state TABLE(status varchar(10));
DECLARE @now datetime2(3)=SYSUTCDATETIME(),@later datetime2(3),@earlier datetime2(3),@cutoff datetime2(3),@evidence datetime2(3);
SET @later=DATEADD(minute,5,@now);
SET @earlier=DATEADD(minute,-5,@now);
WHILE @case<=3
BEGIN
  BEGIN TRY
    BEGIN TRANSACTION;
    -- SQL Server does not allow this lock statement inside INSERT EXEC.
    -- Return the three codes directly and check them in the wrapper.
    EXEC sys.sp_executesql @lockSql,@lockParams,@day,'database';
    EXEC sys.sp_executesql @lockSql,@lockParams,@day,'domain';
    EXEC sys.sp_executesql @lockSql,@lockParams,@day,'database';
    IF APPLOCK_MODE('public','portal.catalog-task.v1:database:2099-11-18','Transaction')<>'Exclusive'
      OR APPLOCK_MODE('public','portal.catalog-task.v1:domain:2099-11-18','Transaction')<>'Exclusive'
      THROW 54691,N'Day lock did not remain transaction-owned.',1;
    INSERT #dayFenceFixture VALUES(1),(2);
    DELETE FROM @state;
    SET @cutoff=CASE WHEN @case=3 THEN @earlier ELSE @later END;
    SET @evidence=CASE WHEN @case=1 THEN @later ELSE @earlier END;
    INSERT @state EXEC sys.sp_executesql @clockSql,@clockParams,@cutoff,@evidence;
    SELECT @status=status FROM @state;
    IF (SELECT COUNT(*) FROM @state)<>1 OR @status<>CASE @case WHEN 1 THEN 'valid' WHEN 2 THEN 'unverified' ELSE 'cutoff' END
      THROW 54692,N'Unexpected SQL deadline result.',1;
    IF @status='valid' COMMIT TRANSACTION;
    ELSE ROLLBACK TRANSACTION;
    IF (SELECT COUNT(*) FROM #dayFenceFixture)<>CASE WHEN @case=1 THEN 2 ELSE 0 END
      THROW 54693,N'Provisional groups did not commit or roll back together.',1;
    IF @@TRANCOUNT<>0 THROW 54694,N'Day transaction was not closed.',1;
    BEGIN TRANSACTION;
    IF APPLOCK_MODE('public','portal.catalog-task.v1:database:2099-11-18','Transaction')<>'NoLock'
      OR APPLOCK_MODE('public','portal.catalog-task.v1:domain:2099-11-18','Transaction')<>'NoLock'
      THROW 54694,N'Day lock remained after the transaction.',1;
    COMMIT TRANSACTION;
    DELETE FROM #dayFenceFixture;
    SET @passed+=1;
  END TRY
  BEGIN CATCH
    IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
    DROP TABLE #dayFenceFixture;
    SELECT ERROR_NUMBER() AS error_number,@case AS error_case;
    RETURN;
  END CATCH;
  SET @case+=1;
END;
SELECT @passed AS passed,(SELECT COUNT(*) FROM #dayFenceFixture) AS remaining_fixtures;
DROP TABLE #dayFenceFixture;
'@

$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
try {
  $response=(& $invoke -SessionDirectory $session -Sql ($prefix+[Environment]::NewLine+$fixture) -Mode write -TimeoutSeconds 25 -MaxRows 1) |
    ConvertFrom-Json -Depth 16
} catch {
  $exceptionType=$_.Exception.GetType().Name
  $category=switch -Regex ($_.Exception.Message) {
    'Incorrect syntax near|Unclosed quotation' { 'SQL syntax'; break }
    'Timeout|timed out' { 'timeout'; break }
    'Invalid column|Invalid object' { 'SQL binding'; break }
    'object named.*dayFenceFixture' { 'stale QA scratch table'; break }
    'no response|no longer running|stale' { 'session'; break }
    default { $exceptionType }
  }
  throw "QA day transaction rehearsal did not return sanitized evidence ($category)."
}
$sets=@($response.resultSets)
$row=if($sets.Count){$sets[-1].rows[0]}else{$null}
if(!$response.success -or $sets.Count -ne 10 -or $row.passed -ne 3 -or $row.remaining_fixtures -ne 0){
  throw "QA day transaction rehearsal failed (SQL number: $([int]$row.error_number); case: $([int]$row.error_case))."
}
for($i=0;$i -lt 9;$i++){
  if($sets[$i].rows.Count -ne 1 -or $sets[$i].rows[0].lockCode -notin @(0,1)){
    throw 'A transaction-owned task-day lock did not succeed.'
  }
}
$row | Select-Object passed,remaining_fixtures | ConvertTo-Json -Compress
