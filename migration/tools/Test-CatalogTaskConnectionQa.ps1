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
$registerQuery=(Get-Content -Raw -LiteralPath (Join-Path $root 'api/src/lib/catalogExecutionRegistrationSqlRepository.ts')).Split([char]96) |
  Where-Object { $_ -match '^\s*DECLARE @registryNow' } | Select-Object -First 1
if(!$registerQuery -or $registerQuery -notmatch 'INSERT workflow\.catalog_task_execution_links'){ throw 'Expected the guarded link registration batch.' }
$registerQuery=$registerQuery.Replace('${catalogDomainRouteFingerprintSql}',$routeHash)
$literal+="DECLARE @registerProbe nvarchar(max)=N'"+$registerQuery.Replace("'","''")+"';"
$fixture=@'
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF DB_NAME()<>N'PortalSAGWeb-TEST' OR @@TRANCOUNT<>0 THROW 53880,N'Wrong database or transaction.',1;
DECLARE @tag nvarchar(72)=N'qa-taskconn-'+LOWER(CONVERT(char(36),NEWID()));
DECLARE @stamp datetime2(3)=SYSUTCDATETIME(), @target bigint, @physical uniqueidentifier, @taskKey bigint, @execution bigint;
DECLARE @task nvarchar(150)=@tag+N'-task', @assigned nvarchar(150)=@tag+N'-assigned', @other nvarchar(150)=@tag+N'-broad';
DECLARE @a nvarchar(150)=@tag+N'-a-db', @b nvarchar(150)=@tag+N'-b-db';
DECLARE @sourceKey bigint,@origin uniqueidentifier,@customerKey bigint,@version smallint,@revision bigint,@lock int;
DECLARE @bindingVersion binary(8),@profileVersion binary(8);
DECLARE @operationalOwner bigint,@operationalLink bigint,@logicalLinkId uniqueidentifier=NEWID(),@wrongLinkId uniqueidentifier=NEWID();
DECLARE @canonicalLinkId varchar(36)=LOWER(CONVERT(char(36),@logicalLinkId));
DECLARE @params nvarchar(max)=N'@actor nvarchar(150), @db nvarchar(150), @task nvarchar(260), @environment varchar(10), @permission nvarchar(160)';
DECLARE @rows TABLE(serverHostPort nvarchar(500),initialCatalog nvarchar(256),userId nvarchar(256),secretName nvarchar(256),
  databaseId nvarchar(150),taskId nvarchar(260),linkId nvarchar(260),profileVersion varchar(16),linkVersion varchar(16),executionVersion varchar(16),
  catalogSourceId varchar(36),catalogRevisionId varchar(20),catalogBindingVersion varchar(16),catalogProfileVersion varchar(16),
  catalogVerifiedUntil datetime2(3));
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

  EXEC @lock=sys.sp_getapplock @Resource=N'portal-sag:catalog-customer-publication:qa',@LockMode=N'Exclusive',
    @LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock<0 THROW 53888,N'Could not reserve QA fixture publication.',1;
  SELECT @version=match_key_version FROM settings.catalog_match_key_registry WHERE portal_environment='qa';
  IF @version IS NULL
  BEGIN
    SET @version=1;
    INSERT settings.catalog_match_key_registry(portal_environment,match_key_version,vault_secret_version,key_verifier)
      VALUES('qa',@version,CONVERT(binary(16),NEWID()),HASHBYTES('SHA2_256',N'qa fixture, not a key'));
  END;
  INSERT settings.external_database_connections(source_id,display_name,server_host,database_name,login_name,
    password_configured,password_secret_name,created_by,updated_by)
    VALUES(@tag,@tag,N'fixture.invalid',N'synthetic',N'synthetic',1,N'fixture-no-key','fixture','fixture');
  INSERT settings.catalog_source_bindings(external_database_connection_key,display_name,source_role,portal_environment,
    contract_version,source_state,issuer_scope,validated_at,validated_profile_version,created_by,updated_by)
    SELECT external_database_connection_key,@tag,'erp-customers','qa','erp_v1','active','CO',@stamp,row_version,'fixture','fixture'
    FROM settings.external_database_connections WHERE source_id=@tag;
  SET @sourceKey=SCOPE_IDENTITY();
  SELECT @origin=source_id,@bindingVersion=row_version,@profileVersion=validated_profile_version
    FROM settings.catalog_source_bindings WHERE catalog_source_key=@sourceKey;
  INSERT core.catalog_customer_ids DEFAULT VALUES;
  SET @customerKey=SCOPE_IDENTITY();
  DECLARE @attempt bigint=9223372036854775790,@validUntil datetime2(3)=DATEADD(minute,3,@stamp);
  INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,match_key_version,
    attempt_ordinal,expected_rows,expected_scopes,observed_at,verified_until)
    VALUES(@sourceKey,'erp-customers',@bindingVersion,@profileVersion,@version,@attempt,2,0,@stamp,@validUntil);
  SET @revision=SCOPE_IDENTITY();
  INSERT core.catalog_customer_revision_rows(revision_key,source_role,source_record_id,catalog_customer_key,official_name,active_code)
    VALUES(@revision,'erp-customers',1,@customerKey,N'QA Fixture','S'),(@revision,'erp-customers',2,@customerKey,N'QA Fixture','N');
  UPDATE core.catalog_customer_source_revisions SET sealed_at=@stamp WHERE revision_key=@revision;
  INSERT settings.catalog_customer_revision_heads(catalog_source_key,attempt_status,attempted_at,attempt_ordinal)
    VALUES(@sourceKey,'failed',@stamp,@attempt-1);
  UPDATE workflow.catalog_task_execution_links SET link_id=@canonicalLinkId,catalog_source_key=@sourceKey,catalog_record_id=N'1' WHERE link_id=@b;
  INSERT @rows EXEC sys.sp_executesql @probe,@params,@assigned,@b,@task,'qa',N'updates.tasks.reveal_database_password';
  IF EXISTS(SELECT 1 FROM @rows) THROW 53894,N'A sealed but unpublished record authorized access after a failed attempt.',1;
  UPDATE settings.catalog_customer_revision_heads SET revision_key=@revision,attempt_status='succeeded',attempt_ordinal=@attempt
    WHERE catalog_source_key=@sourceKey;
  INSERT core.catalog_operational_owners(portal_environment,catalog_customer_key,client_key,registered_by)
    SELECT 'qa',@customerKey,client_key,N'fixture' FROM core.databases WHERE source_id=@b;
  SELECT @operationalOwner=owner_key FROM core.catalog_operational_owners
    WHERE portal_environment='qa' AND catalog_customer_key=@customerKey;
  INSERT core.catalog_operational_links(link_id,owner_key,portal_environment,client_key,domain_key,database_key,
    catalog_source_key,source_record_id,target_kind,link_environment,registered_by)
    SELECT @logicalLinkId,@operationalOwner,'qa',client_key,domain_key,database_key,@sourceKey,1,'database','test',N'fixture'
    FROM core.databases WHERE source_id=@b;
  SELECT @operationalLink=link_key FROM core.catalog_operational_links WHERE link_id=@logicalLinkId;
  INSERT @rows EXEC sys.sp_executesql @probe,@params,@assigned,@b,@task,'qa',N'updates.tasks.reveal_database_password';
  IF EXISTS(SELECT 1 FROM @rows) THROW 53910,N'Published ERP data exposed a task without its link approval.',1;
  -- Separate the actual registration and approval instants (datetime2(3)).
  WAITFOR DELAY '00:00:00.025';
  INSERT core.catalog_operational_link_approvals(link_key,binding_version,profile_version,revision_key,approval_reference,approved_by)
    VALUES(@operationalLink,@bindingVersion,@profileVersion,@revision,'QA-TASK-CONNECTION',N'fixture');
  INSERT @rows EXEC sys.sp_executesql @probe,@params,@assigned,@b,@task,'qa',N'updates.tasks.reveal_database_password';
  IF NOT EXISTS (SELECT 1 FROM @rows WHERE linkId=@canonicalLinkId AND catalogRevisionId=CONVERT(varchar(20),@revision)
    AND catalogVerifiedUntil=@validUntil) OR (SELECT COUNT(*) FROM @rows)<>1
    THROW 53889,N'Current exact approved ERP link did not authorize the assigned task.',1;
  DELETE FROM @rows;
  UPDATE workflow.catalog_task_execution_links SET catalog_record_id=N'2' WHERE link_id=@canonicalLinkId;
  INSERT @rows EXEC sys.sp_executesql @probe,@params,@assigned,@b,@task,'qa',N'updates.tasks.reveal_database_password';
  IF EXISTS(SELECT 1 FROM @rows) THROW 53890,N'Inactive ERP record authorized a grant.',1;
  UPDATE workflow.catalog_task_execution_links SET catalog_record_id=N'3' WHERE link_id=@canonicalLinkId;
  INSERT @rows EXEC sys.sp_executesql @probe,@params,@assigned,@b,@task,'qa',N'updates.tasks.reveal_database_password';
  IF EXISTS(SELECT 1 FROM @rows) THROW 53891,N'Missing ERP record authorized a grant.',1;

  DECLARE @wrongLinkText varchar(36)=LOWER(CONVERT(char(36),@wrongLinkId));
  UPDATE workflow.catalog_task_execution_links SET catalog_record_id=N'1',link_id=@wrongLinkText WHERE link_id=@canonicalLinkId;
  INSERT @rows EXEC sys.sp_executesql @probe,@params,@assigned,@b,@task,'qa',N'updates.tasks.reveal_database_password';
  IF EXISTS(SELECT 1 FROM @rows) THROW 53911,N'A different logical UUID authorized a grant.',1;
  UPDATE workflow.catalog_task_execution_links SET link_id=@canonicalLinkId,catalog_source_key=NULL WHERE link_id=@wrongLinkText;
  INSERT @rows EXEC sys.sp_executesql @probe,@params,@assigned,@b,@task,'qa',N'updates.tasks.reveal_database_password';
  IF EXISTS(SELECT 1 FROM @rows) THROW 53912,N'An external logical UUID authorized a local grant.',1;
  DELETE FROM @cutoffRows;
  INSERT @cutoffRows EXEC sys.sp_executesql @cutoffProbe,N'@env varchar(10),@execution varbinary(32)','qa',@executionHash;
  IF NOT EXISTS (SELECT 1 FROM @cutoffRows WHERE linkId=@canonicalLinkId AND validUntil IS NULL)
    THROW 53913,N'An external logical UUID was treated as local at cutoff.',1;
  UPDATE workflow.catalog_task_execution_links SET catalog_source_key=@sourceKey WHERE link_id=@canonicalLinkId;
  DELETE FROM @cutoffRows;
  INSERT @cutoffRows EXEC sys.sp_executesql @cutoffProbe,N'@env varchar(10),@execution varbinary(32)','qa',@executionHash;
  IF NOT EXISTS (SELECT 1 FROM @cutoffRows WHERE linkId=@canonicalLinkId AND validUntil=@validUntil)
    THROW 53914,N'The cutoff did not use the approved ERP link and earlier expiry.',1;
  DECLARE @approvalAt datetime2(3)=(SELECT approved_at FROM core.catalog_operational_link_approvals WHERE link_key=@operationalLink);
  DECLARE @beforeApproval datetime2(3)=DATEADD(millisecond,-1,@approvalAt);
  IF NOT EXISTS (SELECT 1 FROM core.catalog_operational_links WHERE link_key=@operationalLink AND registered_at<=@beforeApproval)
    THROW 53915,N'Fixture did not separate registration and approval timestamps.',1;
  UPDATE workflow.catalog_task_executions SET cutoff_at=@beforeApproval WHERE catalog_execution_key=@execution;
  DELETE FROM @cutoffRows;
  INSERT @cutoffRows EXEC sys.sp_executesql @cutoffProbe,N'@env varchar(10),@execution varbinary(32)','qa',@executionHash;
  IF NOT EXISTS (SELECT 1 FROM @cutoffRows WHERE linkId=@canonicalLinkId AND effectiveAt=@beforeApproval AND validUntil IS NULL)
    THROW 53916,N'An approval after cutoff was accepted retroactively.',1;
  UPDATE workflow.catalog_task_executions SET cutoff_at=DATEADD(minute,5,@stamp) WHERE catalog_execution_key=@execution;
  -- Replace this fixture-only execution alias with the one produced by the real registration batch.
  DELETE FROM workflow.catalog_task_execution_links WHERE catalog_execution_key=@execution AND link_id=@canonicalLinkId;

  -- Advance the same profile's sealed head so the negative revision probe is
  -- a genuine historical revision, not an arbitrary nonexistent number.
  DECLARE @staleRevision bigint=@revision,@currentAt datetime2(3)=SYSUTCDATETIME();
  SET @attempt+=1;
  INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,match_key_version,
    attempt_ordinal,expected_rows,expected_scopes,observed_at,verified_until)
    VALUES(@sourceKey,'erp-customers',@bindingVersion,@profileVersion,@version,@attempt,1,0,@currentAt,@validUntil);
  SET @revision=SCOPE_IDENTITY();
  INSERT core.catalog_customer_revision_rows(revision_key,source_role,source_record_id,catalog_customer_key,official_name,active_code)
    VALUES(@revision,'erp-customers',1,@customerKey,N'QA Fixture','S');
  UPDATE core.catalog_customer_source_revisions SET sealed_at=@currentAt WHERE revision_key=@revision;
  UPDATE settings.catalog_customer_revision_heads
    SET revision_key=@revision,attempt_status='succeeded',attempted_at=@currentAt,attempt_ordinal=@attempt
    WHERE catalog_source_key=@sourceKey;

  DECLARE @planned nvarchar(max),@record nvarchar(260)=N'1 ';
  DECLARE @currentRevision varchar(20)=CONVERT(varchar(20),@revision);
  DECLARE @registrationParams nvarchar(180)=N'@executionId bigint,@kind varchar(20),@portalEnvironment varchar(10),@physicalId uniqueidentifier,@links nvarchar(max)';
  DECLARE @accepted TABLE(linkId nvarchar(260),validUntil datetime2(3));
  SELECT @planned=(SELECT @canonicalLinkId AS linkId,@record AS recordId,db.source_id AS databaseId,
      c.source_id AS clientId,d.source_id AS domainId,LOWER(CONVERT(char(36),@origin)) AS catalogSourceId,'test' AS environment,
      @currentRevision AS revisionId,LOWER(CONVERT(char(16),@bindingVersion,2)) AS bindingVersion,
      LOWER(CONVERT(char(16),@profileVersion,2)) AS profileVersion
    FROM core.databases db JOIN core.domains d ON d.domain_key=db.domain_key JOIN core.clients c ON c.client_key=db.client_key
    WHERE db.source_id=@b FOR JSON PATH);
  INSERT @accepted EXEC sys.sp_executesql @registerProbe,@registrationParams,@execution,'database','qa',@physical,@planned;
  IF EXISTS(SELECT 1 FROM @accepted) THROW 53892,N'An inexact record was registered.',1;
  SET @planned=JSON_MODIFY(@planned,'$[0].recordId',N'1');
  SET @planned=JSON_MODIFY(@planned,'$[0].linkId',LOWER(CONVERT(char(36),@wrongLinkId)));
  INSERT @accepted EXEC sys.sp_executesql @registerProbe,@registrationParams,@execution,'database','qa',@physical,@planned;
  IF EXISTS(SELECT 1 FROM @accepted) THROW 53895,N'A different logical link ID was registered.',1;
  SET @planned=JSON_MODIFY(@planned,'$[0].linkId',@canonicalLinkId);
  SET @planned=JSON_MODIFY(@planned,'$[0].revisionId',CONVERT(varchar(20),@staleRevision));
  INSERT @accepted EXEC sys.sp_executesql @registerProbe,@registrationParams,@execution,'database','qa',@physical,@planned;
  IF EXISTS(SELECT 1 FROM @accepted) THROW 53896,N'A historical revision was accepted during registration.',1;
  SET @planned=JSON_MODIFY(@planned,'$[0].revisionId',@currentRevision);
  DECLARE @misclassified nvarchar(max)=JSON_MODIFY(@planned,'$[0].catalogSourceId',NULL);
  INSERT @accepted EXEC sys.sp_executesql @registerProbe,@registrationParams,@execution,'database','qa',@physical,@misclassified;
  IF EXISTS(SELECT 1 FROM @accepted) THROW 53897,N'An external logical link was accepted as local.',1;
  INSERT @accepted EXEC sys.sp_executesql @registerProbe,@registrationParams,@execution,'database','qa',@physical,@planned;
  IF (SELECT COUNT(*) FROM @accepted WHERE linkId=@canonicalLinkId AND validUntil=@validUntil)<>1
    THROW 53893,N'The registered link was not exact or did not inherit the earlier evidence expiry.',1;

  SAVE TRANSACTION fixtureProfile;
  UPDATE core.database_access_profiles SET sql_user_id=N'changed-fixture' WHERE source_id=@tag+N'-b-profile';
  INSERT @rows EXEC sys.sp_executesql @probe,@params,@assigned,@b,@task,'qa',N'updates.tasks.reveal_database_password';
  IF EXISTS(SELECT 1 FROM @rows) THROW 53884,N'A changed profile reused an earlier grant.',1;
  ROLLBACK TRANSACTION fixtureProfile;
  DECLARE @beforeRetirement datetime2(3)=SYSUTCDATETIME();
  WAITFOR DELAY '00:00:00.025';
  UPDATE core.catalog_operational_links SET retired_at=SYSUTCDATETIME() WHERE link_key=@operationalLink;
  INSERT @rows EXEC sys.sp_executesql @probe,@params,@assigned,@b,@task,'qa',N'updates.tasks.reveal_database_password';
  IF EXISTS(SELECT 1 FROM @rows) THROW 53917,N'A retired 042 link authorized a grant.',1;
  DELETE FROM @cutoffRows;
  INSERT @cutoffRows EXEC sys.sp_executesql @cutoffProbe,N'@env varchar(10),@execution varbinary(32)','qa',@executionHash;
  IF NOT EXISTS (SELECT 1 FROM @cutoffRows WHERE linkId=@canonicalLinkId AND validUntil IS NULL)
    THROW 53918,N'A retired 042 link remained verified for the current cutoff sweep.',1;
  UPDATE workflow.catalog_task_executions SET cutoff_at=@beforeRetirement WHERE catalog_execution_key=@execution;
  DELETE FROM @cutoffRows;
  INSERT @cutoffRows EXEC sys.sp_executesql @cutoffProbe,N'@env varchar(10),@execution varbinary(32)','qa',@executionHash;
  IF NOT EXISTS (SELECT 1 FROM @cutoffRows WHERE linkId=@canonicalLinkId AND effectiveAt=@beforeRetirement AND validUntil=@validUntil)
    THROW 53919,N'A retirement after cutoff erased earlier logical link evidence.',1;
  ROLLBACK TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
SELECT 25 AS passed,
  (SELECT COUNT(*) FROM workflow.update_tasks WHERE source_id=@task)
  +(SELECT COUNT(*) FROM security.users WHERE source_id IN (@assigned,@other))
  +(SELECT COUNT(*) FROM core.catalog_physical_targets WHERE target_id=@physical)
  +(SELECT COUNT(*) FROM settings.external_database_connections WHERE source_id=@tag)
  +(SELECT COUNT(*) FROM settings.catalog_source_bindings WHERE catalog_source_key=@sourceKey)
  +(SELECT COUNT(*) FROM core.catalog_customer_ids WHERE catalog_customer_key=@customerKey)
  +(SELECT COUNT(*) FROM core.catalog_customer_source_revisions WHERE catalog_source_key=@sourceKey)
  +(SELECT COUNT(*) FROM core.catalog_operational_owners WHERE owner_key=@operationalOwner)
  +(SELECT COUNT(*) FROM core.catalog_operational_links WHERE link_id IN (@logicalLinkId,@wrongLinkId))
  +(SELECT COUNT(*) FROM core.catalog_operational_link_approvals WHERE link_key=@operationalLink)
  +(SELECT COUNT(*) FROM workflow.catalog_task_execution_links WHERE catalog_execution_key=@execution) AS remaining_fixtures;
'@
$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
$response=(& $invoke -SessionDirectory $session -Sql ($literal + [Environment]::NewLine + $fixture) -Mode write -TimeoutSeconds 35 -MaxRows 1) | ConvertFrom-Json -Depth 16
$row=$response.resultSets[0].rows[0]
if(!$response.success -or $row.passed -ne 25 -or $row.remaining_fixtures -ne 0){
  $number=$response.error.number
  throw "QA connection, cutoff and registration rehearsal did not pass or left residual data (SQL error number: $number)."
}
$row | ConvertTo-Json -Compress
