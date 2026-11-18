[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SessionDirectory)

$ErrorActionPreference='Stop'
$session=(Resolve-Path -LiteralPath $SessionDirectory).Path
$descriptor=Get-Content -Raw -LiteralPath (Join-Path $session 'active.json') | ConvertFrom-Json
if($descriptor.database -cne 'PortalSAGWeb-TEST' -or $descriptor.environment -cne 'qa' -or
  $descriptor.accessLevel -cne 'full-control'){
  throw 'This rollback-only rehearsal requires the authorized full-control PortalSAGWeb-TEST session.'
}
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$migration=@(Get-ChildItem -LiteralPath (Join-Path $root 'migration/sql') -File -Filter '049_*.sql')
if($migration.Count -ne 1){throw 'Expected exactly one migration 049 SQL file.'}
$ddl=Get-Content -Raw -LiteralPath $migration[0].FullName
if($ddl -notmatch 'record_catalog_once_observations' -or $ddl -match '(?im)^\s*(?:GO|USE)\b'){
  throw 'Expected the single-batch 049 ledger migration.'
}

$checks=@'
DECLARE @objects TABLE (object_id int PRIMARY KEY);
INSERT @objects VALUES(OBJECT_ID(N'scheduling.catalog_once_observations',N'U')),
  (OBJECT_ID(N'scheduling.catalog_once_observation_pairs',N'U'));
DECLARE @role int=DATABASE_PRINCIPAL_ID(N'portal_runtime');
IF @role IS NULL OR (SELECT COUNT(*) FROM sys.database_permissions
  WHERE class=1 AND minor_id=0 AND grantee_principal_id=@role AND state='D'
  AND major_id IN(SELECT object_id FROM @objects) AND permission_name IN('INSERT','UPDATE','DELETE'))<>6
  OR NOT EXISTS(SELECT 1 FROM sys.database_permissions WHERE class=1 AND minor_id=0 AND grantee_principal_id=@role
    AND major_id=OBJECT_ID(N'scheduling.record_catalog_once_observations',N'P') AND permission_name='EXECUTE' AND state='G')
  THROW 54981,N'Expected direct DML denials and a procedure-only grant.',1;
'@

$behavior=@'
DECLARE @tag nvarchar(72)=N'qa-once-'+LOWER(CONVERT(char(36),NEWID())),@stamp datetime2(3)=SYSUTCDATETIME();
DECLARE @day date=CONVERT(date,DATEADD(day,1,DATEADD(hour,-5,@stamp))),@cutoff datetime2(3),@until datetime2(3)=DATEADD(minute,4,@stamp);
DECLARE @proofUntil datetime2(3)=DATEADD(minute,8,@stamp),@population uniqueidentifier=NEWID(),@lock int;
DECLARE @erp bigint,@erpBinding binary(8),@erpProfile binary(8),@revision bigint,@customer bigint,@approver bigint;
DECLARE @matchKeyVersion smallint;
DECLARE @client bigint,@owner bigint,@schedule bigint,@version binary(8),@task bigint,@execution bigint,@target bigint;
DECLARE @operation nvarchar(25)=N'fixture.once.catalog',@digest binary(32)=HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag));
DECLARE @sourceJson varchar(max),@linkJson varchar(max),@populationSha binary(32),@priorFence binary(32);
DECLARE @attempt bigint=9223372036854775766,@executionHex char(64)=LOWER(CONVERT(char(64),@digest,2));
DECLARE @edges TABLE (n int PRIMARY KEY,alias uniqueidentifier NOT NULL DEFAULT NEWID(),domain_key bigint NULL);
DECLARE @ack TABLE (accepted int NOT NULL);
DECLARE @lockName nvarchar(255),@first bigint,@second bigint,@restored bigint,@full nvarchar(max),@small nvarchar(max),@blocked nvarchar(max);
SET @cutoff=DATEADD(hour,5,DATEADD(day,1,CONVERT(datetime2(3),@day)));
SET @lockName=N'portal.catalog-task.v1:database:'+CONVERT(char(10),@day,23);
EXEC @lock=sys.sp_getapplock @Resource=@lockName,@LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
IF @lock<0 THROW 54985,N'Could not reserve the synthetic database task day.',1;
SET @lockName=N'portal.catalog-task.v1:domain:'+CONVERT(char(10),@day,23);
EXEC @lock=sys.sp_getapplock @Resource=@lockName,@LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
IF @lock<0 THROW 54985,N'Could not reserve the synthetic domain task day.',1;
EXEC @lock=sys.sp_getapplock @Resource=N'portal-sag:catalog-customer-publication:qa',@LockMode=N'Exclusive',
  @LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
IF @lock<0 OR EXISTS(SELECT 1 FROM settings.catalog_source_bindings WHERE portal_environment='qa' AND source_state='active')
  OR EXISTS(SELECT 1 FROM scheduling.catalog_schedule_population_approvals WHERE portal_environment='qa' AND retired_at IS NULL)
  THROW 54986,N'The positive fixture requires QA without active catalog bindings or approval.',1;
SELECT @matchKeyVersion=match_key_version FROM settings.catalog_match_key_registry WHERE portal_environment='qa';
IF @matchKeyVersion IS NULL
BEGIN
  SET @matchKeyVersion=1;
  INSERT settings.catalog_match_key_registry(portal_environment,match_key_version,vault_secret_version,key_verifier)
    VALUES('qa',@matchKeyVersion,CONVERT(binary(16),NEWID()),@digest);
  SET @stamp=SYSUTCDATETIME();
END;

INSERT security.users(source_id,display_name,email,email_normalized,active,created_at,created_by,updated_at,updated_by)
  VALUES(@tag,@tag,@tag+N'@invalid.example',@tag+N'@invalid.example',1,@stamp,'fixture',@stamp,'fixture');
-- Obtain generated keys by source ID if an unrelated table trigger inserts its own row.
SELECT @approver=user_key FROM security.users WHERE source_id=@tag;
INSERT security.user_roles(user_key,role_id,assigned_by) VALUES(@approver,N'super_admin',N'fixture');
INSERT settings.external_database_connections(source_id,display_name,server_host,database_name,login_name,
  password_configured,password_secret_name,created_by,updated_by)
  SELECT @tag+suffix,@tag+suffix,N'fixture.invalid',N'synthetic',N'synthetic',1,N'fixture-no-key','fixture','fixture'
  FROM (VALUES(N'-erp'),(N'-sag')) v(suffix);
INSERT settings.catalog_source_bindings(external_database_connection_key,display_name,source_role,portal_environment,
  contract_version,source_state,issuer_scope,validated_at,validated_profile_version,created_by,updated_by)
  SELECT external_database_connection_key,source_id,CASE WHEN source_id=@tag+N'-erp' THEN 'erp-customers' ELSE 'sag-admin' END,'qa',
    CASE WHEN source_id=@tag+N'-erp' THEN 'erp_v1' ELSE 'sag_admin_v1' END,'active',
    CASE WHEN source_id=@tag+N'-erp' THEN 'CO' END,@stamp,row_version,'fixture','fixture'
  FROM settings.external_database_connections WHERE source_id IN (@tag+N'-erp',@tag+N'-sag');
SELECT @erp=catalog_source_key,@erpBinding=row_version,@erpProfile=validated_profile_version
  FROM settings.catalog_source_bindings WHERE display_name=@tag+N'-erp';
INSERT core.catalog_customer_ids DEFAULT VALUES;
SET @customer=SCOPE_IDENTITY();
INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,
  match_key_version,attempt_ordinal,expected_rows,expected_scopes,observed_at,verified_until,has_sag_inventory_evidence)
  VALUES(@erp,'erp-customers',@erpBinding,@erpProfile,@matchKeyVersion,@attempt,1,0,@stamp,@proofUntil,0);
SET @revision=SCOPE_IDENTITY();
INSERT core.catalog_customer_revision_rows(revision_key,source_role,source_record_id,catalog_customer_key,official_name,
  active_code,issuer,document_type,document_number_token)
  VALUES(@revision,'erp-customers',1,@customer,N'Fixture','S','CO','NIT',@digest);
UPDATE core.catalog_customer_source_revisions SET sealed_at=@stamp WHERE revision_key=@revision;
INSERT settings.catalog_customer_revision_heads(catalog_source_key,revision_key,attempt_status,attempted_at,attempt_ordinal)
  VALUES(@erp,@revision,'succeeded',@stamp,@attempt);

INSERT core.clients(source_id,name,name_normalized,status,created_at,created_by,updated_at,updated_by)
  VALUES(@tag,@tag,@tag,'active',@stamp,'fixture',@stamp,'fixture');
SET @client=SCOPE_IDENTITY();
INSERT @edges(n) VALUES(1),(2);
INSERT core.domains(source_id,client_key,domain_name,domain_name_normalized,environment_id,status,created_at,created_by,updated_at,updated_by)
  SELECT @tag+N'-d'+CONVERT(nvarchar(1),n),@client,N'https://'+@tag+N'-'+CONVERT(nvarchar(1),n)+N'.invalid/',
    N'https://'+@tag+N'-'+CONVERT(nvarchar(1),n)+N'.invalid/','test','active',@stamp,'fixture',@stamp,'fixture' FROM @edges;
UPDATE x SET domain_key=d.domain_key FROM @edges x JOIN core.domains d ON d.client_key=@client
  AND d.source_id=@tag+N'-d'+CONVERT(nvarchar(1),x.n);
INSERT core.catalog_operational_owners(portal_environment,catalog_customer_key,client_key,registered_by)
  VALUES('qa',@customer,@client,'fixture');
SELECT @owner=owner_key FROM core.catalog_operational_owners WHERE portal_environment='qa' AND catalog_customer_key=@customer;
INSERT core.catalog_operational_links(link_id,owner_key,portal_environment,client_key,domain_key,catalog_source_key,
  source_record_id,target_kind,link_environment,registered_by)
  SELECT alias,@owner,'qa',@client,domain_key,@erp,1,'domain','test','fixture' FROM @edges;
INSERT core.catalog_operational_link_approvals(link_key,binding_version,profile_version,revision_key,approval_reference,approved_by)
  SELECT l.link_key,@erpBinding,@erpProfile,@revision,'QA-ONCE','fixture'
  FROM core.catalog_operational_links l JOIN @edges x ON x.alias=l.link_id;

-- Reconstruct the documented UTF-8 canonical ASCII manifest independently of the procedure.
SELECT @sourceJson=STRING_AGG(CONVERT(varchar(max),CONCAT('["',LOWER(CONVERT(char(36),source_id)),
  '","',source_role,'","',LOWER(CONVERT(char(16),CONVERT(binary(8),row_version),2)),'","',
  LOWER(CONVERT(char(16),validated_profile_version,2)),'"]')),',')
  WITHIN GROUP (ORDER BY LOWER(CONVERT(char(36),source_id)) COLLATE Latin1_General_100_BIN2)
FROM settings.catalog_source_bindings WHERE portal_environment='qa' AND source_state='active';
SELECT @linkJson=STRING_AGG(CONVERT(varchar(max),'"'+LOWER(CONVERT(char(36),alias))+'"'),',')
  WITHIN GROUP (ORDER BY LOWER(CONVERT(char(36),alias)) COLLATE Latin1_General_100_BIN2) FROM @edges;
IF NOT EXISTS(SELECT 1 FROM scheduling.catalog_once_source_fence('qa')
  WHERE source_count=2 AND population_sources COLLATE Latin1_General_100_BIN2=@sourceJson COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(population_sources)=DATALENGTH(@sourceJson))
  THROW 54993,N'Source tuple serialization differs from the independent fixture manifest.',1;
IF (SELECT COUNT(*) FROM core.catalog_operational_links l JOIN core.catalog_operational_owners o ON o.owner_key=l.owner_key
  WHERE l.portal_environment='qa' AND l.retired_at IS NULL AND o.retired_at IS NULL)<>2
  THROW 54994,N'Unexpected active operational link fixture count.',1;
SET @populationSha=HASHBYTES('SHA2_256',CONCAT('["portal-sag:catalog-schedule-population:v1","qa",[',@sourceJson,'],[',@linkJson,']]'));
INSERT scheduling.catalog_schedule_population_approvals(population_id,portal_environment,source_count,link_count,
  population_sha256,approved_by,valid_until) VALUES(@population,'qa',2,2,@populationSha,@approver,@proofUntil);

INSERT scheduling.update_schedules(source_id,client_key,name,target_type,frequency_type,start_date,timezone,assigned_role,
  selection_mode,created_at,created_by,updated_at,updated_by)
  VALUES(@tag,@client,N'Fixture','domain','once',@day,N'America/Bogota',N'super_admin','manual',@stamp,'fixture',@stamp,'fixture');
SET @schedule=SCOPE_IDENTITY();
SELECT @version=row_version FROM scheduling.update_schedules WHERE schedule_key=@schedule;
INSERT scheduling.catalog_schedule_operation_approvals(portal_environment,schedule_key,schedule_version,operation_id,approved_by)
  VALUES('qa',@schedule,@version,@operation,@approver);
INSERT core.catalog_physical_targets(portal_environment,target_kind,identity_fingerprint) VALUES('qa','domain',@digest);
SET @target=SCOPE_IDENTITY();
INSERT core.catalog_physical_target_links(physical_target_key,portal_environment,target_kind,client_key,domain_key,
  domain_route_fingerprint,proof_id,verified_by,verified_at,valid_until)
  SELECT @target,'qa','domain',@client,d.domain_key,
    HASHBYTES('SHA2_256',CONVERT(varbinary(max),N'portal-sag:web-route:v1|')
      +CONVERT(binary(4),DATALENGTH(d.domain_name_normalized))+CONVERT(varbinary(max),d.domain_name_normalized)
      +CONVERT(varbinary(max),0x00)),NEWID(),N'fixture',@stamp,@proofUntil
  FROM @edges x JOIN core.domains d ON d.domain_key=x.domain_key;
INSERT workflow.update_tasks(source_id,task_date,task_bucket,client_key,client_source_id,client_name_snapshot,domain_key,
  domain_source_id,domain_name_snapshot,target_type,target_source_id,target_name_snapshot,assigned_role,status,
  created_at,created_by,updated_at,updated_by)
  SELECT @tag,@day,'fixture',@client,@tag,@tag,d.domain_key,d.source_id,d.domain_name,'domain',d.source_id,
    d.domain_name,'super_admin','pending',@stamp,'fixture',@stamp,'fixture'
  FROM @edges x JOIN core.domains d ON d.domain_key=x.domain_key WHERE x.n=1;
SET @task=SCOPE_IDENTITY();
INSERT workflow.catalog_task_executions(task_key,execution_key,occurrence_id,execution_kind,verified_target_id,
  operation_id,initial_catalog_revision_id,cutoff_at)
  SELECT @task,@digest,CONVERT(nvarchar(10),@day,23),'domain',LOWER(CONVERT(nvarchar(36),target_id)),@operation,'fixture',@cutoff
  FROM core.catalog_physical_targets WHERE physical_target_key=@target;
SET @execution=SCOPE_IDENTITY();
INSERT workflow.catalog_task_execution_links(catalog_execution_key,execution_kind,link_id,catalog_source_key,
  catalog_record_id,client_key,domain_key,link_environment)
  SELECT @execution,'domain',LOWER(CONVERT(nvarchar(36),alias)),@erp,N'1',@client,domain_key,'test' FROM @edges;
INSERT workflow.catalog_task_execution_sources(catalog_execution_link_key,schedule_key)
  SELECT catalog_execution_link_key,@schedule FROM workflow.catalog_task_execution_links WHERE catalog_execution_key=@execution;

SET @full=(SELECT @tag AS scheduleId,LOWER(CONVERT(char(16),@version,2)) AS scheduleVersion,@operation AS operationId,
  JSON_QUERY((SELECT LOWER(CONVERT(nvarchar(36),alias)) AS linkId,@executionHex AS executionKey FROM @edges ORDER BY n FOR JSON PATH)) AS pairs
  FOR JSON PATH);
SET @small=JSON_MODIFY(@full,'$[0].pairs',JSON_QUERY((SELECT LOWER(CONVERT(nvarchar(36),alias)) AS linkId,
  @executionHex AS executionKey FROM @edges WHERE n=1 FOR JSON PATH)));
SET @blocked=JSON_MODIFY(@full,'strict $[0].pairs',NULL);

SET @step=40;
INSERT @ack EXEC scheduling.record_catalog_once_observations 'qa',@day,@cutoff,@until,@population,@full;
SELECT @first=observation_key FROM scheduling.catalog_once_observations WHERE schedule_key=@schedule AND pair_count=2
  AND task_date=@day AND schedule_version=@version AND operation_id=@operation AND population_id=@population
  AND cutoff_at=@cutoff AND valid_until=@until AND observed_at>=@stamp;
IF @first IS NULL OR (SELECT COUNT(*) FROM @ack WHERE accepted=1)<>1 OR
  (SELECT COUNT(*) FROM scheduling.catalog_once_observation_pairs WHERE observation_key=@first AND catalog_execution_key=@execution)<>2
  THROW 54987,N'The exact positive alias pair observation was not recorded.',1;
SET @passed+=1;

SET @step=41;
DELETE FROM @ack;
INSERT @ack EXEC scheduling.record_catalog_once_observations 'qa',@day,@cutoff,@until,@population,@full;
IF (SELECT COUNT(*) FROM @ack WHERE accepted=1)<>1 OR
  (SELECT COUNT(*) FROM scheduling.catalog_once_observations WHERE schedule_key=@schedule)<>1
  THROW 54987,N'An adjacent retry appended redundant proof.',1;
SET @passed+=1;

SET @step=42;
DELETE FROM @ack;
INSERT @ack EXEC scheduling.record_catalog_once_observations 'qa',@day,@cutoff,@until,@population,@small;
SELECT @second=observation_key FROM scheduling.catalog_once_observations WHERE schedule_key=@schedule AND pair_count=0;
IF @second IS NULL OR @second<=@first OR (SELECT COUNT(*) FROM @ack WHERE accepted=1)<>1
  OR EXISTS(SELECT 1 FROM scheduling.catalog_once_observation_pairs WHERE observation_key=@second)
  THROW 54987,N'Removing a prior link did not produce only blocked evidence.',1;
SET @passed+=1;

SET @step=43;
DELETE FROM @ack;
INSERT @ack EXEC scheduling.record_catalog_once_observations 'qa',@day,@cutoff,@until,@population,@full;
SELECT @restored=MAX(observation_key) FROM scheduling.catalog_once_observations WHERE schedule_key=@schedule AND pair_count=2;
IF @restored IS NULL OR @restored<=@second OR (SELECT COUNT(*) FROM @ack WHERE accepted=1)<>1 OR
  (SELECT COUNT(*) FROM scheduling.catalog_once_observation_pairs WHERE observation_key=@restored AND catalog_execution_key=@execution)<>2
  THROW 54987,N'Negative to positive recovery did not preserve history and exact pairs.',1;
SET @passed+=1;

SET @step=44;
DELETE FROM @ack;
INSERT @ack EXEC scheduling.record_catalog_once_observations 'qa',@day,@cutoff,@until,@population,@blocked;
IF (SELECT COUNT(*) FROM @ack WHERE accepted=1)<>1 OR
  (SELECT COUNT(*) FROM scheduling.catalog_once_observations WHERE schedule_key=@schedule AND pair_count=0)<>2 OR
  (SELECT COUNT(*) FROM scheduling.catalog_once_observation_pairs WHERE schedule_key=@schedule)<>4 OR
  NOT EXISTS(SELECT 1 FROM scheduling.update_schedules WHERE schedule_key=@schedule AND active=1 AND completed_at IS NULL) OR
  NOT EXISTS(SELECT 1 FROM workflow.update_tasks WHERE task_key=@task AND status='pending')
  THROW 54987,N'An explicit blocked observation changed operational state or pair history.',1;
SET @passed+=1;
SET @step=45;
SELECT @priorFence=source_fence FROM scheduling.catalog_once_source_fence('qa');
UPDATE settings.catalog_customer_revision_heads SET attempt_status='failed',attempt_ordinal=@attempt+1,attempted_at=SYSUTCDATETIME()
  WHERE catalog_source_key=@erp AND revision_key=@revision;
DELETE FROM @ack;
INSERT @ack EXEC scheduling.record_catalog_once_observations 'qa',@day,@cutoff,@until,@population,@full;
IF (SELECT COUNT(*) FROM @ack WHERE accepted=1)<>1 OR NOT EXISTS(
  SELECT 1 FROM settings.catalog_customer_revision_heads WHERE catalog_source_key=@erp AND revision_key=@revision AND attempt_status='failed')
  OR NOT EXISTS(SELECT 1 FROM scheduling.catalog_once_observations WHERE schedule_key=@schedule AND pair_count=0 AND source_fence<>@priorFence)
  OR (SELECT COUNT(*) FROM scheduling.catalog_once_observations WHERE schedule_key=@schedule AND pair_count=2)<>2
  THROW 54987,N'A failed source attempt keeping the revision did not fence the prior proof.',1;
SET @passed+=1;
SET @fixtureTag=@tag;
SET @fixturePopulation=@population;

-- The contract uses XACT_ABORT, so perform intentional rejection last.
SET @step=46;
SET @day=DATEADD(day,3,@day);
SET @cutoff=DATEADD(hour,5,DATEADD(day,1,CONVERT(datetime2(3),@day)));
BEGIN TRY
  EXEC scheduling.record_catalog_once_observations 'qa',@day,@cutoff,@until,@population,@full;
  THROW 54988,N'The observation procedure accepted a day without its transaction locks.',1;
END TRY
BEGIN CATCH
  IF ERROR_NUMBER()<>54903 THROW;
  SET @passed+=1;
END CATCH;
'@

$fixture=@'
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR DATALENGTH(DB_NAME())<>34 OR @@TRANCOUNT<>0
  THROW 54980,N'Unexpected QA rehearsal target.',1;
DECLARE @before int=OBJECT_ID(N'scheduling.catalog_once_observations',N'U'),
  @beforePairs int=OBJECT_ID(N'scheduling.catalog_once_observation_pairs',N'U'),
  @beforeProc int=OBJECT_ID(N'scheduling.record_catalog_once_observations',N'P'),
  @beforeFence int=OBJECT_ID(N'scheduling.catalog_once_source_fence');
DECLARE @header int,@pair int,@proc int,@fence int,@passed int=0,@step int=1,@fixtureTag nvarchar(72),@fixturePopulation uniqueidentifier;
BEGIN TRY
  BEGIN TRANSACTION;
  EXEC sys.sp_executesql @ddl;
  SELECT @header=OBJECT_ID(N'scheduling.catalog_once_observations',N'U'),
    @pair=OBJECT_ID(N'scheduling.catalog_once_observation_pairs',N'U'),
    @proc=OBJECT_ID(N'scheduling.record_catalog_once_observations',N'P'),
    @fence=OBJECT_ID(N'scheduling.catalog_once_source_fence');
  IF @header IS NULL OR @pair IS NULL OR @proc IS NULL OR @fence IS NULL OR @@TRANCOUNT<>1
    THROW 54982,N'Expected four ledger objects without a migration-owned commit.',1;
  SET @passed+=1;
  SET @step=2;
  EXEC sys.sp_executesql @ddl;
  IF COALESCE(OBJECT_ID(N'scheduling.catalog_once_observations',N'U'),0)<>@header
    OR COALESCE(OBJECT_ID(N'scheduling.catalog_once_observation_pairs',N'U'),0)<>@pair
    OR COALESCE(OBJECT_ID(N'scheduling.record_catalog_once_observations',N'P'),0)<>@proc
    OR COALESCE(OBJECT_ID(N'scheduling.catalog_once_source_fence'),0)<>@fence OR @@TRANCOUNT<>1
    THROW 54983,N'Reapplying 049 changed ledger object identities or transaction ownership.',1;
  SET @passed+=1;
  SET @step=3;
  EXEC sys.sp_executesql @checks;
  SET @passed+=1;
  SET @step=39;
  EXEC sys.sp_executesql @behavior,N'@passed int OUTPUT,@step int OUTPUT,@fixtureTag nvarchar(72) OUTPUT,@fixturePopulation uniqueidentifier OUTPUT',
    @passed OUTPUT,@step OUTPUT,@fixtureTag OUTPUT,@fixturePopulation OUTPUT;
  IF XACT_STATE()=0 THROW 54984,N'The rehearsal unexpectedly lost its rollback transaction.',1;
  ROLLBACK TRANSACTION;
  SET @step=4;
  IF @@TRANCOUNT<>0 OR COALESCE(@before,0)<>COALESCE(OBJECT_ID(N'scheduling.catalog_once_observations',N'U'),0)
    OR COALESCE(@beforePairs,0)<>COALESCE(OBJECT_ID(N'scheduling.catalog_once_observation_pairs',N'U'),0)
    OR COALESCE(@beforeProc,0)<>COALESCE(OBJECT_ID(N'scheduling.record_catalog_once_observations',N'P'),0)
    OR COALESCE(@beforeFence,0)<>COALESCE(OBJECT_ID(N'scheduling.catalog_once_source_fence'),0)
    OR @fixtureTag IS NULL OR @fixturePopulation IS NULL
    OR EXISTS(SELECT 1 FROM core.clients WHERE source_id=@fixtureTag)
    OR EXISTS(SELECT 1 FROM security.users WHERE source_id=@fixtureTag)
    OR EXISTS(SELECT 1 FROM scheduling.update_schedules WHERE source_id=@fixtureTag)
    OR EXISTS(SELECT 1 FROM workflow.update_tasks WHERE source_id=@fixtureTag)
    OR EXISTS(SELECT 1 FROM settings.external_database_connections WHERE source_id IN (@fixtureTag+N'-erp',@fixtureTag+N'-sag'))
    OR EXISTS(SELECT 1 FROM scheduling.catalog_schedule_population_approvals WHERE population_id=@fixturePopulation)
    THROW 54984,N'Ledger rehearsal left schema or fixture residue.',1;
  SET @passed+=1;
  SELECT @passed AS passed,0 AS error_number,0 AS error_step,0 AS error_line;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  SELECT @passed AS passed,ERROR_NUMBER() AS error_number,@step AS error_step,ERROR_LINE() AS error_line;
END CATCH;
'@

$prefix="DECLARE @ddl nvarchar(max)=N'"+$ddl.Replace("'","''")+"',@checks nvarchar(max)=N'"+$checks.Replace("'","''")+
  "',@behavior nvarchar(max)=N'"+$behavior.Replace("'","''")+"';"
$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
try {
  $response=(& $invoke -SessionDirectory $session -Sql ($prefix+[Environment]::NewLine+$fixture) -Mode write -TimeoutSeconds 60 -MaxRows 1) |
    ConvertFrom-Json -Depth 16
} catch {throw 'QA ledger rehearsal did not return sanitized evidence.'}
$sets=@($response.resultSets)
$row=if($sets.Count){$sets[-1].rows[0]}else{$null}
if(!$response.success -or !$row -or $row.passed -ne 11 -or $row.error_number -ne 0){
  throw "QA ledger rehearsal failed (SQL number: $([int]$row.error_number); step: $([int]$row.error_step); line: $([int]$row.error_line))."
}
$row | Select-Object passed,error_number,error_step | ConvertTo-Json -Compress
