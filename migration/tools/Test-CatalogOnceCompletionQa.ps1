[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$SessionDirectory,
  [ValidateSet('all','bootstrap','manual','licensing-any','licensing-all','database-any','database-all')][string]$ProbeStage='all',
  [ValidateRange(10,90)][int]$SqlTimeoutSeconds=90
)

$ErrorActionPreference='Stop'
$session=(Resolve-Path -LiteralPath $SessionDirectory).Path
$descriptor=Get-Content -Raw -LiteralPath (Join-Path $session 'active.json') | ConvertFrom-Json
if($descriptor.database -cne 'PortalSAGWeb-TEST' -or $descriptor.environment -cne 'qa' -or $descriptor.accessLevel -cne 'full-control'){
  throw 'This historical owner fixture requires the authorized full-control PortalSAGWeb-TEST session.'
}
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$migration=@(Get-ChildItem -LiteralPath (Join-Path $root 'migration/sql') -File -Filter '050_*.sql')
if($migration.Count -ne 1){throw 'Expected exactly one migration 050.'}
$ddl=Get-Content -Raw -LiteralPath $migration[0].FullName
$compiled=Join-Path $root 'api/dist/src/lib'
function Read-CompiledSql([string]$Module,[string]$Name){
  $file=Join-Path $compiled ($Module+'.js')
  $value=(& node -e 'const q=require(process.argv[1])[process.argv[2]];if(typeof q!=="string"||!q.trim())process.exit(1);process.stdout.write(q);' $file $Name) -join [Environment]::NewLine
  if($LASTEXITCODE -ne 0 -or !$value){throw "Build the candidate SQL export $Name before this rehearsal."}
  return $value.Replace("'","''")
}
$read=Read-CompiledSql 'catalogOnceClosureSql' 'readCatalogOnceClosureProofSql'
$update=Read-CompiledSql 'catalogOnceClosureSqlRepository' 'completeCatalogOnceScheduleSql'
$reserve=Read-CompiledSql 'catalogOnceClosureSqlRepository' 'reserveCatalogOnceClosureCandidatesSql'
$prefix="DECLARE @readSql nvarchar(max)=N'$read',@updateSql nvarchar(max)=N'$update',@reserveSql nvarchar(max)=N'$reserve',@ddlSql nvarchar(max)=N'"+$ddl.Replace("'","''")+"';"
$prefix+="DECLARE @probeStage varchar(20)='$ProbeStage';"

# Explicit QA-only exception approved by the Orchestrator: INSERT-stamping
# triggers are suspended ONLY for synthetic historical seeding, then all are
# re-enabled before migration/proof/closure execution. No append-only UPDATE/
# DELETE guard is disabled. This is NOT evidence that normal publication can
# backdate records, a real HTTP workflow, or a two-session race certification.
$body=@'
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @runStarted datetime2(3)=SYSUTCDATETIME();
IF DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR @@TRANCOUNT<>0
  OR CAST(SERVERPROPERTY('ProductMajorVersion') AS int)<>15
  THROW 55070,N'Unexpected historical owner fixture target.',1;
IF OBJECT_ID(N'settings.catalog_source_head_events',N'U') IS NOT NULL
  OR OBJECT_ID(N'scheduling.catalog_once_source_witnesses',N'U') IS NOT NULL
  THROW 55071,N'Run this rollback-only migration rehearsal before installing 050.',1;
IF EXISTS(SELECT 1 FROM settings.catalog_source_bindings WHERE portal_environment='qa' AND source_state='active')
  OR EXISTS(SELECT 1 FROM scheduling.catalog_schedule_population_approvals WHERE portal_environment='qa' AND retired_at IS NULL)
  OR EXISTS(SELECT 1 FROM settings.catalog_match_key_registry WHERE portal_environment='qa')
  THROW 55072,N'The isolated historical fixture requires an empty active QA catalog and enrollment.',1;
DECLARE @stamps table(trigger_name nvarchar(260) PRIMARY KEY);
INSERT @stamps VALUES(N'core.TR_catalog_operational_owner_register'),(N'core.TR_catalog_operational_link_register'),
  (N'core.TR_catalog_operational_approval_stamp'),(N'scheduling.TR_catalog_schedule_operation_approvals_register'),
  (N'scheduling.TR_catalog_schedule_population_approvals_register'),(N'settings.TR_catalog_sag_license_module_approvals_stamp'),
  (N'core.TR_catalog_physical_target_links_register');
IF (SELECT COUNT(*) FROM sys.triggers t JOIN @stamps s ON t.object_id=OBJECT_ID(s.trigger_name) WHERE t.is_disabled=0)<>7
  THROW 55073,N'Every reviewed INSERT-stamping trigger must initially be enabled.',1;
DECLARE @tag nvarchar(72)=N'qa-once-close-'+LOWER(CONVERT(char(36),NEWID())),@passed int=0,@step int=0;
DECLARE @now datetime2(3)=SYSUTCDATETIME(),@day date,@stamp datetime2(3),@cutoff datetime2(3),@until datetime2(3);
SET @day=CONVERT(date,DATEADD(day,-1,DATEADD(hour,-5,@now)));
SET @stamp=DATEADD(hour,6,CONVERT(datetime2(3),@day));
SET @cutoff=DATEADD(hour,5,DATEADD(day,1,CONVERT(datetime2(3),@day)));
SET @until=DATEADD(day,2,@now);
DECLARE @client bigint,@owner bigint,@approver bigint,@customer bigint,@target bigint,@task bigint,@execution bigint;
DECLARE @erp bigint,@sag bigint,@erpBinding binary(8),@sagBinding binary(8),@erpProfile binary(8),@sagProfile binary(8);
DECLARE @erpRevision bigint,@sagRevision bigint,@newRevision bigint,@event bigint,@moduleA bigint,@moduleB bigint,@lock int;
DECLARE @dbProfile bigint,@dbTarget bigint,@dbTask bigint,@dbExecution bigint,@dbProfileVersion binary(8),@dbDigest binary(32),@dbHex char(64);
DECLARE @erpAttempt bigint=9223372036854775741,@sagAttempt bigint=9223372036854775742,@nextAttempt bigint=9223372036854775743;
IF EXISTS(SELECT 1 FROM core.catalog_customer_source_revisions WHERE attempt_ordinal IN (@erpAttempt,@sagAttempt,@nextAttempt))
  THROW 55073,N'Reserved synthetic attempt ordinals are already present.',1;
DECLARE @digest binary(32)=HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag)),@hex char(64);
SET @hex=LOWER(CONVERT(char(64),@digest,2));
SET @dbDigest=HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag+N'-db'));
SET @dbHex=LOWER(CONVERT(char(64),@dbDigest,2));
DECLARE @operation nvarchar(25)=N'fixture.once.close',@population uniqueidentifier=NEWID(),@sourceJson varchar(max),@linkJson varchar(max),@fence binary(32);
DECLARE @edges table(n int PRIMARY KEY,link_id uniqueidentifier NOT NULL DEFAULT NEWID(),domain_key bigint NULL,
  db_link_id uniqueidentifier NOT NULL DEFAULT NEWID(),database_key bigint NULL);
DECLARE @rules table(n int PRIMARY KEY,schedule_key bigint NULL,version binary(8) NULL,observation_key bigint NULL);
DECLARE @proof table(scheduleId nvarchar(150),scheduleVersion char(16),clientId nvarchar(150));
DECLARE @changed table(changed int);
DECLARE @scan table(portalEnvironment varchar(10),taskDate varchar(10),observationKey varchar(19));
DECLARE @firstScan varchar(19),@secondScan varchar(19),@readDay date;
DECLARE @observation bigint,@schedule bigint,@scheduleId nvarchar(150),@version char(16),@case int,@expected int;
BEGIN TRY
  EXEC sys.sp_set_session_context @key=N'portal_qa_once_step',@value=@step;
  BEGIN TRANSACTION;
  EXEC @lock=sys.sp_getapplock @Resource=N'portal-sag:catalog-customer-publication:qa',@LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock<0 THROW 55074,N'Could not reserve the isolated QA catalog.',1;
  DECLARE @resource nvarchar(255)=N'portal.catalog-task.v1:database:'+CONVERT(char(10),@day,23);
  EXEC @lock=sys.sp_getapplock @Resource=@resource,@LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock<0 THROW 55074,N'Could not reserve the QA database day.',1;
  SET @resource=N'portal.catalog-task.v1:domain:'+CONVERT(char(10),@day,23);
  EXEC @lock=sys.sp_getapplock @Resource=@resource,@LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock<0 THROW 55074,N'Could not reserve the QA domain day.',1;
  DISABLE TRIGGER core.TR_catalog_operational_owner_register ON core.catalog_operational_owners;
  DISABLE TRIGGER core.TR_catalog_operational_link_register ON core.catalog_operational_links;
  DISABLE TRIGGER core.TR_catalog_operational_approval_stamp ON core.catalog_operational_link_approvals;
  DISABLE TRIGGER scheduling.TR_catalog_schedule_operation_approvals_register ON scheduling.catalog_schedule_operation_approvals;
  DISABLE TRIGGER scheduling.TR_catalog_schedule_population_approvals_register ON scheduling.catalog_schedule_population_approvals;
  DISABLE TRIGGER settings.TR_catalog_sag_license_module_approvals_stamp ON settings.catalog_sag_license_module_approvals;
  DISABLE TRIGGER core.TR_catalog_physical_target_links_register ON core.catalog_physical_target_links;
  SET @step=1;
  EXEC sys.sp_set_session_context @key=N'portal_qa_once_step',@value=@step;
  INSERT settings.catalog_match_key_registry(portal_environment,match_key_version,vault_secret_version,key_verifier,enrolled_at)
    VALUES('qa',1,CONVERT(binary(16),NEWID()),@digest,@stamp);
  INSERT security.users(source_id,display_name,email,email_normalized,active,created_at,created_by,updated_at,updated_by)
    VALUES(@tag,@tag,@tag+N'@invalid.example',@tag+N'@invalid.example',1,@stamp,N'fixture',@stamp,N'fixture');
  SELECT @approver=user_key FROM security.users WHERE source_id=@tag;
  INSERT security.user_roles(user_key,role_id,assigned_by) VALUES(@approver,N'super_admin',N'fixture');
  INSERT settings.external_database_connections(source_id,display_name,server_host,database_name,login_name,password_configured,password_secret_name,created_by,updated_by)
    SELECT @tag+suffix,@tag+suffix,N'fixture.invalid',N'synthetic',N'synthetic',1,N'fixture-no-key',N'fixture',N'fixture'
    FROM (VALUES(N'-erp'),(N'-sag')) s(suffix);
  INSERT settings.catalog_source_bindings(external_database_connection_key,display_name,source_role,portal_environment,contract_version,source_state,issuer_scope,validated_at,validated_profile_version,created_by,updated_by)
    SELECT external_database_connection_key,source_id,CASE WHEN source_id=@tag+N'-erp' THEN 'erp-customers' ELSE 'sag-admin' END,'qa',
      CASE WHEN source_id=@tag+N'-erp' THEN 'erp_v1' ELSE 'sag_admin_v1' END,'active',CASE WHEN source_id=@tag+N'-erp' THEN 'CO' END,@stamp,row_version,N'fixture',N'fixture'
    FROM settings.external_database_connections WHERE source_id IN (@tag+N'-erp',@tag+N'-sag');
  SELECT @erp=catalog_source_key,@erpBinding=row_version,@erpProfile=validated_profile_version FROM settings.catalog_source_bindings WHERE display_name=@tag+N'-erp';
  SELECT @sag=catalog_source_key,@sagBinding=row_version,@sagProfile=validated_profile_version FROM settings.catalog_source_bindings WHERE display_name=@tag+N'-sag';
  INSERT core.catalog_customer_ids DEFAULT VALUES;
  SET @customer=SCOPE_IDENTITY();
  INSERT @edges(n) VALUES(1),(2);
  INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,match_key_version,attempt_ordinal,expected_rows,expected_scopes,observed_at,verified_until,has_sag_inventory_evidence)
    VALUES(@erp,'erp-customers',@erpBinding,@erpProfile,1,@erpAttempt,1,0,@stamp,@until,0);
  SET @erpRevision=SCOPE_IDENTITY();
  INSERT core.catalog_customer_revision_rows(revision_key,source_role,source_record_id,catalog_customer_key,official_name,active_code,issuer,document_type,document_number_token)
    VALUES(@erpRevision,'erp-customers',1,@customer,N'Synthetic official name','S','CO','NIT',@digest);
  UPDATE core.catalog_customer_source_revisions SET sealed_at=@stamp WHERE revision_key=@erpRevision;
  INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,match_key_version,attempt_ordinal,expected_rows,expected_scopes,observed_at,verified_until,has_sag_inventory_evidence)
    VALUES(@sag,'sag-admin',@sagBinding,@sagProfile,1,@sagAttempt,2,0,@stamp,@until,1);
  SET @sagRevision=SCOPE_IDENTITY();
  INSERT core.catalog_customer_revision_rows(revision_key,source_role,source_record_id,catalog_customer_key,official_name,active_code,issuer,document_type,document_number_token)
    SELECT @sagRevision,'sag-admin',n,NULL,NULL,NULL,'CO','NIT',@digest FROM @edges;
  INSERT core.catalog_sag_revision_evidence(revision_key,source_record_id,domain_candidate,environment_kind,license_codes)
    SELECT @sagRevision,n,CONVERT(varchar(253),@tag+N'-'+CONVERT(nvarchar(1),n)+N'.invalid'),'test','AB' FROM @edges;
  UPDATE core.catalog_customer_source_revisions SET sealed_at=@stamp WHERE revision_key=@sagRevision;
  INSERT settings.catalog_customer_revision_heads(catalog_source_key,revision_key,attempt_status,attempted_at,attempt_ordinal)
    VALUES(@erp,@erpRevision,'succeeded',@stamp,@erpAttempt),(@sag,@sagRevision,'succeeded',@stamp,@sagAttempt);
  INSERT core.clients(source_id,name,name_normalized,status,created_at,created_by,updated_at,updated_by)
    VALUES(@tag,@tag,@tag,'active',@stamp,N'fixture',@stamp,N'fixture');
  SET @client=SCOPE_IDENTITY();
  INSERT core.domains(source_id,client_key,domain_name,domain_name_normalized,environment_id,status,created_at,created_by,updated_at,updated_by)
    SELECT @tag+N'-d'+CONVERT(nvarchar(1),n),@client,N'https://'+@tag+N'-'+CONVERT(nvarchar(1),n)+N'.invalid/',
      N'https://'+@tag+N'-'+CONVERT(nvarchar(1),n)+N'.invalid/','test','active',@stamp,N'fixture',@stamp,N'fixture' FROM @edges;
  UPDATE x SET domain_key=d.domain_key FROM @edges x JOIN core.domains d ON d.client_key=@client AND d.source_id=@tag+N'-d'+CONVERT(nvarchar(1),x.n);
  INSERT core.catalog_operational_owners(portal_environment,catalog_customer_key,client_key,registered_by,registered_at)
    VALUES('qa',@customer,@client,N'fixture',@stamp);
  SELECT @owner=owner_key FROM core.catalog_operational_owners WHERE portal_environment='qa' AND catalog_customer_key=@customer;
  INSERT core.catalog_operational_links(link_id,owner_key,portal_environment,client_key,domain_key,catalog_source_key,source_record_id,target_kind,link_environment,registered_by,registered_at)
    SELECT link_id,@owner,'qa',@client,domain_key,@erp,1,'domain','test',N'fixture',@stamp FROM @edges;
  INSERT core.catalog_operational_link_approvals(link_key,binding_version,profile_version,revision_key,approval_reference,approved_by,approved_at)
    SELECT l.link_key,@erpBinding,@erpProfile,@erpRevision,'QA-CLOSE',N'fixture',@stamp FROM core.catalog_operational_links l JOIN @edges x ON x.link_id=l.link_id;
  -- Two logical database relations, one physical SQL destination and one task.
  -- This is metadata only: no secret is resolved and no socket is opened.
  INSERT core.database_access_profiles(source_id,server_host_port,initial_catalog,sql_user_id,password_secret_name,
    connection_fingerprint,created_at,created_by,updated_at,updated_by)
    VALUES(@tag+N'-profile',N'fixture.invalid,1433',N'synthetic',N'fixture',N'fixture-no-key',
      HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag+N'-profile')),@stamp,N'fixture',@stamp,N'fixture');
  SET @dbProfile=SCOPE_IDENTITY();
  SELECT @dbProfileVersion=row_version FROM core.database_access_profiles WHERE access_profile_key=@dbProfile;
  INSERT core.databases(source_id,client_key,domain_key,access_profile_key,company_name,company_name_normalized,
    environment_id,status,created_at,created_by,updated_at,updated_by)
    SELECT @tag+N'-db'+CONVERT(nvarchar(1),n),@client,domain_key,@dbProfile,@tag,@tag,'test','active',@stamp,N'fixture',@stamp,N'fixture' FROM @edges;
  UPDATE e SET database_key=db.database_key FROM @edges e JOIN core.databases db
    ON db.source_id=@tag+N'-db'+CONVERT(nvarchar(1),e.n);
  INSERT core.catalog_operational_links(link_id,owner_key,portal_environment,client_key,domain_key,database_key,
    catalog_source_key,source_record_id,target_kind,link_environment,registered_by,registered_at)
    SELECT db_link_id,@owner,'qa',@client,domain_key,database_key,@erp,1,'database','test',N'fixture',@stamp FROM @edges;
  INSERT core.catalog_operational_link_approvals(link_key,binding_version,profile_version,revision_key,approval_reference,approved_by,approved_at)
    SELECT l.link_key,@erpBinding,@erpProfile,@erpRevision,'QA-CLOSE-DB',N'fixture',@stamp
    FROM core.catalog_operational_links l JOIN @edges e ON e.db_link_id=l.link_id;
  INSERT licensing.license_modules(source_id,name,name_normalized,status,created_at,created_by,updated_at,updated_by)
    SELECT @tag+suffix,@tag+suffix,@tag+suffix,'active',@stamp,N'fixture',@stamp,N'fixture' FROM (VALUES(N'-a'),(N'-b')) s(suffix);
  SELECT @moduleA=module_key FROM licensing.license_modules WHERE source_id=@tag+N'-a';
  SELECT @moduleB=module_key FROM licensing.license_modules WHERE source_id=@tag+N'-b';
  INSERT settings.catalog_sag_license_module_approvals(catalog_source_key,binding_version,profile_version,sag_code,module_key,approval_reference,approved_by,approved_at)
    VALUES(@sag,@sagBinding,@sagProfile,'A',@moduleA,'QA-CLOSE-A',N'fixture',@stamp),(@sag,@sagBinding,@sagProfile,'B',@moduleB,'QA-CLOSE-B',N'fixture',@stamp);
  SELECT @sourceJson=STRING_AGG(CONVERT(varchar(max),CONCAT('["',LOWER(CONVERT(char(36),source_id)),'","',source_role,'","',LOWER(CONVERT(char(16),CONVERT(binary(8),row_version),2)),'","',LOWER(CONVERT(char(16),validated_profile_version,2)),'"]')),',')
    WITHIN GROUP (ORDER BY LOWER(CONVERT(char(36),source_id)) COLLATE Latin1_General_100_BIN2)
    FROM settings.catalog_source_bindings WHERE portal_environment='qa' AND source_state='active';
  SELECT @linkJson=STRING_AGG(CONVERT(varchar(max),'"'+LOWER(CONVERT(char(36),link_id))+'"'),',') WITHIN GROUP(ORDER BY LOWER(CONVERT(char(36),link_id)) COLLATE Latin1_General_100_BIN2)
    FROM (SELECT link_id FROM @edges UNION ALL SELECT db_link_id FROM @edges) manifestLinks;
  SELECT @fence=source_fence FROM scheduling.catalog_once_source_fence('qa');
  INSERT scheduling.catalog_schedule_population_approvals(population_id,portal_environment,source_count,link_count,population_sha256,approved_by,approved_at,valid_until)
    VALUES(@population,'qa',2,4,HASHBYTES('SHA2_256',CONCAT('["portal-sag:catalog-schedule-population:v1","qa",[',@sourceJson,'],[',@linkJson,']]')),@approver,@stamp,@until);
  INSERT @rules(n) VALUES(1),(2),(3),(4),(5),(6),(7);
  INSERT scheduling.update_schedules(source_id,client_key,name,target_type,frequency_type,start_date,timezone,assigned_role,selection_mode,created_at,created_by,updated_at,updated_by)
    SELECT @tag+N'-s'+CONVERT(nvarchar(1),n),@client,N'Fixture',CASE WHEN n IN (6,7) THEN 'database' ELSE 'domain' END,
      'once',@day,N'America/Bogota',N'super_admin',CASE WHEN n IN (2,3,6,7) THEN 'licensing' ELSE 'manual' END,@stamp,N'fixture',@stamp,N'fixture' FROM @rules;
  UPDATE r SET schedule_key=s.schedule_key,version=s.row_version FROM @rules r JOIN scheduling.update_schedules s ON s.source_id=@tag+N'-s'+CONVERT(nvarchar(1),r.n);
  INSERT scheduling.catalog_schedule_operation_approvals(portal_environment,schedule_key,schedule_version,operation_id,approved_by,approved_at)
    SELECT 'qa',schedule_key,version,@operation,@approver,@stamp FROM @rules;
  INSERT scheduling.licensing_scope(schedule_key,license_match_mode,environment_id,target_types,active_only)
    SELECT schedule_key,CASE WHEN n IN (2,6) THEN 'any' ELSE 'all' END,'test',CASE WHEN n IN (6,7) THEN 'databases_only' ELSE 'domains_only' END,1 FROM @rules WHERE n IN (2,3,6,7);
  INSERT scheduling.licensing_scope_modules(schedule_key,module_key) SELECT schedule_key,@moduleA FROM @rules WHERE n IN (2,3,6,7);
  INSERT scheduling.licensing_scope_modules(schedule_key,module_key) SELECT schedule_key,@moduleB FROM @rules WHERE n IN (3,7);
  INSERT core.catalog_physical_targets(portal_environment,target_kind,identity_fingerprint,created_at) VALUES('qa','domain',@digest,@stamp);
  SET @target=SCOPE_IDENTITY();
  INSERT core.catalog_physical_target_links(physical_target_key,portal_environment,target_kind,client_key,domain_key,domain_route_fingerprint,proof_id,verified_by,verified_at,valid_until,registered_at)
    SELECT @target,'qa','domain',@client,d.domain_key,HASHBYTES('SHA2_256',CONVERT(varbinary(max),N'portal-sag:web-route:v1|')+CONVERT(binary(4),DATALENGTH(d.domain_name_normalized))+CONVERT(varbinary(max),d.domain_name_normalized)+CONVERT(varbinary(max),0x00)),NEWID(),N'fixture',@stamp,@until,@stamp
    FROM @edges x JOIN core.domains d ON d.domain_key=x.domain_key;
  INSERT core.catalog_physical_targets(portal_environment,target_kind,identity_fingerprint,database_name_fingerprint,created_at)
    VALUES('qa','database',@dbDigest,HASHBYTES('SHA2_256',CONVERT(varbinary(max),N'synthetic')),@stamp);
  SET @dbTarget=SCOPE_IDENTITY();
  INSERT core.catalog_physical_target_links(physical_target_key,portal_environment,target_kind,client_key,domain_key,database_key,
    access_profile_key,access_profile_version,proof_id,verified_by,verified_at,valid_until,registered_at)
    SELECT @dbTarget,'qa','database',@client,domain_key,database_key,@dbProfile,@dbProfileVersion,NEWID(),N'fixture',@stamp,@until,@stamp FROM @edges;
  INSERT workflow.update_tasks(source_id,task_date,task_bucket,client_key,client_source_id,client_name_snapshot,domain_key,domain_source_id,domain_name_snapshot,target_type,target_source_id,target_name_snapshot,assigned_role,status,result,completed_at,completed_by,completed_with_problems,created_at,created_by,updated_at,updated_by)
    SELECT N'catalog-'+@hex,@day,'fixture',@client,@tag,@tag,d.domain_key,d.source_id,d.domain_name,'domain',d.source_id,d.domain_name,N'super_admin','completed',N'success',@now,N'fixture',0,@stamp,N'fixture',@now,N'fixture' FROM @edges x JOIN core.domains d ON d.domain_key=x.domain_key WHERE x.n=1;
  SET @task=SCOPE_IDENTITY();
  INSERT workflow.task_status_history(task_key,previous_status,new_status,action,performed_by,performed_by_email,performed_at,is_inferred,metadata_json)
    VALUES(@task,'pending','completed',N'task_completed',N'fixture',N'fixture@invalid.example',@now,0,N'{"explicitCompletionSuccess":true}');
  INSERT workflow.catalog_task_executions(task_key,execution_key,occurrence_id,execution_kind,verified_target_id,operation_id,initial_catalog_revision_id,cutoff_at,created_at)
    SELECT @task,@digest,CONVERT(nvarchar(10),@day,23),'domain',LOWER(CONVERT(nvarchar(36),target_id)),@operation,N'fixture',@cutoff,@stamp FROM core.catalog_physical_targets WHERE physical_target_key=@target;
  SET @execution=SCOPE_IDENTITY();
  INSERT workflow.catalog_task_execution_links(catalog_execution_key,execution_kind,link_id,catalog_source_key,catalog_record_id,client_key,domain_key,link_environment,created_at)
    SELECT @execution,'domain',LOWER(CONVERT(nvarchar(36),link_id)),@erp,N'1',@client,domain_key,'test',@stamp FROM @edges;
  INSERT workflow.catalog_task_execution_sources(catalog_execution_link_key,schedule_key,attached_at)
    SELECT l.catalog_execution_link_key,r.schedule_key,@stamp FROM workflow.catalog_task_execution_links l CROSS JOIN @rules r WHERE l.catalog_execution_key=@execution AND r.n<=5;
  INSERT workflow.update_tasks(source_id,task_date,task_bucket,client_key,client_source_id,client_name_snapshot,domain_key,
    domain_source_id,domain_name_snapshot,target_type,target_source_id,target_name_snapshot,database_key,assigned_role,status,
    result,completed_at,completed_by,completed_with_problems,created_at,created_by,updated_at,updated_by)
    SELECT N'catalog-'+@dbHex,@day,'fixture',@client,@tag,@tag,e.domain_key,d.source_id,d.domain_name,
      'database',db.source_id,N'synthetic',e.database_key,N'super_admin','completed',N'success',@now,N'fixture',0,@stamp,N'fixture',@now,N'fixture'
    FROM @edges e JOIN core.domains d ON d.domain_key=e.domain_key JOIN core.databases db ON db.database_key=e.database_key WHERE e.n=1;
  SET @dbTask=SCOPE_IDENTITY();
  INSERT workflow.task_status_history(task_key,previous_status,new_status,action,performed_by,performed_by_email,performed_at,is_inferred,metadata_json)
    VALUES(@dbTask,'pending','completed',N'task_completed',N'fixture',N'fixture@invalid.example',@now,0,N'{"explicitCompletionSuccess":true}');
  INSERT workflow.catalog_task_executions(task_key,execution_key,occurrence_id,execution_kind,verified_target_id,
    operation_id,initial_catalog_revision_id,cutoff_at,created_at)
    SELECT @dbTask,@dbDigest,CONVERT(nvarchar(10),@day,23),'database',LOWER(CONVERT(nvarchar(36),target_id)),@operation,N'fixture',@cutoff,@stamp
    FROM core.catalog_physical_targets WHERE physical_target_key=@dbTarget;
  SET @dbExecution=SCOPE_IDENTITY();
  INSERT workflow.catalog_task_execution_links(catalog_execution_key,execution_kind,link_id,catalog_source_key,catalog_record_id,
    client_key,domain_key,database_key,link_environment,created_at)
    SELECT @dbExecution,'database',LOWER(CONVERT(nvarchar(36),db_link_id)),@erp,N'1',@client,domain_key,database_key,'test',@stamp FROM @edges;
  INSERT workflow.catalog_task_execution_sources(catalog_execution_link_key,schedule_key,attached_at)
    SELECT l.catalog_execution_link_key,r.schedule_key,@stamp FROM workflow.catalog_task_execution_links l CROSS JOIN @rules r WHERE l.catalog_execution_key=@dbExecution AND r.n IN (6,7);
  INSERT scheduling.catalog_once_observations(schedule_key,portal_environment,task_date,cutoff_at,schedule_version,operation_id,population_id,observed_at,valid_until,pair_count,source_fence)
    SELECT schedule_key,'qa',@day,@cutoff,version,@operation,@population,DATEADD(minute,5,@stamp),@until,2,@fence FROM @rules;
  UPDATE r SET observation_key=o.observation_key FROM @rules r JOIN scheduling.catalog_once_observations o ON o.schedule_key=r.schedule_key;
  INSERT scheduling.catalog_once_observation_pairs(observation_key,schedule_key,link_key,catalog_execution_key,catalog_execution_link_key)
    SELECT r.observation_key,r.schedule_key,l.link_key,@execution,x.catalog_execution_link_key FROM @rules r CROSS JOIN @edges ed
    JOIN core.catalog_operational_links l ON l.link_id=ed.link_id JOIN workflow.catalog_task_execution_links x ON x.catalog_execution_key=@execution AND x.link_id=LOWER(CONVERT(nvarchar(36),ed.link_id))
    WHERE r.n<=5 AND (r.n<>5 OR ed.n=1);
  INSERT scheduling.catalog_once_observation_pairs(observation_key,schedule_key,link_key,catalog_execution_key,catalog_execution_link_key)
    SELECT r.observation_key,r.schedule_key,l.link_key,@dbExecution,x.catalog_execution_link_key FROM @rules r CROSS JOIN @edges ed
    JOIN core.catalog_operational_links l ON l.link_id=ed.db_link_id JOIN workflow.catalog_task_execution_links x
      ON x.catalog_execution_key=@dbExecution AND x.link_id=LOWER(CONVERT(nvarchar(36),ed.db_link_id)) WHERE r.n IN (6,7);
  INSERT scheduling.catalog_once_observations(schedule_key,portal_environment,task_date,cutoff_at,schedule_version,operation_id,population_id,observed_at,valid_until,pair_count,source_fence)
    SELECT schedule_key,'qa',@day,@cutoff,version,@operation,@population,DATEADD(minute,6,@stamp),@until,0,@fence FROM @rules WHERE n=4;
  ENABLE TRIGGER core.TR_catalog_operational_owner_register ON core.catalog_operational_owners;
  ENABLE TRIGGER core.TR_catalog_operational_link_register ON core.catalog_operational_links;
  ENABLE TRIGGER core.TR_catalog_operational_approval_stamp ON core.catalog_operational_link_approvals;
  ENABLE TRIGGER scheduling.TR_catalog_schedule_operation_approvals_register ON scheduling.catalog_schedule_operation_approvals;
  ENABLE TRIGGER scheduling.TR_catalog_schedule_population_approvals_register ON scheduling.catalog_schedule_population_approvals;
  ENABLE TRIGGER settings.TR_catalog_sag_license_module_approvals_stamp ON settings.catalog_sag_license_module_approvals;
  ENABLE TRIGGER core.TR_catalog_physical_target_links_register ON core.catalog_physical_target_links;
  IF EXISTS(SELECT 1 FROM sys.triggers t JOIN @stamps s ON t.object_id=OBJECT_ID(s.trigger_name) WHERE t.is_disabled=1)
    THROW 55075,N'Historical seeding did not restore every INSERT stamp.',1;
  SET @step=2;
  EXEC sys.sp_set_session_context @key=N'portal_qa_once_step',@value=@step;
  EXEC sys.sp_executesql @ddlSql;
  EXEC sys.sp_executesql @ddlSql;
  IF (SELECT COUNT(*) FROM settings.catalog_source_head_events WHERE catalog_source_key IN (@erp,@sag))<>2
    OR EXISTS(SELECT 1 FROM settings.catalog_source_head_events WHERE catalog_source_key IN (@erp,@sag) AND recorded_at<@cutoff)
    OR EXISTS(SELECT 1 FROM scheduling.catalog_once_source_witnesses w JOIN @rules r ON r.observation_key=w.observation_key)
    THROW 55076,N'Migration replay fabricated or duplicated historical evidence.',1;
  IF @probeStage='bootstrap'
  BEGIN
    SET @passed+=1;
    GOTO FinishFixture;
  END;
  SET @step=3;
  EXEC sys.sp_set_session_context @key=N'portal_qa_once_step',@value=@step;
  SELECT @observation=observation_key FROM @rules WHERE n=1;
  INSERT @proof EXEC sys.sp_executesql @readSql,N'@portalEnvironment varchar(10),@taskDate date,@observationKey bigint','qa',@day,@observation;
  IF EXISTS(SELECT 1 FROM @proof) THROW 55077,N'Pre-migration observation closed without captured witnesses.',1;
  SET @passed+=1;
  -- Explicit historical owner fixture, not normal publication/backdating.
  SET @step=4;
  EXEC sys.sp_set_session_context @key=N'portal_qa_once_step',@value=@step;
  INSERT settings.catalog_source_head_events(catalog_source_key,revision_key,attempt_ordinal,attempt_status,attempted_at,recorded_at)
    VALUES(@erp,@erpRevision,@erpAttempt,'succeeded',@stamp,@stamp),(@sag,@sagRevision,@sagAttempt,'succeeded',@stamp,@stamp);
  INSERT scheduling.catalog_once_source_witnesses(observation_key,catalog_source_key,head_event_key,binding_version,profile_version,source_role,match_key_version,captured_at)
    SELECT r.observation_key,b.catalog_source_key,e.head_event_key,b.row_version,b.validated_profile_version,b.source_role,1,DATEADD(minute,5,@stamp)
    FROM @rules r CROSS JOIN settings.catalog_source_bindings b JOIN settings.catalog_source_head_events e ON e.catalog_source_key=b.catalog_source_key AND e.recorded_at=@stamp
    WHERE b.catalog_source_key IN (@erp,@sag);
  SET @case=CASE @probeStage WHEN 'licensing-any' THEN 2 WHEN 'licensing-all' THEN 3 WHEN 'database-any' THEN 19 WHEN 'database-all' THEN 20 ELSE 1 END;
  DECLARE @caseEnd int=CASE WHEN @probeStage='all' THEN 23 ELSE @case END;
  WHILE @case<=@caseEnd
  BEGIN
    SET @step=CASE WHEN @case<=18 THEN 10+@case ELSE 30+@case END;
    EXEC sys.sp_set_session_context @key=N'portal_qa_once_step',@value=@step;
    SAVE TRANSACTION scenario;
    SELECT @observation=observation_key FROM @rules WHERE n=CASE WHEN @case IN (2,3) THEN @case WHEN @case=13 THEN 2 WHEN @case IN (17,18) THEN 3 WHEN @case=16 THEN 5 WHEN @case=19 THEN 6 WHEN @case IN (20,21,22,23) THEN 7 ELSE 1 END;
    SET @expected=CASE WHEN @case<=4 OR @case IN (19,20) THEN 1 ELSE 0 END;
    SET @readDay=@day;
    IF @case=4
    BEGIN
      INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,match_key_version,attempt_ordinal,expected_rows,expected_scopes,observed_at,verified_until,has_sag_inventory_evidence)
        VALUES(@erp,'erp-customers',@erpBinding,@erpProfile,1,@nextAttempt,1,0,@now,@until,0);
      SET @newRevision=SCOPE_IDENTITY();
      INSERT core.catalog_customer_revision_rows(revision_key,source_role,source_record_id,catalog_customer_key,official_name,active_code,issuer,document_type,document_number_token)
        VALUES(@newRevision,'erp-customers',1,@customer,N'Updated synthetic name','S','CO','NIT',@digest);
      UPDATE core.catalog_customer_source_revisions SET sealed_at=SYSUTCDATETIME() WHERE revision_key=@newRevision;
      UPDATE settings.catalog_customer_revision_heads SET revision_key=@newRevision,attempt_ordinal=@nextAttempt,attempted_at=SYSUTCDATETIME() WHERE catalog_source_key=@erp;
    END;
    IF @case=5 INSERT settings.catalog_source_head_events(catalog_source_key,revision_key,attempt_ordinal,attempt_status,attempted_at,recorded_at)
      VALUES(@erp,@erpRevision,@nextAttempt,'failed',DATEADD(minute,-1,@cutoff),DATEADD(minute,-1,@cutoff));
    IF @case=6 UPDATE scheduling.update_schedules SET name=N'Changed fixture' WHERE schedule_key=(SELECT schedule_key FROM @rules WHERE n=1);
    IF @case=7 UPDATE workflow.update_tasks SET status='cancelled' WHERE task_key=@task;
    IF @case=8 UPDATE workflow.update_tasks SET completed_with_problems=1 WHERE task_key=@task;
    IF @case=9 UPDATE workflow.update_tasks SET status='pending',reopened_at=SYSUTCDATETIME() WHERE task_key=@task;
    IF @case=10 INSERT workflow.task_status_history(task_key,previous_status,new_status,action,performed_by,performed_at,is_inferred,metadata_json)
      VALUES(@task,'completed','completed',N'task_completed',N'fixture',@now,0,N'{"explicitCompletionSuccess":false}');
    IF @case=11 UPDATE settings.external_database_connections SET display_name=N'Changed profile fixture'
      WHERE external_database_connection_key=(SELECT external_database_connection_key FROM settings.catalog_source_bindings WHERE catalog_source_key=@erp);
    IF @case=12 SELECT @observation=observation_key FROM @rules WHERE n=4;
    IF @case=13 UPDATE licensing.license_modules SET status='inactive' WHERE module_key=@moduleA;
    IF @case=14 SET @readDay=CONVERT(date,DATEADD(day,1,@now));
    IF @case=15 INSERT settings.catalog_source_head_events(catalog_source_key,revision_key,attempt_ordinal,attempt_status,attempted_at,recorded_at)
      VALUES(@erp,NULL,NULL,'never',NULL,DATEADD(minute,-1,@cutoff));
    IF @case=17 UPDATE scheduling.licensing_scope SET environment_id='production' WHERE schedule_key=(SELECT schedule_key FROM @rules WHERE n=3);
    IF @case=18 INSERT scheduling.licensing_excluded_domains(schedule_key,domain_key)
      SELECT r.schedule_key,e.domain_key FROM @rules r CROSS JOIN @edges e WHERE r.n=3 AND e.n=1;
    IF @case=21 UPDATE parent SET retired_at=SYSUTCDATETIME() FROM core.catalog_operational_links parent
      JOIN @edges e ON e.link_id=parent.link_id WHERE e.n=1;
    IF @case=22 UPDATE core.database_access_profiles SET sql_user_id=N'changed-fixture' WHERE access_profile_key=@dbProfile;
    IF @case=23 INSERT scheduling.licensing_excluded_databases(schedule_key,database_key)
      SELECT r.schedule_key,e.database_key FROM @rules r CROSS JOIN @edges e WHERE r.n=7 AND e.n=1;
    DELETE FROM @proof;
    INSERT @proof EXEC sys.sp_executesql @readSql,N'@portalEnvironment varchar(10),@taskDate date,@observationKey bigint','qa',@readDay,@observation;
    IF (SELECT COUNT(*) FROM @proof)<>@expected THROW 55078,N'Unexpected exact closure proof result for historical fixture case.',1;
    ROLLBACK TRANSACTION scenario;
    SET @passed+=1;
    SET @case+=1;
  END;
  IF @probeStage<>'all' GOTO FinishFixture;
  SET @step=29;
  EXEC sys.sp_set_session_context @key=N'portal_qa_once_step',@value=@step;
  UPDATE scheduling.catalog_once_closure_scan_cursors SET last_observation_key=(
    SELECT MAX(o.observation_key)-1 FROM scheduling.catalog_once_observations o
    JOIN @rules r ON r.schedule_key=o.schedule_key WHERE r.n=4) WHERE portal_environment='qa';
  INSERT @scan EXEC sys.sp_executesql @reserveSql,N'@portalEnvironment varchar(10),@take int','qa',1;
  SELECT @firstScan=observationKey FROM @scan;
  DELETE FROM @proof;
  SET @observation=CONVERT(bigint,@firstScan);
  INSERT @proof EXEC sys.sp_executesql @readSql,N'@portalEnvironment varchar(10),@taskDate date,@observationKey bigint','qa',@day,@observation;
  IF EXISTS(SELECT 1 FROM @proof) THROW 55079,N'The blocked first scan candidate unexpectedly qualified.',1;
  DELETE FROM @scan;
  INSERT @scan EXEC sys.sp_executesql @reserveSql,N'@portalEnvironment varchar(10),@take int','qa',1;
  SELECT @secondScan=observationKey FROM @scan;
  IF @firstScan IS NULL OR @secondScan IS NULL OR @firstScan=@secondScan
    THROW 55079,N'The durable scan cursor did not advance past an unclosed candidate.',1;
  SET @passed+=1;
  SET @step=30;
  EXEC sys.sp_set_session_context @key=N'portal_qa_once_step',@value=@step;
  SELECT @observation=observation_key,@schedule=schedule_key FROM @rules WHERE n=1;
  DELETE FROM @proof;
  INSERT @proof EXEC sys.sp_executesql @readSql,N'@portalEnvironment varchar(10),@taskDate date,@observationKey bigint','qa',@day,@observation;
  SELECT @scheduleId=scheduleId,@version=scheduleVersion FROM @proof;
  IF @scheduleId IS NULL THROW 55079,N'Missing positive closure proof before exact update.',1;
  INSERT @changed EXEC sys.sp_executesql @updateSql,N'@portalEnvironment varchar(10),@taskDate date,@observationKey bigint,@scheduleId nvarchar(150),@scheduleVersion char(16)',
    'qa',@day,@observation,@scheduleId,@version;
  IF NOT EXISTS(SELECT 1 FROM @changed WHERE changed=1) OR NOT EXISTS(SELECT 1 FROM scheduling.update_schedules WHERE schedule_key=@schedule AND active=0 AND completed_reason=N'one_time_schedule_executed')
    THROW 55079,N'The compiled closure update did not close the exact eligible schedule.',1;
  DELETE FROM @changed;
  INSERT @changed EXEC sys.sp_executesql @updateSql,N'@portalEnvironment varchar(10),@taskDate date,@observationKey bigint,@scheduleId nvarchar(150),@scheduleVersion char(16)',
    'qa',@day,@observation,@scheduleId,@version;
  IF NOT EXISTS(SELECT 1 FROM @changed WHERE changed=0) THROW 55079,N'Closure replay was not idempotent.',1;
  SET @passed+=1;
  SET @case=6;
  WHILE @case<=7
  BEGIN
    SET @step=25+@case;
    EXEC sys.sp_set_session_context @key=N'portal_qa_once_step',@value=@step;
    SELECT @observation=observation_key,@schedule=schedule_key FROM @rules WHERE n=@case;
    DELETE FROM @proof;
    INSERT @proof EXEC sys.sp_executesql @readSql,N'@portalEnvironment varchar(10),@taskDate date,@observationKey bigint','qa',@day,@observation;
    SET @scheduleId=NULL;
    SELECT @scheduleId=scheduleId,@version=scheduleVersion FROM @proof;
    IF @scheduleId IS NULL THROW 55079,N'Missing positive database proof before exact update.',1;
    DELETE FROM @changed;
    INSERT @changed EXEC sys.sp_executesql @updateSql,N'@portalEnvironment varchar(10),@taskDate date,@observationKey bigint,@scheduleId nvarchar(150),@scheduleVersion char(16)',
      'qa',@day,@observation,@scheduleId,@version;
    IF NOT EXISTS(SELECT 1 FROM @changed WHERE changed=1) OR NOT EXISTS(SELECT 1 FROM scheduling.update_schedules WHERE schedule_key=@schedule AND active=0 AND completed_reason=N'one_time_schedule_executed')
      THROW 55079,N'The compiled database closure update did not close its exact schedule.',1;
    DELETE FROM @changed;
    INSERT @changed EXEC sys.sp_executesql @updateSql,N'@portalEnvironment varchar(10),@taskDate date,@observationKey bigint,@scheduleId nvarchar(150),@scheduleVersion char(16)',
      'qa',@day,@observation,@scheduleId,@version;
    IF NOT EXISTS(SELECT 1 FROM @changed WHERE changed=0) THROW 55079,N'Database closure replay was not idempotent.',1;
    SET @passed+=1;
    SET @case+=1;
  END;
  SELECT @schedule=schedule_key FROM @rules WHERE n=1;
  UPDATE workflow.update_tasks SET status='pending',reopened_at=SYSUTCDATETIME() WHERE task_key=@task;
  IF NOT EXISTS(SELECT 1 FROM scheduling.update_schedules WHERE schedule_key=@schedule AND active=0)
    THROW 55079,N'A task reopen unexpectedly reactivated its completed schedule.',1;
  SET @passed+=1;
FinishFixture:
  ROLLBACK TRANSACTION;
  IF EXISTS(SELECT 1 FROM sys.triggers t JOIN @stamps s ON t.object_id=OBJECT_ID(s.trigger_name) WHERE t.is_disabled=1)
    OR EXISTS(SELECT 1 FROM core.clients WHERE source_id=@tag)
    OR EXISTS(SELECT 1 FROM settings.external_database_connections WHERE source_id IN (@tag+N'-erp',@tag+N'-sag'))
    OR EXISTS(SELECT 1 FROM core.databases WHERE source_id IN (@tag+N'-db1',@tag+N'-db2'))
    OR EXISTS(SELECT 1 FROM core.database_access_profiles WHERE source_id=@tag+N'-profile')
    OR OBJECT_ID(N'settings.catalog_source_head_events',N'U') IS NOT NULL
    OR OBJECT_ID(N'scheduling.catalog_once_source_witnesses',N'U') IS NOT NULL
    OR OBJECT_ID(N'scheduling.catalog_once_closure_scan_cursors',N'U') IS NOT NULL
    THROW 55080,N'The rollback did not restore the QA fixture and trigger state.',1;
  EXEC sys.sp_set_session_context @key=N'portal_qa_once_step',@value=NULL;
  SELECT @passed AS passed,0 AS error_number,0 AS error_case,0 AS error_line,0 AS fixture_rows_remaining,
    @probeStage AS probe_stage,DATEDIFF_BIG(millisecond,@runStarted,SYSUTCDATETIME()) AS elapsed_ms;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  EXEC sys.sp_set_session_context @key=N'portal_qa_once_step',@value=NULL;
  SELECT @passed AS passed,ERROR_NUMBER() AS error_number,@step AS error_case,ERROR_LINE() AS error_line,
    (SELECT COUNT(*) FROM core.clients WHERE source_id=@tag) AS fixture_rows_remaining,
    @probeStage AS probe_stage,DATEDIFF_BIG(millisecond,@runStarted,SYSUTCDATETIME()) AS elapsed_ms;
END CATCH;
'@
$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
$response=(& $invoke -SessionDirectory $session -Sql ($prefix+[Environment]::NewLine+$body) -Mode write -TimeoutSeconds $SqlTimeoutSeconds -MaxRows 1) | ConvertFrom-Json -Depth 14
$sets=@($response.resultSets)
$row=if($sets.Count){$sets[-1].rows[0]}else{$null}
$expectedPassed=if($ProbeStage -eq 'all'){29}elseif($ProbeStage -eq 'bootstrap'){1}else{2}
if(!$response.success -or $row.passed -ne $expectedPassed -or $row.error_number -ne 0 -or $row.fixture_rows_remaining -ne 0){
  throw "QA once completion failed (SQL number: $([int]$row.error_number); case: $([int]$row.error_case); line: $([int]$row.error_line))."
}
$row | Select-Object passed,error_number,error_case,fixture_rows_remaining,probe_stage,elapsed_ms | ConvertTo-Json -Compress
