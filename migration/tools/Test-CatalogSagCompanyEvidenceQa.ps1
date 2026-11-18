[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$SessionDirectory,
  [ValidateSet('all','bootstrap')][string]$ProbeStage='all',
  [ValidateRange(10,90)][int]$SqlTimeoutSeconds=90
)
$ErrorActionPreference='Stop'
$session=(Resolve-Path -LiteralPath $SessionDirectory).Path
$descriptor=Get-Content -LiteralPath (Join-Path $session 'active.json') -Raw | ConvertFrom-Json
if($descriptor.database -cne 'PortalSAGWeb-TEST' -or $descriptor.environment -cne 'qa' -or $descriptor.accessLevel -cne 'full-control'){
  throw 'Company evidence rehearsal requires the authorized full-control PortalSAGWeb-TEST session.'
}
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$migration=Get-Content -LiteralPath (Join-Path $root 'migration/sql/052_catalog_sag_company_evidence.sql') -Raw
# No external source is queried. Each intended trigger failure owns an entire
# transaction: XACT_ABORT may doom it, so no savepoint is reused after a THROW.
# Synthetic key verifiers are generated inside SQL and are never returned.
# This is not a two-session insert/seal race or runtime publisher certificate.
$scenario=@'
SET NOCOUNT ON;
DECLARE @tag nvarchar(72)=N'qa-company-'+LOWER(CONVERT(char(36),NEWID())),@source bigint,@profile bigint,@revision bigint,
  @ordinal bigint,@version binary(8),@binding binary(8),@now datetime2(3)=SYSUTCDATETIME(),@until datetime2(3)=DATEADD(minute,30,SYSUTCDATETIME()),
  @role varchar(15)=CASE WHEN @case=6 THEN 'erp-customers' ELSE 'sag-admin' END,
  @contract varchar(40)=CASE WHEN @case IN(1,9,26) THEN 'sag_admin_v1' WHEN @case=6 THEN 'erp_v1'
    WHEN @case=10 THEN 'SAG_ADMIN_V2' WHEN @case=11 THEN 'sag_admin_v2 ' ELSE 'sag_admin_v2' END,
  @hasInventory bit=CASE WHEN @case IN(6,7) THEN 0 ELSE 1 END,
  @customers int=CASE WHEN @case IN(3,32,33) THEN 1 WHEN @case=8 THEN 100000 ELSE 0 END,
  @companies int=CASE WHEN @case IN(1,12,13,26) THEN NULL WHEN @case=3 THEN 3 WHEN @case=4 THEN -1 WHEN @case=5 THEN 100001
    WHEN @case IN(8,16,17,19,20,23,24,25,29,30) THEN 1 ELSE 0 END;
IF @case=0
BEGIN
  IF (SELECT COUNT(*) FROM sys.columns WHERE object_id=OBJECT_ID(N'core.catalog_customer_source_revisions') AND name=N'expected_sag_company_rows'
      AND system_type_id=56 AND is_nullable=1 AND default_object_id=0)<>1
    OR (SELECT COUNT(*) FROM sys.columns WHERE object_id=OBJECT_ID(N'core.catalog_sag_company_revision_rows'))<>5
    OR (SELECT COUNT(*) FROM sys.check_constraints WHERE object_id=OBJECT_ID(N'core.CK_catalog_sag_company_revision_count') AND is_disabled=0 AND is_not_trusted=0)<>1
    OR (SELECT COUNT(*) FROM sys.foreign_keys WHERE parent_object_id=OBJECT_ID(N'core.catalog_sag_company_revision_rows') AND is_disabled=0 AND is_not_trusted=0
      AND name=N'FK_catalog_sag_company_revision_parent' AND referenced_object_id=OBJECT_ID(N'core.catalog_customer_source_revisions'))<>1
    OR (SELECT COUNT(*) FROM sys.indexes WHERE object_id=OBJECT_ID(N'core.catalog_sag_company_revision_rows') AND name=N'PK_catalog_sag_company_revision_rows' AND is_primary_key=1)<>1
    OR (SELECT COUNT(*) FROM sys.triggers WHERE object_id IN(OBJECT_ID(N'core.TR_catalog_sag_company_revision_rows_guard'),OBJECT_ID(N'core.TR_catalog_sag_company_revision_seal')) AND is_disabled=0)<>2
    OR (SELECT COUNT(*) FROM sys.database_permissions WHERE class=1 AND minor_id=0 AND grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime')
      AND major_id=OBJECT_ID(N'core.catalog_sag_company_revision_rows') AND permission_name IN('INSERT','UPDATE','DELETE') AND state='D')<>3
    OR EXISTS(SELECT 1 FROM core.catalog_customer_source_revisions WHERE expected_sag_company_rows IS NOT NULL)
    THROW 55290,N'052 apply/reapply shape, permissions or legacy NULL assertion failed.',1;
  RETURN;
END;
INSERT settings.catalog_match_key_registry(portal_environment,match_key_version,vault_secret_version,key_verifier)
  VALUES('qa',1,CONVERT(binary(16),NEWID()),HASHBYTES('SHA2_256',CONVERT(binary(16),NEWID())));
INSERT settings.external_database_connections(source_id,display_name,server_host,database_name,login_name,password_configured,password_secret_name,created_by,updated_by)
  VALUES(@tag,@tag,N'fixture.invalid',N'synthetic',N'fixture',1,N'fixture-no-secret',N'fixture',N'fixture');
SET @profile=SCOPE_IDENTITY();
SELECT @version=row_version FROM settings.external_database_connections WHERE external_database_connection_key=@profile;
INSERT settings.catalog_source_bindings(external_database_connection_key,display_name,source_role,portal_environment,contract_version,
  source_state,issuer_scope,validated_at,validated_profile_version,created_by,updated_by)
  VALUES(@profile,@tag,@role,'qa',@contract,'active',CASE WHEN @role='erp-customers' THEN N'CO:NIT' END,@now,@version,N'fixture',N'fixture');
SET @source=SCOPE_IDENTITY();
SELECT @binding=row_version FROM settings.catalog_source_bindings WHERE catalog_source_key=@source;
SET @ordinal=NEXT VALUE FOR settings.catalog_customer_attempt_sequence;
INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,match_key_version,attempt_ordinal,
  expected_rows,expected_scopes,observed_at,verified_until,has_sag_inventory_evidence,expected_sag_company_rows)
  VALUES(@source,@role,@binding,@version,1,@ordinal,@customers,0,@now,@until,@hasInventory,@companies);
SET @revision=SCOPE_IDENTITY();
IF @case IN(3,32)
BEGIN
  INSERT core.catalog_customer_revision_rows(revision_key,source_role,source_record_id) VALUES(@revision,'sag-admin',1);
  IF @case=3 INSERT core.catalog_sag_revision_evidence(revision_key,source_record_id,environment_kind) VALUES(@revision,1,'unknown');
END;
IF @case=3
  INSERT core.catalog_sag_company_revision_rows(revision_key,company_record_id,customer_record_id,display_name,is_available)
    VALUES(@revision,0,1,N'Synthetic valid parent',1),(@revision,-2147483648,NULL,NULL,NULL),(@revision,2147483647,-999,N'Synthetic orphan',0);
IF @case IN(16,17,19,20,25,30)
  INSERT core.catalog_sag_company_revision_rows(revision_key,company_record_id,customer_record_id,display_name,is_available)
    VALUES(@revision,1,NULL,NULL,NULL);
IF @case=24
  INSERT core.catalog_sag_company_revision_rows(revision_key,company_record_id,customer_record_id,display_name,is_available)
    VALUES(@revision,1,NULL,NULL,NULL),(@revision,2,-999,NULL,0);
IF @case IN(1,2,3,18,19,20,22,30,31)
  UPDATE core.catalog_customer_source_revisions SET sealed_at=SYSUTCDATETIME() WHERE revision_key=@revision;
IF @case IN(1,2,3)
BEGIN
  INSERT settings.catalog_customer_revision_heads(catalog_source_key,revision_key,attempt_status,attempted_at,attempt_ordinal)
    VALUES(@source,@revision,'succeeded',SYSUTCDATETIME(),@ordinal);
  IF NOT EXISTS(SELECT 1 FROM settings.catalog_source_head_events WHERE catalog_source_key=@source AND revision_key=@revision AND attempt_status='succeeded')
    OR (@case=1 AND EXISTS(SELECT 1 FROM core.catalog_customer_source_revisions WHERE revision_key=@revision AND expected_sag_company_rows IS NOT NULL))
    OR (@case=3 AND ((SELECT COUNT(*) FROM core.catalog_sag_company_revision_rows WHERE revision_key=@revision)<>3
      OR NOT EXISTS(SELECT 1 FROM core.catalog_sag_company_revision_rows WHERE revision_key=@revision AND customer_record_id IS NULL AND is_available IS NULL)
      OR NOT EXISTS(SELECT 1 FROM core.catalog_sag_company_revision_rows WHERE revision_key=@revision AND customer_record_id=-999 AND is_available=0)))
    THROW 55290,N'Positive Company revision, nullable/orphan lineage or head event mismatch.',1;
END;
IF @case=12 UPDATE core.catalog_customer_source_revisions SET sealed_at=SYSUTCDATETIME() WHERE revision_key=@revision;
IF @case=13 UPDATE core.catalog_customer_source_revisions SET expected_sag_company_rows=0 WHERE revision_key=@revision;
IF @case=14 UPDATE core.catalog_customer_source_revisions SET expected_sag_company_rows=NULL WHERE revision_key=@revision;
IF @case=15 UPDATE core.catalog_customer_source_revisions SET expected_sag_company_rows=1 WHERE revision_key=@revision;
IF @case IN(16,19) UPDATE core.catalog_sag_company_revision_rows SET display_name=N'Changed' WHERE revision_key=@revision;
IF @case IN(17,20) DELETE core.catalog_sag_company_revision_rows WHERE revision_key=@revision;
IF @case IN(18,26) INSERT core.catalog_sag_company_revision_rows(revision_key,company_record_id) VALUES(@revision,1);
IF @case IN(21,22) DELETE core.catalog_customer_source_revisions WHERE revision_key=@revision;
IF @case IN(23,24,32,33) UPDATE core.catalog_customer_source_revisions SET sealed_at=SYSUTCDATETIME() WHERE revision_key=@revision;
IF @case=25 INSERT core.catalog_sag_company_revision_rows(revision_key,company_record_id) VALUES(@revision,1);
IF @case=27 INSERT core.catalog_sag_company_revision_rows(revision_key,company_record_id) VALUES(-9223372036854775807,1);
IF @case=28 INSERT settings.catalog_customer_revision_heads(catalog_source_key,revision_key,attempt_status,attempted_at,attempt_ordinal)
  VALUES(@source,@revision,'succeeded',SYSUTCDATETIME(),@ordinal);
IF @case=29 UPDATE core.catalog_customer_source_revisions SET expected_sag_company_rows=0,sealed_at=SYSUTCDATETIME() WHERE revision_key=@revision;
IF @case=30
BEGIN
  DECLARE @second bigint;
  SET @ordinal=NEXT VALUE FOR settings.catalog_customer_attempt_sequence;
  INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,match_key_version,attempt_ordinal,
    expected_rows,expected_scopes,observed_at,verified_until,has_sag_inventory_evidence,expected_sag_company_rows)
    VALUES(@source,'sag-admin',@binding,@version,1,@ordinal,0,0,@now,@until,1,1);
  SET @second=SCOPE_IDENTITY();
  INSERT core.catalog_sag_company_revision_rows(revision_key,company_record_id,customer_record_id,is_available) VALUES(@second,1,-999,0);
  UPDATE core.catalog_customer_source_revisions SET sealed_at=SYSUTCDATETIME() WHERE revision_key=@second;
  IF (SELECT COUNT(*) FROM core.catalog_sag_company_revision_rows WHERE revision_key IN(@revision,@second) AND company_record_id=1)<>2
    THROW 55290,N'Company identity could not recur in a different immutable revision.',1;
END;
IF @case=31 UPDATE core.catalog_customer_source_revisions SET expected_rows=1 WHERE revision_key=@revision;
'@
$prefix="DECLARE @migration nvarchar(max)=N'"+$migration.Replace("'","''")+"';`nDECLARE @scenario nvarchar(max)=N'"+$scenario.Replace("'","''")+"';`nDECLARE @probe varchar(12)='$ProbeStage';`n"
$body=@'
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR @@TRANCOUNT<>0
  OR CAST(SERVERPROPERTY('ProductMajorVersion') AS int)<>15
  OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150)
  THROW 55291,N'Unexpected Company evidence QA target.',1;
DECLARE @jobsObject int=OBJECT_ID(N'settings.catalog_source_refresh_jobs',N'U'),@headObject int=OBJECT_ID(N'settings.catalog_source_head_events',N'U');
IF @jobsObject IS NULL OR @headObject IS NULL OR COL_LENGTH(N'core.catalog_customer_source_revisions',N'expected_sag_company_rows') IS NOT NULL
  OR OBJECT_ID(N'core.catalog_sag_company_revision_rows',N'U') IS NOT NULL
  OR EXISTS(SELECT 1 FROM settings.catalog_source_bindings WHERE portal_environment='qa' AND source_state='active')
  OR EXISTS(SELECT 1 FROM settings.catalog_match_key_registry WHERE portal_environment='qa')
  THROW 55291,N'Requires installed051, absent052, no active QA source and no QA key enrollment.',1;
DECLARE @triggers table(object_id int PRIMARY KEY);
INSERT @triggers SELECT object_id FROM sys.triggers WHERE is_disabled=0;
DECLARE @case int=0,@last int=CASE WHEN @probe='bootstrap' THEN 0 ELSE 33 END,@passed int=0,@error int=0,@line int=0,@expected varchar(50),
  @started datetime2(3)=SYSUTCDATETIME(),@lock int,@fixtures int=0,@constraint sysname;
WHILE @case<=@last
BEGIN
  SET @error=0; SET @line=0; SET @constraint=NULL;
  SET @expected=CASE
    WHEN @case IN(0,1,2,3,30) THEN '0'
    WHEN @case IN(4,5,6,7,8,27) THEN '547'
    WHEN @case IN(9,10,11,12) THEN '55207'
    WHEN @case IN(13,14,15,29) THEN '55206'
    WHEN @case IN(16,17,19,20) THEN '55204'
    WHEN @case IN(18,26) THEN '55205'
    WHEN @case=21 THEN '55209'
    WHEN @case=22 THEN '55209,53301'
    WHEN @case IN(23,24) THEN '55208'
    WHEN @case=25 THEN '2627,2601'
    WHEN @case=28 THEN '53306'
    WHEN @case=31 THEN '53301,53302,53503'
    WHEN @case=32 THEN '53503'
    WHEN @case=33 THEN '53302,53503'
    ELSE '55299' END;
  EXEC sys.sp_set_session_context @key=N'portal_qa_company_evidence_step',@value=@case;
  BEGIN TRY
    BEGIN TRANSACTION;
    EXEC @lock=sys.sp_getapplock @Resource=N'portal-sag:catalog-customer-publication:qa',@LockMode=N'Exclusive',@LockOwner=N'Transaction',@LockTimeout=5000;
    IF @lock<0 THROW 55292,N'QA publication lock unavailable.',1;
    EXEC sys.sp_executesql @migration;
    IF @case=0 EXEC sys.sp_executesql @migration;
    EXEC sys.sp_executesql @scenario,N'@case int',@case;
    ROLLBACK TRANSACTION;
  END TRY
  BEGIN CATCH
    SET @error=ERROR_NUMBER();SET @line=ERROR_LINE();
    SELECT TOP(1) @constraint=name FROM sys.objects WHERE type IN('C','F','UQ','PK') AND CHARINDEX(name,ERROR_MESSAGE())>0 ORDER BY LEN(name) DESC;
    IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  END CATCH;
  SELECT @fixtures=(SELECT COUNT(*) FROM settings.external_database_connections WHERE source_id LIKE N'qa-company-%')
    +(SELECT COUNT(*) FROM settings.catalog_source_bindings WHERE display_name LIKE N'qa-company-%')
    +(SELECT COUNT(*) FROM settings.catalog_match_key_registry WHERE portal_environment='qa');
  IF @@TRANCOUNT<>0 OR OBJECT_ID(N'core.catalog_sag_company_revision_rows',N'U') IS NOT NULL
    OR COL_LENGTH(N'core.catalog_customer_source_revisions',N'expected_sag_company_rows') IS NOT NULL
    OR OBJECT_ID(N'settings.catalog_source_refresh_jobs',N'U')<>@jobsObject
    OR OBJECT_ID(N'settings.catalog_source_head_events',N'U')<>@headObject
    OR EXISTS(SELECT 1 FROM @triggers t LEFT JOIN sys.triggers actual ON actual.object_id=t.object_id WHERE actual.object_id IS NULL OR actual.is_disabled=1)
    OR @fixtures<>0
  BEGIN SET @error=55293;BREAK;END;
  IF NOT EXISTS(SELECT 1 FROM STRING_SPLIT(@expected,',') WHERE TRY_CONVERT(int,value)=@error) BREAK;
  SET @passed+=1;SET @case+=1;
END;
EXEC sys.sp_set_session_context @key=N'portal_qa_company_evidence_step',@value=NULL;
SELECT @passed AS passed,CASE WHEN @passed=@last+1 THEN 0 WHEN @error=0 THEN 55294 ELSE @error END AS error_number,
  CASE WHEN @passed=@last+1 THEN 0 ELSE @case END AS error_case,@line AS error_line,@constraint AS error_constraint,
  @fixtures AS fixture_rows_remaining,@probe AS probe_stage,DATEDIFF_BIG(millisecond,@started,SYSUTCDATETIME()) AS elapsed_ms;
'@
$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
$response=(& $invoke -SessionDirectory $session -Sql ($prefix+$body) -Mode write -TimeoutSeconds $SqlTimeoutSeconds -MaxRows 1) | ConvertFrom-Json -Depth 14
$sets=@($response.resultSets);$row=if($sets.Count){$sets[-1].rows[0]}else{$null}
$expectedPassed=if($ProbeStage -eq 'bootstrap'){1}else{34}
if(!$response.success -or $row.passed -ne $expectedPassed -or $row.error_number -ne 0 -or $row.fixture_rows_remaining -ne 0){
  $constraint=if($row.error_constraint -match '^[A-Za-z0-9_]+$'){$row.error_constraint}else{'not available'}
  throw "Company evidence QA failed (SQL: $([int]$row.error_number); case: $([int]$row.error_case); line: $([int]$row.error_line); passed: $([int]$row.passed); constraint: $constraint)."
}
$row | Select-Object passed,error_number,error_case,fixture_rows_remaining,probe_stage,elapsed_ms | ConvertTo-Json -Compress
