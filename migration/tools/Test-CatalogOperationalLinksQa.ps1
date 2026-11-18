[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SessionDirectory)

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
