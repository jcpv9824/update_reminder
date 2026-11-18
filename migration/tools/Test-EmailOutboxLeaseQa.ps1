[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SessionDirectory)

$ErrorActionPreference='Stop'
$session=(Resolve-Path -LiteralPath $SessionDirectory).Path
$descriptor=Get-Content -Raw -LiteralPath (Join-Path $session 'active.json') | ConvertFrom-Json
if($descriptor.database -cne 'PortalSAGWeb-TEST' -or $descriptor.environment -cne 'qa'){
  throw 'This rehearsal requires the PortalSAGWeb-TEST session.'
}
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$compiled=Join-Path $root 'api/dist/src/lib/emailOutboxSqlRepository.js'
if(!(Test-Path -LiteralPath $compiled)){throw 'Build the API candidate before rehearsing the outbox lease.'}
$query=(& node -e 'const q=require(process.argv[1]).renewSqlEmailClaimSql;if(typeof q!=="string"||!q.trim())process.exit(1);process.stdout.write(q);' $compiled) -join [Environment]::NewLine
if($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($query)){
  throw 'Expected the exported renewal SQL from the compiled API candidate.'
}
# Load the exact compiled statement, not a reconstructed copy of its predicates.
$literal="DECLARE @renewSql nvarchar(max)=N'"+$query.Replace("'","''")+"';"
$body=@'
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR @@TRANCOUNT<>0
  THROW 54980,N'Unexpected QA email lease rehearsal target.',1;
IF CAST(SERVERPROPERTY('ProductMajorVersion') AS int)<>15
  THROW 54981,N'This rehearsal requires SQL Server 2019.',1;
DECLARE @fixture nvarchar(150)=N'qa-outbox-lease-'+CONVERT(nvarchar(36),NEWID());
DECLARE @worker nvarchar(150)=N'qa-worker-'+CONVERT(nvarchar(36),NEWID());
DECLARE @otherWorker nvarchar(150)=N'qa-worker-'+CONVERT(nvarchar(36),NEWID());
DECLARE @key bigint,@requestKey bigint,@passed int=0,@scenario int=1;
DECLARE @before binary(8),@expiry datetime2(3),@now datetime2(3),@survivors int;
DECLARE @result table(renewed int);
IF EXISTS(SELECT 1 FROM notifications.email_notifications WHERE notification_key=9223372036854775807)
  THROW 54982,N'Reserved absent QA notification key is already present.',1;
BEGIN TRY
  BEGIN TRANSACTION;
  SET @now=SYSUTCDATETIME();
  -- No recipients, content, task or external target exists. The fixture remains
  -- uncommitted and is rolled back; this script never calls the email worker.
  INSERT notifications.email_notifications
    (source_id,notification_type,idempotency_key,subject,status,attempt_count,
     claimed_by,claim_expires_at,metadata_json,created_at,created_by,updated_at,updated_by)
  VALUES(@fixture,'task_reminder',@fixture,N'QA lease only','processing',1,
    @worker,DATEADD(second,60,@now),N'{}',@now,@worker,@now,@worker);
  SET @key=CONVERT(bigint,SCOPE_IDENTITY());
  WHILE @scenario<=7
  BEGIN
    SET @now=SYSUTCDATETIME();
    SET @expiry=CASE WHEN @scenario=2 THEN DATEADD(second,-30,@now)
      WHEN @scenario=3 THEN @now ELSE DATEADD(second,60,@now) END;
    UPDATE notifications.email_notifications
      SET status=CASE WHEN @scenario=6 THEN 'pending' ELSE 'processing' END,
        attempt_count=CASE WHEN @scenario=5 THEN 2 ELSE 1 END,
        claimed_by=CASE WHEN @scenario=4 THEN @otherWorker ELSE @worker END,
        claim_expires_at=@expiry
      WHERE notification_key=@key;
    SELECT @before=row_version FROM notifications.email_notifications WHERE notification_key=@key;
    SET @requestKey=CASE WHEN @scenario=7 THEN 9223372036854775807 ELSE @key END;
    DELETE FROM @result;
    INSERT @result EXEC sys.sp_executesql @renewSql,
      N'@notificationKey bigint,@workerId nvarchar(150),@attemptNo int,@leaseSeconds int',
      @requestKey,@worker,1,120;
    IF (SELECT COUNT(*) FROM @result)<>1
      THROW 54983,N'Renewal must return exactly one decision.',1;
    IF @scenario=1
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM @result WHERE renewed=1)
        THROW 54984,N'Unexpired matching lease failed renewal.',1;
      IF NOT EXISTS(SELECT 1 FROM notifications.email_notifications
        WHERE notification_key=@key AND claimed_by=@worker AND attempt_count=1
          AND status='processing' AND claim_expires_at>@expiry AND row_version<>@before)
        THROW 54985,N'Successful renewal did not extend the matching lease.',1;
    END
    ELSE
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM @result WHERE renewed=0)
        THROW 54986,N'Expired, replaced or mismatched lease was renewed.',1;
      IF NOT EXISTS(SELECT 1 FROM notifications.email_notifications WHERE notification_key=@key AND row_version=@before)
        THROW 54987,N'Rejected renewal changed the fixture.',1;
    END;
    SET @passed+=1;
    SET @scenario+=1;
  END;
  ROLLBACK TRANSACTION;
  SELECT @survivors=COUNT(*) FROM notifications.email_notifications WHERE source_id=@fixture;
  IF @survivors<>0 THROW 54988,N'QA fixture survived rollback.',1;
  SELECT @passed AS passed,0 AS error_number,0 AS error_case,0 AS error_line,
    @survivors AS fixture_rows_remaining;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  SELECT @passed AS passed,ERROR_NUMBER() AS error_number,@scenario AS error_case,
    ERROR_LINE() AS error_line,
    (SELECT COUNT(*) FROM notifications.email_notifications WHERE source_id=@fixture) AS fixture_rows_remaining;
END CATCH;
'@
# Case 3 sets expiry to SQL's current time just before executing the statement;
# it tests the at-or-past boundary, not simultaneous clocks or two-session overlap.
# The worker replacement cases are sequential ownership mutations, not a claim
# of concurrent-worker certification. SMTP delivery is not exercised here.
$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
$response=(& $invoke -SessionDirectory $session -Sql ($literal+[Environment]::NewLine+$body) -Mode write -TimeoutSeconds 35 -MaxRows 1) |
  ConvertFrom-Json -Depth 14
$sets=@($response.resultSets)
$row=if($sets.Count){$sets[-1].rows[0]}else{$null}
if(!$response.success -or $row.passed -ne 7 -or $row.error_number -ne 0 -or $row.fixture_rows_remaining -ne 0){
  throw "QA email lease rehearsal failed (SQL number: $([int]$row.error_number); case: $([int]$row.error_case); line: $([int]$row.error_line))."
}
$row | Select-Object passed,error_number,error_case,fixture_rows_remaining | ConvertTo-Json -Compress
