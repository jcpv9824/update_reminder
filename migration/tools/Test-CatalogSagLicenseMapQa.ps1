[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SessionDirectory)

$ErrorActionPreference='Stop'
$session=(Resolve-Path -LiteralPath $SessionDirectory).Path
$descriptor=Get-Content -Raw -LiteralPath (Join-Path $session 'active.json') | ConvertFrom-Json
if($descriptor.database -ne 'PortalSAGWeb-TEST' -or ($descriptor.environment -and $descriptor.environment -ne 'qa')){
  throw 'This rehearsal requires the PortalSAGWeb-TEST session.'
}
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$query=(Get-Content -LiteralPath (Join-Path $root 'api/src/lib/catalogSagCustomerEvidenceSqlRepository.ts') -Raw).Split([char]96) |
  Where-Object { $_ -match 'SELECT mapping.sag_code' } | Select-Object -First 1
if(!$query){ throw 'Could not locate the SQL module projection.' }
$query=$query.Substring($query.IndexOf('SELECT mapping.sag_code')).Trim()
if($query -match '(?im)^\s*(INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|CREATE)\b'){ throw 'Expected a read-only module projection.' }
$literal="DECLARE @selector nvarchar(max)=N'"+$query.Replace("'","''")+"';"
$fixture=@'
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF DB_NAME()<>N'PortalSAGWeb-TEST' OR @@TRANCOUNT<>0 THROW 54020,N'Unexpected database or transaction.',1;
IF EXISTS(SELECT 1 FROM settings.catalog_match_key_registry WHERE portal_environment='qa')
  OR EXISTS(SELECT 1 FROM core.catalog_customer_source_revisions) THROW 54021,N'Rehearsal requires an unused QA catalog.',1;
DECLARE @tag nvarchar(85)=N'qa-license-map-'+LOWER(CONVERT(char(36),NEWID()));
DECLARE @now datetime2(3)=SYSUTCDATETIME(), @sagKey bigint, @lock int, @rejected int=0;
DECLARE @moduleA bigint, @moduleB bigint, @srcA bigint, @srcB bigint;
DECLARE @bindingA binary(8),@bindingB binary(8),@profileA binary(8),@profileB binary(8);
DECLARE @found TABLE (sag_code varchar(1),module_id nvarchar(150),module_name nvarchar(200),module_description nvarchar(2000));
DECLARE @binding TABLE (idx char(1),source_key bigint);
DECLARE @state varchar(11)='verified';
BEGIN TRY
  BEGIN TRANSACTION;
  EXEC @lock=sys.sp_getapplock @Resource=N'portal-sag:catalog-customer-publication:qa',@LockMode=N'Exclusive',
    @LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
  IF @lock<0 THROW 54022,N'Rehearsal could not take the QA publication lock.',1;
  INSERT settings.catalog_match_key_registry(portal_environment,match_key_version,vault_secret_version,key_verifier)
    VALUES('qa',1,CONVERT(binary(16),0x0401),HASHBYTES('SHA2_256',N'fixture-040-not-a-key'));
  INSERT licensing.license_modules(source_id,name,name_normalized,description,status,created_at,created_by,updated_at,updated_by)
    SELECT @tag+suffix,@tag+suffix,@tag+suffix,N'Fixture only','active',@now,'fixture',@now,'fixture' FROM (VALUES('a'),('b')) names(suffix);
  SELECT @moduleA=module_key FROM licensing.license_modules WHERE source_id=@tag+N'a';
  SELECT @moduleB=module_key FROM licensing.license_modules WHERE source_id=@tag+N'b';
  INSERT settings.external_database_connections(source_id,display_name,server_host,database_name,login_name,
    password_configured,password_secret_name,created_by,updated_by)
    SELECT @tag+suffix,@tag+suffix,N'fixture.invalid',N'synthetic',N'synthetic',1,N'fixture-no-key','fixture','fixture' FROM (VALUES('a'),('b')) names(suffix);
  INSERT settings.catalog_source_bindings(external_database_connection_key,display_name,source_role,portal_environment,
    contract_version,source_state,validated_at,validated_profile_version,created_at,updated_at,created_by,updated_by)
    OUTPUT RIGHT(inserted.display_name,1),inserted.catalog_source_key INTO @binding(idx,source_key)
    SELECT external_database_connection_key,source_id,'sag-admin',CASE WHEN source_id=@tag+N'a' THEN 'qa' ELSE 'production' END,
      'sag_admin_v1','active',@now,row_version,@now,@now,'fixture','fixture'
    FROM settings.external_database_connections WHERE source_id IN (@tag+N'a',@tag+N'b');
  SELECT @srcA=source_key FROM @binding WHERE idx='a';
  SELECT @srcB=source_key FROM @binding WHERE idx='b';
  SELECT @bindingA=row_version,@profileA=validated_profile_version FROM settings.catalog_source_bindings WHERE catalog_source_key=@srcA;
  SELECT @bindingB=row_version,@profileB=validated_profile_version FROM settings.catalog_source_bindings WHERE catalog_source_key=@srcB;
  INSERT settings.catalog_sag_license_module_approvals(catalog_source_key,binding_version,profile_version,sag_code,module_key,
    approval_reference,approved_by,approved_at)
    VALUES(@srcA,@bindingA,@profileA,'A',@moduleA,'qa-041','fixture',DATEADD(day,-1,@now)),
      (@srcA,@bindingA,@profileA,'B',@moduleA,'qa-041','fixture',DATEADD(day,-1,@now)),
      (@srcB,@bindingB,@profileB,'A',@moduleB,'qa-041','fixture',DATEADD(day,-1,@now));
  IF EXISTS(SELECT 1 FROM settings.catalog_sag_license_module_approvals WHERE catalog_source_key IN (@srcA,@srcB) AND approved_at<@now)
    THROW 54023,N'SQL accepted a caller-supplied approval time.',1;
  INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,match_key_version,
    attempt_ordinal,expected_rows,expected_scopes,observed_at,verified_until)
    VALUES(@srcA,'sag-admin',@bindingA,@profileA,1,9223372036854775800,0,0,@now,DATEADD(minute,5,@now));
  SET @sagKey=SCOPE_IDENTITY();
  SET @now=SYSUTCDATETIME();
  DECLARE @params nvarchar(160)=N'@sagKey bigint,@state varchar(11),@now datetime2(3)';
  -- The checked-in projection reads @details, so create it within the same dynamic batch.
  DECLARE @query nvarchar(max)=N'DECLARE @details TABLE(license_codes varchar(25)); INSERT @details VALUES(''A'');'+@selector;
  INSERT @found EXEC sys.sp_executesql @query,@params,@sagKey,@state,@now;
  IF (SELECT COUNT(*) FROM @found)<>1 OR NOT EXISTS(SELECT 1 FROM @found WHERE sag_code='A' AND module_id=@tag+N'a')
    THROW 54024,N'Projection mixed sources or admitted an unobserved code.',1;
  DELETE FROM @found;
  UPDATE licensing.license_modules SET status='inactive' WHERE module_key=@moduleA;
  INSERT @found EXEC sys.sp_executesql @query,@params,@sagKey,@state,@now;
  IF EXISTS(SELECT 1 FROM @found) THROW 54025,N'Projection admitted an inactive module.',1;
  UPDATE licensing.license_modules SET status='active' WHERE module_key=@moduleA;
  UPDATE settings.external_database_connections SET database_name='replacement-fixture' WHERE source_id=@tag+N'a';
  SELECT @profileA=row_version FROM settings.external_database_connections WHERE source_id=@tag+N'a';
  UPDATE settings.catalog_source_bindings SET validated_profile_version=@profileA,validated_at=@now WHERE catalog_source_key=@srcA;
  SELECT @bindingA=row_version FROM settings.catalog_source_bindings WHERE catalog_source_key=@srcA;
  INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,match_key_version,
    attempt_ordinal,expected_rows,expected_scopes,observed_at,verified_until)
    VALUES(@srcA,'sag-admin',@bindingA,@profileA,1,9223372036854775801,0,0,@now,DATEADD(minute,5,@now));
  SET @sagKey=SCOPE_IDENTITY();
  INSERT @found EXEC sys.sp_executesql @query,@params,@sagKey,@state,@now;
  IF EXISTS(SELECT 1 FROM @found) THROW 54027,N'The replacement profile inherited a previous approval.',1;
  -- The exception may doom the transaction; the outer catch always rolls it back.
  UPDATE settings.catalog_sag_license_module_approvals SET module_key=@moduleB WHERE catalog_source_key=@srcA AND sag_code='A';
  THROW 54026,N'An approved equivalence was overwritten.',1;
END TRY
BEGIN CATCH
  SET @rejected=ERROR_NUMBER();
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  IF @rejected<>54102 THROW;
END CATCH;
SELECT 6 AS passed,(SELECT COUNT(*) FROM licensing.license_modules WHERE source_id IN (@tag+N'a',@tag+N'b'))
  +(SELECT COUNT(*) FROM settings.catalog_sag_license_module_approvals WHERE catalog_source_key IN (@srcA,@srcB))
  +(SELECT COUNT(*) FROM settings.external_database_connections WHERE source_id IN (@tag+N'a',@tag+N'b'))
  +(SELECT COUNT(*) FROM settings.catalog_source_bindings WHERE catalog_source_key IN (@srcA,@srcB))
  +(SELECT COUNT(*) FROM core.catalog_customer_source_revisions WHERE catalog_source_key IN (@srcA,@srcB))
  +(SELECT COUNT(*) FROM settings.catalog_match_key_registry WHERE portal_environment='qa') AS remaining_fixtures;
'@
$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
$response=(& $invoke -SessionDirectory $session -Sql ($literal+[Environment]::NewLine+$fixture) -Mode write -TimeoutSeconds 35 -MaxRows 1)|ConvertFrom-Json -Depth 16
$row=$response.resultSets[0].rows[0]
if(!$response.success -or $row.passed -ne 6 -or $row.remaining_fixtures -ne 0){ throw 'QA SAG license map rehearsal failed or left residual rows.' }
$row | ConvertTo-Json -Compress
