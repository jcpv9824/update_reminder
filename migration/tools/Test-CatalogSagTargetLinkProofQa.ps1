[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SessionDirectory)

$ErrorActionPreference='Stop'
$session=(Resolve-Path -LiteralPath $SessionDirectory).Path
$descriptor=Get-Content -Raw -LiteralPath (Join-Path $session 'active.json') | ConvertFrom-Json
if ($descriptor.database -cne 'PortalSAGWeb-TEST' -or $descriptor.environment -cne 'qa' -or
    $descriptor.accessLevel -cne 'full-control' -or $descriptor.sessionAuthorized -ne $true -or
    $descriptor.approvalMode -cne 'session') {
  throw 'This rehearsal requires an authorized full-control PortalSAGWeb-TEST session.'
}
$ddlPath=Join-Path $PSScriptRoot '../sql/056_catalog_sag_target_link_proof.sql'
$ddlBytes=[IO.File]::ReadAllBytes($ddlPath)
$ddlHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($ddlBytes))
if ($ddlHash -cne 'CA61CB55428E5821AC31F8AD9E713515F432A6732C1FDC27371965916BF95CAA') {
  throw 'The 056 bytes do not match the reviewed QA candidate.'
}
$ddl=[Text.UTF8Encoding]::new($false,$true).GetString($ddlBytes)
$prefix="DECLARE @ddl056 nvarchar(max)=N'"+$ddl.Replace("'","''")+"';"
$fixture=@'
SET NOCOUNT ON;
SET XACT_ABORT ON;
SET IMPLICIT_TRANSACTIONS OFF;
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
IF DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR DATALENGTH(DB_NAME())<>34
  OR @@TRANCOUNT<>0 OR CAST(SERVERPROPERTY('ProductMajorVersion') AS int)<>15
  OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150
    AND collation_name=N'Modern_Spanish_CI_AS')
  THROW 55650,N'Unexpected QA rehearsal target.',1;

DECLARE @tag nvarchar(72)=N'qa-sag-target-'+LOWER(CONVERT(char(36),NEWID()));
DECLARE @at datetime2(3)=SYSUTCDATETIME(),@lock int,@stage int=0,@case int=0,@count int=0;
DECLARE @erpEnd datetime2(3)=DATEADD(minute,5,@at),@sagEnd datetime2(3)=DATEADD(minute,3,@at);
DECLARE @physicalEnd datetime2(3)=DATEADD(minute,4,@at),@deadline datetime2(3),@expected datetime2(3);
DECLARE @token binary(32)=HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag+N'-document'));
DECLARE @differentDocument binary(32)=HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag+N'-different-document'));
DECLARE @route binary(32)=HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag+N'-route'));
DECLARE @wrongRoute binary(32)=HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag+N'-wrong-route'));
DECLARE @version smallint,@erp bigint,@sag bigint,@erpRev bigint,@sagRev bigint,@customer bigint;
DECLARE @erpAttempt bigint=9223372036854775780,@sagAttempt bigint=9223372036854775781;
DECLARE @erpBinding binary(8),@erpProfile binary(8),@sagBinding binary(8),@sagProfile binary(8);
DECLARE @client bigint,@domain bigint,@database bigint,@owner bigint,@access bigint,@target bigint;
DECLARE @approvedVersion binary(8),@probeVersion varbinary(32),@probeToken varbinary(64);
DECLARE @operationalId uniqueidentifier=NEWID(),@linkKey bigint,@physicalId uniqueidentifier=NEWID(),
  @targetId uniqueidentifier=NEWID(),@sagId uniqueidentifier,@instanceId uniqueidentifier=NEWID();
DECLARE @probeEnv varchar(32),@purpose varchar(16),@company int,@probeInstance uniqueidentifier,@probePhysicalId uniqueidentifier;
DECLARE @catalog nvarchar(128)=N'synthetic',@fqdn nvarchar(500)=N'https://'+@tag+N'.invalid/';
BEGIN TRY
  BEGIN TRANSACTION;
  EXEC @lock=sys.sp_getapplock @Resource=N'portal-sag:catalog-customer-publication:qa',@LockMode=N'Exclusive',
    @LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock<0 OR OBJECT_ID(N'settings.verify_catalog_sag_target_link_internal',N'P') IS NOT NULL
    OR EXISTS(SELECT 1 FROM settings.catalog_source_bindings WITH (UPDLOCK,HOLDLOCK)
      WHERE source_role='sag-admin' AND portal_environment='qa' AND source_state='active')
    THROW 55651,N'Rehearsal requires a free QA catalog with no active SAG source and no 056 installation.',1;
  SET @stage=1;
  EXEC sys.sp_executesql @ddl056;
  IF @@TRANCOUNT<>1 OR XACT_STATE()<>1 OR OBJECT_ID(N'settings.verify_catalog_sag_target_link_internal',N'P') IS NULL
    THROW 55652,N'Expected one owned SERIALIZABLE QA transaction with 056 installed.',1;

  SET @stage=2;
  SELECT @version=match_key_version FROM settings.catalog_match_key_registry WITH (HOLDLOCK) WHERE portal_environment='qa';
  IF @version IS NULL
  BEGIN
    SET @version=1;
    INSERT settings.catalog_match_key_registry(portal_environment,match_key_version,vault_secret_version,key_verifier)
      VALUES('qa',@version,CONVERT(binary(16),NEWID()),@token);
  END;
  INSERT settings.external_database_connections(source_id,display_name,server_host,database_name,login_name,
    password_configured,password_secret_name,created_by,updated_by)
  SELECT @tag+suffix,@tag+suffix,N'fixture.invalid',@catalog,N'fixture',1,N'fixture-no-key','fixture','fixture'
  FROM (VALUES(N'-erp'),(N'-sag')) v(suffix);
  INSERT settings.catalog_source_bindings(external_database_connection_key,display_name,source_role,portal_environment,
    contract_version,source_state,issuer_scope,validated_at,validated_profile_version,created_by,updated_by)
  SELECT external_database_connection_key,source_id,
    CASE WHEN source_id=@tag+N'-erp' THEN 'erp-customers' ELSE 'sag-admin' END,'qa',
    CASE WHEN source_id=@tag+N'-erp' THEN 'erp_v1' ELSE 'sag_admin_v2' END,'active',
    CASE WHEN source_id=@tag+N'-erp' THEN 'CO' END,@at,row_version,'fixture','fixture'
  FROM settings.external_database_connections WHERE source_id IN (@tag+N'-erp',@tag+N'-sag');
  SELECT @erp=catalog_source_key,@erpBinding=row_version,@erpProfile=validated_profile_version
    FROM settings.catalog_source_bindings WHERE display_name=@tag+N'-erp';
  SELECT @sag=catalog_source_key,@sagId=source_id,@sagBinding=row_version,@sagProfile=validated_profile_version
    FROM settings.catalog_source_bindings WHERE display_name=@tag+N'-sag';
  INSERT core.catalog_customer_ids DEFAULT VALUES;
  SET @customer=SCOPE_IDENTITY();
  INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,match_key_version,
    attempt_ordinal,expected_rows,expected_scopes,observed_at,verified_until,has_sag_inventory_evidence,expected_sag_company_rows)
  VALUES(@erp,'erp-customers',@erpBinding,@erpProfile,@version,@erpAttempt,2,0,@at,@erpEnd,0,NULL);
  SET @erpRev=SCOPE_IDENTITY();
  INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,match_key_version,
    attempt_ordinal,expected_rows,expected_scopes,observed_at,verified_until,has_sag_inventory_evidence,expected_sag_company_rows)
  VALUES(@sag,'sag-admin',@sagBinding,@sagProfile,@version,@sagAttempt,3,0,@at,@sagEnd,1,4);
  SET @sagRev=SCOPE_IDENTITY();
  INSERT core.catalog_customer_revision_rows(revision_key,source_role,source_record_id,catalog_customer_key,official_name,
    active_code,issuer,document_type,document_number_token)
  VALUES(@erpRev,'erp-customers',1,@customer,N'Fixture','S','CO','NIT',@token),
    (@erpRev,'erp-customers',2,@customer,N'Fixture alias','S','CO','NIT',@token),
    (@sagRev,'sag-admin',11,NULL,NULL,NULL,'CO','NIT',@token),
    (@sagRev,'sag-admin',12,NULL,NULL,NULL,'CO','NIT',@differentDocument),
    (@sagRev,'sag-admin',13,NULL,NULL,NULL,'CO','NIT',@token);
  INSERT core.catalog_sag_revision_evidence(revision_key,source_record_id,environment_kind)
  VALUES(@sagRev,11,'test'),(@sagRev,12,'test'),(@sagRev,13,'production');
  INSERT core.catalog_sag_company_revision_rows(revision_key,company_record_id,customer_record_id,is_available)
  VALUES(@sagRev,21,11,1),(@sagRev,22,12,1),(@sagRev,23,13,1),(@sagRev,24,11,1);
  UPDATE core.catalog_customer_source_revisions SET sealed_at=@at WHERE revision_key IN (@erpRev,@sagRev);
  INSERT settings.catalog_customer_revision_heads(catalog_source_key,revision_key,attempt_status,attempted_at,attempt_ordinal)
  VALUES(@erp,@erpRev,'succeeded',@at,@erpAttempt),(@sag,@sagRev,'succeeded',@at,@sagAttempt);

  SET @stage=3;
  INSERT core.clients(source_id,name,name_normalized,status,created_at,created_by,updated_at,updated_by)
  VALUES(@tag,@tag,@tag,'active',@at,'fixture',@at,'fixture');
  SET @client=SCOPE_IDENTITY();
  INSERT core.domains(source_id,client_key,domain_name,domain_name_normalized,environment_id,status,created_at,created_by,updated_at,updated_by)
  VALUES(@tag+N'-domain',@client,@fqdn,@fqdn,'test','active',@at,'fixture',@at,'fixture');
  SET @domain=SCOPE_IDENTITY();
  INSERT core.database_access_profiles(source_id,server_host_port,initial_catalog,sql_user_id,password_secret_name,
    connection_fingerprint,created_at,created_by,updated_at,updated_by)
  VALUES(@tag+N'-profile',N'fixture.invalid,1433',@catalog,N'fixture',N'fixture-no-key',
    HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag+N'-profile')),@at,'fixture',@at,'fixture');
  SET @access=SCOPE_IDENTITY();
  SELECT @approvedVersion=row_version FROM core.database_access_profiles WHERE access_profile_key=@access;
  INSERT core.databases(source_id,client_key,domain_key,access_profile_key,company_name,company_name_normalized,environment_id,
    status,created_at,created_by,updated_at,updated_by)
  VALUES(@tag+N'-database',@client,@domain,@access,@tag,@tag,'test','active',@at,'fixture',@at,'fixture');
  SET @database=SCOPE_IDENTITY();
  INSERT core.catalog_operational_owners(portal_environment,catalog_customer_key,client_key,registered_by)
  VALUES('qa',@customer,@client,'fixture');
  SELECT @owner=owner_key FROM core.catalog_operational_owners WHERE portal_environment='qa' AND catalog_customer_key=@customer;
  INSERT core.catalog_operational_links(link_id,owner_key,portal_environment,client_key,domain_key,database_key,
    catalog_source_key,source_record_id,target_kind,link_environment,registered_by)
  VALUES(@operationalId,@owner,'qa',@client,@domain,@database,@erp,1,'database','test','fixture');
  SELECT @linkKey=link_key FROM core.catalog_operational_links WHERE link_id=@operationalId;
  INSERT core.catalog_operational_link_approvals(link_key,binding_version,profile_version,revision_key,approval_reference,approved_by)
  VALUES(@linkKey,@erpBinding,@erpProfile,@erpRev,'QA-SAG-TARGET','fixture');
  INSERT core.catalog_physical_targets(target_id,portal_environment,target_kind,identity_fingerprint,database_name_fingerprint)
  VALUES(@targetId,'qa','database',HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag+N'-target')),
    HASHBYTES('SHA2_256',CONVERT(varbinary(max),@catalog)));
  SET @target=SCOPE_IDENTITY();
  INSERT core.catalog_physical_target_links(link_id,physical_target_key,portal_environment,target_kind,client_key,domain_key,
    database_key,access_profile_key,access_profile_version,proof_id,verified_by,verified_at,valid_until)
  VALUES(@physicalId,@target,'qa','database',@client,@domain,@database,@access,@approvedVersion,NEWID(),'fixture',@at,@physicalEnd);

  SET @stage=4;
  WHILE @case<13
  BEGIN
    SET @case+=1;
    -- 1: 053 sealed, no 055 seal. 2: exact task, two ERP rows grouped under one identity.
    -- 3: wrong route. 4: absent profile version. 5: wrong version. 6: wrong Company.
    -- 7: wrong parent. 8: wrong Company environment. 9: wrong Portal environment.
    -- 10: report missing 054. 11: wrong 054 instance. 12: exact report corroboration
    -- (NOT report authorization; the caller still requires 037). 13: stale approved profile.
    IF @case=2
    BEGIN
      INSERT core.catalog_sag_company_location_observations(revision_key,company_record_id,observation_state,location_token)
      VALUES(@sagRev,21,'candidate',@route),(@sagRev,22,'candidate',@route),
        (@sagRev,23,'candidate',@route),(@sagRev,24,'unverified',NULL);
      INSERT core.catalog_sag_company_location_seals(revision_key,expected_company_rows) VALUES(@sagRev,4);
    END;
    IF @case=11
      INSERT core.catalog_sql_target_instance_identities(physical_target_key,portal_environment,target_kind,trusted_instance_id,proof_id)
      VALUES(@target,'qa','database',@instanceId,NEWID());
    IF @case=13
      UPDATE core.database_access_profiles SET updated_at=SYSUTCDATETIME() WHERE access_profile_key=@access;
    SET @probeEnv=CASE WHEN @case=9 THEN 'production' ELSE 'qa' END;
    SET @purpose=CASE WHEN @case IN(10,11,12) THEN 'report' ELSE 'task' END;
    SET @probeInstance=CASE WHEN @case=11 THEN NEWID() WHEN @case IN(10,12) THEN @instanceId END;
    SET @probePhysicalId=@physicalId;
    SET @probeVersion=CASE WHEN @case=4 THEN NULL WHEN @case=5 THEN CONVERT(binary(8),0) ELSE @approvedVersion END;
    SET @probeToken=CASE WHEN @case=3 THEN @wrongRoute ELSE @route END;
    SET @company=CASE @case WHEN 6 THEN 24 WHEN 7 THEN 22 WHEN 8 THEN 23 ELSE 21 END;
    SET @expected=CASE WHEN @case IN(2,12) THEN @sagEnd END;
    SET @deadline='2099-01-01';
    EXEC settings.verify_catalog_sag_target_link_internal
      @environment=@probeEnv,@purpose=@purpose,@operationalLinkId=@operationalId,@physicalLinkId=@probePhysicalId,
      @physicalTargetId=@targetId,@accessProfileVersion=@probeVersion,@sagSourceId=@sagId,@sagRevisionKey=@sagRev,
      @sagCompanyRecordId=@company,@matchKeyVersion=@version,@locationToken=@probeToken,
      @reportInstanceId=@probeInstance,@validUntil=@deadline OUTPUT;
    IF (@expected IS NULL AND @deadline IS NOT NULL) OR (@expected IS NOT NULL AND (@deadline IS NULL OR @deadline<>@expected))
      THROW 55653,N'Unexpected target-link proof result.',1;
    SET @count+=1;
  END;
  ROLLBACK TRANSACTION;
  SET @stage=5;
  IF @@TRANCOUNT<>0 OR OBJECT_ID(N'settings.verify_catalog_sag_target_link_internal',N'P') IS NOT NULL
    OR EXISTS(SELECT 1 FROM settings.catalog_source_bindings WHERE catalog_source_key IN (@erp,@sag))
    OR EXISTS(SELECT 1 FROM settings.external_database_connections WHERE source_id IN (@tag+N'-erp',@tag+N'-sag'))
    OR EXISTS(SELECT 1 FROM core.catalog_customer_source_revisions WHERE revision_key IN (@erpRev,@sagRev))
    OR EXISTS(SELECT 1 FROM core.catalog_customer_ids WHERE catalog_customer_key=@customer)
    OR EXISTS(SELECT 1 FROM core.clients WHERE client_key=@client)
    OR EXISTS(SELECT 1 FROM core.database_access_profiles WHERE access_profile_key=@access)
    OR EXISTS(SELECT 1 FROM core.catalog_operational_links WHERE link_id=@operationalId)
    OR EXISTS(SELECT 1 FROM core.catalog_physical_targets WHERE target_id=@targetId)
    THROW 55654,N'Residual QA rehearsal fixture detected.',1;
  SELECT @count AS passed,0 AS remaining_fixtures;
END TRY
BEGIN CATCH
  DECLARE @err int=ERROR_NUMBER(),@line int=ERROR_LINE();
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  SELECT @err AS error_number,@line AS error_line,@stage AS error_stage,@case AS error_case;
END CATCH;
'@

$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
try {
  $response=(& $invoke -SessionDirectory $session -Sql ($prefix+[Environment]::NewLine+$fixture) -Mode write -TimeoutSeconds 60 -MaxRows 1) |
    ConvertFrom-Json -Depth 16
} catch {
  throw 'The guarded QA request did not return a sanitized result.'
}
$row=$response.resultSets[0].rows[0]
if (!$response.success -or $row.passed -ne 13 -or $row.remaining_fixtures -ne 0) {
  throw "Target-link proof QA failed (SQL: $([int]$row.error_number); line: $([int]$row.error_line); stage: $([int]$row.error_stage); case: $([int]$row.error_case))."
}
$row | Select-Object passed,remaining_fixtures | ConvertTo-Json -Compress
