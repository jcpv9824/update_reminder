[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SessionDirectory)
$ErrorActionPreference='Stop'
$session=(Resolve-Path -LiteralPath $SessionDirectory).Path
$d=Get-Content -Raw -LiteralPath (Join-Path $session 'active.json') | ConvertFrom-Json
if($d.database -cne 'PortalSAGWeb-TEST' -or $d.environment -cne 'qa' -or $d.accessLevel -cne 'full-control'){
  throw 'Expected an explicitly authorized PortalSAGWeb-TEST session.'
}
$captured=(& node (Join-Path $PSScriptRoot 'capture-same-day-deletion-qa-sql.cjs')) -join [Environment]::NewLine
if($LASTEXITCODE -ne 0 -or !$captured){throw 'Build the exact API candidate before this rehearsal.'}
$queries=$captured | ConvertFrom-Json -AsHashtable
$prefix=foreach($name in @('lock','remove','detach','exclusive','history','cancel','suppress')){
  $query=[string]$queries[$name]
  if(!$query -or $query -match '(?i)\b(scheduling|workflow|notifications|core|security|migration|settings|dbo)\s*\.'){
    throw 'The compiled statement escaped the private shadow fixture.'
  }
  'DECLARE @'+$name+"Sql nvarchar(max)=N'"+$query.Replace("'","''")+"';"
}
# SQL engine rehearsal only: no global FIFO worker, shared tables, identity
# allocation, app audit, browser, or sending email. DDL/DML is local to #temp.
$body=@'
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR DATALENGTH(DB_NAME())<>34 OR @@TRANCOUNT<>0
  OR CAST(SERVERPROPERTY('ProductMajorVersion') AS int)<>15 THROW 58780,N'Unexpected shadow QA target.',1;
DECLARE @day date=CONVERT(date,DATEADD(hour,-5,SYSUTCDATETIME())),@now datetime2(3)=SYSUTCDATETIME(),@deleted datetime2(3),@passed int=0;
BEGIN TRY
  BEGIN TRANSACTION;
  CREATE TABLE #schedules(schedule_key bigint PRIMARY KEY,source_id nvarchar(150) COLLATE DATABASE_DEFAULT UNIQUE,
    active bit,deleted_at datetime2(3),deleted_by nvarchar(150),updated_at datetime2(3),updated_by nvarchar(150),start_date date);
  CREATE TABLE #tasks(task_key bigint PRIMARY KEY,source_id nvarchar(260) COLLATE DATABASE_DEFAULT UNIQUE,
    client_source_id nvarchar(150),client_name_snapshot nvarchar(200),domain_source_id nvarchar(150),domain_name_snapshot nvarchar(500),
    target_type varchar(20),target_source_id nvarchar(150),task_date date,status varchar(30),result nvarchar(500),
    notes nvarchar(max),updated_at datetime2(3),updated_by nvarchar(150),
    primary_schedule_source_id nvarchar(150) COLLATE DATABASE_DEFAULT,primary_schedule_key bigint);
  CREATE TABLE #taskSources(task_key bigint,schedule_source_id nvarchar(150) COLLATE DATABASE_DEFAULT,schedule_key bigint);
  CREATE TABLE #executions(catalog_execution_key bigint PRIMARY KEY,task_key bigint);
  CREATE TABLE #executionLinks(catalog_execution_link_key bigint PRIMARY KEY,catalog_execution_key bigint,retired_at datetime2(3));
  CREATE TABLE #attachments(catalog_execution_link_key bigint,schedule_key bigint,attached_at datetime2(3),detached_at datetime2(3));
  CREATE TABLE #history(task_key bigint,previous_status varchar(30),new_status varchar(30),action nvarchar(80),comment nvarchar(max),
    performed_by nvarchar(150),performed_by_email nvarchar(254),performed_at datetime2(3),is_inferred bit,metadata_json nvarchar(max));
  CREATE TABLE #notices(notification_key bigint PRIMARY KEY,task_key bigint,notification_type varchar(60),status varchar(20),
    claimed_by nvarchar(150),claim_expires_at datetime2(3),attempt_count int,next_attempt_at datetime2(3),
    last_error nvarchar(2000),updated_at datetime2(3),updated_by nvarchar(150),metadata_json nvarchar(max) COLLATE DATABASE_DEFAULT);
  CREATE TABLE #attempts(notification_key bigint,attempt_no int,completed_at datetime2(3),attempt_status varchar(20),error_message nvarchar(2000));
  CREATE TABLE #recipients(notification_key bigint,delivery_status varchar(20),error_message nvarchar(2000));
  INSERT #schedules(schedule_key,source_id,active,start_date) VALUES(1,N'original',1,@day),(2,N'copy',1,@day),(3,N'third',1,@day);
  INSERT #tasks(task_key,source_id,target_type,task_date,status,primary_schedule_source_id,primary_schedule_key)
    VALUES(11,N'original-task','domain',@day,'pending',N'original',1),(12,N'shared-task','domain',@day,'blocked',N'original',1),
      (13,N'third-task','domain',@day,'pending',N'third',3),(14,N'copy-task','domain',@day,'pending',N'copy',2);
  INSERT #executions VALUES(21,11),(22,12),(23,13),(24,14);
  INSERT #executionLinks VALUES(31,21,NULL),(32,22,NULL),(33,23,NULL),(34,24,NULL);
  INSERT #attachments VALUES(31,1,@now,NULL),(32,1,@now,NULL),(32,2,@now,NULL),(33,3,@now,NULL),(34,2,@now,NULL);
  INSERT #notices(notification_key,task_key,notification_type,status,claimed_by,claim_expires_at,attempt_count,next_attempt_at,metadata_json)
    VALUES(1,11,'task_reminder','pending',NULL,NULL,0,@now,N'{}'),
      (2,12,'blocked_task_reminder','failed',NULL,NULL,1,@now,N'{"taskIds":["shared-task"],"schedulesByTask":[["shared-task","original"]]}'),
      (3,12,'blocked_task_reminder','pending',NULL,NULL,0,@now,N'{"taskIds":["shared-task"],"schedulesByTask":[["shared-task","copy"]]}'),
      (4,11,'task_reminder','processing',N'qa',DATEADD(minute,10,@now),2,NULL,N'{}'),
      (5,13,'task_reminder','pending',NULL,NULL,0,@now,N'{}'),(6,11,'test_email','pending',NULL,NULL,0,@now,N'{}'),
      (7,11,'task_reminder','pending',NULL,NULL,0,@now,N'{"taskIds":["original-task","copy-task"],"schedulesByTask":[["original-task","original"],["copy-task","copy"]]}'),
      (8,11,'task_reminder','sent',NULL,NULL,1,NULL,N'{}'),(9,11,'task_reminder','processing',N'qa',DATEADD(minute,-1,@now),2,NULL,N'{}');
  INSERT #attempts(notification_key,attempt_no,attempt_status) VALUES(4,2,'processing'),(9,2,'processing');
  INSERT #recipients(notification_key,delivery_status) VALUES(1,'pending'),(2,'failed'),(3,'pending'),(4,'pending'),
    (5,'pending'),(6,'pending'),(7,'pending'),(8,'sent'),(9,'pending');

  DECLARE @locked table(schedule_key bigint);
  DECLARE @tombstone table(deleted_at datetime2(3));
  INSERT @locked EXEC sys.sp_executesql @lockSql,N'@sourceId nvarchar(150)',N'original';
  IF (SELECT COUNT(*) FROM @locked)<>1 OR NOT EXISTS(SELECT 1 FROM @locked WHERE schedule_key=1)
    THROW 58781,N'Unexpected original lock outcome.',1;
  INSERT @tombstone EXEC sys.sp_executesql @removeSql,N'@sourceId nvarchar(150),@actorId nvarchar(150)',N'original',N'qa';
  SELECT @deleted=deleted_at FROM @tombstone;
  IF @deleted IS NULL OR NOT EXISTS(SELECT 1 FROM #schedules WHERE schedule_key=1 AND active=0 AND deleted_at=@deleted AND start_date=@day)
    THROW 58782,N'The same-day original was not tombstoned.',1;
  SET @passed+=1;
  EXEC sys.sp_executesql @detachSql,N'@scheduleId nvarchar(150),@now datetime2(3)',N'original',@deleted;
  IF (SELECT COUNT(*) FROM #attachments WHERE schedule_key=1 AND detached_at IS NOT NULL)<>2
     OR (SELECT COUNT(*) FROM #attachments WHERE schedule_key IN (2,3) AND detached_at IS NULL)<>3
    THROW 58783,N'Copy or unrelated provenance was not preserved.',1;
  SET @passed+=1;
  DECLARE @exclusive table(task_key bigint,source_id nvarchar(260),client_source_id nvarchar(150),client_name_snapshot nvarchar(200),
    domain_source_id nvarchar(150),domain_name_snapshot nvarchar(500),target_type varchar(20),target_source_id nvarchar(150),
    task_date date,status varchar(30),result nvarchar(500),notes nvarchar(max));
  INSERT @exclusive EXEC sys.sp_executesql @exclusiveSql,N'@scheduleId nvarchar(150)',N'original';
  IF (SELECT COUNT(*) FROM @exclusive)<>1 OR NOT EXISTS(SELECT 1 FROM @exclusive WHERE task_key=11 AND source_id=N'original-task')
    THROW 58784,N'Unexpected exclusive task selection.',1;
  SET @passed+=1;
  EXEC sys.sp_executesql @historySql,
    N'@taskKey bigint,@notes nvarchar(max),@now datetime2(3),@actorId nvarchar(150),@actorEmail nvarchar(254),@previousStatus varchar(30),@metadata nvarchar(max)',
    11,N'QA synthetic cancellation',@deleted,N'qa',N'qa@example.invalid','pending',N'{}';
  IF NOT EXISTS(SELECT 1 FROM #history WHERE task_key=11 AND new_status='cancelled')
    OR NOT EXISTS(SELECT 1 FROM #tasks WHERE task_key=11 AND status='cancelled')
    OR NOT EXISTS(SELECT 1 FROM #tasks WHERE task_key=12 AND status='blocked')
    OR (SELECT COUNT(*) FROM #tasks WHERE task_key IN (13,14) AND status='pending')<>2
    OR (SELECT COUNT(*) FROM #schedules WHERE schedule_key IN (2,3) AND deleted_at IS NULL AND active=1)<>2
    THROW 58785,N'Task status/history did not preserve surviving work.',1;
  SET @passed+=1;
  EXEC sys.sp_executesql @cancelSql,N'@taskIds nvarchar(max),@actorId nvarchar(150),@removedScheduleId nvarchar(150)',
    N'["original-task"]',N'qa',N'original';
  IF (SELECT COUNT(*) FROM #notices WHERE notification_key IN (1,2,9) AND status='cancelled' AND next_attempt_at IS NULL AND claimed_by IS NULL)<>3
    OR (SELECT COUNT(*) FROM #recipients WHERE notification_key IN (1,2,9) AND delivery_status='skipped')<>3
    OR NOT EXISTS(SELECT 1 FROM #attempts WHERE notification_key=9 AND attempt_no=2 AND completed_at IS NOT NULL AND attempt_status='failed')
    OR (SELECT COUNT(*) FROM #notices WHERE notification_key IN (3,5,6,7) AND status='pending')<>4
    OR (SELECT COUNT(*) FROM #recipients WHERE notification_key IN (3,5,6,7) AND delivery_status='pending')<>4
    OR NOT EXISTS(SELECT 1 FROM #notices WHERE notification_key=8 AND status='sent')
    THROW 58786,N'The compiled outbox predicate did not isolate original queued/retry reminders.',1;
  SET @passed+=1;
  IF NOT EXISTS(SELECT 1 FROM #notices WHERE notification_key=4 AND status='processing' AND attempt_count=2)
    THROW 58787,N'An in-flight claim was overwritten.',1;
  EXEC sys.sp_executesql @suppressSql,N'@notificationKey bigint,@workerId nvarchar(150),@attemptNo int',4,N'qa',1;
  IF NOT EXISTS(SELECT 1 FROM #notices WHERE notification_key=4 AND status='processing' AND attempt_count=2)
    THROW 58788,N'A stale attempt suppressed a newer claim.',1;
  EXEC sys.sp_executesql @suppressSql,N'@notificationKey bigint,@workerId nvarchar(150),@attemptNo int',4,N'qa',2;
  IF NOT EXISTS(SELECT 1 FROM #notices WHERE notification_key=4 AND status='cancelled' AND claimed_by IS NULL)
    OR NOT EXISTS(SELECT 1 FROM #attempts WHERE notification_key=4 AND attempt_no=2 AND completed_at IS NOT NULL AND attempt_status='failed')
    OR NOT EXISTS(SELECT 1 FROM #recipients WHERE notification_key=4 AND delivery_status='skipped')
    THROW 58789,N'The exact in-flight claim was not fenced.',1;
  SET @passed+=1;
  ROLLBACK TRANSACTION;
  IF OBJECT_ID(N'tempdb..#schedules') IS NOT NULL OR OBJECT_ID(N'tempdb..#notices') IS NOT NULL
    THROW 58790,N'Shadow fixtures survived rollback.',1;
  SELECT @passed AS passed,0 AS error_number,0 AS error_line,0 AS shared_outbox_writes;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  SELECT @passed AS passed,ERROR_NUMBER() AS error_number,ERROR_LINE() AS error_line,0 AS shared_outbox_writes;
END CATCH;
'@
$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
$response=(& $invoke -SessionDirectory $session -Sql (($prefix -join [Environment]::NewLine)+[Environment]::NewLine+$body) -Mode write -TimeoutSeconds 35 -MaxRows 1) |
  ConvertFrom-Json -Depth 14
$sets=@($response.resultSets)
$row=if($sets.Count){$sets[-1].rows[0]}else{$null}
if(!$response.success -or $row.passed -ne 6 -or $row.error_number -ne 0 -or $row.shared_outbox_writes -ne 0){
  throw "QA shadow cancellation rehearsal failed (SQL number: $([int]$row.error_number); line: $([int]$row.error_line))."
}
$row | Select-Object passed,error_number,error_line,shared_outbox_writes | ConvertTo-Json -Compress
