[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SessionDirectory)

$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$session=(Resolve-Path -LiteralPath $SessionDirectory).Path
$descriptor=Get-Content -Raw -LiteralPath (Join-Path $session 'active.json') | ConvertFrom-Json
if($descriptor.database -ne 'PortalSAGWeb-TEST' -or ($descriptor.environment -and $descriptor.environment -ne 'qa')){
  throw 'This rehearsal requires the PortalSAGWeb-TEST session.'
}
$reader=(Get-Content -Raw -LiteralPath (Join-Path $root 'api/src/lib/catalogPhysicalTargetSqlRepository.ts')).Split([char]96)[1]
$route=(Get-Content -Raw -LiteralPath (Join-Path $root 'api/src/lib/catalogPhysicalTargetIdentity.ts')).Split([char]96)[1]
if($reader -notlike '*WITH wanted AS*' -or $route -notlike '*portal-sag:web-route:v1*'){
  throw 'Unable to locate the checked-in catalog target query.'
}
$reader=$reader.Replace('${withPins ? physicalLinkProjection : ""}','').Replace('${catalogDomainRouteFingerprintSql}',$route)
if($reader.Contains('${') -or $reader -match '(?im)^\s*(INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|CREATE)\b'){
  throw 'The catalog target projection is not read-only.'
}
$literal=("DECLARE @probe nvarchar(max)=N'"+$reader.Replace("'","''")+"';")
$fixture=@'
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF DB_NAME()<>N'PortalSAGWeb-TEST' THROW 53680,N'Wrong database for catalog rehearsal.',1;
IF @@TRANCOUNT<>0 THROW 53681,N'Unexpected existing transaction.',1;
DECLARE @tag nvarchar(80)=N'catalog-qa-'+LOWER(CONVERT(nvarchar(36),NEWID()));
DECLARE @stamp datetime2(3)=SYSUTCDATETIME();
DECLARE @requestedLinks nvarchar(max);
BEGIN TRY
  BEGIN TRANSACTION;
  INSERT core.clients(source_id,name,name_normalized,status,created_at,created_by,updated_at,updated_by)
  SELECT @tag+suffix,@tag+suffix,@tag+suffix,'active',@stamp,'scenario-036',@stamp,'scenario-036'
  FROM (VALUES(N'-a'),(N'-b')) AS v(suffix);

  INSERT core.domains(source_id,client_key,domain_name,domain_name_normalized,environment_id,status,
    created_at,created_by,updated_at,updated_by)
  SELECT c.source_id+N'-web',c.client_key,N'https://'+c.source_id+N'.invalid',
    N'https://'+c.source_id+N'.invalid','test','active',@stamp,'scenario-036',@stamp,'scenario-036'
  FROM core.clients AS c WHERE c.source_id IN (@tag+N'-a',@tag+N'-b');

  INSERT core.catalog_physical_targets(portal_environment,target_kind,identity_fingerprint)
  VALUES('qa','domain',HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag)));
  DECLARE @target bigint=CONVERT(bigint,SCOPE_IDENTITY());

  INSERT core.catalog_physical_target_links(physical_target_key,portal_environment,target_kind,client_key,domain_key,
    domain_route_fingerprint,proof_id,verified_by,verified_at,valid_until)
  SELECT @target,'qa','domain',d.client_key,d.domain_key,
    /* ROUTE_HASH */,NEWID(),'scenario-036',@stamp,DATEADD(minute,5,@stamp)
  FROM core.domains AS d WHERE d.source_id IN (@tag+N'-a-web',@tag+N'-b-web');

  SET @requestedLinks=(SELECT 'domain' AS kind,'test' AS environment,c.source_id AS customerId,d.source_id AS domainId
    FROM core.clients AS c JOIN core.domains AS d ON d.client_key=c.client_key
    WHERE c.source_id IN (@tag+N'-a',@tag+N'-b') ORDER BY c.source_id FOR JSON PATH);
  DECLARE @seen TABLE (ordinal int,target_status varchar(15),physical_id char(36));
  INSERT @seen
    EXEC sys.sp_executesql @probe,N'@portalEnvironment varchar(10), @requestedLinks nvarchar(max), @now datetime2(3)',
      @portalEnvironment='qa',@requestedLinks=@requestedLinks,@now=@stamp;
  IF (SELECT COUNT(*) FROM @seen WHERE target_status='verified')<>2
     OR (SELECT COUNT(DISTINCT physical_id) FROM @seen)<>1
    THROW 53682,N'Shared deployment was not resolved to a single physical identity.',1;

  UPDATE core.domains SET publishable_domain=N'https://'+@tag+N'-changed.invalid' WHERE source_id=@tag+N'-a-web';
  UPDATE core.domains SET publishable_domain=NULL WHERE source_id=@tag+N'-a-web';
  DELETE FROM @seen;
  INSERT @seen
    EXEC sys.sp_executesql @probe,N'@portalEnvironment varchar(10), @requestedLinks nvarchar(max), @now datetime2(3)',
      @portalEnvironment='qa',@requestedLinks=@requestedLinks,@now=@stamp;
  IF NOT EXISTS (SELECT 1 FROM @seen WHERE ordinal=0 AND target_status='unverifiable' AND physical_id IS NULL)
    OR NOT EXISTS (SELECT 1 FROM @seen WHERE ordinal=1 AND target_status='verified' AND physical_id IS NOT NULL)
    THROW 53683,N'Route reversal revived retired evidence or affected the other client.',1;

  -- The password field receives a synthetic reference. This rehearsal never opens a destination connection.
  INSERT core.database_access_profiles(source_id,server_host_port,initial_catalog,sql_user_id,password_secret_name,
    connection_fingerprint,created_at,created_by,updated_at,updated_by)
  SELECT @tag+suffix+N'-profile',N'fixture.invalid,1433',N'qa_synthetic',N'fixture',
    N'fixture-unused-no-secret',HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag+suffix)),@stamp,'scenario-036',@stamp,'scenario-036'
  FROM (VALUES(N'-a'),(N'-b')) AS v(suffix);

  INSERT core.databases(source_id,client_key,domain_key,access_profile_key,company_name,company_name_normalized,
    environment_id,status,created_at,created_by,updated_at,updated_by)
  SELECT c.source_id+N'-db',c.client_key,d.domain_key,p.access_profile_key,c.source_id,c.source_id,
    CASE WHEN c.source_id=@tag+N'-a' THEN 'test' ELSE 'production' END,'active',@stamp,'scenario-036',@stamp,'scenario-036'
  FROM core.clients AS c JOIN core.domains AS d ON d.client_key=c.client_key
  JOIN core.database_access_profiles AS p ON p.source_id=c.source_id+N'-profile'
  WHERE c.source_id IN (@tag+N'-a',@tag+N'-b');

  INSERT core.catalog_physical_targets(portal_environment,target_kind,identity_fingerprint,database_name_fingerprint)
  VALUES('qa','database',HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag+N'-db')),
    HASHBYTES('SHA2_256',CONVERT(varbinary(max),N'qa_synthetic')));
  SET @target=CONVERT(bigint,SCOPE_IDENTITY());
  INSERT core.catalog_physical_target_links(physical_target_key,portal_environment,target_kind,client_key,domain_key,
    database_key,access_profile_key,access_profile_version,proof_id,verified_by,verified_at,valid_until)
  SELECT @target,'qa','database',db.client_key,db.domain_key,db.database_key,p.access_profile_key,p.row_version,
    NEWID(),'scenario-036',@stamp,DATEADD(minute,5,@stamp)
  FROM core.databases AS db JOIN core.database_access_profiles AS p ON p.access_profile_key=db.access_profile_key
  WHERE db.source_id IN (@tag+N'-a-db',@tag+N'-b-db');

  SET @requestedLinks=(SELECT 'database' AS kind,db.environment_id AS environment,c.source_id AS customerId,
    d.source_id AS domainId,db.source_id AS databaseId
    FROM core.clients AS c JOIN core.domains AS d ON d.client_key=c.client_key
    JOIN core.databases AS db ON db.client_key=c.client_key AND db.domain_key=d.domain_key
    WHERE c.source_id IN (@tag+N'-a',@tag+N'-b') ORDER BY c.source_id FOR JSON PATH);
  DELETE FROM @seen;
  INSERT @seen
    EXEC sys.sp_executesql @probe,N'@portalEnvironment varchar(10), @requestedLinks nvarchar(max), @now datetime2(3)',
      @portalEnvironment='qa',@requestedLinks=@requestedLinks,@now=@stamp;
  IF (SELECT COUNT(*) FROM @seen WHERE target_status='verified')<>2
     OR (SELECT COUNT(DISTINCT physical_id) FROM @seen)<>1
    THROW 53684,N'Shared SQL destination was not resolved to a single identity.',1;

  UPDATE core.database_access_profiles SET initial_catalog=N'qa_changed' WHERE source_id=@tag+N'-a-profile';
  UPDATE core.database_access_profiles SET initial_catalog=N'qa_synthetic' WHERE source_id=@tag+N'-a-profile';
  DELETE FROM @seen;
  INSERT @seen
    EXEC sys.sp_executesql @probe,N'@portalEnvironment varchar(10), @requestedLinks nvarchar(max), @now datetime2(3)',
      @portalEnvironment='qa',@requestedLinks=@requestedLinks,@now=@stamp;
  IF NOT EXISTS (SELECT 1 FROM @seen WHERE ordinal=0 AND target_status='unverifiable' AND physical_id IS NULL)
    OR NOT EXISTS (SELECT 1 FROM @seen WHERE ordinal=1 AND target_status='verified' AND physical_id IS NOT NULL)
    THROW 53685,N'Profile reversal revived a stale SQL proof or affected the other alias.',1;

  ROLLBACK TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
SELECT CAST(1 AS bit) AS shared_target_verified,CAST(1 AS bit) AS route_reversal_stayed_retired,
  CAST(1 AS bit) AS shared_sql_verified,CAST(1 AS bit) AS profile_reversal_stayed_unverifiable,
  (SELECT COUNT(*) FROM core.clients WHERE source_id IN (@tag+N'-a',@tag+N'-b'))
    +(SELECT COUNT(*) FROM core.database_access_profiles WHERE source_id IN (@tag+N'-a-profile',@tag+N'-b-profile'))
    +(SELECT COUNT(*) FROM core.catalog_physical_targets WHERE identity_fingerprint IN (
      HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag)),HASHBYTES('SHA2_256',CONVERT(varbinary(max),@tag+N'-db')))) AS residual_rows;
'@
$fixture=$fixture.Replace('/* ROUTE_HASH */',$route)
$arguments=@{Mode='write';SessionDirectory=$session;Sql=($literal+[Environment]::NewLine+$fixture);TimeoutSeconds=30;MaxRows=1}
$result=(& (Join-Path $root 'migration/connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1') @arguments) |
  ConvertFrom-Json -Depth 12
$row=$result.resultSets[0].rows[0]
if($row.shared_target_verified -ne $true -or $row.route_reversal_stayed_retired -ne $true -or
   $row.shared_sql_verified -ne $true -or $row.profile_reversal_stayed_unverifiable -ne $true -or $row.residual_rows -ne 0){
  throw 'Physical-target rehearsal did not pass all invariants.'
}
Write-Host 'PASS QA physical targets: shared web and SQL identities, route/profile reversal does not revive proof, zero residual fixture rows.'
