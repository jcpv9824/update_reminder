[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$SessionDirectory,
  [ValidateSet('all','bootstrap','permissions','reserve','publish','failure','fences','payload','protocol','audit','superseded','tail')][string]$ProbeStage='all',
  [ValidateRange(10,90)][int]$SqlTimeoutSeconds=90,
  [switch]$Installed
)
$ErrorActionPreference='Stop'
$session=(Resolve-Path -LiteralPath $SessionDirectory).Path
$descriptor=Get-Content -LiteralPath (Join-Path $session 'active.json') -Raw | ConvertFrom-Json
if($descriptor.database -cne 'PortalSAGWeb-TEST' -or $descriptor.environment -cne 'qa' -or $descriptor.accessLevel -cne 'full-control'){
  throw 'V2 publication rehearsal requires the authorized full-control PortalSAGWeb-TEST session.'
}
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$path053=Join-Path $root 'migration/sql/053_catalog_sag_v2_publication.sql'
if((Get-FileHash -LiteralPath $path053 -Algorithm SHA256).Hash -cne '0F1D24F0DF57953A016D1AC3DBD30F7F318DECF0DD18BC6D1D1CB0DF43FEEEAB'){
  throw '053 differs from the reviewed artifact.'
}
$ddl053=Get-Content -LiteralPath $path053 -Raw
# The temporary same-owner wrapper is expressly QA-only, invoked by the fixture
# owner with a module-scoped synthetic publisher context and removed by rollback.
# It exercises the real private transition through a low-privilege ownership chain.
# Public procs are NOT modified to allow ambient transactions. Their successful
# independent COMMIT and genuine two-session races remain unproven here.
$wrapper=@'
CREATE PROCEDURE settings.qa_catalog_sag_v2_transition_rehearsal
  @environment varchar(32),@sourceId uniqueidentifier,@jobId uniqueidentifier,@workerId uniqueidentifier,
  @leaseToken uniqueidentifier,@attempt int,@bindingVersion varbinary(32),@profileVersion varbinary(32),
  @matchKeyVersion smallint,@vaultSecretVersion varbinary(64),@keyVerifier varbinary(64),
  @action varchar(12),@attemptOrdinal bigint=NULL,@customerCount int=NULL,@companyCount int=NULL,
  @customers nvarchar(max)=NULL,@companies nvarchar(max)=NULL,
  @result varchar(12) OUTPUT,@jobStatus varchar(12) OUTPUT,@reservedOrdinal bigint OUTPUT,
  @observedAt datetime2(3) OUTPUT,@leaseUntil datetime2(3) OUTPUT,@successFreshUntil datetime2(3)=NULL OUTPUT
WITH EXECUTE AS 'qa_catalog_v2_publisher_test'
AS
BEGIN
  SET NOCOUNT ON;
  EXEC settings.catalog_sag_v2_transition_internal
    @environment=@environment,@sourceId=@sourceId,@jobId=@jobId,@workerId=@workerId,@leaseToken=@leaseToken,
    @attempt=@attempt,@bindingVersion=@bindingVersion,@profileVersion=@profileVersion,@matchKeyVersion=@matchKeyVersion,
    @vaultSecretVersion=@vaultSecretVersion,@keyVerifier=@keyVerifier,@action=@action,@attemptOrdinal=@attemptOrdinal,
    @customerCount=@customerCount,@companyCount=@companyCount,@customers=@customers,@companies=@companies,
    @result=@result OUTPUT,@jobStatus=@jobStatus OUTPUT,@reservedOrdinal=@reservedOrdinal OUTPUT,
    @observedAt=@observedAt OUTPUT,@leaseUntil=@leaseUntil OUTPUT,@successFreshUntil=@successFreshUntil OUTPUT;
END;
'@
if($Installed){
  if($ProbeStage -cne 'all' -or $descriptor.sessionAuthorized -ne $true -or $descriptor.approvalMode -cne 'session'){
    throw 'Installed mode requires the authorized QA session and does not accept an absent-mode probe stage.'
  }
  $pinned=@'
0f1d24f0df57953a016d1ac3dbd30f7f318decf0dd18bc6d1d1cb0df43feeeab  053_catalog_sag_v2_publication.sql
f55689d6161c01fe150e131d0e1231b0ff85c8608660aa6440a91c22994284b5  054_catalog_sql_target_instance_identity.sql
e3d04cd088f3c25f071a8163a91fe6194c2c8cc16c741f938f76c4af1cfcd49c  055_catalog_sag_target_observations.sql
ca61cb55428e5821ac31f8ad9e713515f432a6732c1fdc27371965916bf95caa  056_catalog_sag_target_link_proof.sql
dae2059f0255eac2db747f84284d838371c103036bd37909357876440253af5c  057_catalog_sag_target_runtime_gate.sql
d142000b6eedba93c9c1b9fbc9045828c5b151e0814a0f1ceb5464403eb50588  058_catalog_sql_target_instance_enrollment.sql
6450cd058f736089e9d100971527ab9aa81e1b3a9e5aa58b654ffb97b3d02f1b  059_catalog_sag_v2_license_approval.sql
'@
  $manifest=Get-Content -LiteralPath (Join-Path $root 'migration/sql/MANIFEST.sha256')
  $rows=foreach($entry in ($pinned -split '\r?\n')){
    if($entry -cnotmatch '^([0-9a-f]{64})  ((05[3-9])_[a-z0-9_]+\.sql)$'){throw 'Invalid pinned migration declaration.'}
    $sha=$Matches[1];$name=$Matches[2];$id=$Matches[3]
    if(@($manifest|Where-Object{$_ -ceq $entry}).Count -ne 1 -or
      (Get-FileHash -LiteralPath (Join-Path $root "migration/sql/$name") -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sha){
      throw 'Installed QA mode requires the exact reviewed 053 through 059 artifacts.'
    }
    "('$id',N'$name',0x$sha)"
  }
  $candidate=$wrapper.Replace('qa_catalog_sag_v2_transition_rehearsal','qa_catalog_v2_installed_publish')
  $fixed=$candidate.Replace('@action=@action,@attemptOrdinal=',"@action='publish',@attemptOrdinal=")
  if($candidate -ceq $fixed -or $fixed -match '(?i)\bNEXT\s+VALUE\s+FOR\b|@action=@action'){
    throw 'Installed mode may only reach the fixed publish action, never sequence allocation.'
  }
  $privateModule=[regex]::Matches($ddl053,"(?is)EXEC\s+sys\.sp_executesql\s+N'(CREATE OR ALTER PROCEDURE settings\.catalog_sag_v2_transition_internal(?:''|[^'])*)'\s*;")
  if($privateModule.Count -ne 1){throw 'Expected one private 053 transition definition in the reviewed SQL.'}
  $privateSuffix=$privateModule[0].Groups[1].Value.Replace("''","'").Substring('CREATE OR ALTER '.Length).Replace([string][char]13,'')
  $privateSha=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::Unicode.GetBytes($privateSuffix)))
  $permission=@'
CREATE PROCEDURE settings.__MODULE__ @passed bit OUTPUT
WITH EXECUTE AS '__USER__'
AS
BEGIN
  SET NOCOUNT ON;
  SET @passed=0;
  IF USER_NAME()<>N'__USER__' OR ISNULL(IS_ROLEMEMBER(N'db_owner'),0)<>0
    OR ISNULL(IS_ROLEMEMBER(N'__ROLE__'),0)<>1 OR ISNULL(IS_ROLEMEMBER(N'__OTHER__'),0)<>0
    RETURN;
  IF EXISTS(SELECT 1 FROM (VALUES
    (N'settings.reserve_catalog_sag_v2_attempt',N'EXECUTE',__PUB__),
    (N'settings.publish_catalog_sag_v2_revision',N'EXECUTE',__PUB__),
    (N'settings.fail_catalog_sag_v2_attempt',N'EXECUTE',__PUB__),
    (N'settings.publish_catalog_sag_v2_with_targets',N'EXECUTE',__PUB__),
    (N'settings.catalog_sag_v2_transition_internal',N'EXECUTE',0),
    (N'settings.enroll_catalog_sql_target_instance_internal',N'EXECUTE',0),
    (N'settings.verify_catalog_sag_target_link_internal',N'EXECUTE',0),
    (N'settings.verify_catalog_sag_target_link',N'EXECUTE',__RUNTIME__),
    (N'settings.read_catalog_sag_target_link_candidates',N'EXECUTE',__RUNTIME__),
    (N'core.catalog_sag_company_location_observations',N'SELECT',0),
    (N'core.catalog_sag_company_location_seals',N'SELECT',0),
    (N'settings.catalog_customer_attempt_sequence',N'UPDATE',0)
  ) v(securable,permission,allowed) WHERE ISNULL(HAS_PERMS_BY_NAME(v.securable,N'OBJECT',v.permission),0)<>v.allowed)
    RETURN;
  SET @passed=1;
END;
'@
  $installedRuntime=$permission.Replace('__MODULE__','qa_catalog_v2_installed_runtime_permissions').Replace('__USER__','qa_catalog_v2_runtime_test').
    Replace('__ROLE__','portal_runtime').Replace('__OTHER__','portal_catalog_v2_publisher').Replace('__PUB__','0').Replace('__RUNTIME__','1')
  $installedPublisher=$permission.Replace('__MODULE__','qa_catalog_v2_installed_publisher_permissions').Replace('__USER__','qa_catalog_v2_publisher_test').
    Replace('__ROLE__','portal_catalog_v2_publisher').Replace('__OTHER__','portal_runtime').Replace('__PUB__','1').Replace('__RUNTIME__','0')
  $installedPrefix="DECLARE @expected table(version varchar(3),script nvarchar(260),sha binary(32)); INSERT @expected VALUES "+($rows -join ',')+";"
  $installedPrefix+="DECLARE @expectedPrivateSha binary(32)=0x$privateSha;"
  $installedPrefix+="DECLARE @fixed nvarchar(max)=N'"+$fixed.Replace("'","''")+"',@runtime nvarchar(max)=N'"+$installedRuntime.Replace("'","''")+
    "',@publisher nvarchar(max)=N'"+$installedPublisher.Replace("'","''")+"';"
  $installedBody=@'
SET NOCOUNT ON;SET XACT_ABORT ON;SET IMPLICIT_TRANSACTIONS OFF;
IF DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR DATALENGTH(DB_NAME())<>34 OR @@TRANCOUNT<>0
  OR CONVERT(int,SERVERPROPERTY('ProductMajorVersion'))<>15 OR NOT EXISTS(SELECT 1 FROM sys.databases
    WHERE database_id=DB_ID() AND compatibility_level=150 AND collation_name=N'Modern_Spanish_CI_AS')
  THROW 55391,N'Unexpected installed publication rehearsal target.',1;
DECLARE @tag nvarchar(72)=N'qa-v2-installed-'+LOWER(CONVERT(char(36),NEWID()));
DECLARE @case int=1,@passed int=0,@code int=0,@lock int,@savedOwner sysname=USER_NAME();
DECLARE @draft table(source_key bigint PRIMARY KEY,version binary(8));
DECLARE @sequence table(current_value bigint NULL,last_used_value bigint NULL);
DECLARE @keyVer smallint,@vault binary(16),@verifier binary(32);
DECLARE @profileKey bigint,@sourceKey bigint,@jobKey bigint,@sourceId uniqueidentifier,
  @opVersion binary(8),@profileVersion binary(8),@job uniqueidentifier=NEWID(),@worker uniqueidentifier=NEWID(),
  @lease uniqueidentifier=NEWID(),@wrongLease uniqueidentifier=NEWID(),@probeLease uniqueidentifier,
  @now datetime2(3),@leaseEnd datetime2(3),@ordinal bigint=9223372036854700000+ABS(CONVERT(bigint,CHECKSUM(NEWID())))%50000,
  @probeOrdinal bigint,@customers nvarchar(max),@companies nvarchar(max),@companyCount int,@result varchar(12),@status varchar(12),@revision bigint,
  @reserved bigint,@observed datetime2(3),@leaseOut datetime2(3),@fresh datetime2(3),@permissionPassed bit;
BEGIN TRY
  SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
  BEGIN TRANSACTION;
  EXEC @lock=sys.sp_getapplock @Resource=N'portal-sag:catalog-customer-publication:qa',@LockMode=N'Exclusive',
    @LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock<0 OR EXISTS(SELECT version,script,sha FROM @expected EXCEPT
    SELECT migration_version,script_name,script_sha256 FROM migration.schema_migrations WITH (HOLDLOCK) WHERE succeeded=1)
    OR DATABASE_PRINCIPAL_ID(N'qa_catalog_v2_runtime_test') IS NOT NULL
    OR DATABASE_PRINCIPAL_ID(N'qa_catalog_v2_publisher_test') IS NOT NULL
    OR OBJECT_ID(N'settings.qa_catalog_v2_installed_publish',N'P') IS NOT NULL
    OR OBJECT_ID(N'settings.qa_catalog_v2_installed_runtime_permissions',N'P') IS NOT NULL
    OR OBJECT_ID(N'settings.qa_catalog_v2_installed_publisher_permissions',N'P') IS NOT NULL
    OR (SELECT COUNT(*) FROM settings.catalog_source_bindings WITH (HOLDLOCK) WHERE portal_environment='qa')<>2
    OR (SELECT COUNT(DISTINCT source_role) FROM settings.catalog_source_bindings WITH (HOLDLOCK)
      WHERE portal_environment='qa' AND source_state='draft' AND source_role IN('erp-customers','sag-admin'))<>2
    OR EXISTS(SELECT 1 FROM core.catalog_customer_source_revisions WHERE attempt_ordinal=@ordinal)
    OR EXISTS(SELECT 1 FROM settings.catalog_source_refresh_attempts WHERE attempt_ordinal=@ordinal)
    THROW 55392,N'Installed QA publication prerequisites changed.',1;
  DECLARE @privateId int=OBJECT_ID(N'settings.catalog_sag_v2_transition_internal',N'P');
  DECLARE @privateDefinition nvarchar(max)=OBJECT_DEFINITION(@privateId);
  DECLARE @privateRawSha binary(32)=HASHBYTES('SHA2_256',CONVERT(varbinary(max),@privateDefinition));
  SET @privateDefinition=REPLACE(@privateDefinition,NCHAR(13),N'');
  DECLARE @anchor nvarchar(100)=N'PROCEDURE settings.catalog_sag_v2_transition_internal';
  DECLARE @privateStart int=CASE
    WHEN LEFT(@privateDefinition,16) COLLATE Latin1_General_100_BIN2=N'CREATE OR ALTER ' THEN 17
    WHEN LEFT(@privateDefinition,9) COLLATE Latin1_General_100_BIN2=N'CREATE   ' THEN 10 END;
  IF @privateRawSha IS NULL OR @privateStart IS NULL
    OR SUBSTRING(@privateDefinition,@privateStart,LEN(@anchor)) COLLATE Latin1_General_100_BIN2<>@anchor COLLATE Latin1_General_100_BIN2
    OR HASHBYTES('SHA2_256',CONVERT(varbinary(max),SUBSTRING(@privateDefinition,@privateStart,DATALENGTH(@privateDefinition)/2)))
      <>@expectedPrivateSha
    THROW 55392,N'Installed private 053 transition differs from the reviewed definition.',1;
  INSERT @draft SELECT catalog_source_key,row_version FROM settings.catalog_source_bindings WHERE portal_environment='qa';
  INSERT @sequence SELECT CONVERT(bigint,current_value),CONVERT(bigint,last_used_value) FROM sys.sequences
    WHERE object_id=OBJECT_ID(N'settings.catalog_customer_attempt_sequence',N'SO');
  SELECT @keyVer=match_key_version,@vault=vault_secret_version,@verifier=key_verifier
  FROM settings.catalog_match_key_registry WITH (HOLDLOCK) WHERE portal_environment='qa';
  IF @keyVer IS NULL OR @vault IS NULL OR @verifier IS NULL OR (SELECT COUNT(*) FROM @sequence)<>1
    OR NOT EXISTS(SELECT 1 FROM settings.catalog_match_key_registry WHERE portal_environment='qa' AND enrolled_at<=SYSUTCDATETIME())
    THROW 55392,N'Installed match-key or sequence metadata unavailable.',1;
  SET @passed+=1;
  CREATE USER qa_catalog_v2_runtime_test WITHOUT LOGIN;
  CREATE USER qa_catalog_v2_publisher_test WITHOUT LOGIN;
  ALTER ROLE portal_runtime ADD MEMBER qa_catalog_v2_runtime_test;
  ALTER ROLE portal_catalog_v2_publisher ADD MEMBER qa_catalog_v2_publisher_test;
  EXEC sys.sp_executesql @fixed;
  EXEC sys.sp_executesql @runtime;
  EXEC sys.sp_executesql @publisher;
  SET @case=2;
  EXEC settings.qa_catalog_v2_installed_runtime_permissions @permissionPassed OUTPUT;
  IF ISNULL(@permissionPassed,0)<>1 THROW 55390,N'Installed runtime permissions did not match.',1;
  SET @passed+=1;
  SET @case=3;
  EXEC settings.qa_catalog_v2_installed_publisher_permissions @permissionPassed OUTPUT;
  IF ISNULL(@permissionPassed,0)<>1 THROW 55390,N'Installed publisher permissions did not match.',1;
  SET @passed+=1;

  SET @now=SYSUTCDATETIME();SET @leaseEnd=DATEADD(minute,2,@now);
  INSERT settings.external_database_connections(source_id,display_name,server_host,database_name,login_name,
    password_configured,password_secret_name,created_by,updated_by)
  VALUES(@tag,@tag,N'fixture.invalid',N'synthetic',N'fixture',1,N'fixture-no-key',N'fixture',N'fixture');
  SET @profileKey=SCOPE_IDENTITY();
  SELECT @profileVersion=row_version FROM settings.external_database_connections WHERE external_database_connection_key=@profileKey;
  INSERT settings.catalog_source_bindings(external_database_connection_key,display_name,source_role,portal_environment,
    contract_version,source_state,validated_at,validated_profile_version,created_by,updated_by)
  VALUES(@profileKey,@tag,'sag-admin','qa','sag_admin_v2','active',@now,@profileVersion,N'fixture',N'fixture');
  SET @sourceKey=SCOPE_IDENTITY();
  SELECT @sourceId=source_id,@opVersion=row_version FROM settings.catalog_source_bindings WHERE catalog_source_key=@sourceKey;
  INSERT settings.catalog_source_refresh_jobs(job_id,catalog_source_key,portal_environment,binding_version,profile_version,match_key_version,
    provenance,job_status,attempt_no,requested_at,updated_at,available_at,worker_id,lease_token,lease_expires_at,attempt_ordinal)
  VALUES(@job,@sourceKey,'qa',@opVersion,@profileVersion,@keyVer,'timer','processing',1,@now,@now,@now,@worker,@lease,@leaseEnd,@ordinal);
  SET @jobKey=SCOPE_IDENTITY();
  INSERT settings.catalog_source_refresh_attempts(job_key,attempt_no,event_kind,occurred_at,attempt_ordinal)
    VALUES(@jobKey,1,'claimed',@now,NULL),(@jobKey,1,'reserved',@now,@ordinal);
  WHILE @case<7
  BEGIN
    SET @case+=1;SET @code=NULL;
    SET @probeLease=CASE WHEN @case=4 THEN @wrongLease ELSE @lease END;
    SET @probeOrdinal=CASE WHEN @case=5 THEN @ordinal+1 ELSE @ordinal END;
    SET @customers=CASE WHEN @case=6 THEN N'{}' ELSE N'[]' END;
    SET @companyCount=CASE WHEN @case=7 THEN 1 ELSE 0 END;
    SET XACT_ABORT OFF;
    BEGIN TRY
      EXEC settings.qa_catalog_v2_installed_publish @environment='qa',@sourceId=@sourceId,@jobId=@job,@workerId=@worker,
        @leaseToken=@probeLease,@attempt=1,@bindingVersion=@opVersion,@profileVersion=@profileVersion,
        @matchKeyVersion=@keyVer,@vaultSecretVersion=@vault,@keyVerifier=@verifier,@action='publish',@attemptOrdinal=@probeOrdinal,
        @customerCount=0,@companyCount=@companyCount,@customers=@customers,@companies=N'[]',@result=@result OUTPUT,
        @jobStatus=@status OUTPUT,@reservedOrdinal=@reserved OUTPUT,@observedAt=@observed OUTPUT,
        @leaseUntil=@leaseOut OUTPUT,@successFreshUntil=@fresh OUTPUT;
    END TRY
    BEGIN CATCH
      SET @code=ERROR_NUMBER();
    END CATCH;
    SET XACT_ABORT ON;
    IF ISNULL(@code,0)<>CASE WHEN @case IN(4,5) THEN 55307 ELSE 55308 END OR XACT_STATE()<>1 OR @@TRANCOUNT<>1
      OR EXISTS(SELECT 1 FROM core.catalog_customer_source_revisions WHERE catalog_source_key=@sourceKey)
      OR EXISTS(SELECT 1 FROM settings.catalog_customer_revision_heads WHERE catalog_source_key=@sourceKey)
      OR (SELECT COUNT(*) FROM settings.catalog_source_refresh_attempts WHERE job_key=@jobKey)<>2
      OR NOT EXISTS(SELECT 1 FROM settings.catalog_source_refresh_jobs WHERE job_key=@jobKey AND job_status='processing'
        AND attempt_ordinal=@ordinal AND lease_token=@lease)
      THROW 55394,N'Installed publication negative decision or synthetic job state differs.',1;
    SET @passed+=1;
  END;
  -- Actual 053 materialization under the same rollback. 055 public RPC
  -- requires an independent transaction; it is not invoked in this mode.
  SET @case=8;SET @code=NULL;
  SET @customers=N'[{"sourceRecordId":1,"issuer":null,"documentType":null,"token":null,"domainCandidate":null,"environmentKind":"test","licenseCodes":"AS","testStartedOn":null,"productionStartedOn":null,"demoStartedOn":null}]';
  SET @companies=N'[{"companyRecordId":11,"customerRecordId":1,"displayName":"Synthetic fixture","isAvailable":true}]';
  EXEC settings.qa_catalog_v2_installed_publish @environment='qa',@sourceId=@sourceId,@jobId=@job,@workerId=@worker,
    @leaseToken=@lease,@attempt=1,@bindingVersion=@opVersion,@profileVersion=@profileVersion,
    @matchKeyVersion=@keyVer,@vaultSecretVersion=@vault,@keyVerifier=@verifier,@action='publish',@attemptOrdinal=@ordinal,
    @customerCount=1,@companyCount=1,@customers=@customers,@companies=@companies,@result=@result OUTPUT,
    @jobStatus=@status OUTPUT,@reservedOrdinal=@reserved OUTPUT,@observedAt=@observed OUTPUT,
    @leaseUntil=@leaseOut OUTPUT,@successFreshUntil=@fresh OUTPUT;
  SELECT @revision=revision_key FROM settings.catalog_customer_revision_heads
    WHERE catalog_source_key=@sourceKey AND attempt_status='succeeded' AND attempt_ordinal=@ordinal;
  IF ISNULL(@result,'')<>'published' OR ISNULL(@status,'')<>'succeeded' OR @revision IS NULL OR @fresh IS NULL
    OR NOT EXISTS(SELECT 1 FROM core.catalog_customer_source_revisions WHERE revision_key=@revision AND catalog_source_key=@sourceKey
      AND match_key_version=@keyVer AND expected_rows=1 AND expected_sag_company_rows=1 AND has_sag_inventory_evidence=1
      AND observed_at=@now AND sealed_at IS NOT NULL AND verified_until=@fresh)
    OR NOT EXISTS(SELECT 1 FROM core.catalog_sag_revision_evidence WHERE revision_key=@revision AND source_record_id=1
      AND environment_kind='test' AND license_codes='AS')
    OR NOT EXISTS(SELECT 1 FROM core.catalog_sag_company_revision_rows WHERE revision_key=@revision AND company_record_id=11
      AND customer_record_id=1 AND is_available=1)
    OR NOT EXISTS(SELECT 1 FROM settings.catalog_source_refresh_jobs WHERE job_key=@jobKey AND job_status='succeeded'
      AND finished_at IS NOT NULL AND attempt_ordinal IS NULL AND lease_token IS NULL)
    OR (SELECT COUNT(*) FROM settings.catalog_source_refresh_attempts WHERE job_key=@jobKey)<>3
    OR NOT EXISTS(SELECT 1 FROM settings.catalog_source_refresh_attempts WHERE job_key=@jobKey AND event_kind='succeeded' AND attempt_ordinal=@ordinal)
    OR (SELECT COUNT(*) FROM audit.audit_logs WHERE entity_type=N'catalog_source_binding' AND entity_source_id=LOWER(CONVERT(char(36),@sourceId))
      AND action=N'catalog_source_refreshed' AND JSON_VALUE(metadata_json,'$.status')='published')<>1
    THROW 55394,N'Installed 053 did not materialize the exact synthetic Company revision and audit.',1;
  SET @passed+=1;
  ROLLBACK TRANSACTION;
  SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
  IF @@TRANCOUNT<>0 OR USER_NAME()<>@savedOwner
    OR ISNULL(OBJECT_ID(N'settings.catalog_sag_v2_transition_internal',N'P'),0)<>@privateId
    OR ISNULL(HASHBYTES('SHA2_256',CONVERT(varbinary(max),OBJECT_DEFINITION(@privateId))),0x00)<>@privateRawSha
    OR DATABASE_PRINCIPAL_ID(N'qa_catalog_v2_runtime_test') IS NOT NULL
    OR DATABASE_PRINCIPAL_ID(N'qa_catalog_v2_publisher_test') IS NOT NULL
    OR OBJECT_ID(N'settings.qa_catalog_v2_installed_publish',N'P') IS NOT NULL
    OR OBJECT_ID(N'settings.qa_catalog_v2_installed_runtime_permissions',N'P') IS NOT NULL
    OR OBJECT_ID(N'settings.qa_catalog_v2_installed_publisher_permissions',N'P') IS NOT NULL
    OR EXISTS(SELECT 1 FROM settings.external_database_connections WHERE external_database_connection_key=@profileKey)
    OR EXISTS(SELECT 1 FROM settings.catalog_source_bindings WHERE catalog_source_key=@sourceKey)
    OR EXISTS(SELECT 1 FROM settings.catalog_source_refresh_jobs WHERE job_id=@job)
    OR EXISTS(SELECT 1 FROM settings.catalog_source_refresh_attempts WHERE job_key=@jobKey)
    OR EXISTS(SELECT 1 FROM settings.catalog_customer_revision_heads WHERE catalog_source_key=@sourceKey)
    OR EXISTS(SELECT 1 FROM core.catalog_customer_source_revisions WHERE catalog_source_key=@sourceKey)
    OR EXISTS(SELECT 1 FROM core.catalog_sag_company_revision_rows WHERE revision_key=@revision)
    OR EXISTS(SELECT 1 FROM audit.audit_logs WHERE entity_type=N'catalog_source_binding' AND entity_source_id=LOWER(CONVERT(char(36),@sourceId)))
    OR NOT EXISTS(SELECT 1 FROM settings.catalog_match_key_registry WHERE portal_environment='qa'
      AND match_key_version=@keyVer AND vault_secret_version=@vault AND key_verifier=@verifier)
    OR EXISTS(SELECT source_key,version FROM @draft EXCEPT SELECT catalog_source_key,row_version
      FROM settings.catalog_source_bindings WHERE portal_environment='qa' AND source_state='draft')
    OR EXISTS(SELECT current_value,last_used_value FROM @sequence EXCEPT
      SELECT CONVERT(bigint,current_value),CONVERT(bigint,last_used_value) FROM sys.sequences
      WHERE object_id=OBJECT_ID(N'settings.catalog_customer_attempt_sequence',N'SO'))
    THROW 55393,N'Post-rollback fixtures or baseline metadata changed.',1;
  SELECT @passed AS passed,0 AS fixture_rows_remaining,1 AS sequence_unchanged,1 AS materialized;
END TRY
BEGIN CATCH
  DECLARE @line int=ERROR_LINE(),@error int=ERROR_NUMBER();
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  SET XACT_ABORT ON;
  SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
  SELECT @error AS error_number,@line AS error_line,@case AS error_case,@code AS decision_number;
END CATCH;
'@
  $invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
  try {
    $response=(& $invoke -SessionDirectory $session -Sql ($installedPrefix+$installedBody) -Mode write -TimeoutSeconds $SqlTimeoutSeconds -MaxRows 1)|
      ConvertFrom-Json -Depth 14
  } catch { throw 'Installed publication QA failed before a sanitized result.' }
  $sets=@($response.resultSets)
  $row=if($sets.Count -eq 1 -and @($sets[0].rows).Count -eq 1){$sets[0].rows[0]}else{$null}
  if(!$response.success -or $row.passed -ne 8 -or $row.fixture_rows_remaining -ne 0 -or $row.sequence_unchanged -ne 1 -or $row.materialized -ne 1){
    throw "Installed publication QA failed (SQL: $([int]$row.error_number); case: $([int]$row.error_case); line: $([int]$row.error_line); decision: $([int]$row.decision_number))."
  }
  $row | Select-Object passed,fixture_rows_remaining,sequence_unchanged,materialized | ConvertTo-Json -Compress
  return
}
$probeTemplate=@'
CREATE PROCEDURE settings.__PROCEDURE__
  @case int,@environment varchar(32),@sourceId uniqueidentifier,@jobId uniqueidentifier,@workerId uniqueidentifier,
  @leaseToken uniqueidentifier,@attempt int,@bindingVersion varbinary(32),@profileVersion varbinary(32),
  @matchKeyVersion smallint,@vaultSecretVersion varbinary(64),@keyVerifier varbinary(64),
  @customerCount int,@companyCount int,@customers nvarchar(max),@companies nvarchar(max)
WITH EXECUTE AS '__PRINCIPAL__'
AS
BEGIN
  SET NOCOUNT ON;
  IF USER_NAME()<>N'__PRINCIPAL__' OR ISNULL(IS_ROLEMEMBER(N'db_owner'),0)<>0
    THROW 55390,N'QA probe did not enter its exact low-privilege module context.',1;
  DECLARE @args nvarchar(max)=N' @environment=@environment,@sourceId=@sourceId,@jobId=@jobId,@workerId=@workerId,@leaseToken=@leaseToken,
    @attempt=@attempt,@bindingVersion=@bindingVersion,@profileVersion=@profileVersion,@matchKeyVersion=@matchKeyVersion,
    @vaultSecretVersion=@vaultSecretVersion,@keyVerifier=@keyVerifier';
  DECLARE @statement nvarchar(max)=CASE
    WHEN @case IN(1,5) THEN N'EXEC settings.reserve_catalog_sag_v2_attempt'+@args+N';'
    WHEN @case IN(2,6) THEN N'EXEC settings.publish_catalog_sag_v2_revision'+@args+N',@attemptOrdinal=1,
      @customerCount=@customerCount,@companyCount=@companyCount,@customers=@customers,@companies=@companies;'
    WHEN @case IN(3,7) THEN N'EXEC settings.fail_catalog_sag_v2_attempt'+@args+N',@attemptOrdinal=1;'
    WHEN @case=4 THEN N'DECLARE @r varchar(12),@s varchar(12),@o bigint,@at datetime2(3),@lease datetime2(3),@fresh datetime2(3);
      EXEC settings.catalog_sag_v2_transition_internal'+@args+N',@action=''reserve'',@result=@r OUTPUT,@jobStatus=@s OUTPUT,
        @reservedOrdinal=@o OUTPUT,@observedAt=@at OUTPUT,@leaseUntil=@lease OUTPUT,@successFreshUntil=@fresh OUTPUT;'
    WHEN @case=8 THEN N'DELETE core.catalog_sag_company_revision_rows WHERE 1=0;'
    WHEN @case=9 THEN N'DECLARE @n bigint=NEXT VALUE FOR settings.catalog_customer_attempt_sequence;'
    WHEN @case=10 THEN N'DELETE core.catalog_customer_source_revisions WHERE 1=0;'
    WHEN @case=40 THEN N'DELETE core.catalog_customer_ids WHERE 1=0;'
    WHEN @case=41 THEN N'DELETE core.catalog_customer_revision_rows WHERE 1=0;'
    WHEN @case=42 THEN N'DELETE core.catalog_customer_revision_scopes WHERE 1=0;'
    WHEN @case=43 THEN N'DELETE core.catalog_sag_revision_evidence WHERE 1=0;'
    WHEN @case=44 THEN N'DELETE settings.catalog_customer_revision_heads WHERE 1=0;' END;
  IF @statement IS NULL THROW 55390,N'QA permission probe case is not allowlisted.',1;
  -- This closed dynamic batch intentionally breaks the dbo ownership chain for
  -- permission negatives. No caller can supply SQL or object identifiers.
  EXEC sys.sp_executesql @statement,N'@environment varchar(32),@sourceId uniqueidentifier,@jobId uniqueidentifier,@workerId uniqueidentifier,
    @leaseToken uniqueidentifier,@attempt int,@bindingVersion varbinary(32),@profileVersion varbinary(32),
    @matchKeyVersion smallint,@vaultSecretVersion varbinary(64),@keyVerifier varbinary(64),
    @customerCount int,@companyCount int,@customers nvarchar(max),@companies nvarchar(max)',
    @environment,@sourceId,@jobId,@workerId,@leaseToken,@attempt,@bindingVersion,@profileVersion,@matchKeyVersion,@vaultSecretVersion,@keyVerifier,
    @customerCount,@companyCount,@customers,@companies;
END;
'@
$runtimeProbe=$probeTemplate.Replace('__PROCEDURE__','qa_catalog_sag_v2_runtime_probe').Replace('__PRINCIPAL__','qa_catalog_v2_runtime_test')
$publisherProbe=$probeTemplate.Replace('__PROCEDURE__','qa_catalog_sag_v2_publisher_probe').Replace('__PRINCIPAL__','qa_catalog_v2_publisher_test')
$scenario=@'
SET NOCOUNT ON;
DECLARE @tag nvarchar(72)=N'qa-v2-publish-'+LOWER(CONVERT(char(36),NEWID())),@source uniqueidentifier,@sourceKey bigint,@profileKey bigint,
  @job uniqueidentifier=NEWID(),@worker uniqueidentifier=NEWID(),@lease uniqueidentifier=NEWID(),@attempt int=CASE WHEN @case=15 THEN 5 ELSE 1 END,
  @binding varbinary(32),@profile varbinary(32),@version varbinary(64)=CONVERT(binary(16),NEWID()),
  @verifier varbinary(64)=HASHBYTES('SHA2_256',CONVERT(binary(16),NEWID())),@env varchar(32)='qa',
  @now datetime2(3)=SYSUTCDATETIME(),@jobKey bigint,@ordinal bigint,@reserved bigint,@observed datetime2(3),@leaseUntil datetime2(3),@fresh datetime2(3),
  @result varchar(12),@status varchar(12),@action varchar(12)='reserve',@customerCount int=2,@companyCount int=3,
  @customers nvarchar(max)=N'[{"sourceRecordId":1,"issuer":null,"documentType":null,"token":null,"domainCandidate":null,"environmentKind":"unknown","licenseCodes":null,"testStartedOn":null,"productionStartedOn":null,"demoStartedOn":null},{"sourceRecordId":2,"issuer":null,"documentType":null,"token":null,"domainCandidate":null,"environmentKind":"test","licenseCodes":"AS","testStartedOn":null,"productionStartedOn":null,"demoStartedOn":null}]',
  @companies nvarchar(max)=N'[{"companyRecordId":1,"customerRecordId":1,"displayName":"Synthetic","isAvailable":true},{"companyRecordId":2,"customerRecordId":null,"displayName":null,"isAvailable":false},{"companyRecordId":3,"customerRecordId":999,"displayName":null,"isAvailable":null}]';
IF @case=0
BEGIN
  IF DATABASE_PRINCIPAL_ID(N'portal_catalog_v2_publisher') IS NULL
    OR (SELECT COUNT(*) FROM sys.procedures WHERE object_id IN(OBJECT_ID(N'settings.catalog_sag_v2_transition_internal'),OBJECT_ID(N'settings.reserve_catalog_sag_v2_attempt'),
      OBJECT_ID(N'settings.publish_catalog_sag_v2_revision'),OBJECT_ID(N'settings.fail_catalog_sag_v2_attempt')))<>4
    OR EXISTS(SELECT 1 FROM sys.database_role_members WHERE role_principal_id=DATABASE_PRINCIPAL_ID(N'portal_catalog_v2_publisher'))
    OR (SELECT COUNT(*) FROM sys.database_permissions WHERE class=1 AND minor_id=0 AND permission_name='EXECUTE' AND state='G'
      AND grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_catalog_v2_publisher') AND major_id IN(OBJECT_ID(N'settings.reserve_catalog_sag_v2_attempt'),
      OBJECT_ID(N'settings.publish_catalog_sag_v2_revision'),OBJECT_ID(N'settings.fail_catalog_sag_v2_attempt')))<>3
    OR EXISTS(SELECT 1 FROM sys.database_permissions WHERE class=1 AND permission_name='EXECUTE' AND state='G'
      AND major_id=OBJECT_ID(N'settings.catalog_sag_v2_transition_internal') AND grantee_principal_id IN(0,DATABASE_PRINCIPAL_ID(N'portal_runtime'),DATABASE_PRINCIPAL_ID(N'portal_catalog_v2_publisher')))
    OR (SELECT COUNT(*) FROM sys.sql_modules WHERE object_id IN(OBJECT_ID(N'settings.reserve_catalog_sag_v2_attempt'),OBJECT_ID(N'settings.publish_catalog_sag_v2_revision'),
      OBJECT_ID(N'settings.fail_catalog_sag_v2_attempt')) AND execute_as_principal_id IS NULL
      AND CHARINDEX(N'@@TRANCOUNT<>0 OR (@@OPTIONS & 2)<>0',definition)>0)<>3
    THROW 55390,N'053 metadata, execution grant or independent transaction guard mismatch.',1;
  RETURN;
END;
INSERT settings.catalog_match_key_registry(portal_environment,match_key_version,vault_secret_version,key_verifier) VALUES('qa',1,@version,@verifier);
INSERT settings.external_database_connections(source_id,display_name,server_host,database_name,login_name,password_configured,password_secret_name,created_by,updated_by)
  VALUES(@tag,@tag,N'fixture.invalid',N'synthetic',N'fixture',1,N'fixture-no-secret',N'fixture',N'fixture');
SET @profileKey=SCOPE_IDENTITY();
SELECT @profile=row_version FROM settings.external_database_connections WHERE external_database_connection_key=@profileKey;
INSERT settings.catalog_source_bindings(external_database_connection_key,display_name,source_role,portal_environment,contract_version,source_state,
  validated_at,validated_profile_version,created_by,updated_by)
  VALUES(@profileKey,@tag,'sag-admin','qa','sag_admin_v2','active',@now,@profile,N'fixture',N'fixture');
SET @sourceKey=SCOPE_IDENTITY();
SELECT @source=source_id,@binding=row_version FROM settings.catalog_source_bindings WHERE catalog_source_key=@sourceKey;
INSERT settings.catalog_source_refresh_jobs(job_id,catalog_source_key,portal_environment,binding_version,profile_version,match_key_version,provenance,
  job_status,attempt_no,requested_at,updated_at,available_at,worker_id,lease_token,lease_expires_at)
  VALUES(@job,@sourceKey,'qa',@binding,@profile,1,'timer','processing',@attempt,@now,@now,@now,@worker,@lease,DATEADD(second,120,@now));
SET @jobKey=SCOPE_IDENTITY();
INSERT settings.catalog_source_refresh_attempts(job_key,attempt_no,event_kind,occurred_at) VALUES(@jobKey,@attempt,'claimed',@now);
DECLARE @params nvarchar(max)=N'@environment varchar(32),@sourceId uniqueidentifier,@jobId uniqueidentifier,@workerId uniqueidentifier,@leaseToken uniqueidentifier,
  @attempt int,@bindingVersion varbinary(32),@profileVersion varbinary(32),@matchKeyVersion smallint,@vaultSecretVersion varbinary(64),@keyVerifier varbinary(64),
  @action varchar(12),@attemptOrdinal bigint,@customerCount int,@companyCount int,@customers nvarchar(max),@companies nvarchar(max),
  @result varchar(12) OUTPUT,@jobStatus varchar(12) OUTPUT,@reservedOrdinal bigint OUTPUT,@observedAt datetime2(3) OUTPUT,@leaseUntil datetime2(3) OUTPUT,@successFreshUntil datetime2(3) OUTPUT';
DECLARE @args nvarchar(max)=N' @environment=@environment,@sourceId=@sourceId,@jobId=@jobId,@workerId=@workerId,@leaseToken=@leaseToken,
  @attempt=@attempt,@bindingVersion=@bindingVersion,@profileVersion=@profileVersion,@matchKeyVersion=@matchKeyVersion,
  @vaultSecretVersion=@vaultSecretVersion,@keyVerifier=@keyVerifier';
DECLARE @invoke nvarchar(max)=N'EXEC settings.qa_catalog_sag_v2_transition_rehearsal'+@args+N',
  @action=@action,@attemptOrdinal=@attemptOrdinal,@customerCount=@customerCount,@companyCount=@companyCount,@customers=@customers,@companies=@companies,
  @result=@result OUTPUT,@jobStatus=@jobStatus OUTPUT,@reservedOrdinal=@reservedOrdinal OUTPUT,@observedAt=@observedAt OUTPUT,
  @leaseUntil=@leaseUntil OUTPUT,@successFreshUntil=@successFreshUntil OUTPUT;';
IF @case IN(1,2,3,4,5,6,7,8,9,10,40,41,42,43,44)
BEGIN
  IF @case IN(4,5,6,7)
    EXEC settings.qa_catalog_sag_v2_publisher_probe @case,@env,@source,@job,@worker,@lease,@attempt,@binding,@profile,1,@version,@verifier,
      @customerCount,@companyCount,@customers,@companies;
  ELSE
    EXEC settings.qa_catalog_sag_v2_runtime_probe @case,@env,@source,@job,@worker,@lease,@attempt,@binding,@profile,1,@version,@verifier,
      @customerCount,@companyCount,@customers,@companies;
  RETURN;
END;
IF @case=17 SET @lease=NEWID();
IF @case=18 SET @attempt=2;
IF @case=19 SET @verifier=HASHBYTES('SHA2_256',CONVERT(binary(16),NEWID()));
IF @case=20 SET @profile=0xFFFFFFFFFFFFFFFF;
IF @case=21 SET @env='qa ';
IF @case=22 SET @binding=0x010203040506070809;
IF @case=23 UPDATE settings.catalog_source_refresh_jobs SET lease_expires_at=DATEADD(second,-1,SYSUTCDATETIME()) WHERE job_key=@jobKey;
IF @case=24 BEGIN SET @action='publish';SET @ordinal=1;END;
IF @case=25 UPDATE settings.external_database_connections SET display_name=display_name+N'-changed' WHERE external_database_connection_key=@profileKey;
IF @case=26
BEGIN
  UPDATE settings.catalog_source_bindings SET contract_version='sag_admin_v1' WHERE catalog_source_key=@sourceKey;
  SELECT @binding=row_version FROM settings.catalog_source_bindings WHERE catalog_source_key=@sourceKey;
  UPDATE settings.catalog_source_refresh_jobs SET binding_version=@binding WHERE job_key=@jobKey;
END;
IF @case=32 SET @action='unknown';
IF @case=33 SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
IF @case=39
BEGIN
  SET @ordinal=NEXT VALUE FOR settings.catalog_customer_attempt_sequence;
  UPDATE settings.catalog_source_refresh_jobs SET attempt_ordinal=@ordinal WHERE job_key=@jobKey;
  INSERT settings.catalog_source_refresh_attempts(job_key,attempt_no,event_kind,attempt_ordinal,occurred_at)
    VALUES(@jobKey,@attempt,'reserved',@ordinal,DATEADD(second,10,SYSUTCDATETIME()));
END;
IF @case=45 SET @version=CONVERT(binary(16),NEWID());
EXEC sys.sp_executesql @invoke,@params,@env,@source,@job,@worker,@lease,@attempt,@binding,@profile,1,@version,@verifier,@action,@ordinal,
  @customerCount,@companyCount,@customers,@companies,@result OUTPUT,@status OUTPUT,@reserved OUTPUT,@observed OUTPUT,@leaseUntil OUTPUT,@fresh OUTPUT;
SET @ordinal=@reserved;
IF @case=11
BEGIN
  DECLARE @originalAt datetime2(3)=@observed,@originalOrdinal bigint=@reserved;
  EXEC sys.sp_executesql @invoke,@params,@env,@source,@job,@worker,@lease,@attempt,@binding,@profile,1,@version,@verifier,@action,@ordinal,
    @customerCount,@companyCount,@customers,@companies,@result OUTPUT,@status OUTPUT,@reserved OUTPUT,@observed OUTPUT,@leaseUntil OUTPUT,@fresh OUTPUT;
  IF @result<>'reserved' OR @reserved<>@originalOrdinal OR @observed<>@originalAt
    OR (SELECT COUNT(*) FROM settings.catalog_source_refresh_attempts WHERE job_key=@jobKey AND event_kind='reserved')<>1
    THROW 55390,N'Reserve replay changed its ordinal, clock or history.',1;
  RETURN;
END;
IF @case=13 BEGIN SET @customers=N'[]';SET @companies=N'[]';SET @customerCount=0;SET @companyCount=0;END;
IF @case=27 SET @companies=JSON_MODIFY(@companies,N'$[0].password',N'synthetic-forbidden-field');
IF @case=28 SET @companyCount=4;
IF @case=29 SET @customers=REPLACE(@customers,N'"sourceRecordId":2',N'"sourceRecordId":1');
IF @case=30 SET @companies=REPLACE(@companies,N'"isAvailable":true',N'"isAvailable":1');
IF @case=31 SET @companies=JSON_MODIFY(@companies,N'$[0].displayName',REPLICATE(N'ñ',513));
IF @case=34 EXEC(N'CREATE TRIGGER audit.qa_catalog_v2_publication_fault ON audit.audit_logs AFTER INSERT AS
  BEGIN SET NOCOUNT ON; THROW 55398,N''Synthetic audit fault.'',1; END;');
IF @case IN(35,36,37)
BEGIN
  DECLARE @higher bigint=NEXT VALUE FOR settings.catalog_customer_attempt_sequence,@higherRevision bigint;
  IF @case IN(35,37)
  BEGIN
    INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,match_key_version,attempt_ordinal,
      expected_rows,expected_scopes,observed_at,verified_until,has_sag_inventory_evidence,expected_sag_company_rows)
      VALUES(@sourceKey,'sag-admin',@binding,@profile,1,@higher,0,0,@now,DATEADD(minute,30,@now),1,0);
    SET @higherRevision=SCOPE_IDENTITY();
    UPDATE core.catalog_customer_source_revisions SET sealed_at=SYSUTCDATETIME() WHERE revision_key=@higherRevision;
  END;
  INSERT settings.catalog_customer_revision_heads(catalog_source_key,revision_key,attempt_status,attempted_at,attempt_ordinal)
    VALUES(@sourceKey,@higherRevision,CASE WHEN @case=36 THEN 'failed' ELSE 'succeeded' END,SYSUTCDATETIME(),@higher);
  IF @case=37 SET @companies=JSON_MODIFY(@companies,N'$[0].password',N'synthetic-forbidden-field');
END;
SET @action=CASE WHEN @case IN(14,15) THEN 'fail' ELSE 'publish' END;
EXEC sys.sp_executesql @invoke,@params,@env,@source,@job,@worker,@lease,@attempt,@binding,@profile,1,@version,@verifier,@action,@ordinal,
  @customerCount,@companyCount,@customers,@companies,@result OUTPUT,@status OUTPUT,@reserved OUTPUT,@observed OUTPUT,@leaseUntil OUTPUT,@fresh OUTPUT;
IF @case IN(12,13,16,38)
BEGIN
  IF @result<>'published' OR @status<>'succeeded'
    OR NOT EXISTS(SELECT 1 FROM core.catalog_customer_source_revisions WHERE catalog_source_key=@sourceKey AND sealed_at IS NOT NULL
      AND expected_rows=@customerCount AND expected_sag_company_rows=@companyCount AND expected_scopes=0)
    OR (SELECT COUNT(*) FROM core.catalog_sag_company_revision_rows c JOIN core.catalog_customer_source_revisions r ON r.revision_key=c.revision_key WHERE r.catalog_source_key=@sourceKey)<>@companyCount
    OR NOT EXISTS(SELECT 1 FROM settings.catalog_source_head_events WHERE catalog_source_key=@sourceKey AND attempt_ordinal=@ordinal AND attempt_status='succeeded')
    OR NOT EXISTS(SELECT 1 FROM audit.audit_logs WHERE entity_source_id=LOWER(CONVERT(char(36),@source)) AND performed_by=N'system:catalog-refresh' AND action=N'catalog_source_refreshed')
    OR NOT EXISTS(SELECT 1 FROM settings.catalog_source_refresh_jobs WHERE job_key=@jobKey AND job_status='succeeded' AND finished_at IS NOT NULL)
    THROW 55390,N'Positive publication did not atomically seal, advance history, audit and close the job.',1;
END;
IF @case IN(14,15)
BEGIN
  IF @result<>'failed' OR @status<>CASE WHEN @case=15 THEN 'failed' ELSE 'retry' END
    OR EXISTS(SELECT 1 FROM core.catalog_customer_source_revisions WHERE catalog_source_key=@sourceKey)
    OR NOT EXISTS(SELECT 1 FROM settings.catalog_customer_revision_heads WHERE catalog_source_key=@sourceKey AND revision_key IS NULL AND attempt_status='failed')
    OR NOT EXISTS(SELECT 1 FROM settings.catalog_source_refresh_jobs WHERE job_key=@jobKey AND job_status=@status AND (@case=15 OR DATEDIFF(second,updated_at,available_at)=30))
    OR NOT EXISTS(SELECT 1 FROM settings.catalog_source_refresh_attempts WHERE job_key=@jobKey AND event_kind=@status)
    THROW 55390,N'Failure did not preserve revision absence and the bounded job transition.',1;
END;
IF @case=16
BEGIN
  DECLARE @oldRevision bigint;SELECT @oldRevision=revision_key FROM settings.catalog_customer_revision_heads WHERE catalog_source_key=@sourceKey;
  SET @job=NEWID();SET @lease=NEWID();SET @now=SYSUTCDATETIME();SET @action='reserve';SET @ordinal=NULL;
  INSERT settings.catalog_source_refresh_jobs(job_id,catalog_source_key,portal_environment,binding_version,profile_version,match_key_version,provenance,
    job_status,attempt_no,requested_at,updated_at,available_at,worker_id,lease_token,lease_expires_at)
    VALUES(@job,@sourceKey,'qa',@binding,@profile,1,'timer','processing',1,@now,@now,@now,@worker,@lease,DATEADD(second,120,@now));
  EXEC sys.sp_executesql @invoke,@params,@env,@source,@job,@worker,@lease,@attempt,@binding,@profile,1,@version,@verifier,@action,@ordinal,
    @customerCount,@companyCount,@customers,@companies,@result OUTPUT,@status OUTPUT,@reserved OUTPUT,@observed OUTPUT,@leaseUntil OUTPUT,@fresh OUTPUT;
  SET @ordinal=@reserved;SET @action='fail';
  EXEC sys.sp_executesql @invoke,@params,@env,@source,@job,@worker,@lease,@attempt,@binding,@profile,1,@version,@verifier,@action,@ordinal,
    @customerCount,@companyCount,@customers,@companies,@result OUTPUT,@status OUTPUT,@reserved OUTPUT,@observed OUTPUT,@leaseUntil OUTPUT,@fresh OUTPUT;
  IF @result<>'failed' OR @status<>'retry' OR NOT EXISTS(SELECT 1 FROM settings.catalog_customer_revision_heads WHERE catalog_source_key=@sourceKey AND revision_key=@oldRevision AND attempt_status='failed')
    THROW 55390,N'Failure discarded the previous sealed revision.',1;
END;
IF @case IN(35,36)
  IF @result<>'superseded' OR @status<>CASE WHEN @case=35 THEN 'succeeded' ELSE 'cancelled' END
    THROW 55390,N'Superseded success was not limited to an exact fresh higher successful head.',1;
IF @case=38
  EXEC sys.sp_executesql @invoke,@params,@env,@source,@job,@worker,@lease,@attempt,@binding,@profile,1,@version,@verifier,@action,@ordinal,
    @customerCount,@companyCount,@customers,@companies,@result OUTPUT,@status OUTPUT,@reserved OUTPUT,@observed OUTPUT,@leaseUntil OUTPUT,@fresh OUTPUT;
'@
$prefix="DECLARE @ddl053 nvarchar(max)=N'"+$ddl053.Replace("'","''")+"';`nDECLARE @wrapper nvarchar(max)=N'"+$wrapper.Replace("'","''")+"';`nDECLARE @runtimeProbe nvarchar(max)=N'"+$runtimeProbe.Replace("'","''")+"';`nDECLARE @publisherProbe nvarchar(max)=N'"+$publisherProbe.Replace("'","''")+"';`nDECLARE @scenario nvarchar(max)=N'"+$scenario.Replace("'","''")+"';DECLARE @probe varchar(12)='$ProbeStage';`n"
$body=@'
SET NOCOUNT ON;SET XACT_ABORT ON;SET IMPLICIT_TRANSACTIONS OFF;
IF DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR @@TRANCOUNT<>0
  OR CAST(SERVERPROPERTY('ProductMajorVersion') AS int)<>15
  OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150)
  THROW 55391,N'Unexpected v2 publication QA target.',1;
DECLARE @jobsObject int=OBJECT_ID(N'settings.catalog_source_refresh_jobs',N'U'),@headObject int=OBJECT_ID(N'settings.catalog_source_head_events',N'U'),
  @companyObject int=OBJECT_ID(N'core.catalog_sag_company_revision_rows',N'U'),@companyColumn int=COLUMNPROPERTY(OBJECT_ID(N'core.catalog_customer_source_revisions'),N'expected_sag_company_rows','ColumnId'),
  @ledgerHash binary(32);
IF @jobsObject IS NULL OR @headObject IS NULL OR @companyObject IS NULL OR @companyColumn IS NULL
  OR COL_LENGTH(N'core.catalog_customer_source_revisions',N'expected_sag_company_rows')<>4
  OR NOT EXISTS(SELECT 1 FROM migration.schema_migrations WHERE migration_version='052' AND succeeded=1)
  OR DATABASE_PRINCIPAL_ID(N'portal_catalog_v2_publisher') IS NOT NULL
  OR DATABASE_PRINCIPAL_ID(N'qa_catalog_v2_runtime_test') IS NOT NULL OR DATABASE_PRINCIPAL_ID(N'qa_catalog_v2_publisher_test') IS NOT NULL
  OR OBJECT_ID(N'settings.qa_catalog_sag_v2_transition_rehearsal',N'P') IS NOT NULL OR OBJECT_ID(N'audit.qa_catalog_v2_publication_fault',N'TR') IS NOT NULL
  OR OBJECT_ID(N'settings.qa_catalog_sag_v2_runtime_probe',N'P') IS NOT NULL OR OBJECT_ID(N'settings.qa_catalog_sag_v2_publisher_probe',N'P') IS NOT NULL
  OR EXISTS(SELECT 1 FROM settings.catalog_source_bindings WHERE portal_environment='qa' AND source_state='active')
  OR EXISTS(SELECT 1 FROM settings.catalog_match_key_registry WHERE portal_environment='qa')
  THROW 55391,N'Requires installed052, absent053, no active QA source, key enrollment or synthetic principals.',1;
SELECT @ledgerHash=HASHBYTES('SHA2_256',CONVERT(varbinary(max),(
  SELECT migration_version,script_name,script_sha256,applied_at,applied_by,duration_ms,succeeded,error_number,error_message
  FROM migration.schema_migrations ORDER BY migration_version FOR JSON PATH,INCLUDE_NULL_VALUES)));
DECLARE @triggers table(object_id int PRIMARY KEY);INSERT @triggers SELECT object_id FROM sys.triggers WHERE is_disabled=0;
DECLARE @first int=CASE @probe WHEN 'permissions' THEN 1 WHEN 'reserve' THEN 11 WHEN 'publish' THEN 12 WHEN 'failure' THEN 14
    WHEN 'fences' THEN 17 WHEN 'payload' THEN 27 WHEN 'protocol' THEN 32 WHEN 'audit' THEN 34 WHEN 'superseded' THEN 35 WHEN 'tail' THEN 38 ELSE 0 END,
  @last int=CASE @probe WHEN 'bootstrap' THEN 0 WHEN 'permissions' THEN 10 WHEN 'reserve' THEN 11 WHEN 'publish' THEN 13 WHEN 'failure' THEN 16
    WHEN 'fences' THEN 26 WHEN 'payload' THEN 31 WHEN 'protocol' THEN 33 WHEN 'audit' THEN 34 WHEN 'superseded' THEN 37 ELSE 45 END,
  @case int,@passed int=0,@error int=0,@line int=0,@expected varchar(32),@fixtureOwner sysname=USER_NAME(),
  @started datetime2(3)=SYSUTCDATETIME(),@lock int,@fixtures int=0,@constraint sysname,@expectedCount int;
SET @case=@first;SET @expectedCount=@last-@first+1;
WHILE @case<=@last
BEGIN
  SET @error=0;SET @line=0;SET @constraint=NULL;
  SET @expected=CASE WHEN @case IN(0,11,12,13,14,15,16,35,36) THEN '0'
    WHEN @case IN(1,2,3,4,8,9,10,40,41,42,43,44) THEN '229'
    WHEN @case IN(5,6,7) THEN '55309'
    WHEN @case IN(17,18,19,20,23,24,25,26,38,39,45) THEN '55307'
    WHEN @case IN(21,22,32) THEN '55305'
    WHEN @case IN(27,28,30,31,37) THEN '55308'
    WHEN @case=29 THEN '2627,2601'
    WHEN @case=33 THEN '55304'
    WHEN @case=34 THEN '55398' ELSE '55399' END;
  EXEC sys.sp_set_session_context @key=N'portal_qa_v2_publication_step',@value=@case;
  BEGIN TRY
    SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;BEGIN TRANSACTION;
    EXEC @lock=sys.sp_getapplock @Resource=N'portal-sag:catalog-customer-publication:qa',@LockMode=N'Exclusive',@LockOwner=N'Transaction',@LockTimeout=5000;
    IF @lock<0 THROW 55392,N'QA publication lock unavailable.',1;
    EXEC sys.sp_executesql @ddl053;
    IF @case=0 EXEC sys.sp_executesql @ddl053;
    IF @case<>0
    BEGIN
      CREATE USER qa_catalog_v2_runtime_test WITHOUT LOGIN;
      CREATE USER qa_catalog_v2_publisher_test WITHOUT LOGIN;
      ALTER ROLE portal_runtime ADD MEMBER qa_catalog_v2_runtime_test;
      ALTER ROLE portal_catalog_v2_publisher ADD MEMBER qa_catalog_v2_publisher_test;
      EXEC sys.sp_executesql @wrapper;
      EXEC sys.sp_executesql @runtimeProbe;
      EXEC sys.sp_executesql @publisherProbe;
      IF (SELECT COUNT(*) FROM sys.sql_modules WHERE object_id IN(OBJECT_ID(N'settings.qa_catalog_sag_v2_transition_rehearsal'),OBJECT_ID(N'settings.qa_catalog_sag_v2_publisher_probe'))
          AND execute_as_principal_id=DATABASE_PRINCIPAL_ID(N'qa_catalog_v2_publisher_test'))<>2
        OR (SELECT COUNT(*) FROM sys.sql_modules WHERE object_id=OBJECT_ID(N'settings.qa_catalog_sag_v2_runtime_probe')
          AND execute_as_principal_id=DATABASE_PRINCIPAL_ID(N'qa_catalog_v2_runtime_test'))<>1
        THROW 55390,N'QA modules do not have their exact synthetic low-privilege contexts.',1;
    END;
    EXEC sys.sp_executesql @scenario,N'@case int',@case;
    ROLLBACK TRANSACTION;
  END TRY
  BEGIN CATCH
    SET @error=ERROR_NUMBER();SET @line=ERROR_LINE();
    -- Module contexts have already unwound. Only the original caller rolls
    -- back; no impersonated module drops its own principal or owns cleanup.
    IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
    IF ISNULL(USER_NAME(),N'')<>@fixtureOwner THROW 55395,N'QA module did not restore the original execution context.',1;
    SELECT TOP(1) @constraint=name FROM sys.objects WHERE type IN('C','F','UQ','PK') AND CHARINDEX(name,ERROR_MESSAGE())>0 ORDER BY LEN(name) DESC;
  END CATCH;
  IF ISNULL(USER_NAME(),N'')<>@fixtureOwner THROW 55395,N'QA module did not restore the original execution context.',1;
  SELECT @fixtures=(SELECT COUNT(*) FROM settings.external_database_connections WHERE source_id LIKE N'qa-v2-publish-%')
    +(SELECT COUNT(*) FROM settings.catalog_source_bindings WHERE display_name LIKE N'qa-v2-publish-%')
    +(SELECT COUNT(*) FROM settings.catalog_match_key_registry WHERE portal_environment='qa');
  IF @@TRANCOUNT<>0 OR @fixtures<>0 OR ISNULL(COL_LENGTH(N'core.catalog_customer_source_revisions',N'expected_sag_company_rows'),-1)<>4
    OR ISNULL(COLUMNPROPERTY(OBJECT_ID(N'core.catalog_customer_source_revisions'),N'expected_sag_company_rows','ColumnId'),-1)<>@companyColumn
    OR ISNULL(OBJECT_ID(N'core.catalog_sag_company_revision_rows',N'U'),-1)<>@companyObject
    OR @ledgerHash<>HASHBYTES('SHA2_256',CONVERT(varbinary(max),(
      SELECT migration_version,script_name,script_sha256,applied_at,applied_by,duration_ms,succeeded,error_number,error_message
      FROM migration.schema_migrations ORDER BY migration_version FOR JSON PATH,INCLUDE_NULL_VALUES)))
    OR DATABASE_PRINCIPAL_ID(N'portal_catalog_v2_publisher') IS NOT NULL
    OR DATABASE_PRINCIPAL_ID(N'qa_catalog_v2_runtime_test') IS NOT NULL OR DATABASE_PRINCIPAL_ID(N'qa_catalog_v2_publisher_test') IS NOT NULL
    OR OBJECT_ID(N'settings.qa_catalog_sag_v2_transition_rehearsal',N'P') IS NOT NULL OR OBJECT_ID(N'audit.qa_catalog_v2_publication_fault',N'TR') IS NOT NULL
    OR OBJECT_ID(N'settings.qa_catalog_sag_v2_runtime_probe',N'P') IS NOT NULL OR OBJECT_ID(N'settings.qa_catalog_sag_v2_publisher_probe',N'P') IS NOT NULL
    OR OBJECT_ID(N'settings.reserve_catalog_sag_v2_attempt',N'P') IS NOT NULL OR OBJECT_ID(N'settings.publish_catalog_sag_v2_revision',N'P') IS NOT NULL
    OR OBJECT_ID(N'settings.fail_catalog_sag_v2_attempt',N'P') IS NOT NULL OR OBJECT_ID(N'settings.catalog_sag_v2_transition_internal',N'P') IS NOT NULL
    OR OBJECT_ID(N'settings.catalog_source_refresh_jobs',N'U')<>@jobsObject OR OBJECT_ID(N'settings.catalog_source_head_events',N'U')<>@headObject
    OR EXISTS(SELECT 1 FROM @triggers t LEFT JOIN sys.triggers actual ON actual.object_id=t.object_id WHERE actual.object_id IS NULL OR actual.is_disabled=1)
  BEGIN SET @error=55393;BREAK;END;
  IF NOT EXISTS(SELECT 1 FROM STRING_SPLIT(@expected,',') WHERE TRY_CONVERT(int,value)=@error) BREAK;
  SET @passed+=1;SET @case+=1;
END;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
EXEC sys.sp_set_session_context @key=N'portal_qa_v2_publication_step',@value=NULL;
SELECT @passed AS passed,CASE WHEN @passed=@expectedCount THEN 0 WHEN @error=0 THEN 55394 ELSE @error END AS error_number,
  CASE WHEN @passed=@expectedCount THEN 0 ELSE @case END AS error_case,@line AS error_line,@constraint AS error_constraint,
  @fixtures AS fixture_rows_remaining,@probe AS probe_stage,DATEDIFF_BIG(millisecond,@started,SYSUTCDATETIME()) AS elapsed_ms;
'@
if(($wrapper+$runtimeProbe+$publisherProbe+$scenario+$body) -match '(?i)\bEXEC(?:UTE)?\s+AS\s+USER\b|\bREVERT\b'){
  throw 'QA SQL must use module-scoped contexts only.'
}
$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
$response=(& $invoke -SessionDirectory $session -Sql ($prefix+$body) -Mode write -TimeoutSeconds $SqlTimeoutSeconds -MaxRows 1) | ConvertFrom-Json -Depth 14
$sets=@($response.resultSets);$row=if($sets.Count){$sets[-1].rows[0]}else{$null}
$expectedPassed=switch($ProbeStage){
  'bootstrap'{1};'permissions'{10};'reserve'{1};'publish'{2};'failure'{3};'fences'{10};'payload'{5};'protocol'{2};'audit'{1};'superseded'{3};'tail'{8};default{46}
}
if(!$response.success -or $row.passed -ne $expectedPassed -or $row.error_number -ne 0 -or $row.fixture_rows_remaining -ne 0){
  $constraint=if($row.error_constraint -match '^[A-Za-z0-9_]+$'){$row.error_constraint}else{'not available'}
  throw "V2 publication QA failed (SQL: $([int]$row.error_number); case: $([int]$row.error_case); line: $([int]$row.error_line); passed: $([int]$row.passed); constraint: $constraint)."
}
$row | Select-Object passed,error_number,error_case,fixture_rows_remaining,probe_stage,elapsed_ms | ConvertTo-Json -Compress
