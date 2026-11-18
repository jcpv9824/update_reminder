[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SessionDirectory)

$ErrorActionPreference='Stop'
$session=(Resolve-Path -LiteralPath $SessionDirectory).Path
$descriptor=Get-Content -Raw -LiteralPath (Join-Path $session 'active.json') | ConvertFrom-Json
if($descriptor.database -cne 'PortalSAGWeb-TEST' -or ($descriptor.environment -and $descriptor.environment -cne 'qa')){
  throw 'This rehearsal requires the PortalSAGWeb-TEST session.'
}

$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$readApproval=(Get-Content -Raw -LiteralPath (Join-Path $root 'api/src/lib/catalogScheduleOperationApprovalSqlRepository.ts')).Split([char]96) |
  Where-Object { $_ -match '^\s*SELECT s\.source_id AS scheduleId' } | Select-Object -First 1
if(!$readApproval -or $readApproval -match '(?im)\b(INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|CREATE|EXEC(?:UTE)?)\b'){
  throw 'Expected the approved read-only schedule operation repository query.'
}
$literal="DECLARE @readApproval nvarchar(max)=N'"+$readApproval.Replace("'","''")+"';"
$registrationGuard=(Get-Content -Raw -LiteralPath (Join-Path $root 'api/src/lib/catalogExecutionRegistrationSqlRepository.ts')).Split([char]96) |
  Where-Object { $_ -match '^\s*SELECT s\.source_id AS scheduleId, s\.schedule_key AS scheduleKey' } | Select-Object -First 1
if(!$registrationGuard -or $registrationGuard -match '(?im)^\s*(INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|CREATE|EXEC(?:UTE)?)\b'){
  throw 'Expected the read-only approval guard from the actual task registration repository.'
}
$literal+="DECLARE @registrationGuard nvarchar(max)=N'"+$registrationGuard.Replace("'","''")+"';"

$fixture=@'
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR @@TRANCOUNT<>0
  THROW 54480,N'Wrong database or transaction.',1;
IF OBJECT_ID(N'scheduling.catalog_schedule_operation_approvals',N'U') IS NULL
  THROW 54481,N'Install the schedule operation approval migration before this rehearsal.',1;

DECLARE @tag nvarchar(72)=N'qa-schedule-op-'+LOWER(CONVERT(char(36),NEWID()));
DECLARE @actor nvarchar(150)=N'qa-schedule-operation-fixture';
DECLARE @operation nvarchar(200)=N'Deploy.Catalog_qa:1-fixture',@newOperation nvarchar(200)=N'Deploy.Catalog_qa:2-fixture';
DECLARE @stamp datetime2(3)=SYSUTCDATETIME(),@future datetime2(3),@before datetime2(3),@after datetime2(3);
SET @future=DATEADD(day,1,@stamp);
DECLARE @approvedAt datetime2(3),@client bigint,@activeAdmin bigint,@inactiveAdmin bigint,@ordinary bigint,@schedule bigint;
DECLARE @originalVersion binary(8),@newVersion binary(8),@scenario int=1,@passed int=0,@expected int;
DECLARE @readParams nvarchar(100)=N'@expectedSchedules nvarchar(max),@portalEnvironment varchar(10)';
DECLARE @guardParams nvarchar(max)=N'@schedules nvarchar(max),@portalEnvironment varchar(10),@operationId nvarchar(200),@workflowRole nvarchar(80),@assignmentKind varchar(10),@targetKind varchar(20)';
DECLARE @roster nvarchar(max),@oldVersionText char(16),@newVersionText char(16);
DECLARE @readRows TABLE(scheduleId nvarchar(150),scheduleVersion char(16),operationId nvarchar(200));
DECLARE @guardRows TABLE(scheduleId nvarchar(150),scheduleKey bigint,selectionMode varchar(20),origin varchar(20));
DECLARE @wrongCaseOperation nvarchar(200)=LOWER(@operation);

-- Each expected SQL error may doom its transaction. Each case uses a
-- separate rollback-only fixture against the same database session.
WHILE @scenario<=11
BEGIN
SET @expected=NULL;
BEGIN TRY
  BEGIN TRANSACTION;
  INSERT core.clients(source_id,name,name_normalized,status,created_at,created_by,updated_at,updated_by)
    VALUES(@tag,@tag,@tag,'active',@stamp,@actor,@stamp,@actor);
  SET @client=SCOPE_IDENTITY();
  INSERT security.users(source_id,display_name,email,email_normalized,active,created_at,created_by,updated_at,updated_by)
    SELECT @tag+x.suffix,@tag+x.suffix,@tag+x.suffix+N'@invalid.example',@tag+x.suffix+N'@invalid.example',
      x.active,@stamp,@actor,@stamp,@actor FROM (VALUES(N'-active',1),(N'-inactive',0),(N'-ordinary',1)) x(suffix,active);
  SELECT @activeAdmin=user_key FROM security.users WHERE source_id=@tag+N'-active';
  SELECT @inactiveAdmin=user_key FROM security.users WHERE source_id=@tag+N'-inactive';
  SELECT @ordinary=user_key FROM security.users WHERE source_id=@tag+N'-ordinary';
  INSERT security.user_roles(user_key,role_id,assigned_by)
    VALUES(@activeAdmin,N'super_admin',@actor),(@inactiveAdmin,N'super_admin',@actor);
  INSERT scheduling.update_schedules(source_id,client_key,name,target_type,frequency_type,start_date,timezone,assigned_role,selection_mode,
    created_at,created_by,updated_at,updated_by)
    VALUES(@tag,@client,N'Fixture display label, not an operation ID','domain','manual',CONVERT(date,@stamp),
      N'America/Bogota',N'super_admin','licensing',@stamp,@actor,@stamp,@actor);
  SET @schedule=SCOPE_IDENTITY();
  SELECT @originalVersion=row_version FROM scheduling.update_schedules WHERE schedule_key=@schedule;

  IF @scenario>=9
  BEGIN
    SET @expected=547;
    INSERT scheduling.catalog_schedule_operation_approvals(portal_environment,schedule_key,schedule_version,operation_id,approved_by)
      VALUES('qa',@schedule,@originalVersion,
        CASE @scenario WHEN 9 THEN N'-leading' WHEN 10 THEN N'A/slash' ELSE N'A trailing' END,@activeAdmin);
    THROW 54494,N'A disallowed operation token was accepted.',1;
  END;

  IF @scenario<6
  BEGIN
    SET @expected=CASE WHEN @scenario=4 THEN 54401 ELSE 54402 END;
    IF @scenario=5 UPDATE scheduling.update_schedules SET active=0,deleted_at=@stamp,deleted_by=@actor WHERE schedule_key=@schedule;
    DECLARE @suppliedVersion binary(8)=CASE WHEN @scenario=1 THEN 0x0000000000000000 ELSE @originalVersion END;
    IF @scenario=5 SELECT @suppliedVersion=row_version FROM scheduling.update_schedules WHERE schedule_key=@schedule;
    INSERT scheduling.catalog_schedule_operation_approvals(
      portal_environment,schedule_key,schedule_version,operation_id,approved_by,retired_at)
    VALUES('qa',@schedule,@suppliedVersion,@operation,
      CASE WHEN @scenario=2 THEN @ordinary WHEN @scenario=3 THEN @inactiveAdmin ELSE @activeAdmin END,
      CASE WHEN @scenario=4 THEN @stamp END);
    THROW 54482,N'An invalid operation approval was accepted.',1;
  END;

  IF @scenario IN (6,7)
  BEGIN
    INSERT scheduling.catalog_schedule_operation_approvals(portal_environment,schedule_key,schedule_version,operation_id,approved_by)
      VALUES('qa',@schedule,@originalVersion,@operation,@activeAdmin);
    IF @scenario=6
      UPDATE scheduling.catalog_schedule_operation_approvals SET retired_at=SYSUTCDATETIME()
        WHERE portal_environment='qa' AND schedule_key=@schedule AND schedule_version=@originalVersion;
    SET @expected=54403;
    IF @scenario=6
      UPDATE scheduling.catalog_schedule_operation_approvals SET retired_at=@future
        WHERE portal_environment='qa' AND schedule_key=@schedule AND schedule_version=@originalVersion;
    ELSE
      DELETE scheduling.catalog_schedule_operation_approvals
        WHERE portal_environment='qa' AND schedule_key=@schedule AND schedule_version=@originalVersion;
    THROW 54490,N'An approval was retired twice or deleted.',1;
  END;

  SET @before=SYSUTCDATETIME();
  INSERT scheduling.catalog_schedule_operation_approvals(
    portal_environment,schedule_key,schedule_version,operation_id,approved_by,approved_at)
    VALUES('qa',@schedule,@originalVersion,@operation,@activeAdmin,@future);
  SET @after=SYSUTCDATETIME();
  SELECT @approvedAt=approved_at FROM scheduling.catalog_schedule_operation_approvals
    WHERE portal_environment='qa' AND schedule_key=@schedule AND schedule_version=@originalVersion AND approved_by=@activeAdmin;
  SET @oldVersionText=LOWER(CONVERT(char(16),@originalVersion,2));
  SELECT @roster=(SELECT @tag AS id,@oldVersionText AS version FOR JSON PATH);
  INSERT @readRows EXEC sys.sp_executesql @readApproval,@readParams,@roster,'qa';
  IF @approvedAt IS NULL OR @approvedAt<@before OR @approvedAt>@after
    OR (SELECT COUNT(*) FROM @readRows WHERE scheduleId=@tag AND scheduleVersion=@oldVersionText AND operationId=@operation)<>1
    OR (SELECT COUNT(*) FROM @readRows)<>1
    THROW 54483,N'The exact approval was not accepted with its SQL-owned UTC timestamp.',1;
  SET @passed+=1;
  INSERT @guardRows EXEC sys.sp_executesql @registrationGuard,@guardParams,@roster,'qa',@operation,N'super_admin','role','domain';
  IF (SELECT COUNT(*) FROM @guardRows WHERE scheduleId=@tag AND scheduleKey=@schedule AND selectionMode='licensing')<>1
    OR (SELECT COUNT(*) FROM @guardRows)<>1
    THROW 54491,N'The registration transaction did not recognize the exact approved operation.',1;
  SET @passed+=1;
  DELETE FROM @guardRows;
  INSERT @guardRows EXEC sys.sp_executesql @registrationGuard,@guardParams,@roster,'qa',@wrongCaseOperation,N'super_admin','role','domain';
  IF EXISTS(SELECT 1 FROM @guardRows)
    THROW 54492,N'The registration accepted a differently cased operation ID.',1;
  SET @passed+=1;
  DELETE FROM @readRows;
  INSERT @readRows EXEC sys.sp_executesql @readApproval,@readParams,@roster,'production';
  IF EXISTS(SELECT 1 FROM @readRows)
    THROW 54484,N'An approval escaped its Portal environment.',1;
  SET @passed+=1;

  UPDATE scheduling.update_schedules SET notes=N'Synthetic edit',updated_at=SYSUTCDATETIME() WHERE schedule_key=@schedule;
  SELECT @newVersion=row_version FROM scheduling.update_schedules WHERE schedule_key=@schedule;
  INSERT @readRows EXEC sys.sp_executesql @readApproval,@readParams,@roster,'qa';
  IF EXISTS(SELECT 1 FROM @readRows) THROW 54485,N'The reader returned a stale approval after a schedule edit.',1;
  SET @newVersionText=LOWER(CONVERT(char(16),@newVersion,2));
  SELECT @roster=(SELECT @tag AS id,@newVersionText AS version FOR JSON PATH);
  INSERT @readRows EXEC sys.sp_executesql @readApproval,@readParams,@roster,'qa';
  IF @newVersion IS NULL OR @newVersion=@originalVersion
    OR EXISTS(SELECT 1 FROM @readRows)
    OR NOT EXISTS(SELECT 1 FROM scheduling.catalog_schedule_operation_approvals
      WHERE portal_environment='qa' AND schedule_key=@schedule AND schedule_version=@originalVersion AND operation_id=@operation)
    THROW 54485,N'Editing a schedule reused or erased its previous approval.',1;
  SET @passed+=1;

  INSERT scheduling.catalog_schedule_operation_approvals(portal_environment,schedule_key,schedule_version,operation_id,approved_by)
    VALUES('qa',@schedule,@newVersion,@newOperation,@activeAdmin);
  INSERT @readRows EXEC sys.sp_executesql @readApproval,@readParams,@roster,'qa';
  IF (SELECT COUNT(*) FROM @readRows WHERE scheduleId=@tag AND scheduleVersion=@newVersionText AND operationId=@newOperation)<>1
    OR (SELECT COUNT(*) FROM @readRows)<>1
    THROW 54486,N'The edited schedule did not acquire its separate exact approval.',1;
  SET @passed+=1;

  SET @before=SYSUTCDATETIME();
  UPDATE scheduling.catalog_schedule_operation_approvals SET retired_at=@future
    WHERE portal_environment='qa' AND schedule_key=@schedule AND schedule_version=@newVersion;
  SET @after=SYSUTCDATETIME();
  DELETE FROM @readRows;
  INSERT @readRows EXEC sys.sp_executesql @readApproval,@readParams,@roster,'qa';
  IF EXISTS(SELECT 1 FROM @readRows)
    OR NOT EXISTS(SELECT 1 FROM scheduling.catalog_schedule_operation_approvals
      WHERE portal_environment='qa' AND schedule_key=@schedule AND schedule_version=@newVersion AND operation_id=@newOperation
        AND retired_at BETWEEN @before AND @after AND retired_at>=approved_at)
    THROW 54487,N'Retirement did not preserve proof history with its SQL-owned UTC timestamp.',1;
  SET @passed+=1;
  INSERT @guardRows EXEC sys.sp_executesql @registrationGuard,@guardParams,@roster,'qa',@newOperation,N'super_admin','role','domain';
  IF EXISTS(SELECT 1 FROM @guardRows)
    THROW 54493,N'A retired operation approval still authorized new registration.',1;
  SET @passed+=1;

  SET @expected=2627;
  INSERT scheduling.catalog_schedule_operation_approvals(portal_environment,schedule_key,schedule_version,operation_id,approved_by)
    VALUES('qa',@schedule,@newVersion,@operation,@activeAdmin);
  THROW 54488,N'A retired schedule version was approved again.',1;
END TRY
BEGIN CATCH
  DECLARE @caught int=ERROR_NUMBER(),@message nvarchar(4000)=ERROR_MESSAGE();
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  IF @expected IS NULL OR @caught<>@expected
    OR (@scenario=8 AND CHARINDEX(N'PK_catalog_schedule_operation_approvals',@message)=0)
    OR (@scenario>=9 AND CHARINDEX(N'CK_catalog_schedule_operation_approvals_id',@message)=0)
  BEGIN
    SELECT @passed AS passed,1 AS remaining_fixtures,@caught AS error_number,@scenario AS error_scenario;
    RETURN;
  END;
  SET @passed+=1;
END CATCH;
IF EXISTS(SELECT 1 FROM scheduling.catalog_schedule_operation_approvals WHERE schedule_key=@schedule)
  OR EXISTS(SELECT 1 FROM scheduling.update_schedules WHERE source_id=@tag)
  OR EXISTS(SELECT 1 FROM core.clients WHERE source_id=@tag)
  OR EXISTS(SELECT 1 FROM security.users WHERE source_id IN (@tag+N'-active',@tag+N'-inactive',@tag+N'-ordinary'))
  OR EXISTS(SELECT 1 FROM security.user_roles WHERE user_key IN (@activeAdmin,@inactiveAdmin,@ordinary))
  THROW 54489,N'The rollback-only fixture left residual rows.',1;
SET @scenario+=1;
END;
SELECT @passed AS passed,0 AS remaining_fixtures;
'@

$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
try {
  $response=(& $invoke -SessionDirectory $session -Sql ($literal + [Environment]::NewLine + $fixture) -Mode write -TimeoutSeconds 35 -MaxRows 1) |
    ConvertFrom-Json -Depth 16
} catch {
  throw 'QA schedule operation approval rehearsal did not return a valid sanitized result.'
}
$row=$response.resultSets[0].rows[0]
if(!$response.success -or $row.passed -ne 19 -or $row.remaining_fixtures -ne 0){
  $number=0
  $scenario=0
  [void][int]::TryParse([string]$row.error_number,[ref]$number)
  [void][int]::TryParse([string]$row.error_scenario,[ref]$scenario)
  throw "QA schedule operation approval rehearsal did not pass or left residual rows (SQL error number: $number; scenario: $scenario)."
}
$row | Select-Object passed,remaining_fixtures | ConvertTo-Json -Compress
