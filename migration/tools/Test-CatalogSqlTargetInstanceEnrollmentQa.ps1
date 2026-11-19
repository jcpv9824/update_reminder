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
$ddlPath=Join-Path $PSScriptRoot '../sql/058_catalog_sql_target_instance_enrollment.sql'
$ddlBytes=[IO.File]::ReadAllBytes($ddlPath)
$ddlHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($ddlBytes))
if ($ddlHash -cne 'D142000B6EEDBA93C9C1B9FBC9045828C5B151E0814A0F1CEB5464403EB50588') {
  throw 'The 058 bytes do not match the reviewed QA candidate.'
}
$ddl=[Text.UTF8Encoding]::new($false,$true).GetString($ddlBytes)
$prefix="DECLARE @ddl058 nvarchar(max)=N'"+$ddl.Replace("'","''")+"';"
$fixture=@'
SET NOCOUNT ON;
SET XACT_ABORT ON;
SET IMPLICIT_TRANSACTIONS OFF;
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
IF DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR DATALENGTH(DB_NAME())<>34
  OR @@TRANCOUNT<>0 OR CAST(SERVERPROPERTY('ProductMajorVersion') AS int)<>15
  OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150
    AND collation_name=N'Modern_Spanish_CI_AS')
  THROW 55850,N'Unexpected instance enrollment QA target.',1;

DECLARE @tag nvarchar(75)=N'qa-instance-058-'+LOWER(CONVERT(char(36),NEWID()));
DECLARE @actor nvarchar(150)=@tag+N'-operator',@viewer nvarchar(150)=@tag+N'-viewer';
DECLARE @origin datetime2(3)=SYSUTCDATETIME(),@now datetime2(3),@linkAt datetime2(3),@linkUntil datetime2(3);
SET @linkAt=DATEADD(minute,-2,@origin);
SET @linkUntil=DATEADD(minute,3,@origin);
DECLARE @stage int=0,@case int=0,@lock int,@passed int=0,@enrolled int=0,@idempotent int=0;
DECLARE @client bigint,@domain bigint,@adminUser bigint,@firstProof uniqueidentifier=NEWID(),@seedProof uniqueidentifier=NEWID();
DECLARE @originalStamp datetime2(3),@seedStamp datetime2(3),@aliasA uniqueidentifier=NEWID(),@aliasB uniqueidentifier=NEWID(),
  @targetA uniqueidentifier=NEWID(),@targetB uniqueidentifier=NEWID(),@linkProofA uniqueidentifier=NEWID(),@linkProofB uniqueidentifier=NEWID();
DECLARE @namespaceA uniqueidentifier='a410a410-a410-4410-8410-a410a410a410',
  @guidA uniqueidentifier='b410b410-b410-4410-8410-b410b410b410',
  @namespaceB uniqueidentifier='a420a420-a420-4420-8420-a420a420a420',
  @guidB uniqueidentifier='b420b420-b420-4420-8420-b420b420b420',
  @wrongNamespace uniqueidentifier='a430a430-a430-4430-8430-a430a430a430';
-- Wire vectors generated independently with the Node v1 identity and
-- UTF-16LE framed handoff (not the SQL under test).
DECLARE @identityA binary(32)=0x356e7dd985f13bba3805bb434d8c08aab5d3de4f52beca0646542c7c1cb66957,
  @identityB binary(32)=0x8e5958c134e2b24b1fa3f4f51fe15d0f40437aefcb214c5baa6700fbd8ce58e1,
  @wrongIdentity binary(32)=0x4b61eb9914325d2cb3ec83a9b8e6f40fc9ac8fc38a186a226818f40b678f64f1;
DECLARE @routeA binary(32)=0xad10c4d07d7cecd0ed2201d1032fcc869b2db74bbd47a270441c9add18e8359c,
  @routeB binary(32)=0x9af04d33e57a7830e61d7af3c05f3c600ae369cfd29fd1f7a495f68b56328e77;
DECLARE @destinations table(
  n int PRIMARY KEY, physicalKey bigint NOT NULL, physicalId uniqueidentifier NOT NULL, physicalLinkId uniqueidentifier NOT NULL,
  accessVersion binary(8) NOT NULL, profileId nvarchar(150) NOT NULL, profileVersion binary(8) NOT NULL,
  routeFingerprint binary(32) NOT NULL, instanceId uniqueidentifier NOT NULL, databaseGuid uniqueidentifier NOT NULL,
  identityFingerprint binary(32) NOT NULL);
BEGIN TRY
  BEGIN TRANSACTION;
  EXEC @lock=sys.sp_getapplock @Resource=N'portal-sag:qa:058:rollback-rehearsal',
    @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock<0 OR OBJECT_ID(N'settings.enroll_catalog_sql_target_instance_internal',N'P') IS NOT NULL
    THROW 55851,N'QA requires an uncontended, uninstalled 058.',1;
  SET @stage=1;
  EXEC sys.sp_executesql @ddl058;
  IF @@TRANCOUNT<>1 OR XACT_STATE()<>1
    OR OBJECT_ID(N'settings.enroll_catalog_sql_target_instance_internal',N'P') IS NULL
    THROW 55852,N'Expected one SERIALIZABLE QA transaction with the transient 058.',1;

  SET @stage=2;
  -- Application identities only: no SQL user, grant, or existing role edit.
  INSERT security.users(source_id,display_name,email,email_normalized,active,created_at,created_by,updated_at,updated_by)
  SELECT id,id,id+N'@fixture.invalid',id+N'@fixture.invalid',1,@linkAt,N'fixture',@linkAt,N'fixture'
  FROM (VALUES(@actor),(@viewer)) v(id);
  SELECT @adminUser=user_key FROM security.users WHERE source_id=@actor;
  INSERT security.user_roles(user_key,role_id,assigned_by) VALUES(@adminUser,N'super_admin',N'fixture');
  INSERT core.clients(source_id,name,name_normalized,status,created_at,created_by,updated_at,updated_by)
  VALUES(@tag,@tag,@tag,'active',@linkAt,N'fixture',@linkAt,N'fixture');
  SET @client=SCOPE_IDENTITY();
  INSERT core.domains(source_id,client_key,domain_name,domain_name_normalized,environment_id,status,created_at,created_by,updated_at,updated_by)
  VALUES(@tag+N'-domain',@client,N'https://qa-enrollment.invalid/',N'https://qa-enrollment.invalid/','test','active',
    @linkAt,N'fixture',@linkAt,N'fixture');
  SET @domain=SCOPE_IDENTITY();

  DECLARE @n int=0,@physicalKey bigint,@profileKey bigint,@dbKey bigint,@physicalId uniqueidentifier,@physicalAlias uniqueidentifier,
    @reportId nvarchar(150),@opVersion binary(8),@reportVersion binary(8),@catalog nvarchar(128),@host nvarchar(255),@port int;
  WHILE @n<2
  BEGIN
    SET @n+=1;
    SET @physicalId=CASE WHEN @n=1 THEN @targetA ELSE @targetB END;
    SET @physicalAlias=CASE WHEN @n=1 THEN @aliasA ELSE @aliasB END;
    SET @reportId=@tag+N'-report'+CONVERT(nvarchar(1),@n);
    SET @catalog=CASE WHEN @n=1 THEN N'Qa_Enrollment_A' ELSE N'Qa_Enrollment_B' END;
    SET @host=CASE WHEN @n=1 THEN N'Qa-Enrollment-A.invalid' ELSE N'qa-enrollment-b.invalid' END;
    SET @port=CASE WHEN @n=1 THEN 1433 ELSE 2433 END;

    INSERT core.database_access_profiles(source_id,server_host_port,initial_catalog,sql_user_id,password_secret_name,
      connection_fingerprint,created_at,created_by,updated_at,updated_by)
    VALUES(@tag+N'-operational'+CONVERT(nvarchar(1),@n),N'qa-enrollment.invalid,1433',@catalog,N'fixture',N'fixture-no-key',
      HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag+CONVERT(nvarchar(1),@n))),@linkAt,N'fixture',@linkAt,N'fixture');
    SET @profileKey=SCOPE_IDENTITY();
    SELECT @opVersion=row_version FROM core.database_access_profiles WHERE access_profile_key=@profileKey;
    INSERT core.databases(source_id,client_key,domain_key,access_profile_key,company_name,company_name_normalized,environment_id,
      status,created_at,created_by,updated_at,updated_by)
    VALUES(@tag+N'-db'+CONVERT(nvarchar(1),@n),@client,@domain,@profileKey,@catalog,@catalog,'test','active',
      @linkAt,N'fixture',@linkAt,N'fixture');
    SET @dbKey=SCOPE_IDENTITY();
    INSERT core.catalog_physical_targets(target_id,portal_environment,target_kind,identity_fingerprint,database_name_fingerprint,created_at)
    VALUES(@physicalId,'qa','database',CASE WHEN @n=1 THEN @identityA ELSE @identityB END,
      HASHBYTES('SHA2_256',CONVERT(varbinary(max),@catalog)),@linkAt);
    SET @physicalKey=SCOPE_IDENTITY();
    INSERT core.catalog_physical_target_links(link_id,physical_target_key,portal_environment,target_kind,client_key,domain_key,
      database_key,access_profile_key,access_profile_version,proof_id,verified_by,verified_at,valid_until)
    VALUES(@physicalAlias,@physicalKey,'qa','database',@client,@domain,@dbKey,@profileKey,@opVersion,
      CASE WHEN @n=1 THEN @linkProofA ELSE @linkProofB END,N'fixture',@linkAt,@linkUntil);
    INSERT settings.external_database_connections(source_id,display_name,server_host,server_port,database_name,login_name,
      password_configured,password_secret_name,created_at,updated_at,created_by,updated_by)
    VALUES(@reportId,@reportId,@host,@port,@catalog,N'fixture-read-only',1,N'fixture-no-key',@linkAt,@linkAt,N'fixture',N'fixture');
    SELECT @reportVersion=row_version FROM settings.external_database_connections WHERE source_id=@reportId;
    INSERT @destinations VALUES(@n,@physicalKey,@physicalId,@physicalAlias,@opVersion,@reportId,@reportVersion,
      CASE WHEN @n=1 THEN @routeA ELSE @routeB END,CASE WHEN @n=1 THEN @namespaceA ELSE @namespaceB END,
      CASE WHEN @n=1 THEN @guidA ELSE @guidB END,CASE WHEN @n=1 THEN @identityA ELSE @identityB END);
  END;
  DECLARE @keyA bigint,@keyB bigint;
  SELECT @keyA=physicalKey FROM @destinations WHERE n=1;
  SELECT @keyB=physicalKey FROM @destinations WHERE n=2;
  -- Simulate incompatible existing historical custody for B only.
  INSERT core.catalog_sql_target_instance_identities(physical_target_key,portal_environment,target_kind,trusted_instance_id,proof_id)
  VALUES(@keyB,'qa','database',@wrongNamespace,@seedProof);
  SELECT @seedStamp=registered_at FROM core.catalog_sql_target_instance_identities WHERE physical_target_key=@keyB;

  SET @stage=3;
  DECLARE @env varchar(32),@requestActor nvarchar(150),@requestInstance uniqueidentifier,@requestGuid uniqueidentifier,
    @requestIdentity varbinary(64),@requestRoute varbinary(64),@requestOpVersion varbinary(32),@requestReportVersion varbinary(32),
    @requestProof uniqueidentifier,@verifiedAt datetime2(3),@validUntil datetime2(3),@result varchar(32),@expected varchar(32);
  WHILE @case<17
  BEGIN
    SET @case+=1;
    SET @now=SYSUTCDATETIME();
    SELECT @physicalId=physicalId,@physicalAlias=physicalLinkId,@requestOpVersion=accessVersion,
      @reportId=profileId,@requestReportVersion=profileVersion,@requestRoute=routeFingerprint,
      @requestInstance=instanceId,@requestGuid=databaseGuid,@requestIdentity=identityFingerprint
    FROM @destinations WHERE n=CASE WHEN @case IN(15,16) THEN 2 ELSE 1 END;
    SET @env=CASE WHEN @case=11 THEN 'production' ELSE 'qa' END;
    SET @requestActor=CASE WHEN @case=1 THEN @viewer ELSE @actor END;
    SET @requestProof=CASE WHEN @case IN(12,13,15) THEN @firstProof WHEN @case=17 THEN @linkProofA ELSE NEWID() END;
    SET @verifiedAt=@now;
    SET @validUntil=DATEADD(second,90,@now);
    IF @case=2 SET @requestReportVersion=0x0000000000000000;
    IF @case=3 SET @requestOpVersion=0x0000000000000000;
    IF @case=4 SET @requestRoute=@routeB;
    IF @case=5 SET @requestIdentity=@identityB;
    IF @case=6
    BEGIN
      SET @requestInstance=@wrongNamespace;
      SET @requestIdentity=@wrongIdentity;
    END;
    IF @case=7
    BEGIN
      SET @verifiedAt=DATEADD(second,-60,@now);
      SET @validUntil=DATEADD(second,-5,@now);
    END;
    IF @case=8 SET @validUntil=DATEADD(second,1,@linkUntil);
    IF @case=9 SET @verifiedAt=DATEADD(second,10,@now);
    IF @case=10 SET @physicalAlias=@aliasB;
    SET @expected=CASE @case
      WHEN 1 THEN 'authority-changed'
      WHEN 5 THEN 'invalid-proof' WHEN 11 THEN 'invalid-proof'
      WHEN 7 THEN 'proof-stale' WHEN 8 THEN 'proof-stale' WHEN 9 THEN 'proof-stale'
      WHEN 12 THEN 'enrolled' WHEN 13 THEN 'already-enrolled' WHEN 14 THEN 'already-enrolled'
      WHEN 15 THEN 'proof-replayed' WHEN 16 THEN 'instance-conflict' WHEN 17 THEN 'proof-replayed'
      ELSE 'reference-changed' END;
    SET @result='sentinel';
    EXEC settings.enroll_catalog_sql_target_instance_internal
      @environment=@env,@actorId=@requestActor,@physicalLinkId=@physicalAlias,@physicalTargetId=@physicalId,
      @operationalProfileVersion=@requestOpVersion,@reportConnectionId=@reportId,@reportProfileVersion=@requestReportVersion,
      @reportRouteFingerprint=@requestRoute,@trustedInstanceId=@requestInstance,@verifiedDatabaseGuid=@requestGuid,
      @identityFingerprint=@requestIdentity,@proofId=@requestProof,@verifiedAt=@verifiedAt,@validUntil=@validUntil,
      @result=@result OUTPUT WITH RESULT SETS NONE;
    IF @result IS NULL OR @result<>@expected OR XACT_STATE()<>1 OR @@TRANCOUNT<>1
      THROW 55853,N'Unexpected instance enrollment decision.',1;
    IF @case=12
    BEGIN
      SELECT @originalStamp=registered_at FROM core.catalog_sql_target_instance_identities WHERE physical_target_key=@keyA;
      IF @originalStamp IS NULL OR @originalStamp<@verifiedAt OR @originalStamp>@validUntil
        THROW 55854,N'Expected positive enrollment to stamp immutable custody.',1;
      SET @enrolled+=1;
    END;
    IF @case IN(13,14) SET @idempotent+=1;
    IF (@case<12 AND EXISTS(SELECT 1 FROM core.catalog_sql_target_instance_identities WHERE physical_target_key=@keyA))
      OR (@case>=12 AND NOT EXISTS(SELECT 1 FROM core.catalog_sql_target_instance_identities
        WHERE physical_target_key=@keyA AND portal_environment='qa' AND target_kind='database'
          AND trusted_instance_id=@namespaceA AND proof_id=@firstProof AND registered_at=@originalStamp))
      OR NOT EXISTS(SELECT 1 FROM core.catalog_sql_target_instance_identities
        WHERE physical_target_key=@keyB AND trusted_instance_id=@wrongNamespace AND proof_id=@seedProof AND registered_at=@seedStamp)
      THROW 55855,N'Enrollment changed or rewrote protected custody unexpectedly.',1;
    SET @passed+=1;
  END;

  ROLLBACK TRANSACTION;
  SET @stage=4;
  IF @@TRANCOUNT<>0 OR OBJECT_ID(N'settings.enroll_catalog_sql_target_instance_internal',N'P') IS NOT NULL
    OR EXISTS(SELECT 1 FROM security.users WHERE source_id IN (@actor,@viewer))
    OR EXISTS(SELECT 1 FROM security.user_roles WHERE user_key=@adminUser)
    OR EXISTS(SELECT 1 FROM core.clients WHERE client_key=@client)
    OR EXISTS(SELECT 1 FROM core.domains WHERE domain_key=@domain)
    OR EXISTS(SELECT 1 FROM core.databases WHERE client_key=@client)
    OR EXISTS(SELECT 1 FROM core.database_access_profiles WHERE source_id IN (@tag+N'-operational1',@tag+N'-operational2'))
    OR EXISTS(SELECT 1 FROM settings.external_database_connections WHERE source_id IN (@tag+N'-report1',@tag+N'-report2'))
    OR EXISTS(SELECT 1 FROM core.catalog_physical_targets WHERE target_id IN (@targetA,@targetB))
    OR EXISTS(SELECT 1 FROM core.catalog_physical_target_links WHERE link_id IN (@aliasA,@aliasB))
    OR EXISTS(SELECT 1 FROM core.catalog_sql_target_instance_identities WHERE physical_target_key IN (@keyA,@keyB))
    THROW 55856,N'Residual 058 rehearsal fixture detected.',1;
  SELECT @passed AS passed,@enrolled AS enrolled,@idempotent AS idempotent,0 AS remaining_fixtures;
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
$resultSets=@($response.resultSets)
$row=if ($resultSets.Count -eq 1 -and @($resultSets[0].rows).Count -eq 1) { $resultSets[0].rows[0] }
if (!$response.success -or $row.passed -ne 17 -or $row.enrolled -ne 1 -or $row.idempotent -ne 2 -or $row.remaining_fixtures -ne 0) {
  throw "Instance enrollment QA failed (SQL: $([int]$row.error_number); line: $([int]$row.error_line); stage: $([int]$row.error_stage); case: $([int]$row.error_case))."
}
$row | Select-Object passed,enrolled,idempotent,remaining_fixtures | ConvertTo-Json -Compress
