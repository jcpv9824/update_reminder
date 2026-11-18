[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$SessionDirectory,
  [ValidateSet('all','bootstrap')][string]$ProbeStage='all',
  [ValidateRange(10,90)][int]$SqlTimeoutSeconds=60
)

$ErrorActionPreference='Stop'
$session=(Resolve-Path -LiteralPath $SessionDirectory).Path
$descriptor=Get-Content -Raw -LiteralPath (Join-Path $session 'active.json') | ConvertFrom-Json
if($descriptor.database -cne 'PortalSAGWeb-TEST' -or $descriptor.environment -cne 'qa' -or $descriptor.accessLevel -cne 'full-control'){
  throw 'This historical owner fixture requires the authorized full-control PortalSAGWeb-TEST session.'
}
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$compiled=Join-Path $root 'api/dist/src/lib/catalogTaskCutoffEvidenceSql.js'
$query=(& node -e 'const q=require(process.argv[1]).catalogTaskCutoffEvidenceSql;if(typeof q!=="string"||!q.trim())process.exit(1);process.stdout.write(q);' $compiled) -join [Environment]::NewLine
if($LASTEXITCODE -ne 0 -or !$query){throw 'Build the candidate cutoff evidence SQL export before this rehearsal.'}
$prefix="DECLARE @evidenceSql nvarchar(max)=N'"+$query.Replace("'","''")+"';DECLARE @probeStage varchar(12)='$ProbeStage';"

# This approved historical-owner fixture is NOT a source-publication, real
# network, task-mutation/HTTP or two-session race certificate. Only the four
# listed INSERT-stamping triggers are temporarily suspended while synthetic
# historical metadata is seeded. Restore them before any compiled query.
# Append-only UPDATE/DELETE guards remain enabled throughout.
$body=@'
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR @@TRANCOUNT<>0
  OR CAST(SERVERPROPERTY('ProductMajorVersion') AS int)<>15
  THROW 55170,N'Unexpected cutoff history QA target.',1;
DECLARE @headObject int=OBJECT_ID(N'settings.catalog_source_head_events',N'U'),
  @witnessObject int=OBJECT_ID(N'scheduling.catalog_once_source_witnesses',N'U'),
  @cursorObject int=OBJECT_ID(N'scheduling.catalog_once_closure_scan_cursors',N'U');
IF @headObject IS NULL OR @witnessObject IS NULL OR @cursorObject IS NULL
  THROW 55171,N'Install migration 050 before this isolated cutoff history rehearsal.',1;
IF EXISTS(SELECT 1 FROM settings.catalog_source_bindings WHERE portal_environment='qa' AND source_state='active')
  THROW 55172,N'This isolated rehearsal requires no active QA catalog binding.',1;
DECLARE @stamps table(trigger_name nvarchar(260) PRIMARY KEY);
INSERT @stamps VALUES(N'core.TR_catalog_operational_owner_register'),(N'core.TR_catalog_operational_link_register'),
  (N'core.TR_catalog_operational_approval_stamp'),(N'core.TR_catalog_physical_target_links_register');
IF (SELECT COUNT(*) FROM sys.triggers t JOIN @stamps s ON t.object_id=OBJECT_ID(s.trigger_name) WHERE t.is_disabled=0)<>4
  THROW 55173,N'All four reviewed INSERT-stamping triggers must initially be enabled.',1;
DECLARE @tag nvarchar(72)=N'qa-cutoff-history-'+LOWER(CONVERT(char(36),NEWID())),@step int=0,@passed int=0,
  @started datetime2(3)=SYSUTCDATETIME(),@now datetime2(3)=SYSUTCDATETIME();
DECLARE @day date=CONVERT(date,DATEADD(day,-1,DATEADD(hour,-5,@now))),@futureDay date=CONVERT(date,DATEADD(day,1,@now));
DECLARE @stamp datetime2(3)=DATEADD(hour,6,CONVERT(datetime2(3),@day)),
  @cutoff datetime2(3)=DATEADD(hour,5,DATEADD(day,1,CONVERT(datetime2(3),@day))),
  @futureCutoff datetime2(3)=DATEADD(hour,5,DATEADD(day,1,CONVERT(datetime2(3),@futureDay))),
  @externalUntil datetime2(3)=DATEADD(day,3,@now),@physicalUntil datetime2(3)=DATEADD(day,2,@now);
DECLARE @version smallint,@enrolledAt datetime2(3),@client bigint,@customer bigint,@owner bigint,@profile bigint,@profileVersion binary(8),@target bigint,
  @task bigint,@execution bigint,@futureTask bigint,@futureExecution bigint,@lock int;
DECLARE @digest binary(32)=HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag)),@futureDigest binary(32)=HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag+N'-future'));
DECLARE @expiredRevision bigint,@inactiveRevision bigint,@lateRevision bigint,@erp1 bigint,@erp2 bigint,
  @erp1Revision bigint,@erp2Revision bigint,@erp1Binding binary(8),@erp1Profile binary(8);
DECLARE @attempt1 bigint=9223372036854775761,@attempt2 bigint=9223372036854775762,
  @expiredAttempt bigint=9223372036854775763,@inactiveAttempt bigint=9223372036854775764,
  @lateAttempt bigint=9223372036854775765,@failedAttempt bigint=9223372036854775766;
IF EXISTS(SELECT 1 FROM core.catalog_customer_source_revisions WHERE attempt_ordinal IN(@attempt1,@attempt2,@expiredAttempt,@inactiveAttempt,@lateAttempt,@failedAttempt))
  OR EXISTS(SELECT 1 FROM settings.catalog_customer_revision_heads WHERE attempt_ordinal IN(@attempt1,@attempt2,@expiredAttempt,@inactiveAttempt,@lateAttempt,@failedAttempt))
  THROW 55173,N'Reserved historical fixture attempts are already present.',1;
DECLARE @edges table(n int PRIMARY KEY,link_id uniqueidentifier NOT NULL DEFAULT NEWID(),source_key bigint NULL,
  binding_version binary(8) NULL,profile_version binary(8) NULL,revision_key bigint NULL,domain_key bigint NULL,database_key bigint NULL);
DECLARE @proof table(linkId nvarchar(260),checkedAt datetime2(3),effectiveAt datetime2(3),validUntil datetime2(3) NULL);
DECLARE @case int=0,@expected int,@queryExecution binary(32),@isFuture bit;
BEGIN TRY
  EXEC sys.sp_set_session_context @key=N'portal_qa_cutoff_history_step',@value=@step;
  BEGIN TRANSACTION;
  EXEC @lock=sys.sp_getapplock @Resource=N'portal-sag:catalog-customer-publication:qa',@LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock<0 THROW 55174,N'Could not reserve the isolated QA catalog.',1;
  SET @step=1;
  EXEC sys.sp_set_session_context @key=N'portal_qa_cutoff_history_step',@value=@step;
  SELECT @version=match_key_version,@enrolledAt=enrolled_at FROM settings.catalog_match_key_registry WHERE portal_environment='qa';
  IF @version IS NULL
  BEGIN
    SET @version=1;
    INSERT settings.catalog_match_key_registry(portal_environment,match_key_version,vault_secret_version,key_verifier,enrolled_at)
      VALUES('qa',@version,CONVERT(binary(16),NEWID()),@digest,@stamp);
  END
  ELSE IF @enrolledAt>@cutoff THROW 55175,N'The existing QA key enrollment is newer than this historical fixture boundary.',1;
  DISABLE TRIGGER core.TR_catalog_operational_owner_register ON core.catalog_operational_owners;
  DISABLE TRIGGER core.TR_catalog_operational_link_register ON core.catalog_operational_links;
  DISABLE TRIGGER core.TR_catalog_operational_approval_stamp ON core.catalog_operational_link_approvals;
  DISABLE TRIGGER core.TR_catalog_physical_target_links_register ON core.catalog_physical_target_links;
  INSERT @edges(n) VALUES(1),(2);
  INSERT settings.external_database_connections(source_id,display_name,server_host,database_name,login_name,password_configured,password_secret_name,created_by,updated_by)
    SELECT @tag+N'-erp'+CONVERT(nvarchar(1),n),@tag+N'-erp'+CONVERT(nvarchar(1),n),N'fixture.invalid',N'synthetic',N'fixture',1,N'fixture-no-key',N'fixture',N'fixture' FROM @edges;
  INSERT settings.catalog_source_bindings(external_database_connection_key,display_name,source_role,portal_environment,
    contract_version,source_state,issuer_scope,validated_at,validated_profile_version,created_by,updated_by)
    SELECT external_database_connection_key,source_id,'erp-customers','qa','erp_v1','active',N'CO:NIT',@stamp,row_version,N'fixture',N'fixture'
    FROM settings.external_database_connections WHERE source_id IN(@tag+N'-erp1',@tag+N'-erp2');
  UPDATE e SET source_key=b.catalog_source_key,binding_version=b.row_version,profile_version=b.validated_profile_version
    FROM @edges e JOIN settings.catalog_source_bindings b ON b.display_name=@tag+N'-erp'+CONVERT(nvarchar(1),e.n);
  SELECT @erp1=source_key,@erp1Binding=binding_version,@erp1Profile=profile_version FROM @edges WHERE n=1;
  SELECT @erp2=source_key FROM @edges WHERE n=2;
  INSERT core.catalog_customer_ids DEFAULT VALUES;
  SET @customer=SCOPE_IDENTITY();
  INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,match_key_version,
    attempt_ordinal,expected_rows,expected_scopes,observed_at,verified_until,has_sag_inventory_evidence)
    SELECT source_key,'erp-customers',binding_version,profile_version,@version,CASE WHEN n=1 THEN @attempt1 ELSE @attempt2 END,
      1,0,@stamp,@externalUntil,0 FROM @edges;
  UPDATE e SET revision_key=r.revision_key FROM @edges e JOIN core.catalog_customer_source_revisions r
    ON r.catalog_source_key=e.source_key AND r.attempt_ordinal=CASE WHEN e.n=1 THEN @attempt1 ELSE @attempt2 END;
  SELECT @erp1Revision=revision_key FROM @edges WHERE n=1;
  SELECT @erp2Revision=revision_key FROM @edges WHERE n=2;
  INSERT core.catalog_customer_revision_rows(revision_key,source_role,source_record_id,catalog_customer_key,official_name,active_code,issuer,document_type,document_number_token)
    SELECT revision_key,'erp-customers',1,@customer,N'Synthetic official name','S','CO','NIT',@digest FROM @edges;
  UPDATE r SET sealed_at=@stamp FROM core.catalog_customer_source_revisions r JOIN @edges e ON e.revision_key=r.revision_key;
  INSERT settings.catalog_customer_revision_heads(catalog_source_key,revision_key,attempt_status,attempted_at,attempt_ordinal)
    SELECT source_key,revision_key,'succeeded',@stamp,CASE WHEN n=1 THEN @attempt1 ELSE @attempt2 END FROM @edges;
  -- Prepare alternate immutable revision facts; normal head updates are still
  -- protected by their ordinary publication guards in every test below.
  INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,match_key_version,
    attempt_ordinal,expected_rows,expected_scopes,observed_at,verified_until,has_sag_inventory_evidence)
    VALUES(@erp1,'erp-customers',@erp1Binding,@erp1Profile,@version,@expiredAttempt,1,0,@stamp,@cutoff,0),
      (@erp1,'erp-customers',@erp1Binding,@erp1Profile,@version,@inactiveAttempt,1,0,@stamp,@externalUntil,0),
      (@erp1,'erp-customers',@erp1Binding,@erp1Profile,@version,@lateAttempt,1,0,@now,@externalUntil,0);
  SELECT @expiredRevision=revision_key FROM core.catalog_customer_source_revisions WHERE attempt_ordinal=@expiredAttempt;
  SELECT @inactiveRevision=revision_key FROM core.catalog_customer_source_revisions WHERE attempt_ordinal=@inactiveAttempt;
  SELECT @lateRevision=revision_key FROM core.catalog_customer_source_revisions WHERE attempt_ordinal=@lateAttempt;
  INSERT core.catalog_customer_revision_rows(revision_key,source_role,source_record_id,catalog_customer_key,official_name,active_code,issuer,document_type,document_number_token)
    SELECT revision_key,'erp-customers',1,@customer,CASE WHEN attempt_ordinal=@lateAttempt THEN N'Renamed same stable identity' ELSE N'Synthetic official name' END,
      CASE WHEN attempt_ordinal=@inactiveAttempt THEN 'N' ELSE 'S' END,'CO','NIT',@digest
    FROM core.catalog_customer_source_revisions WHERE attempt_ordinal IN(@expiredAttempt,@inactiveAttempt,@lateAttempt);
  UPDATE core.catalog_customer_source_revisions SET sealed_at=observed_at WHERE attempt_ordinal IN(@expiredAttempt,@inactiveAttempt,@lateAttempt);
  INSERT core.clients(source_id,name,name_normalized,status,created_at,created_by,updated_at,updated_by)
    VALUES(@tag,@tag,@tag,'active',@stamp,N'fixture',@stamp,N'fixture');
  SET @client=SCOPE_IDENTITY();
  INSERT core.domains(source_id,client_key,domain_name,domain_name_normalized,environment_id,status,created_at,created_by,updated_at,updated_by)
    SELECT @tag+N'-d'+CONVERT(nvarchar(1),n),@client,N'https://'+@tag+N'-'+CONVERT(nvarchar(1),n)+N'.invalid/',
      N'https://'+@tag+N'-'+CONVERT(nvarchar(1),n)+N'.invalid/','test','active',@stamp,N'fixture',@stamp,N'fixture' FROM @edges;
  UPDATE e SET domain_key=d.domain_key FROM @edges e JOIN core.domains d ON d.source_id=@tag+N'-d'+CONVERT(nvarchar(1),e.n);
  INSERT core.database_access_profiles(source_id,server_host_port,initial_catalog,sql_user_id,password_secret_name,
    connection_fingerprint,created_at,created_by,updated_at,updated_by)
    VALUES(@tag+N'-profile',N'fixture.invalid,1433',N'synthetic',N'fixture',N'fixture-no-key',
      HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag+N'-profile')),@stamp,N'fixture',@stamp,N'fixture');
  SET @profile=SCOPE_IDENTITY();
  SELECT @profileVersion=row_version FROM core.database_access_profiles WHERE access_profile_key=@profile;
  INSERT core.databases(source_id,client_key,domain_key,access_profile_key,company_name,company_name_normalized,
    environment_id,status,created_at,created_by,updated_at,updated_by)
    SELECT @tag+N'-db'+CONVERT(nvarchar(1),n),@client,domain_key,@profile,@tag,@tag,'test','active',@stamp,N'fixture',@stamp,N'fixture' FROM @edges;
  UPDATE e SET database_key=db.database_key FROM @edges e JOIN core.databases db ON db.source_id=@tag+N'-db'+CONVERT(nvarchar(1),e.n);
  INSERT core.catalog_operational_owners(portal_environment,catalog_customer_key,client_key,registered_by,registered_at)
    VALUES('qa',@customer,@client,N'fixture',@stamp);
  SELECT @owner=owner_key FROM core.catalog_operational_owners WHERE portal_environment='qa' AND catalog_customer_key=@customer;
  INSERT core.catalog_operational_links(link_id,owner_key,portal_environment,client_key,domain_key,database_key,catalog_source_key,
    source_record_id,target_kind,link_environment,registered_by,registered_at)
    SELECT link_id,@owner,'qa',@client,domain_key,database_key,source_key,1,'database','test',N'fixture',@stamp FROM @edges;
  INSERT core.catalog_operational_link_approvals(link_key,binding_version,profile_version,revision_key,approval_reference,approved_by,approved_at)
    SELECT l.link_key,e.binding_version,e.profile_version,e.revision_key,'QA-CUTOFF-HISTORY',N'fixture',@stamp
    FROM core.catalog_operational_links l JOIN @edges e ON e.link_id=l.link_id;
  INSERT core.catalog_physical_targets(portal_environment,target_kind,identity_fingerprint,database_name_fingerprint,created_at)
    VALUES('qa','database',@digest,HASHBYTES('SHA2_256',CONVERT(varbinary(max),N'synthetic')),@stamp);
  SET @target=SCOPE_IDENTITY();
  INSERT core.catalog_physical_target_links(physical_target_key,portal_environment,target_kind,client_key,domain_key,database_key,
    access_profile_key,access_profile_version,proof_id,verified_by,verified_at,valid_until,registered_at)
    SELECT @target,'qa','database',@client,domain_key,database_key,@profile,@profileVersion,NEWID(),N'fixture',@stamp,@physicalUntil,@stamp FROM @edges;
  INSERT workflow.update_tasks(source_id,task_date,task_bucket,client_key,client_source_id,client_name_snapshot,domain_key,
    domain_source_id,domain_name_snapshot,target_type,target_source_id,target_name_snapshot,database_key,assigned_role,status,
    created_at,created_by,updated_at,updated_by)
    SELECT N'catalog-'+LOWER(CONVERT(char(64),@digest,2)),@day,'fixture',@client,@tag,@tag,e.domain_key,d.source_id,d.domain_name,
      'database',db.source_id,N'synthetic',e.database_key,N'super_admin','pending',@stamp,N'fixture',@stamp,N'fixture'
    FROM @edges e JOIN core.domains d ON d.domain_key=e.domain_key JOIN core.databases db ON db.database_key=e.database_key WHERE e.n=1;
  SET @task=SCOPE_IDENTITY();
  INSERT workflow.catalog_task_executions(task_key,execution_key,occurrence_id,execution_kind,verified_target_id,
    operation_id,initial_catalog_revision_id,cutoff_at,created_at)
    SELECT @task,@digest,CONVERT(nvarchar(10),@day,23),'database',LOWER(CONVERT(nvarchar(36),target_id)),N'fixture.cutoff',N'fixture',@cutoff,@stamp
    FROM core.catalog_physical_targets WHERE physical_target_key=@target;
  SET @execution=SCOPE_IDENTITY();
  INSERT workflow.update_tasks(source_id,task_date,task_bucket,client_key,client_source_id,client_name_snapshot,domain_key,
    domain_source_id,domain_name_snapshot,target_type,target_source_id,target_name_snapshot,database_key,assigned_role,status,
    created_at,created_by,updated_at,updated_by)
    SELECT N'catalog-'+LOWER(CONVERT(char(64),@futureDigest,2)),@futureDay,'fixture',@client,@tag,@tag,e.domain_key,d.source_id,d.domain_name,
      'database',db.source_id,N'synthetic',e.database_key,N'super_admin','pending',@stamp,N'fixture',@stamp,N'fixture'
    FROM @edges e JOIN core.domains d ON d.domain_key=e.domain_key JOIN core.databases db ON db.database_key=e.database_key WHERE e.n=1;
  SET @futureTask=SCOPE_IDENTITY();
  INSERT workflow.catalog_task_executions(task_key,execution_key,occurrence_id,execution_kind,verified_target_id,
    operation_id,initial_catalog_revision_id,cutoff_at,created_at)
    SELECT @futureTask,@futureDigest,CONVERT(nvarchar(10),@futureDay,23),'database',LOWER(CONVERT(nvarchar(36),target_id)),N'fixture.cutoff',N'fixture',@futureCutoff,@stamp
    FROM core.catalog_physical_targets WHERE physical_target_key=@target;
  SET @futureExecution=SCOPE_IDENTITY();
  INSERT workflow.catalog_task_execution_links(catalog_execution_key,execution_kind,link_id,catalog_source_key,catalog_record_id,
    client_key,domain_key,database_key,link_environment,created_at)
    SELECT execution_key,'database',LOWER(CONVERT(nvarchar(36),e.link_id)),e.source_key,N'1',@client,e.domain_key,e.database_key,'test',@stamp
    FROM @edges e CROSS JOIN (SELECT @execution AS execution_key UNION ALL SELECT @futureExecution) x;
  ENABLE TRIGGER core.TR_catalog_operational_owner_register ON core.catalog_operational_owners;
  ENABLE TRIGGER core.TR_catalog_operational_link_register ON core.catalog_operational_links;
  ENABLE TRIGGER core.TR_catalog_operational_approval_stamp ON core.catalog_operational_link_approvals;
  ENABLE TRIGGER core.TR_catalog_physical_target_links_register ON core.catalog_physical_target_links;
  IF EXISTS(SELECT 1 FROM sys.triggers t JOIN @stamps s ON t.object_id=OBJECT_ID(s.trigger_name) WHERE t.is_disabled=1)
    THROW 55176,N'The historical seed did not restore every INSERT stamp.',1;
  IF @probeStage='bootstrap'
  BEGIN
    SET @passed+=1;
    GOTO FinishFixture;
  END;
  SET @step=2;
  EXEC sys.sp_set_session_context @key=N'portal_qa_cutoff_history_step',@value=@step;
  -- Newly recorded current heads are not evidence of their past availability.
  INSERT @proof EXEC sys.sp_executesql @evidenceSql,N'@env varchar(10),@execution varbinary(32)','qa',@digest;
  IF (SELECT COUNT(*) FROM @proof)<>2 OR EXISTS(SELECT 1 FROM @proof WHERE validUntil IS NOT NULL)
    THROW 55177,N'Current/baseline heads fabricated missing past-boundary evidence.',1;
  SET @passed+=1;
  -- Historical owner facts are explicit fixture inputs, not backdated publication.
  INSERT settings.catalog_source_head_events(catalog_source_key,revision_key,attempt_ordinal,attempt_status,attempted_at,recorded_at)
    VALUES(@erp2,@erp2Revision,@attempt2,'succeeded',@stamp,@stamp);
  DELETE FROM @proof;
  INSERT @proof EXEC sys.sp_executesql @evidenceSql,N'@env varchar(10),@execution varbinary(32)','qa',@digest;
  IF (SELECT COUNT(*) FROM @proof)<>2 OR (SELECT COUNT(*) FROM @proof WHERE validUntil IS NOT NULL)<>1
    THROW 55177,N'The healthy independent source did not survive missing evidence for its sibling.',1;
  SET @passed+=1;
  INSERT settings.catalog_source_head_events(catalog_source_key,revision_key,attempt_ordinal,attempt_status,attempted_at,recorded_at)
    VALUES(@erp1,@erp1Revision,@attempt1,'succeeded',@stamp,@stamp);
  SET @case=0;
  WHILE @case<=13
  BEGIN
    SET @step=10+@case;
    EXEC sys.sp_set_session_context @key=N'portal_qa_cutoff_history_step',@value=@step;
    SAVE TRANSACTION scenario;
    SET @isFuture=CASE WHEN @case IN(11,12,13) THEN 1 ELSE 0 END;
    SET @queryExecution=CASE WHEN @isFuture=1 THEN @futureDigest ELSE @digest END;
    SET @expected=CASE WHEN @case IN(0,1,2,11,13) THEN 2 WHEN @case=8 THEN 0 ELSE 1 END;
    IF @case IN(1,13) UPDATE settings.catalog_customer_revision_heads SET revision_key=@lateRevision,
      attempted_at=SYSUTCDATETIME(),attempt_ordinal=@lateAttempt WHERE catalog_source_key=@erp1;
    IF @case IN(2,12) UPDATE settings.catalog_customer_revision_heads SET attempt_status='failed',
      attempted_at=SYSUTCDATETIME(),attempt_ordinal=@failedAttempt WHERE catalog_source_key=@erp1;
    IF @case=3 INSERT settings.catalog_source_head_events(catalog_source_key,revision_key,attempt_ordinal,attempt_status,attempted_at,recorded_at)
      VALUES(@erp1,@erp1Revision,@failedAttempt,'failed',DATEADD(millisecond,-1,@cutoff),DATEADD(millisecond,-1,@cutoff));
    IF @case=4 INSERT settings.catalog_source_head_events(catalog_source_key,revision_key,attempt_ordinal,attempt_status,attempted_at,recorded_at)
      VALUES(@erp1,NULL,NULL,'never',NULL,DATEADD(millisecond,-1,@cutoff));
    IF @case=5 INSERT settings.catalog_source_head_events(catalog_source_key,revision_key,attempt_ordinal,attempt_status,attempted_at,recorded_at)
      VALUES(@erp1,@erp1Revision,@failedAttempt,'failed',@cutoff,@cutoff);
    IF @case=6 INSERT settings.catalog_source_head_events(catalog_source_key,revision_key,attempt_ordinal,attempt_status,attempted_at,recorded_at)
      VALUES(@erp1,@expiredRevision,@expiredAttempt,'succeeded',@stamp,DATEADD(millisecond,-1,@cutoff));
    IF @case=7 UPDATE settings.external_database_connections SET display_name=N'Changed source profile'
      WHERE external_database_connection_key=(SELECT external_database_connection_key FROM settings.catalog_source_bindings WHERE catalog_source_key=@erp1);
    IF @case=8 UPDATE core.database_access_profiles SET sql_user_id=N'changed-fixture' WHERE access_profile_key=@profile;
    IF @case=9 UPDATE d SET status='inactive' FROM core.domains d JOIN @edges e ON e.domain_key=d.domain_key WHERE e.n=1;
    IF @case=10 INSERT settings.catalog_source_head_events(catalog_source_key,revision_key,attempt_ordinal,attempt_status,attempted_at,recorded_at)
      VALUES(@erp1,@inactiveRevision,@inactiveAttempt,'succeeded',@stamp,DATEADD(millisecond,-1,@cutoff));
    DELETE FROM @proof;
    INSERT @proof EXEC sys.sp_executesql @evidenceSql,N'@env varchar(10),@execution varbinary(32)','qa',@queryExecution;
    IF (SELECT COUNT(*) FROM @proof)<>2 OR (SELECT COUNT(DISTINCT linkId) FROM @proof)<>2
      OR (SELECT COUNT(*) FROM @proof WHERE validUntil IS NOT NULL)<>@expected
      THROW 55178,N'Unexpected source-history cutoff decision for synthetic alias pair.',1;
    IF EXISTS(SELECT 1 FROM @proof WHERE validUntil IS NOT NULL AND validUntil<>@physicalUntil)
      THROW 55178,N'The proof did not preserve the earliest physical/source expiry.',1;
    IF (SELECT MIN(checkedAt) FROM @proof)<>(SELECT MAX(checkedAt) FROM @proof)
      OR EXISTS(SELECT 1 FROM @proof WHERE (@isFuture=0 AND (checkedAt<@cutoff OR effectiveAt<>@cutoff))
        OR (@isFuture=1 AND (checkedAt>=@futureCutoff OR effectiveAt<>checkedAt)))
      THROW 55178,N'The proof used an inconsistent SQL-clock boundary.',1;
    ROLLBACK TRANSACTION scenario;
    SET @passed+=1;
    SET @case+=1;
  END;
FinishFixture:
  ROLLBACK TRANSACTION;
  IF EXISTS(SELECT 1 FROM sys.triggers t JOIN @stamps s ON t.object_id=OBJECT_ID(s.trigger_name) WHERE t.is_disabled=1)
    OR EXISTS(SELECT 1 FROM core.clients WHERE source_id=@tag)
    OR EXISTS(SELECT 1 FROM core.databases WHERE source_id IN(@tag+N'-db1',@tag+N'-db2'))
    OR EXISTS(SELECT 1 FROM core.database_access_profiles WHERE source_id=@tag+N'-profile')
    OR EXISTS(SELECT 1 FROM settings.external_database_connections WHERE source_id IN(@tag+N'-erp1',@tag+N'-erp2'))
    OR EXISTS(SELECT 1 FROM workflow.catalog_task_executions WHERE execution_key IN(@digest,@futureDigest))
    OR EXISTS(SELECT 1 FROM settings.catalog_source_head_events WHERE catalog_source_key IN(@erp1,@erp2))
    OR OBJECT_ID(N'settings.catalog_source_head_events',N'U')<>@headObject
    OR OBJECT_ID(N'scheduling.catalog_once_source_witnesses',N'U')<>@witnessObject
    OR OBJECT_ID(N'scheduling.catalog_once_closure_scan_cursors',N'U')<>@cursorObject
    THROW 55179,N'The cutoff history rollback did not preserve objects, stamps and zero fixture rows.',1;
  EXEC sys.sp_set_session_context @key=N'portal_qa_cutoff_history_step',@value=NULL;
  SELECT @passed AS passed,0 AS error_number,0 AS error_case,0 AS error_line,0 AS fixture_rows_remaining,
    @probeStage AS probe_stage,DATEDIFF_BIG(millisecond,@started,SYSUTCDATETIME()) AS elapsed_ms;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  EXEC sys.sp_set_session_context @key=N'portal_qa_cutoff_history_step',@value=NULL;
  SELECT @passed AS passed,ERROR_NUMBER() AS error_number,@step AS error_case,ERROR_LINE() AS error_line,
    (SELECT COUNT(*) FROM core.clients WHERE source_id=@tag) AS fixture_rows_remaining,
    @probeStage AS probe_stage,DATEDIFF_BIG(millisecond,@started,SYSUTCDATETIME()) AS elapsed_ms;
END CATCH;
'@
$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
$response=(& $invoke -SessionDirectory $session -Sql ($prefix+[Environment]::NewLine+$body) -Mode write -TimeoutSeconds $SqlTimeoutSeconds -MaxRows 1) | ConvertFrom-Json -Depth 14
$sets=@($response.resultSets)
$row=if($sets.Count){$sets[-1].rows[0]}else{$null}
$expectedPassed=if($ProbeStage -eq 'bootstrap'){1}else{16}
if(!$response.success -or $row.passed -ne $expectedPassed -or $row.error_number -ne 0 -or $row.fixture_rows_remaining -ne 0){
  throw "QA cutoff history failed (SQL number: $([int]$row.error_number); case: $([int]$row.error_case); line: $([int]$row.error_line))."
}
$row | Select-Object passed,error_number,error_case,fixture_rows_remaining,probe_stage,elapsed_ms | ConvertTo-Json -Compress
