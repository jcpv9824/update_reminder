[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SessionDirectory,
  [ValidateSet('normal','wrong-environment','wrong-target','wrong-operation','wrong-version','attached-alias')]
  [string]$Case='normal')

$ErrorActionPreference='Stop'
$session=(Resolve-Path -LiteralPath $SessionDirectory).Path
$descriptor=Get-Content -Raw -LiteralPath (Join-Path $session 'active.json') | ConvertFrom-Json
if($descriptor.database -cne 'PortalSAGWeb-TEST' -or ($descriptor.environment -and $descriptor.environment -cne 'qa')){
  throw 'This rehearsal requires the PortalSAGWeb-TEST session.'
}
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$proof=(Get-Content -Raw -LiteralPath (Join-Path $root 'api/src/lib/catalogExecutionLicenseSqlProof.ts')).Split([char]96) |
  Where-Object { $_ -match '^\s*SET NOCOUNT ON;' } | Select-Object -First 1
if(!$proof -or $proof -match '(?im)^\s*(UPDATE|DELETE|MERGE|ALTER|DROP|CREATE|EXEC(?:UTE)?)\b' -or
   $proof -match '(?im)^\s*INSERT\s+[^@]'){
  throw 'Expected the actual licensing proof with no persistent writes.'
}
$literal="DECLARE @proof nvarchar(max)=N'"+$proof.Replace("'","''")+"';"
$receipt=(Get-Content -Raw -LiteralPath (Join-Path $root 'api/src/lib/catalogExecutionRegistrationSqlRepository.ts')).Split([char]96) |
  Where-Object { $_ -match '^\s*DECLARE @receiptPairs TABLE' } | Select-Object -First 1
$routeHash=(Get-Content -Raw -LiteralPath (Join-Path $root 'api/src/lib/catalogPhysicalTargetIdentity.ts')).Split([char]96)[1]
if(!$receipt -or $receipt -notmatch 'INSERT workflow\.catalog_task_origin_receipts' -or $receipt.Contains('${') -or
   $routeHash -notmatch 'portal-sag:web-route:v1'){throw 'Expected the exact accounting-only receipt and physical route queries.'}
$literal+="DECLARE @receiptProbe nvarchar(max)=N'"+$receipt.Replace("'","''")+"';"
$caseNumber=@('normal','wrong-environment','wrong-target','wrong-operation','wrong-version','attached-alias').IndexOf($Case)
$literal+="DECLARE @negative int=$caseNumber;"
$fixture=@'
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR @@TRANCOUNT<>0
  THROW 54500,N'Unexpected QA rehearsal target.',1;

DECLARE @tag nvarchar(72)=N'qa-exec-license-'+LOWER(CONVERT(char(36),NEWID()));
DECLARE @hostname varchar(253)=CONVERT(varchar(253),@tag)+'.invalid',@stamp datetime2(3)=SYSUTCDATETIME(),@lock int;
DECLARE @domainName nvarchar(500)=N'https://'+@hostname+N'/';
DECLARE @token binary(32)=HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag));
DECLARE @erpEnd datetime2(3)=DATEADD(minute,5,@stamp),@sagEnd datetime2(3)=DATEADD(minute,3,@stamp);
DECLARE @version smallint,@wrongVersion smallint,@client bigint,@domain bigint,@owner bigint,@operational bigint,@customer bigint;
DECLARE @erp bigint,@sag bigint,@erpBinding binary(8),@erpProfile binary(8),@sagBinding binary(8),@sagProfile binary(8);
DECLARE @erpRevision bigint,@sagRevision bigint,@schedule bigint,@task bigint,@execution bigint,@module bigint,@otherModule bigint;
DECLARE @accessProfile bigint,@database bigint,@dbLink uniqueidentifier=NEWID(),@dbAlias nvarchar(36),@dbOperational bigint;
DECLARE @dbTask bigint,@dbExecution bigint,@dbAttachments nvarchar(max);
DECLARE @receiptTarget bigint,@receiptUser bigint,@scheduleVersion binary(8);
DECLARE @link uniqueidentifier=NEWID(),@alias nvarchar(36),@attempt bigint=9223372036854775780;
DECLARE @attachments nvarchar(max),@unknown nvarchar(max),@passed int=0,@scenario int=0,@licenseModuleId nvarchar(150)=@tag+N'-a';
DECLARE @params nvarchar(200)=N'@executionId bigint,@portalEnvironment varchar(10),@matchKeyVersion smallint,@attachments nvarchar(max)';
DECLARE @result TABLE(validUntil datetime2(3));
SET @alias=LOWER(CONVERT(nvarchar(36),@link));
SET @dbAlias=LOWER(CONVERT(nvarchar(36),@dbLink));
BEGIN TRY
  BEGIN TRANSACTION;
  EXEC @lock=sys.sp_getapplock @Resource=N'portal-sag:catalog-customer-publication:qa',@LockMode=N'Exclusive',
    @LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock<0 OR EXISTS(SELECT 1 FROM settings.catalog_source_bindings WHERE source_role='sag-admin'
    AND portal_environment='qa' AND source_state='active')
    THROW 54501,N'Rehearsal requires an uncontended QA catalog with no active SAG profile.',1;
  SELECT @version=match_key_version FROM settings.catalog_match_key_registry WHERE portal_environment='qa';
  IF @version IS NULL
  BEGIN
    SET @version=1;
    INSERT settings.catalog_match_key_registry(portal_environment,match_key_version,vault_secret_version,key_verifier)
      VALUES('qa',@version,CONVERT(binary(16),NEWID()),@token);
  END;
  SET @wrongVersion=CASE WHEN @version=1 THEN 2 ELSE 1 END;
  SET @scenario=1;
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
  SELECT @erp=catalog_source_key,@erpBinding=row_version,@erpProfile=validated_profile_version
    FROM settings.catalog_source_bindings WHERE display_name=@tag+N'-erp';
  SELECT @sag=catalog_source_key,@sagBinding=row_version,@sagProfile=validated_profile_version
    FROM settings.catalog_source_bindings WHERE display_name=@tag+N'-sag';
  INSERT core.catalog_customer_ids DEFAULT VALUES;
  SET @customer=SCOPE_IDENTITY();
  INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,
    match_key_version,attempt_ordinal,expected_rows,expected_scopes,observed_at,verified_until,has_sag_inventory_evidence)
    VALUES(@erp,'erp-customers',@erpBinding,@erpProfile,@version,@attempt,1,0,@stamp,@erpEnd,0);
  SET @erpRevision=SCOPE_IDENTITY();
  INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,
    match_key_version,attempt_ordinal,expected_rows,expected_scopes,observed_at,verified_until,has_sag_inventory_evidence)
    VALUES(@sag,'sag-admin',@sagBinding,@sagProfile,@version,@attempt+1,1,0,@stamp,@sagEnd,1);
  SET @sagRevision=SCOPE_IDENTITY();
  INSERT core.catalog_customer_revision_rows(revision_key,source_role,source_record_id,catalog_customer_key,official_name,
    active_code,issuer,document_type,document_number_token)
    VALUES(@erpRevision,'erp-customers',1,@customer,N'Fixture','S','CO','NIT',@token),
      (@sagRevision,'sag-admin',2,NULL,NULL,NULL,'CO','NIT',@token);
  INSERT core.catalog_sag_revision_evidence(revision_key,source_record_id,domain_candidate,environment_kind,license_codes)
    VALUES(@sagRevision,2,@hostname,'test','A');
  UPDATE core.catalog_customer_source_revisions SET sealed_at=@stamp WHERE revision_key IN (@erpRevision,@sagRevision);
  INSERT settings.catalog_customer_revision_heads(catalog_source_key,revision_key,attempt_status,attempted_at,attempt_ordinal)
    VALUES(@erp,@erpRevision,'succeeded',@stamp,@attempt),(@sag,@sagRevision,'succeeded',@stamp,@attempt+1);
  SET @scenario=2;
  INSERT core.clients(source_id,name,name_normalized,status,created_at,created_by,updated_at,updated_by)
    VALUES(@tag,@tag,@tag,'active',@stamp,'fixture',@stamp,'fixture');
  SET @client=SCOPE_IDENTITY();
  INSERT core.domains(source_id,client_key,domain_name,domain_name_normalized,environment_id,status,created_at,created_by,updated_at,updated_by)
    VALUES(@tag+N'-domain',@client,@domainName,@domainName,'test','active',@stamp,'fixture',@stamp,'fixture');
  SET @domain=SCOPE_IDENTITY();
  SET @scenario=21;
  INSERT core.catalog_operational_owners(portal_environment,catalog_customer_key,client_key,registered_by)
    VALUES('qa',@customer,@client,'fixture');
  SELECT @owner=owner_key FROM core.catalog_operational_owners WHERE portal_environment='qa' AND catalog_customer_key=@customer;
  SET @scenario=22;
  INSERT core.catalog_operational_links(link_id,owner_key,portal_environment,client_key,domain_key,
    catalog_source_key,source_record_id,target_kind,link_environment,registered_by)
    VALUES(@link,@owner,'qa',@client,@domain,@erp,1,'domain','test','fixture');
  SELECT @operational=link_key FROM core.catalog_operational_links WHERE link_id=@link;
  INSERT core.catalog_operational_link_approvals(link_key,binding_version,profile_version,revision_key,approval_reference,approved_by)
    VALUES(@operational,@erpBinding,@erpProfile,@erpRevision,'QA-EXEC-LICENSE','fixture');
  SET @scenario=23;
  INSERT licensing.license_modules(source_id,name,name_normalized,status,created_at,created_by,updated_at,updated_by)
    SELECT @tag+suffix,@tag+suffix,@tag+suffix,'active',@stamp,'fixture',@stamp,'fixture'
    FROM (VALUES(N'-a'),(N'-b')) v(suffix);
  SELECT @module=module_key FROM licensing.license_modules WHERE source_id=@licenseModuleId;
  SELECT @otherModule=module_key FROM licensing.license_modules WHERE source_id=@tag+N'-b';
  INSERT settings.catalog_sag_license_module_approvals(catalog_source_key,binding_version,profile_version,sag_code,module_key,
    approval_reference,approved_by) VALUES(@sag,@sagBinding,@sagProfile,'A',@module,'QA-EXEC-LICENSE','fixture');
  SET @scenario=24;
  INSERT scheduling.update_schedules(source_id,client_key,name,target_type,frequency_type,start_date,timezone,assigned_role,
    selection_mode,created_at,created_by,updated_at,updated_by)
    VALUES(@tag,@client,'Fixture','domain','manual',CONVERT(date,@stamp),'America/Bogota','super_admin',
      'licensing',@stamp,'fixture',@stamp,'fixture');
  SET @schedule=SCOPE_IDENTITY();
  INSERT scheduling.licensing_scope(schedule_key,license_match_mode,environment_id,target_types,active_only)
    VALUES(@schedule,'all','test','domains_only',1);
  INSERT scheduling.licensing_scope_modules(schedule_key,module_key) VALUES(@schedule,@module);
  SET @scenario=25;
  INSERT workflow.update_tasks(source_id,task_date,task_bucket,client_key,client_source_id,client_name_snapshot,domain_key,
    domain_source_id,domain_name_snapshot,target_type,target_source_id,target_name_snapshot,assigned_role,status,
    created_at,created_by,updated_at,updated_by)
    VALUES(@tag,CONVERT(date,@stamp),'fixture',@client,@tag,@tag,@domain,@tag+N'-domain',@domainName,
      'domain',@tag+N'-domain',@domainName,'super_admin','pending',@stamp,'fixture',@stamp,'fixture');
  SET @task=SCOPE_IDENTITY();
  INSERT workflow.catalog_task_executions(task_key,execution_key,occurrence_id,execution_kind,verified_target_id,
    operation_id,initial_catalog_revision_id,cutoff_at)
    VALUES(@task,@token,@tag,'domain',CONVERT(char(36),NEWID()),'fixture','fixture',@erpEnd);
  SET @execution=SCOPE_IDENTITY();
  INSERT workflow.catalog_task_execution_links(catalog_execution_key,execution_kind,link_id,catalog_source_key,
    catalog_record_id,client_key,domain_key,link_environment) VALUES(@execution,'domain',@alias,@erp,N'1',@client,@domain,'test');
  SET @attachments=(SELECT @alias AS linkId,@tag AS scheduleId,JSON_QUERY(N'["'+@licenseModuleId+N'"]') AS moduleIds FOR JSON PATH);
  SET @unknown=JSON_MODIFY(@attachments,'$[0].moduleIds[0]',@tag+N'-b');

  SET @scenario=3;
  INSERT @result EXEC sys.sp_executesql @proof,@params,@execution,'qa',@version,@attachments;
  IF (SELECT COUNT(*) FROM @result WHERE validUntil=@sagEnd)<>1 THROW 54502,N'Exact proof or earliest deadline missing.',1;
  SET @passed+=1;
  DELETE FROM @result;
  DECLARE @only nvarchar(max)=JSON_MODIFY(@attachments,'$[0].proofOnly',CONVERT(bit,1));
  INSERT @result EXEC sys.sp_executesql @proof,@params,@execution,'qa',@version,@only;
  IF EXISTS(SELECT 1 FROM @result) THROW 54512,N'Provenance mode bypassed the existing execution link.',1;
  SET @passed+=1;
  SAVE TRANSACTION proof_only_fixture;
  DELETE FROM workflow.catalog_task_execution_links WHERE catalog_execution_key=@execution AND link_id=@alias;
  INSERT @result EXEC sys.sp_executesql @proof,@params,@execution,'qa',@version,@attachments;
  IF EXISTS(SELECT 1 FROM @result) THROW 54513,N'Normal licensing proof accepted an unbound link.',1;
  SET @passed+=1;
  INSERT @result EXEC sys.sp_executesql @proof,@params,@execution,'qa',@version,@only;
  IF (SELECT COUNT(*) FROM @result WHERE validUntil=@sagEnd)<>1
    OR EXISTS(SELECT 1 FROM workflow.catalog_task_execution_links WHERE catalog_execution_key=@execution)
    THROW 54514,N'Unbound provenance was not proven without enrolling a credential-capable link.',1;
  SET @passed+=1;
  SET @scenario=31;
  INSERT security.users(source_id,display_name,email,email_normalized,active,created_at,created_by,updated_at,updated_by)
    VALUES(@tag+N'-receipt-admin',@tag,@tag+N'@invalid.example',@tag+N'@invalid.example',1,@stamp,'fixture',@stamp,'fixture');
  SELECT @receiptUser=user_key FROM security.users WHERE source_id=@tag+N'-receipt-admin';
  INSERT security.user_roles(user_key,role_id,assigned_by) VALUES(@receiptUser,N'super_admin',N'fixture');
  SELECT @scheduleVersion=row_version FROM scheduling.update_schedules WHERE schedule_key=@schedule;
  INSERT scheduling.catalog_schedule_operation_approvals(portal_environment,schedule_key,schedule_version,operation_id,approved_by)
    VALUES('qa',@schedule,@scheduleVersion,N'fixture',@receiptUser);
  INSERT core.catalog_physical_targets(portal_environment,target_kind,identity_fingerprint)
    VALUES('qa','domain',HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag+N'-receipt')));
  SET @receiptTarget=SCOPE_IDENTITY();
  UPDATE e SET verified_target_id=LOWER(CONVERT(nvarchar(36),p.target_id))
    FROM workflow.catalog_task_executions e CROSS JOIN core.catalog_physical_targets p
    WHERE e.catalog_execution_key=@execution AND p.physical_target_key=@receiptTarget;
  INSERT core.catalog_physical_target_links(physical_target_key,portal_environment,target_kind,client_key,domain_key,
    domain_route_fingerprint,proof_id,verified_by,verified_at,valid_until)
    SELECT @receiptTarget,'qa','domain',d.client_key,d.domain_key,/* ROUTE_HASH */,NEWID(),N'fixture',@stamp,@erpEnd
    FROM core.domains d WHERE d.domain_key=@domain;
  IF @negative<>0
  BEGIN
    IF @negative=2 UPDATE workflow.catalog_task_executions SET verified_target_id=LOWER(CONVERT(nvarchar(36),NEWID()))
      WHERE catalog_execution_key=@execution;
    IF @negative=3 UPDATE workflow.catalog_task_executions SET operation_id=N'fixture-other'
      WHERE catalog_execution_key=@execution;
    IF @negative=5 INSERT workflow.catalog_task_execution_links(catalog_execution_key,execution_kind,link_id,
      catalog_source_key,catalog_record_id,client_key,domain_key,link_environment)
      VALUES(@execution,'domain',@alias,@erp,N'1',@client,@domain,'test');
    -- Deliberately exercise the trigger even when the app would reject earlier.
    INSERT workflow.catalog_task_origin_receipts(portal_environment,catalog_execution_key,link_key,
      schedule_key,schedule_version,valid_until)
      VALUES(CASE WHEN @negative=1 THEN 'production' ELSE 'qa' END,@execution,@operational,@schedule,
        CASE WHEN @negative=4 THEN 0x0000000000000000 ELSE @scheduleVersion END,@sagEnd);
    THROW 54518,N'Invalid late receipt was accepted.',1;
  END;
  DECLARE @receiptArgs nvarchar(max),@receiptParams nvarchar(180)=
    N'@executionId bigint,@portalEnvironment varchar(10),@validUntil datetime2(3),@receipts nvarchar(max)';
  SELECT @receiptArgs=(SELECT @alias AS linkId,@tag AS scheduleId,
    LOWER(CONVERT(char(16),@scheduleVersion,2)) AS scheduleVersion FOR JSON PATH);
  DECLARE @ack TABLE([count] int);
  INSERT @ack EXEC sys.sp_executesql @receiptProbe,@receiptParams,@execution,'qa',@sagEnd,@receiptArgs;
  IF (SELECT COUNT(*) FROM @ack WHERE [count]=1)<>1 OR NOT EXISTS(
    SELECT 1 FROM workflow.catalog_task_origin_receipts WHERE catalog_execution_key=@execution
      AND link_key=@operational AND schedule_key=@schedule AND schedule_version=@scheduleVersion AND valid_until=@sagEnd)
    THROW 54515,N'Expected one exact receipt for a later alias.',1;
  SET @passed+=1;
  DELETE FROM @ack;
  INSERT @ack EXEC sys.sp_executesql @receiptProbe,@receiptParams,@execution,'qa',@sagEnd,@receiptArgs;
  IF (SELECT COUNT(*) FROM @ack WHERE [count]=1)<>1 OR
    (SELECT COUNT(*) FROM workflow.catalog_task_origin_receipts WHERE catalog_execution_key=@execution)<>1
    THROW 54516,N'Receipt replay was not idempotent.',1;
  SET @passed+=1;
  IF EXISTS(SELECT 1 FROM workflow.catalog_task_execution_links WHERE catalog_execution_key=@execution)
    OR EXISTS(SELECT 1 FROM workflow.catalog_task_execution_events WHERE catalog_execution_key=@execution)
    OR EXISTS(SELECT 1 FROM workflow.task_sources WHERE task_key=@task)
    OR NOT EXISTS(SELECT 1 FROM workflow.update_tasks WHERE task_key=@task AND status='pending'
      AND assigned_role=N'super_admin' AND domain_key=@domain)
    THROW 54517,N'Provenance changed task state, scope or credentials.',1;
  SET @passed+=1;
  ROLLBACK TRANSACTION proof_only_fixture;
  DELETE FROM @result;
  SET @scenario=3;
  INSERT @result EXEC sys.sp_executesql @proof,@params,@execution,'qa',@wrongVersion,@attachments;
  INSERT @result EXEC sys.sp_executesql @proof,@params,@execution,'qa',@version,@unknown;
  IF EXISTS(SELECT 1 FROM @result) THROW 54503,N'Wrong key version or module set passed.',1;
  SET @passed+=2;
  SET @scenario=4;
  INSERT scheduling.licensing_scope_modules(schedule_key,module_key) VALUES(@schedule,@otherModule);
  INSERT @result EXEC sys.sp_executesql @proof,@params,@execution,'qa',@version,@attachments;
  IF EXISTS(SELECT 1 FROM @result) THROW 54504,N'Incomplete all-scope passed.',1;
  SET @passed+=1;
  UPDATE scheduling.licensing_scope SET license_match_mode='any' WHERE schedule_key=@schedule;
  INSERT @result EXEC sys.sp_executesql @proof,@params,@execution,'qa',@version,@attachments;
  IF (SELECT COUNT(*) FROM @result WHERE validUntil=@sagEnd)<>1 THROW 54505,N'Valid any-scope was denied.',1;
  SET @passed+=1;
  DELETE FROM @result;
  INSERT scheduling.licensing_excluded_domains(schedule_key,domain_key) VALUES(@schedule,@domain);
  INSERT @result EXEC sys.sp_executesql @proof,@params,@execution,'qa',@version,@attachments;
  IF EXISTS(SELECT 1 FROM @result) THROW 54506,N'Excluded target passed.',1;
  SET @passed+=1;
  DELETE FROM scheduling.licensing_excluded_domains WHERE schedule_key=@schedule AND domain_key=@domain;
  SET @scenario=6;
  INSERT core.database_access_profiles(source_id,server_host_port,initial_catalog,sql_user_id,password_secret_name,
    connection_fingerprint,created_at,created_by,updated_at,updated_by)
    VALUES(@tag+N'-profile',N'fixture.invalid,1433',N'synthetic',N'fixture',N'fixture-no-key',
      HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag+N'-profile')),@stamp,'fixture',@stamp,'fixture');
  SET @accessProfile=SCOPE_IDENTITY();
  INSERT core.databases(source_id,client_key,domain_key,access_profile_key,company_name,company_name_normalized,environment_id,
    status,created_at,created_by,updated_at,updated_by)
    VALUES(@tag+N'-db',@client,@domain,@accessProfile,@tag,@tag,'test','active',@stamp,'fixture',@stamp,'fixture');
  SET @database=SCOPE_IDENTITY();
  INSERT core.catalog_operational_links(link_id,owner_key,portal_environment,client_key,domain_key,database_key,
    catalog_source_key,source_record_id,target_kind,link_environment,registered_by)
    VALUES(@dbLink,@owner,'qa',@client,@domain,@database,@erp,1,'database','test','fixture');
  SELECT @dbOperational=link_key FROM core.catalog_operational_links WHERE link_id=@dbLink;
  INSERT core.catalog_operational_link_approvals(link_key,binding_version,profile_version,revision_key,approval_reference,approved_by)
    VALUES(@dbOperational,@erpBinding,@erpProfile,@erpRevision,'QA-EXEC-LICENSE-DB','fixture');
  INSERT workflow.update_tasks(source_id,task_date,task_bucket,client_key,client_source_id,client_name_snapshot,domain_key,
    domain_source_id,domain_name_snapshot,target_type,target_source_id,target_name_snapshot,database_key,assigned_role,status,
    created_at,created_by,updated_at,updated_by)
    VALUES(@tag+N'-db-task',CONVERT(date,@stamp),'fixture',@client,@tag,@tag,@domain,@tag+N'-domain',@domainName,
      'database',@tag+N'-db',@tag,@database,'super_admin','pending',@stamp,'fixture',@stamp,'fixture');
  SET @dbTask=SCOPE_IDENTITY();
  INSERT workflow.catalog_task_executions(task_key,execution_key,occurrence_id,execution_kind,verified_target_id,
    operation_id,initial_catalog_revision_id,cutoff_at)
    VALUES(@dbTask,HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag+N'-db-task')),@tag,'database',
      CONVERT(char(36),NEWID()),'fixture','fixture',@erpEnd);
  SET @dbExecution=SCOPE_IDENTITY();
  INSERT workflow.catalog_task_execution_links(catalog_execution_key,execution_kind,link_id,catalog_source_key,
    catalog_record_id,client_key,domain_key,database_key,link_environment)
    VALUES(@dbExecution,'database',@dbAlias,@erp,N'1',@client,@domain,@database,'test');
  SET @dbAttachments=JSON_MODIFY(@attachments,'$[0].linkId',@dbAlias);
  INSERT @result EXEC sys.sp_executesql @proof,@params,@dbExecution,'qa',@version,@dbAttachments;
  IF EXISTS(SELECT 1 FROM @result) THROW 54509,N'Domain-only scope admitted a database.',1;
  SET @passed+=1;
  UPDATE scheduling.licensing_scope SET target_types='domains_and_databases' WHERE schedule_key=@schedule;
  INSERT @result EXEC sys.sp_executesql @proof,@params,@dbExecution,'qa',@version,@dbAttachments;
  IF (SELECT COUNT(*) FROM @result WHERE validUntil=@sagEnd)<>1 THROW 54510,N'Verified parent did not admit the database.',1;
  SET @passed+=1;
  DELETE FROM @result;
  SAVE TRANSACTION parent_fixture;
  UPDATE core.catalog_operational_links SET retired_at=SYSUTCDATETIME() WHERE link_key=@operational;
  INSERT @result EXEC sys.sp_executesql @proof,@params,@dbExecution,'qa',@version,@dbAttachments;
  IF EXISTS(SELECT 1 FROM @result) THROW 54511,N'Database remained licensed without its verified parent.',1;
  SET @passed+=1;
  ROLLBACK TRANSACTION parent_fixture;
  SET @scenario=5;
  UPDATE settings.catalog_customer_revision_heads SET attempt_status='failed',attempted_at=SYSUTCDATETIME(),
    attempt_ordinal=@attempt+2 WHERE catalog_source_key=@sag;
  INSERT @result EXEC sys.sp_executesql @proof,@params,@execution,'qa',@version,@attachments;
  IF EXISTS(SELECT 1 FROM @result) THROW 54507,N'Prior SAG revision authorized after a failed refresh.',1;
  SET @passed+=1;
  ROLLBACK TRANSACTION;
  IF EXISTS(SELECT 1 FROM workflow.update_tasks WHERE source_id IN (@tag,@tag+N'-db-task'))
    OR EXISTS(SELECT 1 FROM workflow.catalog_task_executions WHERE catalog_execution_key IN (@execution,@dbExecution))
    OR EXISTS(SELECT 1 FROM scheduling.update_schedules WHERE source_id=@tag)
    OR EXISTS(SELECT 1 FROM workflow.catalog_task_origin_receipts WHERE catalog_execution_key=@execution)
    OR EXISTS(SELECT 1 FROM core.clients WHERE source_id=@tag)
    OR EXISTS(SELECT 1 FROM core.databases WHERE source_id=@tag+N'-db')
    OR EXISTS(SELECT 1 FROM core.database_access_profiles WHERE source_id=@tag+N'-profile')
    OR EXISTS(SELECT 1 FROM settings.catalog_source_bindings WHERE catalog_source_key IN (@erp,@sag))
    OR EXISTS(SELECT 1 FROM core.catalog_customer_source_revisions WHERE revision_key IN (@erpRevision,@sagRevision))
    OR EXISTS(SELECT 1 FROM settings.catalog_sag_license_module_approvals WHERE catalog_source_key=@sag)
    THROW 54508,N'Residual QA fixture.',1;
  SELECT @passed AS passed,0 AS remaining_fixtures;
END TRY
BEGIN CATCH
  DECLARE @error int=ERROR_NUMBER();
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  IF @negative<>0 AND @scenario=31 AND @error=54802
    AND NOT EXISTS (SELECT 1 FROM workflow.catalog_task_origin_receipts WHERE catalog_execution_key=@execution)
    AND NOT EXISTS (SELECT 1 FROM workflow.update_tasks WHERE source_id=@tag)
    AND NOT EXISTS (SELECT 1 FROM core.catalog_physical_targets WHERE physical_target_key=@receiptTarget)
    SELECT 1 AS passed,0 AS remaining_fixtures;
  ELSE SELECT @error AS error_number, ERROR_LINE() AS error_line,@scenario AS error_scenario;
END CATCH;
'@

$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
try {
  $response=(& $invoke -SessionDirectory $session -Sql ($literal+[Environment]::NewLine+$fixture.Replace('/* ROUTE_HASH */',$routeHash)) -Mode write -TimeoutSeconds 35 -MaxRows 1) |
    ConvertFrom-Json -Depth 16
} catch {
  throw 'QA licensing proof rehearsal did not return a valid sanitized result.'
}
$row=$response.resultSets[0].rows[0]
$expected=if($Case -eq 'normal'){16}else{1}
if(!$response.success -or $row.passed -ne $expected -or $row.remaining_fixtures -ne 0){
  throw "QA licensing proof rehearsal failed (SQL number: $([int]$row.error_number); batch line: $([int]$row.error_line); scenario: $([int]$row.error_scenario))."
}
$row | Select-Object passed,remaining_fixtures | ConvertTo-Json -Compress
