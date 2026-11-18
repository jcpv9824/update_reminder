[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SessionDirectory)

$ErrorActionPreference='Stop'
$session=(Resolve-Path -LiteralPath $SessionDirectory).Path
$descriptor=Get-Content -Raw -LiteralPath (Join-Path $session 'active.json') | ConvertFrom-Json
if($descriptor.database -cne 'PortalSAGWeb-TEST' -or $descriptor.environment -cne 'qa'){
  throw 'This rehearsal requires the PortalSAGWeb-TEST session.'
}
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$source=Get-Content -Raw -LiteralPath (Join-Path $root 'api/src/lib/catalogManualDayIntentSqlRepository.ts')
$delim=[regex]::Escape([string][char]96)
function Read-Probe([string]$name){
  $value=[regex]::Match($source,('(?s)const '+[regex]::Escape($name)+' = '+$delim+'(.*?)'+$delim+';')).Groups[1].Value
  if(!$value -or $value.Contains('${')){ throw "Missing literal query: $name." }
  return $value.Replace("'","''")
}
$append=Read-Probe 'appendSql'
$read=Read-Probe 'readCatalogManualDayIntentsSql'
$literal="DECLARE @append nvarchar(max)=N'$append',@read nvarchar(max)=N'$read';"
$fixture=@'
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR @@TRANCOUNT<>0
  THROW 54790,N'Unexpected QA rehearsal target.',1;
DECLARE @tag nvarchar(80)=N'qa-manual-intent-'+LOWER(CONVERT(char(36),NEWID())),@scenario int=1,@passed int=0,@expected int;
DECLARE @stamp datetime2(3)=SYSUTCDATETIME(),@cutoff datetime2(3),@expired datetime2(3);
DECLARE @day date=DATEADD(day,1,CONVERT(date,@stamp AT TIME ZONE 'UTC' AT TIME ZONE 'SA Pacific Standard Time'));
DECLARE @client bigint,@schedule bigint,@admin bigint,@other bigint,@version binary(8),@versionText char(16);
DECLARE @first datetime2(3),@selector nvarchar(max),@adminId nvarchar(150),@otherId nvarchar(150);
DECLARE @appendParams nvarchar(max)=N'@portalEnvironment varchar(10),@taskDate date,@actorId nvarchar(150),@cutoffAt datetime2(3),@expectedCount int,@schedules nvarchar(max)';
DECLARE @readParams nvarchar(180)=N'@portalEnvironment varchar(10),@taskDate date';
DECLARE @wrote TABLE(accepted int);
DECLARE @seen TABLE(scheduleId nvarchar(150),scheduleVersion char(16));
SET @adminId=@tag+N'-admin';
SET @otherId=@tag+N'-other';
SET @cutoff=DATEADD(minute,5,@stamp);
SET @expired=DATEADD(minute,-5,@stamp);
WHILE @scenario<=6
BEGIN
  SET @expected=NULL;
  BEGIN TRY
    BEGIN TRANSACTION;
    DELETE FROM @wrote;
    DELETE FROM @seen;
    INSERT security.users(source_id,display_name,email,email_normalized,active,created_at,created_by,updated_at,updated_by)
      SELECT id,id,id+N'@invalid.example',id+N'@invalid.example',active,@stamp,'fixture',@stamp,'fixture'
      FROM (VALUES(@adminId,1),(@otherId,CASE WHEN @scenario=4 THEN 0 ELSE 1 END)) v(id,active);
    SELECT @admin=user_key FROM security.users WHERE source_id=@adminId;
    SELECT @other=user_key FROM security.users WHERE source_id=@otherId;
    INSERT security.user_roles(user_key,role_id,assigned_by) VALUES(@admin,N'super_admin',N'fixture');
    INSERT core.clients(source_id,name,name_normalized,status,created_at,created_by,updated_at,updated_by)
      VALUES(@tag,@tag,@tag,'active',@stamp,'fixture',@stamp,'fixture');
    SET @client=SCOPE_IDENTITY();
    INSERT scheduling.update_schedules(source_id,client_key,name,target_type,frequency_type,start_date,timezone,assigned_role,
      created_at,created_by,updated_at,updated_by)
      VALUES(@tag,@client,'Synthetic manual schedule','domain','manual',DATEADD(day,-3,@day),'America/Bogota',
        'super_admin',@stamp,'fixture',@stamp,'fixture');
    SET @schedule=SCOPE_IDENTITY();
    SELECT @version=row_version FROM scheduling.update_schedules WHERE schedule_key=@schedule;
    SET @versionText=LOWER(CONVERT(char(16),@version,2));
    INSERT scheduling.catalog_schedule_operation_approvals(portal_environment,schedule_key,schedule_version,operation_id,approved_by)
      VALUES('qa',@schedule,@version,N'QA.Manual.Intent',@admin);
    SELECT @selector=(SELECT @tag AS id,@versionText AS version FOR JSON PATH);
    IF @scenario=2
    BEGIN
      SET @expected=54781;
      INSERT @wrote EXEC sys.sp_executesql @append,@appendParams,'production',@day,@adminId,@cutoff,1,@selector;
    END;
    IF @scenario=3
    BEGIN
      SET @expected=54780;
      INSERT @wrote EXEC sys.sp_executesql @append,@appendParams,'qa',@day,@adminId,@expired,1,@selector;
    END;
    IF @scenario=4
    BEGIN
      SET @expected=54782;
      INSERT @wrote EXEC sys.sp_executesql @append,@appendParams,'qa',@day,@otherId,@cutoff,1,@selector;
    END;
    IF @scenario=6
    BEGIN
      DECLARE @past date=DATEADD(day,-2,@day);
      SET @expected=54703;
      INSERT scheduling.catalog_manual_day_intents(portal_environment,task_date,schedule_key,schedule_version,requested_by)
        VALUES('qa',@past,@schedule,@version,@admin);
    END;
    IF @expected IS NOT NULL THROW 54791,N'Invalid manual intent unexpectedly passed.',1;

    INSERT @wrote EXEC sys.sp_executesql @append,@appendParams,'qa',@day,@adminId,@cutoff,1,@selector;
    IF (SELECT COUNT(*) FROM @wrote WHERE accepted=1)<>1 THROW 54792,N'Intent not accepted.',1;
    SELECT @first=requested_at FROM scheduling.catalog_manual_day_intents WHERE schedule_key=@schedule AND requested_by=@admin;
    IF @first IS NULL OR @first<@stamp THROW 54793,N'Missing SQL-stamped intent.',1;
    IF @scenario=5
    BEGIN
      SET @expected=54704;
      UPDATE scheduling.catalog_manual_day_intents SET requested_by=@other WHERE schedule_key=@schedule;
      THROW 54794,N'Intent history was not immutable.',1;
    END;
    INSERT @wrote EXEC sys.sp_executesql @append,@appendParams,'qa',@day,@otherId,@cutoff,1,@selector;
    IF (SELECT COUNT(*) FROM @wrote WHERE accepted=1)<>2 OR
       (SELECT COUNT(*) FROM scheduling.catalog_manual_day_intents WHERE schedule_key=@schedule)<>1 OR
       NOT EXISTS(SELECT 1 FROM scheduling.catalog_manual_day_intents WHERE schedule_key=@schedule AND requested_by=@admin AND requested_at=@first)
      THROW 54795,N'Replay did not preserve the first actor and timestamp.',1;
    INSERT @seen EXEC sys.sp_executesql @read,@readParams,'qa',@day;
    IF (SELECT COUNT(*) FROM @seen WHERE scheduleId=@tag AND scheduleVersion=@versionText)<>1
      THROW 54796,N'Current intention was not visible to planning.',1;
    SET @passed+=3;
    SAVE TRANSACTION approval_fixture;
    UPDATE scheduling.catalog_schedule_operation_approvals SET retired_at=SYSUTCDATETIME()
      WHERE portal_environment='qa' AND schedule_key=@schedule AND schedule_version=@version;
    DELETE FROM @seen;
    INSERT @seen EXEC sys.sp_executesql @read,@readParams,'qa',@day;
    IF EXISTS(SELECT 1 FROM @seen WHERE scheduleId=@tag)
      OR NOT EXISTS(SELECT 1 FROM scheduling.catalog_manual_day_intents WHERE schedule_key=@schedule AND requested_by=@admin)
      THROW 54799,N'Retired approval was consumed or historic intent disappeared.',1;
    SET @passed+=1;
    ROLLBACK TRANSACTION approval_fixture;
    UPDATE scheduling.update_schedules SET name=N'New fixture version' WHERE schedule_key=@schedule;
    DELETE FROM @seen;
    INSERT @seen EXEC sys.sp_executesql @read,@readParams,'qa',@day;
    IF EXISTS(SELECT 1 FROM @seen WHERE scheduleId=@tag) OR
       NOT EXISTS(SELECT 1 FROM scheduling.catalog_manual_day_intents WHERE schedule_key=@schedule AND requested_by=@admin)
      THROW 54797,N'Stale intent was consumed or historic intent disappeared.',1;
    SET @passed+=1;
    ROLLBACK TRANSACTION;
  END TRY
  BEGIN CATCH
    DECLARE @no int=ERROR_NUMBER(),@line int=ERROR_LINE();
    IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
    IF @expected IS NULL OR @no<>@expected
    BEGIN
      SELECT @no AS error_number,@line AS error_line,@scenario AS error_scenario;
      RETURN;
    END;
    SET @passed+=1;
  END CATCH;
  IF EXISTS(SELECT 1 FROM scheduling.catalog_manual_day_intents WHERE schedule_key=@schedule)
    OR EXISTS(SELECT 1 FROM scheduling.update_schedules WHERE source_id=@tag)
    OR EXISTS(SELECT 1 FROM core.clients WHERE source_id=@tag)
    OR EXISTS(SELECT 1 FROM security.users WHERE source_id IN (@adminId,@otherId))
    THROW 54798,N'Residual QA fixture.',1;
  SET @scenario+=1;
END;
SELECT @passed AS passed,0 AS remaining_fixtures;
'@

$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
try {
  $response=(& $invoke -SessionDirectory $session -Sql ($literal+[Environment]::NewLine+$fixture) -Mode write -TimeoutSeconds 35 -MaxRows 1) |
    ConvertFrom-Json -Depth 16
} catch { throw 'QA manual intent rehearsal did not return sanitized evidence.' }
$row=$response.resultSets[0].rows[0]
if(!$response.success -or $row.passed -ne 10 -or $row.remaining_fixtures -ne 0){
  throw "QA manual intent rehearsal failed (SQL: $([int]$row.error_number); line: $([int]$row.error_line); scenario: $([int]$row.error_scenario))."
}
$row | Select-Object passed,remaining_fixtures | ConvertTo-Json -Compress
