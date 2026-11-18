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
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET NUMERIC_ROUNDABORT OFF;
IF DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR @@TRANCOUNT<>0
  THROW 54380,N'Wrong database or transaction.',1;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'core.domains',N'U')
    AND name=N'UX_domains_client_environment_name_active' AND is_unique=1 AND is_disabled=0 AND has_filter=1)
  OR EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'core.domains',N'U') AND name=N'UX_domains_name_active')
  THROW 54381,N'The scoped domain route uniqueness migration is not present.',1;

DECLARE @tag nvarchar(72)=N'qa-domain-scope-'+LOWER(CONVERT(char(36),NEWID()));
DECLARE @route nvarchar(500)=N'https://scope-'+LOWER(CONVERT(char(36),NEWID()))+N'.invalid';
DECLARE @now datetime2(3)=SYSUTCDATETIME(),@actor nvarchar(150)=N'qa-domain-scope-fixture';
DECLARE @firstClient bigint,@secondClient bigint,@initialDomain bigint,@replacementDomain bigint;
DECLARE @baseline TABLE(domain_key bigint PRIMARY KEY,source_id nvarchar(150) NOT NULL);
DECLARE @passed int=0,@expectDuplicate bit=0;
BEGIN TRY
  BEGIN TRANSACTION;
  -- Only internal IDs, never reported. Keep the QA baseline consistent while
  -- proving the scoped operations do not change any existing domain IDs.
  INSERT @baseline SELECT domain_key,source_id FROM core.domains WITH (HOLDLOCK);
  INSERT core.clients(source_id,name,name_normalized,status,created_at,created_by,updated_at,updated_by)
    VALUES(@tag+N'-client-a',@tag+N'-client-a',@tag+N'-client-a','active',@now,@actor,@now,@actor),
          (@tag+N'-client-b',@tag+N'-client-b',@tag+N'-client-b','active',@now,@actor,@now,@actor);
  SELECT @firstClient=client_key FROM core.clients WHERE source_id=@tag+N'-client-a';
  SELECT @secondClient=client_key FROM core.clients WHERE source_id=@tag+N'-client-b';
  INSERT core.domains(source_id,client_key,domain_name,domain_name_normalized,environment_id,status,created_at,created_by,updated_at,updated_by)
    VALUES(@tag+N'-a-test',@firstClient,@route,@route,'test','active',@now,@actor,@now,@actor),
          (@tag+N'-b-test',@secondClient,@route,@route,'test','active',@now,@actor,@now,@actor),
          (@tag+N'-a-prod',@firstClient,@route,@route,'production','active',@now,@actor,@now,@actor);
  IF (SELECT COUNT(*) FROM core.domains WHERE domain_name_normalized=@route
    AND environment_id='test' AND client_key IN (@firstClient,@secondClient) AND status='active')<>2
    THROW 54382,N'The same route under two clients was not accepted.',1;
  SET @passed+=1;
  IF (SELECT COUNT(*) FROM core.domains WHERE domain_name_normalized=@route
    AND client_key=@firstClient AND environment_id IN ('test','production') AND status='active')<>2
    THROW 54383,N'The same route under two environments was not accepted.',1;
  SET @passed+=1;

  -- A deleted alias may coexist with the current domain; retiring the
  -- current row makes room for a new ID without rewriting the old ID.
  INSERT core.domains(source_id,client_key,domain_name,domain_name_normalized,environment_id,status,
    created_at,created_by,updated_at,updated_by,deleted_at,deleted_by)
    VALUES(@tag+N'-a-deleted',@firstClient,@route,@route,'test','deleted',@now,@actor,@now,@actor,@now,@actor);
  SELECT @initialDomain=domain_key FROM core.domains WHERE source_id=@tag+N'-a-test';
  UPDATE core.domains SET status='deleted',deleted_at=@now,deleted_by=@actor WHERE domain_key=@initialDomain;
  INSERT core.domains(source_id,client_key,domain_name,domain_name_normalized,environment_id,status,created_at,created_by,updated_at,updated_by)
    VALUES(@tag+N'-a-replacement',@firstClient,@route,@route,'test','active',@now,@actor,@now,@actor);
  SELECT @replacementDomain=domain_key FROM core.domains WHERE source_id=@tag+N'-a-replacement';
  IF @initialDomain IS NULL OR @replacementDomain IS NULL OR @replacementDomain=@initialDomain
    OR NOT EXISTS(SELECT 1 FROM core.domains WHERE domain_key=@initialDomain AND source_id=@tag+N'-a-test' AND status='deleted')
    OR (SELECT COUNT(*) FROM core.domains WHERE client_key=@firstClient AND environment_id='test'
      AND domain_name_normalized=@route AND status='deleted')<>2
    THROW 54384,N'Deleted rows did not remain addressable by their original IDs.',1;
  SET @passed+=1;

  IF EXISTS(SELECT domain_key,source_id FROM @baseline EXCEPT
    SELECT domain_key,source_id FROM core.domains WHERE client_key NOT IN (@firstClient,@secondClient))
    OR EXISTS(SELECT domain_key,source_id FROM core.domains WHERE client_key NOT IN (@firstClient,@secondClient)
      EXCEPT SELECT domain_key,source_id FROM @baseline)
    THROW 54385,N'A preexisting QA domain identity changed during the rehearsal.',1;
  SET @passed+=1;

  -- Inactive, unlike deleted, must still collide in the exact same scope.
  -- The expected unique-index error is last; CATCH rolls all fixtures back.
  SET @expectDuplicate=1;
  INSERT core.domains(source_id,client_key,domain_name,domain_name_normalized,environment_id,status,created_at,created_by,updated_at,updated_by)
    VALUES(@tag+N'-a-duplicate',@firstClient,@route,@route,'test','inactive',@now,@actor,@now,@actor);
  THROW 54386,N'A duplicate was accepted within the same client and environment.',1;
END TRY
BEGIN CATCH
  DECLARE @number int=ERROR_NUMBER(),@message nvarchar(4000)=ERROR_MESSAGE();
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  IF @expectDuplicate<>1 OR @number NOT IN (2601,2627)
    OR CHARINDEX(N'UX_domains_client_environment_name_active',@message)=0 THROW;
  SET @passed+=1;
END CATCH;

SELECT @passed AS passed,
  (SELECT COUNT(*) FROM core.clients WHERE source_id IN (@tag+N'-client-a',@tag+N'-client-b'))
  +(SELECT COUNT(*) FROM core.domains WHERE domain_name_normalized=@route)
  AS remaining_fixtures;
'@

$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
try {
  $response=(& $invoke -SessionDirectory $session -Sql $fixture -Mode write -TimeoutSeconds 35 -MaxRows 1) | ConvertFrom-Json -Depth 16
} catch {
  throw 'QA domain scope rehearsal did not return a valid sanitized result.'
}
$row=$response.resultSets[0].rows[0]
if(!$response.success -or $row.passed -ne 5 -or $row.remaining_fixtures -ne 0){
  $number=0
  [void][int]::TryParse([string]$response.error.number,[ref]$number)
  throw "QA domain scope rehearsal did not pass or left residual rows (SQL error number: $number)."
}
$row | Select-Object passed,remaining_fixtures | ConvertTo-Json -Compress
