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
  throw 'The queue rehearsal requires an authorized full-control PortalSAGWeb-TEST session.'
}
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$migration=Join-Path $root 'migration/sql/051_catalog_refresh_queue.sql'
if((Get-FileHash -LiteralPath $migration -Algorithm SHA256).Hash -cne 'F2428DE9520B288F09D91130F2DA4A86DFBE779941E2888C3F3CBF2ADEA5B2F3'){
  throw 'Migration 051 differs from the reviewed LF artifact.'
}
$queue=Join-Path $root 'api/dist/src/lib/catalogRefreshQueueSqlRepository.js'
$publisher=Join-Path $root 'api/dist/src/lib/catalogCustomerSnapshotPublishSqlRepository.js'
$export=(& node -e 'const q=require(process.argv[1]).catalogRefreshQueueSqlBatches;const p=require(process.argv[2]).catalogRefreshWorkerPublicationSqlBatches;process.stdout.write(JSON.stringify({q,p}));' $queue $publisher) -join [Environment]::NewLine
if($LASTEXITCODE -ne 0 -or !$export){throw 'Build the reviewed API before rehearsing its exact SQL exports.'}
$batches=$export | ConvertFrom-Json
$prefix="DECLARE @probe varchar(12)='$ProbeStage';`n"
foreach($group in @(@{value=$batches.q;prefix='q'},@{value=$batches.p;prefix='p'})){
  foreach($property in $group.value.PSObject.Properties){
    if($property.Name -notmatch '^[A-Za-z]+$' -or $property.Value -isnot [string]){throw 'Unexpected SQL export contract.'}
    $prefix+="DECLARE @$($group.prefix)$($property.Name) nvarchar(max)=N'"+$property.Value.Replace("'","''")+"';`n"
  }
}
$prefix+="DECLARE @migration nvarchar(max)=N'"+(Get-Content -LiteralPath $migration -Raw).Replace("'","''")+"';`n"
# Synthetic Portal metadata only. No source credentials, external connections,
# human-worker impersonation, disabled triggers, or persistent fixture writes.
# Direct compiled batches exercise SQL fences, not the JS transaction/audit
# writer or a genuine two-session concurrency/network/cancellation certificate.
$body=@'
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR @@TRANCOUNT<>0
  OR CAST(SERVERPROPERTY('ProductMajorVersion') AS int)<>15
  OR (SELECT compatibility_level FROM sys.databases WHERE database_id=DB_ID())<>150
  THROW 55180,N'Unexpected queue QA target.',1;
DECLARE @headObject int=OBJECT_ID(N'settings.catalog_source_head_events',N'U');
IF @headObject IS NULL OR OBJECT_ID(N'settings.catalog_source_refresh_jobs',N'U') IS NOT NULL
  OR OBJECT_ID(N'settings.catalog_source_refresh_attempts',N'U') IS NOT NULL
  OR EXISTS(SELECT 1 FROM settings.catalog_source_bindings WHERE portal_environment='qa' AND source_state='active')
  OR EXISTS(SELECT 1 FROM settings.catalog_match_key_registry WHERE portal_environment='qa')
  THROW 55181,N'Requires installed050, absent051, no active QA source and no QA key enrollment.',1;
DECLARE @tag nvarchar(72)=N'qa-refresh-'+LOWER(CONVERT(char(36),NEWID())),@started datetime2(3)=SYSUTCDATETIME(),@step int=0,
  @now datetime2(3)=SYSUTCDATETIME(),@actorKey bigint,@lock int,@worker uniqueidentifier=NEWID(),
  @fakeVersion binary(16)=CONVERT(binary(16),NEWID()),@fakeVerifier binary(32)=HASHBYTES('SHA2_256',CONVERT(binary(16),NEWID()));
DECLARE @cases table(name varchar(100) PRIMARY KEY);
DECLARE @sources table(n int PRIMARY KEY,k bigint,id uniqueidentifier,b binary(8),p binary(8),profile_key bigint);
DECLARE @enqueue table(allowed bit,coalesced int,accepted int);
DECLARE @due table(enqueued int);
DECLARE @claims table(jobId uniqueidentifier,workerId uniqueidentifier,leaseToken uniqueidentifier,attempt tinyint,sourceId uniqueidentifier,
  environment varchar(10),bindingRevision binary(8),profileRevision binary(8),matchKeyVersion smallint);
DECLARE @auth table(allowed int,attemptOrdinal varchar(19));
DECLARE @ordinalResult table(attemptOrdinal varchar(19));
DECLARE @done table(completed bit);
DECLARE @publication table(result varchar(11));
DECLARE @source uniqueidentifier,@binding binary(8),@profile binary(8),@job uniqueidentifier,@token uniqueidentifier,@attempt tinyint,
  @ordinal varchar(19),@otherOrdinal varchar(19),@bad uniqueidentifier,@badProfile binary(8),@badVerifier binary(32),@badVersion binary(16),
  @beforeJobs int,@beforeHistory int,@jobKey bigint,@sourceKey bigint,@i int,@expected int;
DECLARE @enqueueParams nvarchar(max)=N'@actorId nvarchar(150),@sourceIds nvarchar(max),@environment varchar(10),@matchKeyVersion smallint,@includeSag bit',
  @configParams nvarchar(max)=N'@environment varchar(10),@matchKeyVersion smallint,@includeSag bit',
  @claimParams nvarchar(max)=N'@environment varchar(10),@matchKeyVersion smallint,@includeSag bit,@workerId uniqueidentifier,@count tinyint',
  @fenceParams nvarchar(max)=N'@environment varchar(10),@source uniqueidentifier,@binding varbinary(8),@profile varbinary(8),@currentKeyVersion smallint,@jobId uniqueidentifier,@workerId uniqueidentifier,@leaseToken uniqueidentifier,@jobAttempt tinyint',
  @authParams nvarchar(max),@completeParams nvarchar(max),@publishCompleteParams nvarchar(max),@selection nvarchar(max);
SET @authParams=@fenceParams+N',@vaultSecretVersion varbinary(16),@keyVerifier varbinary(32)';
SET @completeParams=@fenceParams+N',@outcome varchar(12)';
SET @publishCompleteParams=@completeParams+N',@reservedOrdinal varchar(19)';
BEGIN TRY
  BEGIN TRANSACTION;
  EXEC @lock=sys.sp_getapplock @Resource=N'portal-sag:catalog-customer-publication:qa',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=5000;
  IF @lock<0 THROW 55182,N'QA catalog lock unavailable.',1;
  EXEC sys.sp_executesql @migration;
  EXEC sys.sp_executesql @migration;
  IF (SELECT COUNT(*) FROM sys.tables WHERE object_id IN(OBJECT_ID(N'settings.catalog_source_refresh_jobs'),OBJECT_ID(N'settings.catalog_source_refresh_attempts')))<>2
    OR (SELECT COUNT(*) FROM sys.triggers WHERE object_id=OBJECT_ID(N'settings.tr_catalog_source_refresh_attempts_immutable') AND is_disabled=0)<>1
    OR (SELECT COUNT(*) FROM sys.indexes WHERE object_id=OBJECT_ID(N'settings.catalog_source_refresh_jobs') AND name IN
      (N'UX_catalog_source_refresh_jobs_open',N'IX_catalog_source_refresh_jobs_claim',N'IX_catalog_source_refresh_jobs_latest'))<>3
    OR (SELECT COUNT(*) FROM sys.foreign_keys WHERE parent_object_id IN(OBJECT_ID(N'settings.catalog_source_refresh_jobs'),OBJECT_ID(N'settings.catalog_source_refresh_attempts')))<>2
    OR (SELECT COUNT(*) FROM sys.check_constraints WHERE parent_object_id IN(OBJECT_ID(N'settings.catalog_source_refresh_jobs'),OBJECT_ID(N'settings.catalog_source_refresh_attempts')) AND is_disabled=0 AND is_not_trusted=0)<>8
    THROW 55183,N'051 apply/reapply metadata mismatch.',1;
  IF (SELECT COUNT(*) FROM sys.database_permissions p JOIN (VALUES
      (OBJECT_ID(N'settings.catalog_source_refresh_jobs'),'SELECT','G'),(OBJECT_ID(N'settings.catalog_source_refresh_jobs'),'INSERT','G'),
      (OBJECT_ID(N'settings.catalog_source_refresh_jobs'),'UPDATE','G'),(OBJECT_ID(N'settings.catalog_source_refresh_jobs'),'DELETE','D'),
      (OBJECT_ID(N'settings.catalog_source_refresh_attempts'),'SELECT','G'),(OBJECT_ID(N'settings.catalog_source_refresh_attempts'),'INSERT','G'),
      (OBJECT_ID(N'settings.catalog_source_refresh_attempts'),'UPDATE','D'),(OBJECT_ID(N'settings.catalog_source_refresh_attempts'),'DELETE','D')
    ) wanted(object_id,permission_name,state) ON p.major_id=wanted.object_id AND p.permission_name=wanted.permission_name AND p.state=wanted.state
    WHERE p.class=1 AND p.minor_id=0 AND p.grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime'))<>8
    THROW 55183,N'051 runtime object permission metadata mismatch.',1;
  INSERT @cases VALUES('051 apply/reapply metadata');
  IF @probe='bootstrap' GOTO Finish;
  SET @step=1; EXEC sys.sp_set_session_context @key=N'portal_qa_refresh_step',@value=@step;
  INSERT settings.catalog_match_key_registry(portal_environment,match_key_version,vault_secret_version,key_verifier)
    VALUES('qa',1,@fakeVersion,@fakeVerifier);
  INSERT security.users(source_id,display_name,email,email_normalized,active,created_at,created_by,updated_at,updated_by)
    VALUES(@tag,@tag,@tag+N'@invalid.example',@tag+N'@invalid.example',1,@now,N'fixture',@now,N'fixture');
  SELECT @actorKey=user_key FROM security.users WHERE source_id=@tag;
  INSERT settings.external_database_connections(source_id,display_name,server_host,database_name,login_name,password_configured,password_secret_name,created_by,updated_by)
    SELECT @tag+N'-'+CONVERT(nvarchar(1),n),@tag+N'-'+CONVERT(nvarchar(1),n),N'fixture.invalid',N'synthetic',N'fixture',1,N'fixture-no-secret',N'fixture',N'fixture'
    FROM (VALUES(1),(2),(3)) v(n);
  INSERT settings.catalog_source_bindings(external_database_connection_key,display_name,source_role,portal_environment,
    contract_version,source_state,issuer_scope,validated_at,validated_profile_version,created_by,updated_by)
    SELECT external_database_connection_key,source_id,CASE WHEN source_id=@tag+N'-3' THEN 'sag-admin' ELSE 'erp-customers' END,'qa',
      CASE WHEN source_id=@tag+N'-3' THEN 'sag_admin_v1' ELSE 'erp_v1' END,'active',CASE WHEN source_id<>@tag+N'-3' THEN N'CO:NIT' END,
      @now,row_version,N'fixture',N'fixture' FROM settings.external_database_connections WHERE source_id IN(@tag+N'-1',@tag+N'-2',@tag+N'-3');
  INSERT @sources SELECT v.n,b.catalog_source_key,b.source_id,b.row_version,p.row_version,p.external_database_connection_key
    FROM (VALUES(1),(2),(3)) v(n) JOIN settings.external_database_connections p ON p.source_id=@tag+N'-'+CONVERT(nvarchar(1),v.n)
    JOIN settings.catalog_source_bindings b ON b.external_database_connection_key=p.external_database_connection_key;
  INSERT security.catalog_source_readers(user_key,catalog_source_key,granted_by) SELECT @actorKey,k,N'fixture' FROM @sources WHERE n=1;
  INSERT @enqueue EXEC sys.sp_executesql @qenqueueRequest,@enqueueParams,@tag,N'[]','qa',1,1;
  IF NOT EXISTS(SELECT 1 FROM @enqueue WHERE allowed=1 AND accepted=0 AND coalesced=0) OR EXISTS(SELECT 1 FROM settings.catalog_source_refresh_jobs)
    THROW 55184,N'Explicit empty selection became all sources.',1;
  INSERT @cases VALUES('empty selection includes no hidden dependency'); DELETE @enqueue;
  SELECT @selection=N'["'+CONVERT(nvarchar(36),MIN(CASE WHEN n=1 THEN CONVERT(char(36),id) END))+N'","'+CONVERT(nvarchar(36),MIN(CASE WHEN n=2 THEN CONVERT(char(36),id) END))+N'"]' FROM @sources;
  INSERT @enqueue EXEC sys.sp_executesql @qenqueueRequest,@enqueueParams,@tag,@selection,'qa',1,1;
  IF NOT EXISTS(SELECT 1 FROM @enqueue WHERE allowed=0 AND accepted=0) OR EXISTS(SELECT 1 FROM settings.catalog_source_refresh_jobs)
    THROW 55184,N'Forged selection partially enqueued.',1;
  INSERT @cases VALUES('forged source denied atomically'); DELETE @enqueue;
  SELECT @selection=N'["'+CONVERT(nvarchar(36),id)+N'"]' FROM @sources WHERE n=1;
  INSERT @enqueue EXEC sys.sp_executesql @qenqueueRequest,@enqueueParams,@tag,@selection,'qa',1,1;
  IF NOT EXISTS(SELECT 1 FROM @enqueue WHERE allowed=1 AND accepted=1 AND coalesced=0)
    OR (SELECT COUNT(*) FROM settings.catalog_source_refresh_jobs)<>2 THROW 55184,N'Scoped enqueue/dependency mismatch.',1;
  INSERT @cases VALUES('scoped enqueue plus hidden SAG'); DELETE @enqueue;
  INSERT @enqueue EXEC sys.sp_executesql @qenqueueRequest,@enqueueParams,@tag,@selection,'qa',1,1;
  IF NOT EXISTS(SELECT 1 FROM @enqueue WHERE accepted=0 AND coalesced=1) OR (SELECT COUNT(*) FROM settings.catalog_source_refresh_jobs)<>2
    THROW 55184,N'Open request did not coalesce.',1;
  INSERT @cases VALUES('coalesced request');
  SELECT 'status-visible' AS fixture_status_case;
  EXEC sys.sp_executesql @qstatus,N'@actorId nvarchar(150),@sourceIds nvarchar(max),@environment varchar(10),@includeSag bit',@tag,@selection,'qa',1;
  UPDATE security.catalog_source_readers SET revoked_at=SYSUTCDATETIME(),revoked_by=N'fixture' WHERE user_key=@actorKey;
  SELECT 'status-revoked' AS fixture_status_case;
  EXEC sys.sp_executesql @qstatus,N'@actorId nvarchar(150),@sourceIds nvarchar(max),@environment varchar(10),@includeSag bit',@tag,@selection,'qa',1;
  UPDATE security.catalog_source_readers SET revoked_at=NULL,revoked_by=NULL WHERE user_key=@actorKey;
  INSERT security.catalog_source_readers(user_key,catalog_source_key,granted_by) SELECT @actorKey,k,N'fixture' FROM @sources WHERE n=2;
  DELETE @enqueue; INSERT @enqueue EXEC sys.sp_executesql @qenqueueRequest,@enqueueParams,@tag,NULL,'qa',1,1;
  IF NOT EXISTS(SELECT 1 FROM @enqueue WHERE accepted=1 AND coalesced=1) OR (SELECT COUNT(*) FROM settings.catalog_source_refresh_jobs)<>3
    THROW 55184,N'All-source authorized scope mismatch.',1;
  INSERT @cases VALUES('undefined means all authorized ERP');
  SET @step=2; EXEC sys.sp_set_session_context @key=N'portal_qa_refresh_step',@value=@step;
  INSERT @claims EXEC sys.sp_executesql @qclaim,@claimParams,'qa',1,1,@worker,2;
  IF (SELECT COUNT(*) FROM @claims)<>2 THROW 55185,N'Claim bound mismatch.',1;
  INSERT @claims EXEC sys.sp_executesql @qclaim,@claimParams,'qa',1,1,@worker,2;
  IF (SELECT COUNT(*) FROM @claims)<>3 OR (SELECT COUNT(DISTINCT sourceId) FROM @claims)<>3 OR EXISTS(SELECT 1 FROM @claims WHERE attempt<>1)
    THROW 55185,N'Claims duplicated or starved another source.',1;
  INSERT @claims EXEC sys.sp_executesql @qclaim,@claimParams,'qa',1,1,@worker,2;
  IF (SELECT COUNT(*) FROM @claims)<>3 THROW 55185,N'Active claim was reclaimed.',1;
  INSERT @cases VALUES('bounded independent claims and no active replay');
  SELECT @source=c.sourceId,@binding=c.bindingRevision,@profile=c.profileRevision,@job=c.jobId,@token=c.leaseToken,@attempt=c.attempt
    FROM @claims c JOIN @sources s ON s.id=c.sourceId WHERE s.n=1;
  SELECT @sourceKey=k FROM @sources WHERE n=1;
  SELECT @jobKey=job_key FROM settings.catalog_source_refresh_jobs WHERE job_id=@job;
  INSERT @auth EXEC sys.sp_executesql @pauthorize,@authParams,'qa',@source,@binding,@profile,1,@job,@worker,@token,@attempt,@fakeVersion,@fakeVerifier;
  IF (SELECT COUNT(*) FROM @auth)<>1 THROW 55186,N'Valid worker proof denied.',1;
  INSERT @cases VALUES('worker lease and synthetic key proof accepted'); DELETE @auth;
  SET @i=1;
  WHILE @i<=7
  BEGIN
    SET @bad=CASE WHEN @i=1 THEN NEWID() ELSE @token END;
    SET @badProfile=CASE WHEN @i=4 THEN 0xFFFFFFFFFFFFFFFF ELSE @profile END;
    SET @badVersion=CASE WHEN @i=5 THEN 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF ELSE @fakeVersion END;
    SET @badVerifier=CASE WHEN @i=6 THEN 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF ELSE @fakeVerifier END;
    DECLARE @testAttempt tinyint=CASE WHEN @i=2 THEN 2 ELSE @attempt END,@testWorker uniqueidentifier=CASE WHEN @i=3 THEN NEWID() ELSE @worker END,
      @testKey smallint=CASE WHEN @i=7 THEN 2 ELSE 1 END;
    INSERT @auth EXEC sys.sp_executesql @pauthorize,@authParams,'qa',@source,@binding,@badProfile,@testKey,@job,@testWorker,@bad,@testAttempt,@badVersion,@badVerifier;
    IF EXISTS(SELECT 1 FROM @auth) THROW 55186,N'Forged worker proof accepted.',1;
    INSERT @cases VALUES('worker negative fence '+CONVERT(varchar(1),@i)); SET @i+=1;
  END;
  INSERT @ordinalResult EXEC sys.sp_executesql @preserve,@fenceParams,'qa',@source,@binding,@profile,1,@job,@worker,@token,@attempt;
  SELECT @ordinal=attemptOrdinal FROM @ordinalResult; DELETE @ordinalResult;
  INSERT @ordinalResult EXEC sys.sp_executesql @preserve,@fenceParams,'qa',@source,@binding,@profile,1,@job,@worker,@token,@attempt;
  IF NOT EXISTS(SELECT 1 FROM @ordinalResult WHERE attemptOrdinal=@ordinal)
    OR (SELECT COUNT(*) FROM settings.catalog_source_refresh_attempts WHERE job_key=@jobKey AND event_kind='reserved')<>1
    THROW 55186,N'Ordinal reservation replay changed history.',1;
  INSERT @cases VALUES('ordinal reservation idempotent');
  SAVE TRANSACTION profileScenario;
  UPDATE settings.external_database_connections SET display_name=display_name+N'-changed' WHERE external_database_connection_key=(SELECT profile_key FROM @sources WHERE n=1);
  INSERT @auth EXEC sys.sp_executesql @pauthorize,@authParams,'qa',@source,@binding,@profile,1,@job,@worker,@token,@attempt,@fakeVersion,@fakeVerifier;
  IF EXISTS(SELECT 1 FROM @auth) THROW 55186,N'Changed profile retained authorization.',1;
  ROLLBACK TRANSACTION profileScenario;
  INSERT @cases VALUES('current profile version rechecked');
  SET @step=3; EXEC sys.sp_set_session_context @key=N'portal_qa_refresh_step',@value=@step;
  DECLARE @publishParams nvarchar(max)=N'@environment varchar(10),@sourceId uniqueidentifier,@bindingRevision varbinary(8),@profileRevision varbinary(8),@attemptOrdinal varchar(19),@matchKeyVersion smallint,@observedAt datetime2(3),@sourceRole varchar(15),@rows nvarchar(max),@scopes nvarchar(max),@rowCount int,@scopeCount int,@freshnessMinutes int',
    @failureParams nvarchar(max)=N'@environment varchar(10),@sourceId uniqueidentifier,@bindingRevision varbinary(8),@profileRevision varbinary(8),@attemptOrdinal varchar(19),@matchKeyVersion smallint,@observedAt datetime2(3)',
    @rows nvarchar(max),@observed datetime2(3)=SYSUTCDATETIME();
  SET @rows=N'[{"sourceRecordId":1,"issuer":"CO","documentType":"NIT","token":"'+CONVERT(varchar(64),@fakeVerifier,2)+N'","officialName":"Synthetic customer","activeCode":"S","allocationId":"'+CONVERT(nvarchar(36),NEWID())+N'"}]';
  SAVE TRANSACTION publishScenario;
  INSERT @publication EXEC sys.sp_executesql @ppublish,@publishParams,'qa',@source,@binding,@profile,@ordinal,1,@observed,'erp-customers',@rows,N'[]',1,0,30;
  IF NOT EXISTS(SELECT 1 FROM @publication WHERE result='published') THROW 55187,N'Fresh publication failed.',1;
  INSERT @done EXEC sys.sp_executesql @qcompletePublication,@publishCompleteParams,'qa',@source,@binding,@profile,1,@job,@worker,@token,@attempt,'succeeded',@ordinal;
  IF NOT EXISTS(SELECT 1 FROM @done WHERE completed=1)
    OR NOT EXISTS(SELECT 1 FROM settings.catalog_source_refresh_jobs WHERE job_key=@jobKey AND job_status='succeeded')
    OR NOT EXISTS(SELECT 1 FROM settings.catalog_source_head_events WHERE catalog_source_key=@sourceKey AND attempt_ordinal=CONVERT(bigint,@ordinal) AND attempt_status='succeeded')
    THROW 55187,N'Published head/history/completion mismatch.',1;
  DELETE @done; INSERT @done EXEC sys.sp_executesql @qcompletePublication,@publishCompleteParams,'qa',@source,@binding,@profile,1,@job,@worker,@token,@attempt,'succeeded',@ordinal;
  IF NOT EXISTS(SELECT 1 FROM @done WHERE completed=0) THROW 55187,N'Completion replay was accepted.',1;
  ROLLBACK TRANSACTION publishScenario;
  IF EXISTS(SELECT 1 FROM settings.catalog_customer_revision_heads WHERE catalog_source_key=@sourceKey)
    OR EXISTS(SELECT 1 FROM settings.catalog_source_head_events WHERE catalog_source_key=@sourceKey)
    OR NOT EXISTS(SELECT 1 FROM settings.catalog_source_refresh_jobs WHERE job_key=@jobKey AND job_status='processing')
    THROW 55187,N'Publication rollback split head, history and job.',1;
  INSERT @cases VALUES('publication head ledger completion replay and rollback');
  -- A higher failed ordinal is NOT a successful refresh, despite superseding this worker.
  SET @i=1;
  WHILE @i<=3
  BEGIN
    SAVE TRANSACTION supersedeScenario;
    DELETE @ordinalResult; INSERT @ordinalResult EXEC sys.sp_executesql N'SELECT CONVERT(varchar(19),NEXT VALUE FOR settings.catalog_customer_attempt_sequence) AS attemptOrdinal;';
    SELECT @otherOrdinal=attemptOrdinal FROM @ordinalResult;
    DELETE @publication;
    IF @i=1 INSERT @publication EXEC sys.sp_executesql @ppublish,@publishParams,'qa',@source,@binding,@profile,@otherOrdinal,1,@observed,'erp-customers',@rows,N'[]',1,0,30;
    IF @i=2 INSERT @publication EXEC sys.sp_executesql @precordFailure,@failureParams,'qa',@source,@binding,@profile,@otherOrdinal,1,@observed;
    DELETE @done; INSERT @done EXEC sys.sp_executesql @qcompletePublication,@publishCompleteParams,'qa',@source,@binding,@profile,1,@job,@worker,@token,@attempt,'superseded',@ordinal;
    IF NOT EXISTS(SELECT 1 FROM @done WHERE completed=1)
      OR NOT EXISTS(SELECT 1 FROM settings.catalog_source_refresh_jobs WHERE job_key=@jobKey AND job_status=CASE WHEN @i=1 THEN 'succeeded' ELSE 'cancelled' END)
      THROW 55187,N'Superseded freshness classification mismatch.',1;
    ROLLBACK TRANSACTION supersedeScenario;
    INSERT @cases VALUES('higher successful failed or missing head '+CONVERT(varchar(1),@i)); SET @i+=1;
  END;
  SET @step=4; EXEC sys.sp_set_session_context @key=N'portal_qa_refresh_step',@value=@step;
  SAVE TRANSACTION expiryScenario;
  UPDATE settings.catalog_source_refresh_jobs SET lease_expires_at=DATEADD(second,-1,SYSUTCDATETIME()) WHERE job_key=@jobKey;
  INSERT @auth EXEC sys.sp_executesql @pauthorize,@authParams,'qa',@source,@binding,@profile,1,@job,@worker,@token,@attempt,@fakeVersion,@fakeVerifier;
  DELETE @done; INSERT @done EXEC sys.sp_executesql @qcomplete,@completeParams,'qa',@source,@binding,@profile,1,@job,@worker,@token,@attempt,'retry';
  IF EXISTS(SELECT 1 FROM @auth) OR NOT EXISTS(SELECT 1 FROM @done WHERE completed=0) THROW 55188,N'Expired worker retained write completion.',1;
  DELETE @claims; INSERT @claims EXEC sys.sp_executesql @qclaim,@claimParams,'qa',1,1,@worker,2;
  IF EXISTS(SELECT 1 FROM @claims) OR NOT EXISTS(SELECT 1 FROM settings.catalog_source_refresh_jobs WHERE job_key=@jobKey AND job_status='retry' AND attempt_no=1 AND available_at>SYSUTCDATETIME())
    THROW 55188,N'Expiry did not release to delayed retry.',1;
  ROLLBACK TRANSACTION expiryScenario;
  INSERT @cases VALUES('expired claim rejected and reaped with backoff');
  SAVE TRANSACTION staleScenario;
  UPDATE settings.catalog_source_bindings SET display_name=display_name+N'-changed' WHERE catalog_source_key=@sourceKey;
  DELETE @claims; INSERT @claims EXEC sys.sp_executesql @qclaim,@claimParams,'qa',1,1,@worker,2;
  IF NOT EXISTS(SELECT 1 FROM settings.catalog_source_refresh_jobs WHERE job_key=@jobKey AND job_status='cancelled')
    OR NOT EXISTS(SELECT 1 FROM settings.catalog_source_refresh_attempts WHERE job_key=@jobKey AND event_kind='stale')
    THROW 55188,N'Stale binding was not cancelled.',1;
  ROLLBACK TRANSACTION staleScenario;
  INSERT @cases VALUES('stale binding cancellation preserves other claims');
  SET @i=1;
  WHILE @i<=5
  BEGIN
    DELETE @done; INSERT @done EXEC sys.sp_executesql @qcomplete,@completeParams,'qa',@source,@binding,@profile,1,@job,@worker,@token,@attempt,'retry';
    SET @expected=CASE @i WHEN 1 THEN 30 WHEN 2 THEN 60 WHEN 3 THEN 120 ELSE 240 END;
    IF NOT EXISTS(SELECT 1 FROM @done WHERE completed=1) OR NOT EXISTS(SELECT 1 FROM settings.catalog_source_refresh_jobs
      WHERE job_key=@jobKey AND attempt_no=@i AND job_status=CASE WHEN @i=5 THEN 'failed' ELSE 'retry' END
      AND (@i=5 OR DATEDIFF(second,updated_at,available_at)=@expected)) THROW 55188,N'Retry budget/backoff mismatch.',1;
    IF @i<5
    BEGIN
      -- QA-owner clock setup only; application never edits availability to bypass delay.
      UPDATE settings.catalog_source_refresh_jobs SET requested_at=DATEADD(minute,-10,@now),available_at=DATEADD(second,-1,SYSUTCDATETIME()) WHERE job_key=@jobKey;
      DELETE @claims; INSERT @claims EXEC sys.sp_executesql @qclaim,@claimParams,'qa',1,1,@worker,1;
      SELECT @token=leaseToken,@attempt=attempt FROM @claims WHERE jobId=@job;
      IF @attempt<>@i+1 THROW 55188,N'Retry claim lost attempt fencing.',1;
    END;
    INSERT @cases VALUES('retry attempt '+CONVERT(varchar(1),@i)); SET @i+=1;
  END;
  IF (SELECT COUNT(*) FROM settings.catalog_source_refresh_jobs WHERE finished_at IS NULL)<>2
    THROW 55188,N'Failure on one source changed other jobs.',1;
  INSERT @cases VALUES('source failure leaves other sources processing');
  DELETE @due; INSERT @due EXEC sys.sp_executesql @qenqueueDue,@configParams,'qa',1,1;
  IF NOT EXISTS(SELECT 1 FROM @due WHERE enqueued=0) THROW 55188,N'Terminal failure cooldown ignored.',1;
  INSERT @cases VALUES('timer terminal cooldown');
Finish:
  ROLLBACK TRANSACTION;
  IF OBJECT_ID(N'settings.catalog_source_refresh_jobs',N'U') IS NOT NULL OR OBJECT_ID(N'settings.catalog_source_refresh_attempts',N'U') IS NOT NULL
    OR OBJECT_ID(N'settings.catalog_source_head_events',N'U')<>@headObject
    OR EXISTS(SELECT 1 FROM security.users WHERE source_id=@tag)
    OR EXISTS(SELECT 1 FROM settings.external_database_connections WHERE source_id IN(@tag+N'-1',@tag+N'-2',@tag+N'-3'))
    OR EXISTS(SELECT 1 FROM settings.catalog_match_key_registry WHERE portal_environment='qa')
    THROW 55189,N'Queue rehearsal rollback left metadata or removed050.',1;
  EXEC sys.sp_set_session_context @key=N'portal_qa_refresh_step',@value=NULL;
  SELECT COUNT(*) AS passed,0 AS error_number,0 AS error_case,0 AS error_line,0 AS fixture_rows_remaining,@probe AS probe_stage,
    DATEDIFF_BIG(millisecond,@started,SYSUTCDATETIME()) AS elapsed_ms FROM @cases;
END TRY
BEGIN CATCH
  -- Emit only a known DDL constraint name, never the engine's raw message/data.
  DECLARE @constraint sysname;
  SELECT TOP(1) @constraint=name FROM sys.objects WHERE type IN('C','F','UQ','PK') AND CHARINDEX(name,ERROR_MESSAGE())>0 ORDER BY LEN(name) DESC;
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  EXEC sys.sp_set_session_context @key=N'portal_qa_refresh_step',@value=NULL;
  SELECT (SELECT COUNT(*) FROM @cases) AS passed,ERROR_NUMBER() AS error_number,@step AS error_case,ERROR_LINE() AS error_line,@constraint AS error_constraint,
    (SELECT COUNT(*) FROM security.users WHERE source_id=@tag) AS fixture_rows_remaining,@probe AS probe_stage,
    DATEDIFF_BIG(millisecond,@started,SYSUTCDATETIME()) AS elapsed_ms;
END CATCH;
'@
$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
$response=(& $invoke -SessionDirectory $session -Sql ($prefix+$body) -Mode write -TimeoutSeconds $SqlTimeoutSeconds -MaxRows 10) | ConvertFrom-Json -Depth 16
$sets=@($response.resultSets)
$row=if($sets.Count){$sets[-1].rows[0]}else{$null}
$expectedPassed=if($ProbeStage -eq 'bootstrap'){1}else{30}
if(!$response.success -or $row.passed -ne $expectedPassed -or $row.error_number -ne 0 -or $row.fixture_rows_remaining -ne 0){
  $constraint=if($row.error_constraint -match '^[A-Za-z0-9_]+$'){$row.error_constraint}else{'not available'}
  throw "QA queue failed (SQL number: $([int]$row.error_number); case: $([int]$row.error_case); line: $([int]$row.error_line); completed: $([int]$row.passed); constraint: $constraint)."
}
if($ProbeStage -eq 'all'){
  foreach($statusCase in @('status-visible','status-revoked')){
    $index=-1
    for($i=0;$i -lt $sets.Count;$i++){if($sets[$i].rows.Count -eq 1 -and $sets[$i].rows[0].fixture_status_case -ceq $statusCase){$index=$i;break}}
    if($index -lt 0 -or $index+2 -ge $sets.Count){throw 'Status scope evidence missing.'}
    $visibility=$sets[$index+1].rows[0];$items=@($sets[$index+2].rows)
    if($statusCase -eq 'status-visible'){
      if(!$visibility.allowed -or !$visibility.sagPending -or $items.Count -ne 1 -or $items[0].status -cne 'queued'){throw 'Authorized status omitted the hidden dependency or leaked ERP scope.'}
    }elseif($visibility.allowed -or $visibility.sagPending -or $items.Count -ne 0){throw 'Revoked status leaked source or job metadata.'}
  }
}
$row | Select-Object passed,error_number,error_case,fixture_rows_remaining,probe_stage,elapsed_ms | ConvertTo-Json -Compress
