[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SessionDirectory)

$ErrorActionPreference='Stop'
$session=(Resolve-Path -LiteralPath $SessionDirectory).Path
$descriptor=Get-Content -Raw -LiteralPath (Join-Path $session 'active.json') | ConvertFrom-Json
if($descriptor.database -ne 'PortalSAGWeb-TEST' -or ($descriptor.environment -and $descriptor.environment -ne 'qa')){
  throw 'This rehearsal requires the PortalSAGWeb-TEST session.'
}
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$query=(Get-Content -Raw -LiteralPath (Join-Path $root 'api/src/lib/catalogTaskDatabaseConnection.ts')).Split([char]96) |
  Where-Object { $_ -match '^\s*DECLARE @now' } | Select-Object -First 1
if(!$query -or $query -match '(?im)^\s*(INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|CREATE)\b'){ throw 'Expected one read-only grant query.' }
$literal="DECLARE @probe nvarchar(max)=N'"+$query.Replace("'","''")+"';"
$cutoffQuery=(Get-Content -Raw -LiteralPath (Join-Path $root 'api/src/lib/catalogTaskCutoffWorker.ts')).Split([char]96) |
  Where-Object { $_ -match '^\s*DECLARE @checkedAt' } | Select-Object -First 1
$routeHash=(Get-Content -Raw -LiteralPath (Join-Path $root 'api/src/lib/catalogPhysicalTargetIdentity.ts')).Split([char]96)[1]
if(!$cutoffQuery -or $cutoffQuery -match '(?im)^\s*(INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|CREATE)\b' -or $routeHash -notmatch 'portal-sag:web-route:v1'){
  throw 'Expected the bounded read-only cutoff evidence query.'
}
$cutoffQuery=$cutoffQuery.Replace('${catalogDomainRouteFingerprintSql}',$routeHash)
$literal+="DECLARE @cutoffProbe nvarchar(max)=N'"+$cutoffQuery.Replace("'","''")+"';"
$fixture=@'
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF DB_NAME()<>N'PortalSAGWeb-TEST' OR @@TRANCOUNT<>0 THROW 53880,N'Wrong database or transaction.',1;
DECLARE @tag nvarchar(72)=N'qa-taskconn-'+LOWER(CONVERT(char(36),NEWID()));
DECLARE @stamp datetime2(3)=SYSUTCDATETIME(), @target bigint, @physical uniqueidentifier, @taskKey bigint, @execution bigint;
DECLARE @task nvarchar(150)=@tag+N'-task', @assigned nvarchar(150)=@tag+N'-assigned', @other nvarchar(150)=@tag+N'-broad';
DECLARE @a nvarchar(150)=@tag+N'-a-db', @b nvarchar(150)=@tag+N'-b-db';
DECLARE @params nvarchar(max)=N'@actor nvarchar(150), @db nvarchar(150), @task nvarchar(260), @environment varchar(10), @permission nvarchar(160)';
DECLARE @rows TABLE(serverHostPort nvarchar(500),initialCatalog nvarchar(256),userId nvarchar(256),secretName nvarchar(256),
  databaseId nvarchar(150),taskId nvarchar(260),linkId nvarchar(260),profileVersion varchar(16),linkVersion varchar(16),executionVersion varchar(16));
BEGIN TRY
  BEGIN TRANSACTION;
  INSERT security.users(source_id,display_name,email,email_normalized,created_at,created_by,updated_at,updated_by)
    SELECT id,id,id+N'@invalid.example',id+N'@invalid.example',@stamp,'fixture',@stamp,'fixture' FROM (VALUES(@assigned),(@other)) names(id);
  INSERT security.user_roles(user_key,role_id,assigned_by)
    SELECT user_key,N'super_admin','fixture' FROM security.users WHERE source_id IN (@assigned,@other);
  INSERT core.clients(source_id,name,name_normalized,status,created_at,created_by,updated_at,updated_by)
    SELECT @tag+suffix,@tag+suffix,@tag+suffix,'active',@stamp,'fixture',@stamp,'fixture' FROM (VALUES(N'-a'),(N'-b')) labels(suffix);
  INSERT core.domains(source_id,client_key,domain_name,domain_name_normalized,environment_id,status,created_at,created_by,updated_at,updated_by)
    SELECT c.source_id+N'-web',c.client_key,N'https://'+c.source_id+N'.invalid',N'https://'+c.source_id+N'.invalid',
      'test','active',@stamp,'fixture',@stamp,'fixture' FROM core.clients c WHERE c.source_id IN (@tag+N'-a',@tag+N'-b');
  INSERT core.database_access_profiles(source_id,server_host_port,initial_catalog,sql_user_id,password_secret_name,
    connection_fingerprint,created_at,created_by,updated_at,updated_by)
    SELECT @tag+suffix+N'-profile',N'synthetic.invalid,1433',N'qa_connection_fixture',N'fixture',N'no-vault-secret',
      HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag+suffix)),@stamp,'fixture',@stamp,'fixture'
    FROM (VALUES(N'-a'),(N'-b')) labels(suffix);
  INSERT core.databases(source_id,client_key,domain_key,access_profile_key,company_name,company_name_normalized,environment_id,
    status,created_at,created_by,updated_at,updated_by)
    SELECT c.source_id+N'-db',c.client_key,d.domain_key,p.access_profile_key,c.name,c.name_normalized,'test','active',
      @stamp,'fixture',@stamp,'fixture' FROM core.clients c JOIN core.domains d ON d.client_key=c.client_key
      JOIN core.database_access_profiles p ON p.source_id=c.source_id+N'-profile' WHERE c.source_id IN (@tag+N'-a',@tag+N'-b');
  INSERT core.catalog_physical_targets(portal_environment,target_kind,identity_fingerprint,database_name_fingerprint,created_at)
    VALUES('qa','database',HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag)),
      HASHBYTES('SHA2_256',CONVERT(varbinary(max),N'qa_connection_fixture')),DATEADD(second,-5,@stamp));
  SET @target=SCOPE_IDENTITY();
  SELECT @physical=target_id FROM core.catalog_physical_targets WHERE physical_target_key=@target;
  INSERT core.catalog_physical_target_links(physical_target_key,portal_environment,target_kind,client_key,domain_key,
    database_key,access_profile_key,access_profile_version,proof_id,verified_by,verified_at,valid_until,registered_at)
    SELECT @target,'qa','database',db.client_key,db.domain_key,db.database_key,p.access_profile_key,p.row_version,
      NEWID(),'fixture',DATEADD(second,-5,@stamp),DATEADD(minute,5,@stamp),DATEADD(second,-5,@stamp) FROM core.databases db
      JOIN core.database_access_profiles p ON p.access_profile_key=db.access_profile_key WHERE db.source_id IN (@a,@b);
  INSERT workflow.update_tasks(source_id,task_date,task_bucket,client_key,client_source_id,client_name_snapshot,domain_key,
    domain_source_id,domain_name_snapshot,target_type,target_source_id,target_name_snapshot,database_key,assigned_role,status,
    created_at,created_by,updated_at,updated_by)
    SELECT @task,CONVERT(date,@stamp),'fixture',c.client_key,c.source_id,c.name,d.domain_key,d.source_id,d.domain_name,
      'database',db.source_id,db.company_name,db.database_key,N'super_admin','pending',@stamp,'fixture',@stamp,'fixture'
      FROM core.databases db JOIN core.clients c ON c.client_key=db.client_key JOIN core.domains d ON d.domain_key=db.domain_key
      WHERE db.source_id=@a;
  SET @taskKey=SCOPE_IDENTITY();
  INSERT workflow.task_assignees(task_key,user_key) SELECT @taskKey,user_key FROM security.users WHERE source_id=@assigned;
  INSERT workflow.catalog_task_executions(task_key,execution_key,occurrence_id,execution_kind,verified_target_id,
    operation_id,initial_catalog_revision_id,cutoff_at)
    VALUES(@taskKey,HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag)),@tag,'database',CONVERT(char(36),@physical),
      'fixture','fixture',DATEADD(minute,5,@stamp));
  SET @execution=SCOPE_IDENTITY();
  INSERT workflow.catalog_task_execution_links(catalog_execution_key,execution_kind,link_id,catalog_record_id,
    client_key,domain_key,database_key,link_environment,created_at)
    SELECT @execution,'database',source_id,source_id,client_key,domain_key,database_key,'test',DATEADD(second,-5,@stamp)
    FROM core.databases WHERE source_id IN (@a,@b);

  DECLARE @executionHash binary(32)=HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag));
  DECLARE @firstRegistered datetime2(3)=(SELECT MIN(registered_at) FROM core.catalog_physical_target_links WHERE physical_target_key=@target);
  IF @firstRegistered IS NULL OR @firstRegistered<@stamp THROW 53885,N'SQL accepted a caller-supplied registration time.',1;
  DECLARE @cutoffRows TABLE(linkId nvarchar(260),checkedAt datetime2(3),effectiveAt datetime2(3),validUntil datetime2(3));
  INSERT @cutoffRows EXEC sys.sp_executesql @cutoffProbe,N'@env varchar(10),@execution varbinary(32)','qa',@executionHash;
  IF (SELECT COUNT(*) FROM @cutoffRows WHERE validUntil IS NOT NULL)<>2 THROW 53886,N'Current proofs were not accepted before the cutoff.',1;
  DELETE FROM @cutoffRows;
  UPDATE workflow.catalog_task_executions SET cutoff_at=DATEADD(millisecond,-1,@firstRegistered) WHERE catalog_execution_key=@execution;
  INSERT @cutoffRows EXEC sys.sp_executesql @cutoffProbe,N'@env varchar(10),@execution varbinary(32)','qa',@executionHash;
  IF (SELECT COUNT(*) FROM @cutoffRows WHERE validUntil IS NULL)<>2 THROW 53887,N'Proof registered after the cutoff was accepted.',1;
  UPDATE workflow.catalog_task_executions SET cutoff_at=DATEADD(minute,5,@stamp) WHERE catalog_execution_key=@execution;

  INSERT @rows EXEC sys.sp_executesql @probe,@params,@assigned,@a,@task,'qa',N'updates.tasks.view_database_connection';
  IF (SELECT COUNT(*) FROM @rows WHERE databaseId=@a AND linkId=@a)<>1 THROW 53881,N'Assigned current representative was not resolved.',1;
  DELETE FROM @rows;
  INSERT @rows EXEC sys.sp_executesql @probe,@params,@other,@a,@task,'qa',N'updates.tasks.reveal_database_password';
  INSERT @rows EXEC sys.sp_executesql @probe,@params,@assigned,@b,@task,'qa',N'updates.tasks.reveal_database_password';
  IF EXISTS(SELECT 1 FROM @rows) THROW 53882,N'Broad visibility or another alias granted access.',1;
  UPDATE workflow.catalog_task_execution_links SET link_state='hidden',state_reason='unverifiable' WHERE link_id=@a;
  INSERT @rows EXEC sys.sp_executesql @probe,@params,@assigned,@b,@task,'qa',N'updates.tasks.view_database_connection';
  IF (SELECT COUNT(*) FROM @rows WHERE databaseId=@b AND linkId=@b)<>1 THROW 53883,N'Surviving representative was not resolved.',1;
  DELETE FROM @rows;
  UPDATE core.database_access_profiles SET sql_user_id=N'changed-fixture' WHERE source_id=@tag+N'-b-profile';
  INSERT @rows EXEC sys.sp_executesql @probe,@params,@assigned,@b,@task,'qa',N'updates.tasks.reveal_database_password';
  IF EXISTS(SELECT 1 FROM @rows) THROW 53884,N'A changed profile reused an earlier grant.',1;
  ROLLBACK TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
SELECT 7 AS passed,
  (SELECT COUNT(*) FROM workflow.update_tasks WHERE source_id=@task)
  +(SELECT COUNT(*) FROM security.users WHERE source_id IN (@assigned,@other))
  +(SELECT COUNT(*) FROM core.catalog_physical_targets WHERE target_id=@physical) AS remaining_fixtures;
'@
$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
$response=(& $invoke -SessionDirectory $session -Sql ($literal + [Environment]::NewLine + $fixture) -Mode write -TimeoutSeconds 35 -MaxRows 1) | ConvertFrom-Json -Depth 16
$row=$response.resultSets[0].rows[0]
if(!$response.success -or $row.passed -ne 7 -or $row.remaining_fixtures -ne 0){ throw 'QA connection and cutoff rehearsal did not pass or left residual data.' }
$row | ConvertTo-Json -Compress
