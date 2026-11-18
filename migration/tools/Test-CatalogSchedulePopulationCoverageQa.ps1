[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SessionDirectory)

$ErrorActionPreference='Stop'
$session=(Resolve-Path -LiteralPath $SessionDirectory).Path
$descriptor=Get-Content -Raw -LiteralPath (Join-Path $session 'active.json') | ConvertFrom-Json
if($descriptor.database -cne 'PortalSAGWeb-TEST' -or ($descriptor.environment -and $descriptor.environment -cne 'qa')){
  throw 'This rehearsal requires the PortalSAGWeb-TEST session.'
}
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$source=Get-Content -Raw -LiteralPath (Join-Path $root 'api/src/lib/catalogSchedulePopulationCoverage.ts')
$delimiter=[regex]::Escape([string][char]96)
$template='(?s)const {0} = '+$delimiter+'(.*?)'+$delimiter+';'
$read=[regex]::Match($source,($template -f 'readCatalogSchedulePopulationSql')).Groups[1].Value
$authority=[regex]::Match($source,($template -f 'currentApproval')).Groups[1].Value
if(!$read -or !$authority -or !$read.Contains('${currentApproval}')){
  throw 'Expected the actual population SQL templates.'
}
$read=$read.Replace('${currentApproval}',$authority)
if($read -match '(?im)^\s*(INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|CREATE|EXEC(?:UTE)?)\b'){
  throw 'Template is no longer read-only.'
}
$literal="DECLARE @read nvarchar(max)=N'"+$read.Replace("'","''")+"';"
$fixture=@'
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR @@TRANCOUNT<>0
  THROW 54680,N'Unexpected QA rehearsal target.',1;
DECLARE @tag nvarchar(72)=N'qa-population-'+LOWER(CONVERT(char(36),NEWID()));
DECLARE @stamp datetime2(3)=SYSUTCDATETIME(),@until datetime2(3),@lock int,@actor bigint,@profile bigint;
DECLARE @erp bigint,@sag bigint,@client bigint,@domain bigint,@customer bigint,@owner bigint;
DECLARE @link uniqueidentifier=NEWID(),@approval uniqueidentifier=NEWID(),@before datetime2(3);
DECLARE @digest binary(32)=HASHBYTES('SHA2_256','synthetic fixture digest, not coverage evidence');
DECLARE @scenario int=1;
SET @until=DATEADD(minute,5,@stamp);
BEGIN TRY
  BEGIN TRANSACTION;
  EXEC @lock=sys.sp_getapplock @Resource=N'portal-sag:catalog-customer-publication:qa',@LockMode=N'Exclusive',
    @LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock<0 OR EXISTS(SELECT 1 FROM settings.catalog_source_bindings WHERE portal_environment='qa' AND source_state='active')
    OR EXISTS(SELECT 1 FROM scheduling.catalog_schedule_population_approvals WHERE portal_environment='qa' AND retired_at IS NULL)
    OR EXISTS(SELECT 1 FROM core.catalog_operational_links WHERE portal_environment='qa' AND retired_at IS NULL)
    THROW 54681,N'Rehearsal requires an isolated and unused QA catalog.',1;
  INSERT security.users(source_id,display_name,email,email_normalized,active,created_at,created_by,updated_at,updated_by)
    VALUES(@tag,@tag,@tag+N'@invalid.example',@tag+N'@invalid.example',1,@stamp,'fixture',@stamp,'fixture');
  SELECT @actor=user_key FROM security.users WHERE source_id=@tag;
  INSERT security.user_roles(user_key,role_id,assigned_by) VALUES(@actor,N'super_admin',N'fixture');
  INSERT settings.external_database_connections(source_id,display_name,server_host,database_name,login_name,
    password_configured,password_secret_name,created_by,updated_by)
    SELECT @tag+suffix,@tag+suffix,N'fixture.invalid',N'synthetic',N'synthetic',1,N'fixture-no-key','fixture','fixture'
    FROM (VALUES(N'-erp'),(N'-sag')) v(suffix);
  INSERT settings.catalog_source_bindings(external_database_connection_key,display_name,source_role,portal_environment,
    contract_version,source_state,issuer_scope,validated_at,validated_profile_version,created_by,updated_by)
    SELECT external_database_connection_key,source_id,
      CASE WHEN source_id=@tag+N'-erp' THEN 'erp-customers' ELSE 'sag-admin' END,'qa',
      CASE WHEN source_id=@tag+N'-erp' THEN 'erp_v1' ELSE 'sag_admin_v1' END,'active',
      CASE WHEN source_id=@tag+N'-erp' THEN 'CO' END,@stamp,row_version,'fixture','fixture'
    FROM settings.external_database_connections WHERE source_id IN (@tag+N'-erp',@tag+N'-sag');
  SELECT @erp=catalog_source_key FROM settings.catalog_source_bindings WHERE display_name=@tag+N'-erp';
  SELECT @sag=catalog_source_key FROM settings.catalog_source_bindings WHERE display_name=@tag+N'-sag';
  INSERT core.clients(source_id,name,name_normalized,status,created_at,created_by,updated_at,updated_by)
    VALUES(@tag,@tag,@tag,'active',@stamp,'fixture',@stamp,'fixture');
  SET @client=SCOPE_IDENTITY();
  INSERT core.domains(source_id,client_key,domain_name,domain_name_normalized,environment_id,status,created_at,created_by,updated_at,updated_by)
    VALUES(@tag+N'-domain',@client,N'https://'+@tag+N'.invalid',N'https://'+@tag+N'.invalid',
      'test','active',@stamp,'fixture',@stamp,'fixture');
  SET @domain=SCOPE_IDENTITY();
  INSERT core.catalog_customer_ids DEFAULT VALUES;
  SET @customer=SCOPE_IDENTITY();
  INSERT core.catalog_operational_owners(portal_environment,catalog_customer_key,client_key,registered_by)
    VALUES('qa',@customer,@client,'fixture');
  SELECT @owner=owner_key FROM core.catalog_operational_owners WHERE portal_environment='qa' AND catalog_customer_key=@customer;
  INSERT core.catalog_operational_links(link_id,owner_key,portal_environment,client_key,domain_key,catalog_source_key,
    source_record_id,target_kind,link_environment,registered_by)
    VALUES(@link,@owner,'qa',@client,@domain,@erp,1,'domain','test','fixture');

  SET @scenario=2;
  SET @before=SYSUTCDATETIME();
  INSERT scheduling.catalog_schedule_population_approvals(population_id,portal_environment,source_count,link_count,
    population_sha256,approved_by,approved_at,valid_until)
    VALUES(@approval,'qa',2,1,@digest,@actor,DATEADD(day,-1,@stamp),@until);
  IF NOT EXISTS(SELECT 1 FROM scheduling.catalog_schedule_population_approvals WHERE population_id=@approval
    AND approved_at>=@before AND population_sha256=@digest AND retired_at IS NULL)
    THROW 54682,N'Approval timestamp was not assigned by SQL.',1;

  EXEC sys.sp_executesql @read,N'@portalEnvironment varchar(10)','qa';
  SET @scenario=3;
  UPDATE security.users SET active=0 WHERE user_key=@actor;
  EXEC sys.sp_executesql @read,N'@portalEnvironment varchar(10)','qa';
  UPDATE security.users SET active=1 WHERE user_key=@actor;

  SET @scenario=4;
  SET @before=SYSUTCDATETIME();
  UPDATE scheduling.catalog_schedule_population_approvals SET retired_at=DATEADD(day,1,@stamp)
    WHERE population_id=@approval;
  IF NOT EXISTS(SELECT 1 FROM scheduling.catalog_schedule_population_approvals WHERE population_id=@approval
    AND retired_at>=@before AND retired_at<=CONVERT(datetime2(3),SYSUTCDATETIME()) AND population_sha256=@digest)
    THROW 54683,N'Retirement was not assigned by SQL or changed approval content.',1;
  EXEC sys.sp_executesql @read,N'@portalEnvironment varchar(10)','qa';
  ROLLBACK TRANSACTION;
  IF EXISTS(SELECT 1 FROM scheduling.catalog_schedule_population_approvals WHERE population_id=@approval)
    OR EXISTS(SELECT 1 FROM core.catalog_operational_links WHERE link_id=@link)
    OR EXISTS(SELECT 1 FROM settings.catalog_source_bindings WHERE catalog_source_key IN (@erp,@sag))
    OR EXISTS(SELECT 1 FROM core.catalog_customer_ids WHERE catalog_customer_key=@customer)
    OR EXISTS(SELECT 1 FROM core.clients WHERE client_key=@client)
    OR EXISTS(SELECT 1 FROM security.users WHERE user_key=@actor)
    THROW 54684,N'Residual QA fixtures.',1;
  SELECT 1 AS confirmed,0 AS remaining_fixtures;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  SELECT ERROR_NUMBER() AS error_number,ERROR_LINE() AS error_line,@scenario AS error_scenario;
END CATCH;
'@

$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
try {
  $response=(& $invoke -SessionDirectory $session -Sql ($literal+[Environment]::NewLine+$fixture) -Mode write -TimeoutSeconds 35 -MaxRows 5) |
    ConvertFrom-Json -Depth 16
} catch {
  $reason=$_.Exception.Message
  $category=switch -Regex ($reason) {
    'timed?\s*out|timeout' { 'timeout'; break }
    'Incorrect syntax near|Unclosed quotation' { 'SQL syntax'; break }
    'duplicate keys|same key' { 'duplicate column or key'; break }
    'Invalid column|Invalid object' { 'SQL binding'; break }
    'no response|no longer running|stale' { 'session'; break }
    default { $_.Exception.GetType().Name }
  }
  throw "QA population coverage rehearsal failed to return sanitized evidence ($category)."
}
$rows=$response.resultSets
$last=if($rows.Count){$rows[-1].rows[0]}else{$null}
if(!$response.success -or $rows.Count -ne 10 -or $last.confirmed -ne 1 -or $last.remaining_fixtures -ne 0){
  throw "QA population coverage rehearsal failed (SQL number: $([int]$last.error_number); batch line: $([int]$last.error_line); scenario: $([int]$last.error_scenario))."
}
if($rows[0].rows.Count -ne 1 -or $rows[0].rows[0].sourceCount -ne 2 -or $rows[0].rows[0].linkCount -ne 1 -or
   $rows[1].rows.Count -ne 2 -or @($rows[1].rows | Where-Object {$_.certified -ne $true}).Count -ne 0 -or
   $rows[2].rows.Count -ne 1 -or $rows[2].rows[0].state -cne 'unverifiable' -or $null -ne $rows[2].rows[0].revisionId -or
   $rows[3].rows.Count -ne 0 -or $rows[6].rows.Count -ne 0){
  throw 'Unexpected approval, source roster, or held-edge evidence in SQL QA.'
}
'{"passed":6,"remaining_fixtures":0}'
