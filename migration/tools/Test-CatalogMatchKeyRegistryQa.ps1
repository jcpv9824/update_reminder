[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SessionDirectory)

$ErrorActionPreference='Stop'
$session=(Resolve-Path -LiteralPath $SessionDirectory).Path
$descriptor=Get-Content -Raw -LiteralPath (Join-Path $session 'active.json') | ConvertFrom-Json
if($descriptor.database -ne 'PortalSAGWeb-TEST' -or ($descriptor.environment -and $descriptor.environment -ne 'qa')){
  throw 'This rehearsal requires the PortalSAGWeb-TEST session.'
}
$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
$sql=@'
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF DB_NAME()<>N'PortalSAGWeb-TEST' OR @@TRANCOUNT<>0 THROW 53820,N'Unexpected database or transaction for registry rehearsal.',1;
IF EXISTS (SELECT 1 FROM settings.catalog_match_key_registry)
  OR EXISTS (SELECT 1 FROM core.catalog_customer_source_revisions)
  THROW 53821,N'The synthetic registry rehearsal requires an empty QA registry and history.',1;
DECLARE @case int=1, @error int, @expected int, @pass int=0, @lock int, @source bigint, @profile bigint;
DECLARE @vault binary(16)=CONVERT(binary(16),0xFA01), @verifier binary(32)=HASHBYTES('SHA2_256',N'fixture-038-not-a-key');
DECLARE @stamp datetime2(3)=SYSUTCDATETIME();
WHILE @case<=5
BEGIN
  SET @error=0;
  SET @expected=CASE @case WHEN 1 THEN 53803 WHEN 2 THEN 53801 WHEN 3 THEN 53801 WHEN 4 THEN 53804 ELSE 0 END;
  BEGIN TRY
    BEGIN TRANSACTION;
    IF @case<>1
    BEGIN
      EXEC @lock=sys.sp_getapplock @Resource=N'portal-sag:catalog-customer-publication:qa',
        @LockMode=N'Exclusive',@LockOwner=N'Transaction',@DbPrincipal=N'public',@LockTimeout=5000;
      IF @lock<0 THROW 53822,N'Could not acquire the QA publication lock.',1;
    END;
    INSERT settings.catalog_match_key_registry(portal_environment,match_key_version,vault_secret_version,key_verifier)
      VALUES('qa',1,@vault,@verifier);
    IF @case=2 UPDATE settings.catalog_match_key_registry SET match_key_version=2 WHERE portal_environment='qa';
    IF @case=3 DELETE settings.catalog_match_key_registry WHERE portal_environment='qa';
    IF @case>=4
    BEGIN
      INSERT settings.external_database_connections(source_id,display_name,server_host,database_name,login_name,created_by,updated_by)
        VALUES('qa-fixture-038','QA synthetic 038','not-connected.invalid','synthetic','synthetic','qa-fixture','qa-fixture');
      SET @profile=SCOPE_IDENTITY();
      INSERT settings.catalog_source_bindings(external_database_connection_key,display_name,source_role,portal_environment,
        issuer_scope,contract_version,created_by,updated_by)
        VALUES(@profile,'QA synthetic 038','erp-customers','qa','CO:NIT','erp_v1','qa-fixture','qa-fixture');
      SET @source=SCOPE_IDENTITY();
      INSERT core.catalog_customer_source_revisions(catalog_source_key,source_role,binding_version,profile_version,
        match_key_version,attempt_ordinal,expected_rows,expected_scopes,observed_at,verified_until)
        VALUES(@source,'erp-customers',0x01,0x02,CASE WHEN @case=4 THEN 2 ELSE 1 END,
          9223372036854775800,0,0,@stamp,DATEADD(minute,5,@stamp));
      IF NOT EXISTS (SELECT 1 FROM settings.catalog_match_key_registry WHERE portal_environment='qa'
        AND match_key_version=1 AND vault_secret_version=@vault AND key_verifier=@verifier)
        OR EXISTS (SELECT 1 FROM settings.catalog_match_key_registry WHERE portal_environment='qa'
        AND match_key_version=1 AND vault_secret_version=@vault AND key_verifier=0x01)
        THROW 53823,N'Expected verifier matching results were not observed.',1;
    END;
    ROLLBACK TRANSACTION;
  END TRY
  BEGIN CATCH
    SET @error=ERROR_NUMBER();
    IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  END CATCH;
  IF @error<>@expected
  BEGIN
    DECLARE @failure nvarchar(100)=CONCAT(N'Registry rehearsal case ',@case,N' returned ',@error,N' expected ',@expected,N'.');
    THROW 53824,@failure,1;
  END;
  SET @pass+=1;
  SET @case+=1;
END;
SELECT @pass AS passed, (SELECT COUNT(*) FROM settings.catalog_match_key_registry) AS remaining_enrollments,
  (SELECT COUNT(*) FROM core.catalog_customer_source_revisions) AS remaining_revisions,
  (SELECT COUNT(*) FROM settings.external_database_connections WHERE source_id='qa-fixture-038') AS remaining_fixtures;
'@
$result=(& $invoke -SessionDirectory $session -Sql $sql -Mode write -TimeoutSeconds 30 -MaxRows 1) | ConvertFrom-Json -Depth 16
$row=$result.resultSets[0].rows[0]
if(!$result.success -or $row.passed -ne 5 -or $row.remaining_enrollments -ne 0 -or $row.remaining_revisions -ne 0 -or $row.remaining_fixtures -ne 0){
  throw 'The catalog match-key QA rehearsal did not pass or left residual data.'
}
$row | ConvertTo-Json -Compress
