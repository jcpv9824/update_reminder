[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SessionDirectory,[switch]$OperatorWriter)

$ErrorActionPreference='Stop'
$session=(Resolve-Path -LiteralPath $SessionDirectory).Path
$descriptor=Get-Content -Raw -LiteralPath (Join-Path $session 'active.json') | ConvertFrom-Json
if($descriptor.database -cne 'PortalSAGWeb-TEST' -or ($descriptor.environment -and $descriptor.environment -cne 'qa')){
  throw 'This rehearsal requires the PortalSAGWeb-TEST session.'
}

$fixture=@'
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR @@TRANCOUNT<>0
  THROW 54280,N'Wrong database or transaction.',1;
IF OBJECT_ID(N'core.catalog_operational_link_evidence',N'V') IS NULL
  THROW 54281,N'Install the operational link migration before this rehearsal.',1;

DECLARE @tag nvarchar(72)=N'qa-oplink-'+LOWER(CONVERT(char(36),NEWID()));
DECLARE @actor nvarchar(150)=N'qa-operational-link-fixture';
DECLARE @stamp datetime2(3)=SYSUTCDATETIME(),@checkedAt datetime2(3),@validUntil datetime2(3);
DECLARE @client bigint,@domain bigint,@database bigint,@operationalProfile bigint,@externalProfile bigint;
DECLARE @source bigint,@customer bigint,@otherCustomer bigint,@owner bigint,@domainLink bigint,@databaseLink bigint,@wrongLink bigint;
DECLARE @domainId uniqueidentifier=NEWID(),@databaseId uniqueidentifier=NEWID(),@wrongId uniqueidentifier=NEWID();
DECLARE @binding binary(8),@profile binary(8),@revision bigint,@keyVersion smallint,@lock int;
DECLARE @fixtureVaultVersion binary(16)=CONVERT(binary(16),NEWID()),@passed int=0;
DECLARE @scenario int=1,@expectedError int,@retiredInsertRejections int=0;
DECLARE @future datetime2(3)=DATEADD(day,1,@stamp),@registerStart datetime2(3),@registerEnd datetime2(3);
DECLARE @legacyViewStamp datetime2(3),@legacyViewDeadline datetime2(7);
DECLARE @otherClient bigint,@retiredOwner bigint;
-- Reserve a fixture-only range without advancing the live attempt sequence.
DECLARE @attempt bigint=9223372036854770000+ABS(CONVERT(bigint,CHECKSUM(NEWID())))%5000;

-- Trigger throws doom their transaction. Test the two pre-retired inserts in
-- separate synthetic transactions before the full normal/authorization path.
WHILE @scenario<=3
BEGIN
SET @expectedError=NULL;
SET @keyVersion=NULL;
BEGIN TRY
  BEGIN TRANSACTION;
  EXEC @lock=sys.sp_getapplock @Resource=N'portal-sag:catalog-customer-publication:qa',@LockMode=N'Exclusive',
    @LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock<0 THROW 54282,N'Could not reserve QA fixture publication.',1;
  IF EXISTS (SELECT 1 FROM core.catalog_customer_source_revisions WHERE attempt_ordinal BETWEEN @attempt AND @attempt+5)
    THROW 54283,N'Fixture attempt ordinal collided; rerun with a fresh fixture.',1;
  SELECT @keyVersion=match_key_version FROM settings.catalog_match_key_registry WHERE portal_environment='qa';
  IF @keyVersion IS NULL
  BEGIN
    SET @keyVersion=1;
    INSERT settings.catalog_match_key_registry(portal_environment,match_key_version,vault_secret_version,key_verifier)
      VALUES('qa',@keyVersion,@fixtureVaultVersion,HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag)));
  END;

  INSERT core.clients(source_id,name,name_normalized,status,created_at,created_by,updated_at,updated_by)
    VALUES(@tag,@tag,@tag,'active',@stamp,@actor,@stamp,@actor);
  SET @client=SCOPE_IDENTITY();
  INSERT core.domains(source_id,client_key,domain_name,domain_name_normalized,environment_id,status,created_at,created_by,updated_at,updated_by)
    VALUES(@tag+N'-domain',@client,N'https://'+@tag+N'.invalid',N'https://'+@tag+N'.invalid','test','active',@stamp,@actor,@stamp,@actor);
  SET @domain=SCOPE_IDENTITY();
  INSERT core.database_access_profiles(source_id,server_host_port,initial_catalog,sql_user_id,password_secret_name,
    connection_fingerprint,created_at,created_by,updated_at,updated_by)
    VALUES(@tag+N'-profile',N'fixture.invalid,1433',N'fixture',N'fixture',N'fixture-no-key',
      HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag+N'-profile')),@stamp,@actor,@stamp,@actor);
  SET @operationalProfile=SCOPE_IDENTITY();
  INSERT core.databases(source_id,client_key,domain_key,access_profile_key,company_name,company_name_normalized,environment_id,
    status,created_at,created_by,updated_at,updated_by)
    VALUES(@tag+N'-database',@client,@domain,@operationalProfile,@tag,@tag,'test','active',@stamp,@actor,@stamp,@actor);
  SET @database=SCOPE_IDENTITY();

  INSERT settings.external_database_connections(source_id,display_name,server_host,database_name,login_name,
    password_configured,password_secret_name,created_by,updated_by)
    VALUES(@tag,@tag,N'fixture.invalid',N'fixture',N'fixture',1,N'fixture-no-key',@actor,@actor);
  SET @externalProfile=SCOPE_IDENTITY();
  SELECT @profile=row_version FROM settings.external_database_connections WHERE external_database_connection_key=@externalProfile;
  INSERT settings.catalog_source_bindings(external_database_connection_key,display_name,source_role,portal_environment,
    contract_version,source_state,issuer_scope,validated_at,validated_profile_version,created_by,updated_by)
    VALUES(@externalProfile,@tag,'erp-customers','qa','erp_v1','active',N'CO:NIT',@stamp,@profile,@actor,@actor);
  SET @source=SCOPE_IDENTITY();
  SELECT @binding=row_version FROM settings.catalog_source_bindings WHERE catalog_source_key=@source;
  INSERT core.catalog_customer_ids DEFAULT VALUES;
  SET @customer=SCOPE_IDENTITY();
  INSERT core.catalog_customer_ids DEFAULT VALUES;
  SET @otherCustomer=SCOPE_IDENTITY();

  -- Phase 1: two exact active records, one for each kind of local link.
  SET @checkedAt=SYSUTCDATETIME();
  SET @validUntil=DATEADD(minute,3,@checkedAt);
  INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,match_key_version,
    attempt_ordinal,expected_rows,expected_scopes,observed_at,verified_until)
    VALUES(@source,'erp-customers',@binding,@profile,@keyVersion,@attempt,2,0,@checkedAt,@validUntil);
  SET @revision=SCOPE_IDENTITY();
  INSERT core.catalog_customer_revision_rows(revision_key,source_role,source_record_id,catalog_customer_key,official_name,active_code)
    VALUES(@revision,'erp-customers',1,@customer,N'QA fixture','S'),(@revision,'erp-customers',2,@customer,N'QA fixture','S');
  UPDATE core.catalog_customer_source_revisions SET sealed_at=@checkedAt WHERE revision_key=@revision;
  INSERT settings.catalog_customer_revision_heads(catalog_source_key,revision_key,attempt_status,attempted_at,attempt_ordinal)
    VALUES(@source,@revision,'succeeded',@checkedAt,@attempt);

  IF @scenario=1
  BEGIN
    SET @expectedError=54205;
    INSERT core.catalog_operational_owners(portal_environment,catalog_customer_key,client_key,registered_by,registered_at,retired_at)
      VALUES('qa',@customer,@client,@actor,@stamp,@stamp);
    THROW 54293,N'An operational owner was registered as already retired.',1;
  END;
  SET @registerStart=SYSUTCDATETIME();
  INSERT core.catalog_operational_owners(portal_environment,catalog_customer_key,client_key,registered_by,registered_at)
    VALUES('qa',@customer,@client,@actor,@future);
  SELECT @owner=owner_key FROM core.catalog_operational_owners
    WHERE portal_environment='qa' AND catalog_customer_key=@customer AND client_key=@client;
  IF @scenario=2
  BEGIN
    SET @expectedError=54206;
    INSERT core.catalog_operational_links(link_id,owner_key,portal_environment,client_key,domain_key,database_key,
      catalog_source_key,source_record_id,target_kind,link_environment,registered_by,registered_at,retired_at)
      VALUES(@domainId,@owner,'qa',@client,@domain,NULL,@source,1,'domain','test',@actor,@stamp,@stamp);
    THROW 54294,N'An operational link was registered as already retired.',1;
  END;
  INSERT core.catalog_operational_links(link_id,owner_key,portal_environment,client_key,domain_key,database_key,
    catalog_source_key,source_record_id,target_kind,link_environment,registered_by,registered_at)
    VALUES(@domainId,@owner,'qa',@client,@domain,NULL,@source,1,'domain','test',@actor,@future),
      (@databaseId,@owner,'qa',@client,@domain,@database,@source,2,'database','test',@actor,@future);
  SET @registerEnd=SYSUTCDATETIME();
  SELECT @domainLink=link_key FROM core.catalog_operational_links WHERE link_id=@domainId;
  SELECT @databaseLink=link_key FROM core.catalog_operational_links WHERE link_id=@databaseId;
  IF @domainLink IS NULL OR @databaseLink IS NULL OR EXISTS(
    SELECT 1 FROM core.catalog_operational_link_evidence WHERE link_id IN (@domainId,@databaseId) AND evidence_state='verified'
  ) THROW 54284,N'Unapproved operational links were accepted.',1;
  IF NOT EXISTS(SELECT 1 FROM core.catalog_operational_owners
    WHERE owner_key=@owner AND registered_at BETWEEN @registerStart AND @registerEnd)
    OR (SELECT COUNT(*) FROM core.catalog_operational_links
      WHERE link_id IN (@domainId,@databaseId) AND registered_at BETWEEN @registerStart AND @registerEnd)<>2
    THROW 54295,N'SQL did not replace submitted future registration timestamps.',1;
  SET @passed+=1;

  INSERT core.catalog_operational_link_approvals(link_key,binding_version,profile_version,revision_key,approval_reference,approved_by)
    VALUES(@domainLink,@binding,@profile,@revision,'QA-OPLINK-01',@actor),
      (@databaseLink,@binding,@profile,@revision,'QA-OPLINK-01',@actor);
  -- A stored scale-3 stamp may briefly lead the unchanged scale-7 view clock.
  SELECT @legacyViewStamp=MAX(approved_at) FROM core.catalog_operational_link_approvals
    WHERE link_key IN (@domainLink,@databaseLink) AND binding_version=@binding AND profile_version=@profile AND revision_key=@revision;
  SET @legacyViewDeadline=DATEADD(millisecond,250,SYSUTCDATETIME());
  WHILE @legacyViewStamp>SYSUTCDATETIME()
  BEGIN
    IF SYSUTCDATETIME()>=@legacyViewDeadline THROW 54285,N'QA view clock did not reach the approval stamp.',1;
    WAITFOR DELAY '00:00:00.005';
  END;
  IF (SELECT COUNT(*) FROM core.catalog_operational_link_evidence
    WHERE link_id IN (@domainId,@databaseId) AND evidence_state='verified')<>2
    THROW 54285,N'Exact approved operational links were not accepted.',1;
  SET @passed+=1;

  -- Publish a newer revision in the same binding/profile: only the first
  -- source record becomes inactive; the other link keeps its existing ID/proof.
  SET @attempt+=1;
  SET @checkedAt=SYSUTCDATETIME();
  INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,match_key_version,
    attempt_ordinal,expected_rows,expected_scopes,observed_at,verified_until)
    VALUES(@source,'erp-customers',@binding,@profile,@keyVersion,@attempt,2,0,@checkedAt,@validUntil);
  SET @revision=SCOPE_IDENTITY();
  INSERT core.catalog_customer_revision_rows(revision_key,source_role,source_record_id,catalog_customer_key,official_name,active_code)
    VALUES(@revision,'erp-customers',1,@customer,N'QA fixture','N'),(@revision,'erp-customers',2,@customer,N'QA fixture','S');
  UPDATE core.catalog_customer_source_revisions SET sealed_at=@checkedAt WHERE revision_key=@revision;
  UPDATE settings.catalog_customer_revision_heads
    SET revision_key=@revision,attempt_status='succeeded',attempted_at=@checkedAt,attempt_ordinal=@attempt WHERE catalog_source_key=@source;
  -- The same view compares the new head and seal stamps at scale 7.
  SET @legacyViewDeadline=DATEADD(millisecond,250,SYSUTCDATETIME());
  WHILE @checkedAt>SYSUTCDATETIME()
  BEGIN
    IF SYSUTCDATETIME()>=@legacyViewDeadline THROW 54286,N'QA view clock did not reach the revision stamp.',1;
    WAITFOR DELAY '00:00:00.005';
  END;
  IF NOT EXISTS(SELECT 1 FROM core.catalog_operational_link_evidence WHERE link_id=@databaseId AND evidence_state='verified')
    OR EXISTS(SELECT 1 FROM core.catalog_operational_link_evidence WHERE link_id=@domainId AND evidence_state='verified')
    THROW 54286,N'An ordinary revision roll lost the stable link or accepted an inactive record.',1;
  SET @passed+=1;

  SET @attempt+=1;
  UPDATE settings.catalog_customer_revision_heads SET attempt_status='failed',attempted_at=SYSUTCDATETIME(),attempt_ordinal=@attempt
    WHERE catalog_source_key=@source;
  IF EXISTS(SELECT 1 FROM core.catalog_operational_link_evidence WHERE link_id IN (@domainId,@databaseId) AND evidence_state='verified')
    THROW 54287,N'A failed current attempt was treated as still verified.',1;
  SET @passed+=1;

  -- Changing the external connection profile invalidates both old approvals.
  UPDATE settings.external_database_connections SET display_name=@tag+N'-changed' WHERE external_database_connection_key=@externalProfile;
  SELECT @profile=row_version FROM settings.external_database_connections WHERE external_database_connection_key=@externalProfile;
  UPDATE settings.catalog_source_bindings SET validated_profile_version=@profile,validated_at=SYSUTCDATETIME()
    WHERE catalog_source_key=@source;
  SELECT @binding=row_version FROM settings.catalog_source_bindings WHERE catalog_source_key=@source;
  SET @attempt+=1;
  SET @checkedAt=SYSUTCDATETIME();
  INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,match_key_version,
    attempt_ordinal,expected_rows,expected_scopes,observed_at,verified_until)
    VALUES(@source,'erp-customers',@binding,@profile,@keyVersion,@attempt,3,0,@checkedAt,@validUntil);
  SET @revision=SCOPE_IDENTITY();
  INSERT core.catalog_customer_revision_rows(revision_key,source_role,source_record_id,catalog_customer_key,official_name,active_code)
    VALUES(@revision,'erp-customers',1,@customer,N'QA fixture','S'),(@revision,'erp-customers',2,@customer,N'QA fixture','S'),
      (@revision,'erp-customers',3,@otherCustomer,N'QA fixture second identity','S');
  UPDATE core.catalog_customer_source_revisions SET sealed_at=@checkedAt WHERE revision_key=@revision;
  UPDATE settings.catalog_customer_revision_heads
    SET revision_key=@revision,attempt_status='succeeded',attempted_at=@checkedAt,attempt_ordinal=@attempt WHERE catalog_source_key=@source;
  IF EXISTS(SELECT 1 FROM core.catalog_operational_link_evidence WHERE link_id IN (@domainId,@databaseId) AND evidence_state='verified')
    THROW 54288,N'A changed connection reused an approval for another revision of the profile.',1;
  SET @passed+=1;

  INSERT core.catalog_operational_link_approvals(link_key,binding_version,profile_version,revision_key,approval_reference,approved_by)
    VALUES(@domainLink,@binding,@profile,@revision,'QA-OPLINK-02',@actor),
      (@databaseLink,@binding,@profile,@revision,'QA-OPLINK-02',@actor);
  SELECT @legacyViewStamp=MAX(approved_at) FROM core.catalog_operational_link_approvals
    WHERE link_key IN (@domainLink,@databaseLink) AND binding_version=@binding AND profile_version=@profile AND revision_key=@revision;
  SET @legacyViewDeadline=DATEADD(millisecond,250,SYSUTCDATETIME());
  WHILE @legacyViewStamp>SYSUTCDATETIME()
  BEGIN
    IF SYSUTCDATETIME()>=@legacyViewDeadline THROW 54289,N'QA view clock did not reach the refreshed approval stamp.',1;
    WAITFOR DELAY '00:00:00.005';
  END;
  IF (SELECT COUNT(*) FROM core.catalog_operational_link_evidence
    WHERE link_id IN (@domainId,@databaseId) AND evidence_state='verified')<>2
    THROW 54289,N'Fresh approval did not restore the same logical link IDs.',1;
  SET @passed+=1;

  UPDATE core.catalog_operational_links SET retired_at=SYSUTCDATETIME() WHERE link_key=@domainLink;
  IF NOT EXISTS(SELECT 1 FROM core.catalog_operational_links
    WHERE link_key=@domainLink AND retired_at>=registered_at AND retired_at<@future)
    OR EXISTS(SELECT 1 FROM core.catalog_operational_link_evidence WHERE link_id=@domainId AND evidence_state='verified')
    OR NOT EXISTS(SELECT 1 FROM core.catalog_operational_link_evidence WHERE link_id=@databaseId AND evidence_state='verified')
    THROW 54290,N'Retirement erased history, left a retired link verified, or changed the sibling.',1;

  -- An auxiliary owner proves immediate retirement without interfering with
  -- the original owner's wrong-association authorization test.
  INSERT core.clients(source_id,name,name_normalized,status,created_at,created_by,updated_at,updated_by)
    VALUES(@tag+N'-other',@tag+N'-other',@tag+N'-other','active',@stamp,@actor,@stamp,@actor);
  SET @otherClient=SCOPE_IDENTITY();
  INSERT core.catalog_operational_owners(portal_environment,catalog_customer_key,client_key,registered_by,registered_at)
    VALUES('qa',@otherCustomer,@otherClient,@actor,@future);
  SELECT @retiredOwner=owner_key FROM core.catalog_operational_owners
    WHERE portal_environment='qa' AND catalog_customer_key=@otherCustomer AND client_key=@otherClient;
  UPDATE core.catalog_operational_owners SET retired_at=SYSUTCDATETIME() WHERE owner_key=@retiredOwner;
  IF NOT EXISTS(SELECT 1 FROM core.catalog_operational_owners
    WHERE owner_key=@retiredOwner AND retired_at>=registered_at AND retired_at<@future)
    THROW 54296,N'An owner could not be retired after a submitted future registration.',1;
  SET @passed+=1;

  -- An exact current source record belonging to a different opaque customer
  -- must be rejected by the write guard. Run this negative as the final
  -- operation: its THROW can doom the transaction, so roll it all back.
  INSERT core.catalog_operational_links(link_id,owner_key,portal_environment,client_key,domain_key,database_key,
    catalog_source_key,source_record_id,target_kind,link_environment,registered_by)
    VALUES(@wrongId,@owner,'qa',@client,@domain,NULL,@source,3,'domain','test',@actor);
  SELECT @wrongLink=link_key FROM core.catalog_operational_links WHERE link_id=@wrongId;
  IF @wrongLink IS NULL THROW 54291,N'Could not register the unapproved wrong-owner case.',1;
  SET @expectedError=54203;
  INSERT core.catalog_operational_link_approvals(link_key,binding_version,profile_version,revision_key,approval_reference,approved_by)
    VALUES(@wrongLink,@binding,@profile,@revision,'QA-OPLINK-NEGATIVE',@actor);
  THROW 54292,N'An exact record for another opaque customer was approved.',1;
END TRY
BEGIN CATCH
  DECLARE @caught int=ERROR_NUMBER();
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  IF @expectedError IS NULL OR @caught<>@expectedError THROW;
  IF @scenario<3
  BEGIN
    IF EXISTS(SELECT 1 FROM settings.external_database_connections WHERE source_id=@tag)
      OR EXISTS(SELECT 1 FROM core.clients WHERE source_id=@tag)
      OR EXISTS(SELECT 1 FROM core.catalog_operational_owners WHERE client_key=@client)
      OR EXISTS(SELECT 1 FROM core.catalog_operational_links WHERE link_id=@domainId)
      THROW 54297,N'A rejected registration probe left residual fixtures.',1;
    SET @retiredInsertRejections+=1;
  END
  ELSE SET @passed+=1;
END CATCH;
SET @scenario+=1;
END;

IF @retiredInsertRejections<>2 THROW 54298,N'Both pre-retired inserts must be rejected.',1;

SELECT @passed AS passed,
  (SELECT COUNT(*) FROM core.clients WHERE client_key IN (@client,@otherClient))
  +(SELECT COUNT(*) FROM core.domains WHERE domain_key=@domain)
  +(SELECT COUNT(*) FROM core.databases WHERE database_key=@database)
  +(SELECT COUNT(*) FROM core.database_access_profiles WHERE access_profile_key=@operationalProfile)
  +(SELECT COUNT(*) FROM settings.external_database_connections WHERE external_database_connection_key=@externalProfile)
  +(SELECT COUNT(*) FROM settings.catalog_source_bindings WHERE catalog_source_key=@source)
  +(SELECT COUNT(*) FROM settings.catalog_match_key_registry WHERE portal_environment='qa' AND vault_secret_version=@fixtureVaultVersion)
  +(SELECT COUNT(*) FROM core.catalog_customer_ids WHERE catalog_customer_key IN (@customer,@otherCustomer))
  +(SELECT COUNT(*) FROM core.catalog_customer_source_revisions WHERE catalog_source_key=@source)
  +(SELECT COUNT(*) FROM settings.catalog_customer_revision_heads WHERE catalog_source_key=@source)
  +(SELECT COUNT(*) FROM core.catalog_operational_owners WHERE owner_key IN (@owner,@retiredOwner))
  +(SELECT COUNT(*) FROM core.catalog_operational_links WHERE link_id IN (@domainId,@databaseId,@wrongId))
  +(SELECT COUNT(*) FROM core.catalog_operational_link_approvals WHERE link_key IN (@domainLink,@databaseLink,@wrongLink))
  AS remaining_fixtures;
'@

$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
if ($OperatorWriter) {
  if ($descriptor.environment -cne 'qa' -or $descriptor.accessLevel -cne 'full-control' -or
      $descriptor.sessionAuthorized -ne $true -or $descriptor.approvalMode -cne 'session') {
    throw 'Operator rehearsal requires an authorized full-control QA session.'
  }
  $operatorPath=Join-Path $PSScriptRoot 'Register-PortalSAGWeb-CatalogOperationalLink.sql'
  $operator=[Text.UTF8Encoding]::new($false,$true).GetString([IO.File]::ReadAllBytes($operatorPath))
  $operator=$operator.Replace(([string][char]13+[char]10),[string][char]10)
  $operatorSha=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($operator)))
  if ($operator.Contains([char]13) -or $operatorSha -cne '0A8FE6F954CC5EAF15341850FBFA37FCEDEEEAE23333BB35DF6186D3EFFAC967') {
    throw 'Operator SQL is not the exact reviewed LF candidate.'
  }
  $firstToken='  DECLARE @now datetime2(3)=SYSUTCDATETIME(),@lock int,'
  $lastToken='  IF @apply=1 COMMIT TRANSACTION; ELSE ROLLBACK TRANSACTION;'
  $first=$operator.IndexOf($firstToken,[StringComparison]::Ordinal)
  $last=$operator.IndexOf($lastToken,[StringComparison]::Ordinal)
  if ($first -lt 0 -or $last -le $first -or $first -ne $operator.LastIndexOf($firstToken,[StringComparison]::Ordinal) -or
      $last -ne $operator.LastIndexOf($lastToken,[StringComparison]::Ordinal)) {
    throw 'Cannot isolate the reviewed operator transaction body.'
  }
  $exactBody=$operator.Substring($first,$last-$first)
  if ($exactBody -match '(?im)\b(?:COMMIT|ROLLBACK|BEGIN\s+TRANSACTION)\b' -or
      $exactBody -notmatch '(?m)^  IF @apply=1 AND @existing=0\s*$' -or
      !$exactBody.Contains('IF @physicalUntil<=@now OR @erpUntil<=@now OR XACT_STATE()<>1')) {
    throw 'Expected intact operator validation/DML without transaction ownership.'
  }
  $transactionFence=@'
IF @environment IS NULL OR @environment COLLATE Latin1_General_100_BIN2<>'qa' OR DATALENGTH(@environment)<>2
  OR DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR DATALENGTH(DB_NAME())<>34
  OR CONVERT(int,SERVERPROPERTY('ProductMajorVersion'))<>15 OR @@TRANCOUNT<>1 OR XACT_STATE()<>1 OR (@@OPTIONS & 2)<>0
  OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150
    AND collation_name=N'Modern_Spanish_CI_AS')
  OR NOT EXISTS(SELECT 1 FROM sys.dm_exec_sessions WHERE session_id=@@SPID AND transaction_isolation_level=4)
  THROW 54260,N'Operational link request rejected.',1;
'@
  $writerOutputs=@'
SET @testStatus=CASE WHEN @apply=0 THEN 'dry-run' WHEN @existing=1 THEN 'existing' ELSE 'registered' END;
SET @testLinkId=CASE WHEN @apply=1 OR @existing=1 THEN @linkId END;
'@
  $writerSql=$transactionFence+[char]10+$exactBody+$writerOutputs
  $prefix="DECLARE @writerSql nvarchar(max)=N'"+$writerSql.Replace("'","''")+"';"
  $writerFixture=@'
SET NOCOUNT ON;
SET XACT_ABORT ON;
SET IMPLICIT_TRANSACTIONS OFF;
IF DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR DATALENGTH(DB_NAME())<>34
  OR @@TRANCOUNT<>0 OR CONVERT(int,SERVERPROPERTY('ProductMajorVersion'))<>15
  OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150
    AND collation_name=N'Modern_Spanish_CI_AS')
  THROW 54271,N'Wrong database or transaction for operator rehearsal.',1;
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;

DECLARE @tag nvarchar(72)=N'qa-oplink-writer-'+LOWER(CONVERT(char(36),NEWID()));
DECLARE @actor nvarchar(150)=@tag+N'-actor',@domainId nvarchar(150)=@tag+N'-domain',
  @databaseId nvarchar(150)=@tag+N'-database',@accessId nvarchar(150)=@tag+N'-access';
DECLARE @at datetime2(3),@until datetime2(3),@lock int,@stage int=0,@case int=0,
  @count int=0,@dry int=0,@registered int=0,@replay int=0,@rejected int=0;
DECLARE @operatorUser bigint,@client bigint,@domain bigint,@database bigint,@access bigint,
  @target bigint,@bindingKey bigint,@connection bigint,@customer bigint,@competingCustomer bigint,@revision bigint;
DECLARE @originalOwner bigint,@originalLink bigint,@originalLinkId uniqueidentifier,
  @originalRevision bigint,@originalOwnerStamp datetime2(3),@originalLinkStamp datetime2(3),@originalApprovalStamp datetime2(3);
DECLARE @physicalId uniqueidentifier=NEWID(),@physicalTargetId uniqueidentifier=NEWID(),
  @physicalProof uniqueidentifier=NEWID(),@catalogOwnerId uniqueidentifier,@sourceId uniqueidentifier;
DECLARE @keyVersion smallint,@vaultVer binary(16)=CONVERT(binary(16),NEWID());
DECLARE @operationalVersion binary(8),@physicalLinkVersion binary(8),@physicalTargetVersion binary(8),
  @bindingVersion binary(8),@erpVersion binary(8),@selectedLinkVersion binary(8);
DECLARE @token binary(32)=HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag+N'-synthetic-document'));
DECLARE @attempt bigint=9223372036854770000+ABS(CONVERT(bigint,CHECKSUM(NEWID())))%5000;
DECLARE @approvalBase varchar(36)='QA-042-'+LOWER(RIGHT(CONVERT(char(36),NEWID()),12));
DECLARE @approvalRef varchar(80)=@approvalBase+'.'+REPLICATE('Q',43);
DECLARE @ambiguousBase varchar(36)='QA-042-AMB-'+LOWER(RIGHT(CONVERT(char(36),NEWID()),12));
DECLARE @requestRecord int,@requestBase varchar(36),@requestRef varchar(80);
DECLARE @apply bit,@testStatus varchar(16),@testLinkId uniqueidentifier,@error int;
DECLARE @writerSignature nvarchar(1800)=N'@environment varchar(10),@actorId nvarchar(150),@targetKind varchar(20),
  @linkEnvironment varchar(20),@clientId nvarchar(150),@domainId nvarchar(150),@databaseId nvarchar(150),
  @physicalLinkId uniqueidentifier,@physicalTargetId uniqueidentifier,@physicalProofId uniqueidentifier,
  @physicalLinkVersion binary(8),@physicalTargetVersion binary(8),@operationalProfileVersion binary(8),
  @catalogOwnerId uniqueidentifier,@erpSourceId uniqueidentifier,@erpRecordId int,@erpRevisionId bigint,
  @bindingVersion binary(8),@erpProfileVersion binary(8),@approvalReferenceBase varchar(36),
  @approvalReference varchar(80),@apply bit,@testStatus varchar(16) OUTPUT,@testLinkId uniqueidentifier OUTPUT';

BEGIN TRY
  BEGIN TRANSACTION;
  EXEC @lock=sys.sp_getapplock @Resource=N'portal-sag:catalog-customer-publication:qa',@LockMode=N'Exclusive',
    @LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock<0 OR OBJECT_ID(N'core.catalog_operational_link_evidence',N'V') IS NULL
    OR NOT EXISTS(SELECT 1 FROM migration.schema_migrations WITH (HOLDLOCK)
      WHERE migration_version='042' AND script_name COLLATE Latin1_General_100_BIN2=N'042_catalog_operational_links.sql'
        AND succeeded=1 AND script_sha256=0x8b9cc546c62913ba83b5a255186213fb087d87b2339f7f35468251b1dd67b9dd)
    OR EXISTS(SELECT 1 FROM core.catalog_customer_source_revisions WHERE attempt_ordinal IN (@attempt,@attempt+1))
    THROW 54272,N'Reviewed operational-link schema or rehearsal slot unavailable.',1;
  SET @stage=1;
  SELECT @keyVersion=match_key_version FROM settings.catalog_match_key_registry WHERE portal_environment='qa';
  IF @keyVersion IS NULL
  BEGIN
    SET @keyVersion=1;
    INSERT settings.catalog_match_key_registry(portal_environment,match_key_version,vault_secret_version,key_verifier)
    VALUES('qa',@keyVersion,@vaultVer,@token);
  END;
  SET @at=SYSUTCDATETIME();
  SET @until=DATEADD(minute,3,@at);
  INSERT security.users(source_id,display_name,email,email_normalized,active,created_at,created_by,updated_at,updated_by)
  VALUES(@actor,@actor,@actor+N'@fixture.invalid',@actor+N'@fixture.invalid',1,@at,N'fixture',@at,N'fixture');
  SET @operatorUser=SCOPE_IDENTITY();
  INSERT security.user_roles(user_key,role_id,assigned_by) VALUES(@operatorUser,N'super_admin',N'fixture');

  INSERT core.clients(source_id,name,name_normalized,status,created_at,created_by,updated_at,updated_by)
  VALUES(@tag,@tag,@tag,'active',@at,N'fixture',@at,N'fixture');
  SET @client=SCOPE_IDENTITY();
  INSERT core.domains(source_id,client_key,domain_name,domain_name_normalized,environment_id,status,created_at,created_by,updated_at,updated_by)
  VALUES(@domainId,@client,N'https://'+@tag+N'.invalid/',N'https://'+@tag+N'.invalid/','test','active',@at,N'fixture',@at,N'fixture');
  SET @domain=SCOPE_IDENTITY();
  INSERT core.database_access_profiles(source_id,server_host_port,initial_catalog,sql_user_id,password_secret_name,
    connection_fingerprint,created_at,created_by,updated_at,updated_by)
  VALUES(@accessId,N'fixture.invalid,1433',N'synthetic',N'fixture',N'fixture-no-key',
    HASHBYTES('SHA2_256',CONVERT(varbinary(max),@accessId)),@at,N'fixture',@at,N'fixture');
  SET @access=SCOPE_IDENTITY();
  SELECT @operationalVersion=row_version FROM core.database_access_profiles WHERE access_profile_key=@access;
  INSERT core.databases(source_id,client_key,domain_key,access_profile_key,company_name,company_name_normalized,environment_id,
    status,created_at,created_by,updated_at,updated_by)
  VALUES(@databaseId,@client,@domain,@access,@tag,@tag,'test','active',@at,N'fixture',@at,N'fixture');
  SET @database=SCOPE_IDENTITY();
  INSERT core.catalog_physical_targets(target_id,portal_environment,target_kind,identity_fingerprint,database_name_fingerprint,created_at)
  VALUES(@physicalTargetId,'qa','database',HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag+N'-physical')),
    HASHBYTES('SHA2_256',CONVERT(varbinary(max),N'synthetic')),@at);
  SET @target=SCOPE_IDENTITY();
  SELECT @physicalTargetVersion=row_version FROM core.catalog_physical_targets WHERE physical_target_key=@target;
  INSERT core.catalog_physical_target_links(link_id,physical_target_key,portal_environment,target_kind,client_key,domain_key,
    database_key,access_profile_key,access_profile_version,proof_id,verified_by,verified_at,valid_until)
  VALUES(@physicalId,@target,'qa','database',@client,@domain,@database,@access,@operationalVersion,@physicalProof,N'fixture',@at,@until);
  SELECT @physicalLinkVersion=row_version FROM core.catalog_physical_target_links WHERE link_id=@physicalId;

  INSERT settings.external_database_connections(source_id,display_name,server_host,database_name,login_name,
    password_configured,password_secret_name,created_by,updated_by)
  VALUES(@tag,@tag,N'fixture.invalid',N'synthetic',N'fixture',1,N'fixture-no-key',N'fixture',N'fixture');
  SET @connection=SCOPE_IDENTITY();
  SELECT @erpVersion=row_version FROM settings.external_database_connections WHERE external_database_connection_key=@connection;
  INSERT settings.catalog_source_bindings(external_database_connection_key,display_name,source_role,portal_environment,
    contract_version,source_state,issuer_scope,validated_at,validated_profile_version,created_by,updated_by)
  VALUES(@connection,@tag,'erp-customers','qa','erp_v1','active',N'CO:NIT',@at,@erpVersion,N'fixture',N'fixture');
  SET @bindingKey=SCOPE_IDENTITY();
  SELECT @sourceId=source_id,@bindingVersion=row_version FROM settings.catalog_source_bindings WHERE catalog_source_key=@bindingKey;
  INSERT core.catalog_customer_ids DEFAULT VALUES;
  SET @customer=SCOPE_IDENTITY();
  SELECT @catalogOwnerId=customer_id FROM core.catalog_customer_ids WHERE catalog_customer_key=@customer;
  INSERT core.catalog_customer_ids DEFAULT VALUES;
  SET @competingCustomer=SCOPE_IDENTITY();
  INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,match_key_version,
    attempt_ordinal,expected_rows,expected_scopes,observed_at,verified_until)
  VALUES(@bindingKey,'erp-customers',@bindingVersion,@erpVersion,@keyVersion,@attempt,2,0,@at,@until);
  SET @revision=SCOPE_IDENTITY();
  SET @originalRevision=@revision;
  INSERT core.catalog_customer_revision_rows(revision_key,source_role,source_record_id,catalog_customer_key,
    official_name,active_code,issuer,document_type,document_number_token)
  VALUES(@revision,'erp-customers',1,@customer,N'Fixture','S','CO','NIT',@token),
    (@revision,'erp-customers',2,@customer,N'Fixture alias','S','CO','NIT',@token);
  UPDATE core.catalog_customer_source_revisions SET sealed_at=@at WHERE revision_key=@revision;
  INSERT settings.catalog_customer_revision_heads(catalog_source_key,revision_key,attempt_status,attempted_at,attempt_ordinal)
  VALUES(@bindingKey,@revision,'succeeded',@at,@attempt);

  SET @stage=2;
  WHILE @case<5
  BEGIN
    SET @case+=1;
    IF @case=5
    BEGIN
      -- Fresh exact source record/approval scope does not already have an
      -- edge that could reject the request for an unrelated replay reason.
      -- Both rows assert the same document identity for different owners.
      SET @at=SYSUTCDATETIME();
      INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,match_key_version,
        attempt_ordinal,expected_rows,expected_scopes,observed_at,verified_until)
      VALUES(@bindingKey,'erp-customers',@bindingVersion,@erpVersion,@keyVersion,@attempt+1,2,0,@at,@until);
      SET @revision=SCOPE_IDENTITY();
      INSERT core.catalog_customer_revision_rows(revision_key,source_role,source_record_id,catalog_customer_key,
        official_name,active_code,issuer,document_type,document_number_token)
      VALUES(@revision,'erp-customers',3,@customer,N'Fixture','S','CO','NIT',@token),
        (@revision,'erp-customers',4,@competingCustomer,N'Fixture conflicting owner','S','CO','NIT',@token);
      UPDATE core.catalog_customer_source_revisions SET sealed_at=@at WHERE revision_key=@revision;
      UPDATE settings.catalog_customer_revision_heads
      SET revision_key=@revision,attempt_status='succeeded',attempted_at=@at,attempt_ordinal=@attempt+1
      WHERE catalog_source_key=@bindingKey;
    END;
    SET @apply=CASE WHEN @case=1 THEN 0 ELSE 1 END;
    SET @selectedLinkVersion=CASE WHEN @case=4 THEN 0x0000000000000000 ELSE @physicalLinkVersion END;
    SET @requestRecord=CASE WHEN @case=5 THEN 3 ELSE 1 END;
    SET @requestBase=CASE WHEN @case=5 THEN @ambiguousBase ELSE @approvalBase END;
    SET @requestRef=CASE WHEN @case=5 THEN @ambiguousBase+'.'+REPLICATE('Z',43) ELSE @approvalRef END;
    SET @testStatus=NULL;
    SET @testLinkId=NULL;
    SET @error=NULL;
    -- An expected pre-write THROW must leave the enclosing synthetic
    -- transaction inspectable. No production error behavior is changed.
    IF @case IN(4,5) SET XACT_ABORT OFF;
    BEGIN TRY
      EXEC sys.sp_executesql @writerSql,@writerSignature,@environment='qa',@actorId=@actor,@targetKind='database',
        @linkEnvironment='test',@clientId=@tag,@domainId=@domainId,@databaseId=@databaseId,
        @physicalLinkId=@physicalId,@physicalTargetId=@physicalTargetId,@physicalProofId=@physicalProof,
        @physicalLinkVersion=@selectedLinkVersion,@physicalTargetVersion=@physicalTargetVersion,
        @operationalProfileVersion=@operationalVersion,@catalogOwnerId=@catalogOwnerId,@erpSourceId=@sourceId,
        @erpRecordId=@requestRecord,@erpRevisionId=@revision,@bindingVersion=@bindingVersion,@erpProfileVersion=@erpVersion,
        @approvalReferenceBase=@requestBase,@approvalReference=@requestRef,@apply=@apply,
        @testStatus=@testStatus OUTPUT,@testLinkId=@testLinkId OUTPUT WITH RESULT SETS NONE;
    END TRY
    BEGIN CATCH
      SET @error=ERROR_NUMBER();
      IF @case NOT IN(4,5) OR @error<>54260 THROW;
    END CATCH;
    SET XACT_ABORT ON;
    IF XACT_STATE()<>1 OR @@TRANCOUNT<>1 THROW 54273,N'Writer did not preserve its QA transaction.',1;

    IF @case=1
    BEGIN
      IF @testStatus IS NULL OR @testStatus<>'dry-run' OR @testLinkId IS NOT NULL
        OR EXISTS(SELECT 1 FROM core.catalog_operational_owners WHERE client_key=@client)
        OR EXISTS(SELECT 1 FROM core.catalog_operational_links WHERE client_key=@client)
        OR EXISTS(SELECT 1 FROM core.catalog_operational_link_approvals WHERE approved_by=@actor)
        THROW 54274,N'Dry-run wrote or returned an unexpected result.',1;
      SET @dry=1;
    END
    ELSE IF @case=2
    BEGIN
      IF @testStatus IS NULL OR @testStatus<>'registered' OR @testLinkId IS NULL
        THROW 54275,N'Exact operator registration did not report success.',1;
      SET @originalLinkId=@testLinkId;
      SELECT @originalOwner=owner_key,@originalOwnerStamp=registered_at
      FROM core.catalog_operational_owners
      WHERE client_key=@client AND catalog_customer_key=@customer AND registered_by=@actor AND portal_environment='qa';
      SELECT @originalLink=link_key,@originalLinkStamp=registered_at
      FROM core.catalog_operational_links WHERE link_id=@originalLinkId AND owner_key=@originalOwner
        AND portal_environment='qa' AND client_key=@client AND domain_key=@domain AND database_key=@database
        AND catalog_source_key=@bindingKey AND source_record_id=1 AND target_kind='database'
        AND link_environment='test' AND registered_by=@actor;
      SELECT @originalApprovalStamp=approved_at FROM core.catalog_operational_link_approvals
      WHERE link_key=@originalLink AND binding_version=@bindingVersion AND profile_version=@erpVersion
        AND revision_key=@originalRevision AND approval_reference=@approvalRef AND approved_by=@actor;
      IF @originalOwner IS NULL OR @originalLink IS NULL OR @originalApprovalStamp IS NULL
        THROW 54276,N'Expected exact persisted owner, link and approval.',1;
      -- Only the QA read-model assertion waits for the unchanged scale-7
      -- view clock. The writer is tested without any delay.
      DECLARE @viewClockDeadline datetime2(7)=DATEADD(millisecond,250,SYSUTCDATETIME());
      WHILE @originalApprovalStamp>SYSUTCDATETIME()
      BEGIN
        IF SYSUTCDATETIME()>=@viewClockDeadline THROW 54276,N'QA view clock did not reach the approval stamp.',1;
        WAITFOR DELAY '00:00:00.005';
      END;
      IF NOT EXISTS(
        SELECT 1 FROM core.catalog_operational_link_evidence WHERE link_id=@originalLinkId AND evidence_state='verified'
          AND revision_key=@originalRevision AND binding_version=@bindingVersion AND profile_version=@erpVersion)
        THROW 54276,N'Expected exact verified owner, link and approval.',1;
      SET @registered=1;
    END
    ELSE IF @case=3
    BEGIN
      IF @testStatus IS NULL OR @testStatus<>'existing' OR @testLinkId IS NULL OR @testLinkId<>@originalLinkId
        THROW 54277,N'Replay did not preserve the exact operational link.',1;
      SET @replay=1;
    END
    ELSE
    BEGIN
      IF @error IS NULL OR @error<>54260 OR @testStatus IS NOT NULL OR @testLinkId IS NOT NULL
        THROW 54278,N'Stale or ambiguous writer scope was not rejected.',1;
      SET @rejected+=1;
    END;

    IF @case>=2 AND (
        (SELECT COUNT(*) FROM core.catalog_operational_owners WHERE client_key=@client)<>1
        OR (SELECT COUNT(*) FROM core.catalog_operational_links WHERE client_key=@client)<>1
        OR (SELECT COUNT(*) FROM core.catalog_operational_link_approvals WHERE approved_by=@actor)<>1
        OR NOT EXISTS(SELECT 1 FROM core.catalog_operational_owners WHERE owner_key=@originalOwner AND registered_at=@originalOwnerStamp AND retired_at IS NULL)
        OR NOT EXISTS(SELECT 1 FROM core.catalog_operational_links WHERE link_key=@originalLink AND link_id=@originalLinkId
          AND registered_at=@originalLinkStamp AND retired_at IS NULL)
        OR NOT EXISTS(SELECT 1 FROM core.catalog_operational_link_approvals WHERE link_key=@originalLink
          AND binding_version=@bindingVersion AND profile_version=@erpVersion AND revision_key=@originalRevision
          AND approval_reference=@approvalRef AND approved_by=@actor AND approved_at=@originalApprovalStamp))
      THROW 54279,N'Writer duplicated or rewrote protected evidence.',1;
    SET @count+=1;
  END;
  ROLLBACK TRANSACTION;
  SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
  SET @stage=3;
  IF @@TRANCOUNT<>0
    OR EXISTS(SELECT 1 FROM security.users WHERE source_id=@actor)
    OR EXISTS(SELECT 1 FROM security.user_roles WHERE user_key=@operatorUser)
    OR EXISTS(SELECT 1 FROM core.clients WHERE client_key=@client)
    OR EXISTS(SELECT 1 FROM core.domains WHERE domain_key=@domain)
    OR EXISTS(SELECT 1 FROM core.databases WHERE database_key=@database)
    OR EXISTS(SELECT 1 FROM core.database_access_profiles WHERE access_profile_key=@access)
    OR EXISTS(SELECT 1 FROM core.catalog_physical_targets WHERE physical_target_key=@target)
    OR EXISTS(SELECT 1 FROM core.catalog_physical_target_links WHERE link_id=@physicalId)
    OR EXISTS(SELECT 1 FROM settings.external_database_connections WHERE external_database_connection_key=@connection)
    OR EXISTS(SELECT 1 FROM settings.catalog_source_bindings WHERE catalog_source_key=@bindingKey)
    OR EXISTS(SELECT 1 FROM settings.catalog_customer_revision_heads WHERE catalog_source_key=@bindingKey)
    OR EXISTS(SELECT 1 FROM core.catalog_customer_source_revisions WHERE catalog_source_key=@bindingKey)
    OR EXISTS(SELECT 1 FROM core.catalog_customer_ids WHERE catalog_customer_key IN (@customer,@competingCustomer))
    OR EXISTS(SELECT 1 FROM settings.catalog_match_key_registry WHERE portal_environment='qa' AND vault_secret_version=@vaultVer)
    OR EXISTS(SELECT 1 FROM core.catalog_operational_owners WHERE client_key=@client)
    OR EXISTS(SELECT 1 FROM core.catalog_operational_links WHERE client_key=@client)
    OR EXISTS(SELECT 1 FROM core.catalog_operational_link_approvals WHERE approved_by=@actor)
    THROW 54269,N'Residual operational writer QA data.',1;

  SELECT @count AS passed,@dry AS dry_run,@registered AS registered,@replay AS replayed,@rejected AS rejected,0 AS remaining_fixtures;
END TRY
BEGIN CATCH
  DECLARE @caught int=ERROR_NUMBER(),@line int=ERROR_LINE();
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  SET XACT_ABORT ON;
  SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
  SELECT @caught AS error_number,@line AS error_line,@stage AS error_stage,@case AS error_case;
END CATCH;
'@
  try {
    $response=(& $invoke -SessionDirectory $session -Sql ($prefix+[char]10+$writerFixture) -Mode write -TimeoutSeconds 60 -MaxRows 1) |
      ConvertFrom-Json -Depth 16
  } catch {
    throw 'QA operator writer rehearsal did not return a sanitized result.'
  }
  $sets=@($response.resultSets)
  $row=if ($sets.Count -eq 1 -and @($sets[0].rows).Count -eq 1) { $sets[0].rows[0] }
  if (!$response.success -or $row.passed -ne 5 -or $row.dry_run -ne 1 -or $row.registered -ne 1 -or
      $row.replayed -ne 1 -or $row.rejected -ne 2 -or $row.remaining_fixtures -ne 0) {
    throw "Operational writer QA failed (SQL: $([int]$row.error_number); line: $([int]$row.error_line); stage: $([int]$row.error_stage); case: $([int]$row.error_case))."
  }
  $row | Select-Object passed,dry_run,registered,replayed,rejected,remaining_fixtures | ConvertTo-Json -Compress
  return
}
try {
  $response=(& $invoke -SessionDirectory $session -Sql $fixture -Mode write -TimeoutSeconds 35 -MaxRows 1) | ConvertFrom-Json -Depth 16
} catch {
  throw 'QA operational link rehearsal did not return a valid sanitized result.'
}
$row=$response.resultSets[0].rows[0]
if(!$response.success -or $row.passed -ne 8 -or $row.remaining_fixtures -ne 0){
  $number=0
  [void][int]::TryParse([string]$response.error.number,[ref]$number)
  throw "QA operational link rehearsal did not pass or left residual rows (SQL error number: $number)."
}
$row | Select-Object passed,remaining_fixtures | ConvertTo-Json -Compress
