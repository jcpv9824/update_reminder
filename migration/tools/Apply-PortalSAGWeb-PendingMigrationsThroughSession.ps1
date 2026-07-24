[CmdletBinding()]
param(
  [ValidateSet('qa','production')]
  [string]$Environment='qa',

  [string]$SessionDirectory
)

$ErrorActionPreference='Stop'
$repoMigrationRoot=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$sqlDirectory=Join-Path $repoMigrationRoot 'sql'
$manifestPath=Join-Path $sqlDirectory 'MANIFEST.sha256'
$clientPath=Join-Path $repoMigrationRoot 'connect-sql-server\Invoke-PortalSAGWeb-EphemeralRequest.ps1'
if([string]::IsNullOrWhiteSpace($SessionDirectory)){
  $sessionName=if($Environment -eq 'qa'){'sql-session-qa'}else{'sql-session'}
  $SessionDirectory=Join-Path $repoMigrationRoot "work\$sessionName"
}

$descriptorPath=Join-Path $SessionDirectory 'active.json'
if(-not (Test-Path -LiteralPath $descriptorPath)){throw "No active $Environment SQL session was found."}
$descriptor=Get-Content -Raw -LiteralPath $descriptorPath | ConvertFrom-Json
$expectedDatabase=if($Environment -eq 'qa'){'PortalSAGWeb-TEST'}else{'PortalSAGWeb'}
if($descriptor.environment -ne $Environment -or $descriptor.database -ne $expectedDatabase){
  throw "The active session does not target $Environment / $expectedDatabase."
}
if($descriptor.fullControl -ne $true -or $descriptor.accessLevel -ne 'full-control'){
  throw 'The active session is not authorized for full-control migrations.'
}

function Get-Sha256Hex([string]$Path){
  $stream=[IO.File]::OpenRead($Path)
  $sha=[Security.Cryptography.SHA256]::Create()
  try{return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}
  finally{$sha.Dispose();$stream.Dispose()}
}

function Invoke-SessionSql {
  param(
    [Parameter(Mandatory=$true)][string]$Sql,
    [ValidateSet('read','write')][string]$Mode,
    [int]$TimeoutSeconds=600,
    [int]$MaxRows=100
  )
  $json=& $clientPath -Sql $Sql -Mode $Mode -SessionDirectory $SessionDirectory `
    -TimeoutSeconds $TimeoutSeconds -MaxRows $MaxRows
  return $json | ConvertFrom-Json -Depth 12
}

$manifest=@{}
foreach($line in Get-Content -LiteralPath $manifestPath){
  if($line -match '^([a-fA-F0-9]{64})\s{2}(.+\.sql)$'){
    $manifest[$Matches[2]]=$Matches[1].ToLowerInvariant()
  }
}

$migrations=@(
  @{version='017';name='017_normalize_domain_url_identity.sql'},
  @{version='018';name='018_expand_license_module_description.sql'},
  @{version='019';name='019_expand_notification_outbox_types.sql'},
  @{version='020';name='020_allow_outbox_attempt_completion.sql'},
  @{version='021';name='021_atomic_operational_refresh.sql'},
  @{version='022';name='022_refresh_print_source_assignments.sql'},
  @{version='023';name='023_enable_masters_report_outbox.sql'},
  @{version='024';name='024_s3_object_storage.sql'}
)

foreach($migration in $migrations){
  $version=[string]$migration.version
  $name=[string]$migration.name
  $path=Join-Path $sqlDirectory $name
  if(-not (Test-Path -LiteralPath $path)){throw "Missing migration script: $name"}
  if(-not $manifest.ContainsKey($name)){throw "The manifest does not contain $name."}
  $hash=Get-Sha256Hex $path
  if($hash -cne $manifest[$name]){throw "Manifest checksum mismatch for $name."}

  $statusSql=@"
SELECT migration_version,CONVERT(VARCHAR(64),script_sha256,2) AS script_sha256,succeeded
FROM migration.schema_migrations
WHERE migration_version='$version';
"@
  $status=Invoke-SessionSql -Sql $statusSql -Mode read -TimeoutSeconds 120 -MaxRows 5
  $rows=@($status.resultSets[0].rows)
  if($rows.Count -gt 0){
    if(([string]$rows[0].script_sha256).ToLowerInvariant() -cne $hash -or $rows[0].succeeded -ne $true){
      throw "Migration history for $version conflicts with the reviewed script."
    }
    Write-Host "SKIP $version - already applied with the reviewed checksum." -ForegroundColor Cyan
    continue
  }

  Write-Host "APPLY $version - $name" -ForegroundColor Yellow
  $applyJson=& $clientPath -SqlFile $path -Mode write -SessionDirectory $SessionDirectory `
    -TimeoutSeconds 900 -MaxRows 100
  $null=$applyJson | ConvertFrom-Json -Depth 12

  $historySql=@"
SET XACT_ABORT ON;
BEGIN TRANSACTION;
IF EXISTS(SELECT 1 FROM migration.schema_migrations WHERE migration_version='$version')
  THROW 51980,N'Migration history changed concurrently.',1;
INSERT migration.schema_migrations
  (migration_version,script_name,script_sha256,duration_ms,succeeded)
VALUES
  ('$version',N'$name',0x$hash,0,1);
COMMIT TRANSACTION;
"@
  $null=Invoke-SessionSql -Sql $historySql -Mode write -TimeoutSeconds 120 -MaxRows 10
  Write-Host "PASS $version" -ForegroundColor Green
}

$verificationSql=@'
SELECT
  (SELECT COUNT(*) FROM migration.schema_migrations WHERE migration_version IN ('017','018','019','020','021','022','023') AND succeeded=1) AS applied_count,
  (SELECT COUNT_BIG(*) FROM core.domains WHERE RIGHT(domain_name_normalized,1)=N'/') AS trailing_domain_identities,
  COL_LENGTH(N'licensing.license_modules',N'description') AS license_description_bytes,
  (SELECT COUNT(*) FROM sys.check_constraints
   WHERE parent_object_id=OBJECT_ID(N'notifications.email_notifications')
     AND name=N'CK_email_notifications_type'
     AND definition LIKE N'%task_status_notification%'
     AND definition LIKE N'%test_email%'
     AND definition LIKE N'%masters_report%'
     AND is_disabled=0 AND is_not_trusted=0) AS outbox_constraint_ready,
  (SELECT COUNT(*) FROM sys.foreign_keys WHERE is_disabled=1 OR is_not_trusted=1) AS untrusted_or_disabled_fks,
  (SELECT COUNT(*) FROM sys.check_constraints WHERE is_disabled=1 OR is_not_trusted=1) AS untrusted_or_disabled_checks,
  (SELECT COUNT(*) FROM sys.triggers
   WHERE object_id=OBJECT_ID(N'notifications.TR_notification_attempts_append_only')
     AND OBJECT_DEFINITION(object_id) LIKE N'%processing-to-terminal completion%') AS attempt_completion_trigger_ready,
  (SELECT COUNT(*) FROM sys.indexes
   WHERE object_id=OBJECT_ID(N'migration.file_transfers')
     AND name=N'UX_file_transfers_run_blob' AND is_unique=1) AS per_run_blob_index_ready,
  CASE WHEN OBJECT_ID(N'migration.usp_replace_operational_from_validated_run',N'P') IS NULL
    THEN 0 ELSE 1 END AS atomic_refresh_ready,
  CASE WHEN OBJECT_DEFINITION(OBJECT_ID(N'migration.usp_replace_operational_from_validated_run'))
      LIKE N'%EXEC migration.usp_load_operational_final_with_print_sources @run_key;%'
    THEN 1 ELSE 0 END AS refresh_print_sources_ready;
'@
$verification=Invoke-SessionSql -Sql $verificationSql -Mode read -TimeoutSeconds 120 -MaxRows 10
$row=$verification.resultSets[0].rows[0]
if($row.applied_count -ne 7 -or $row.trailing_domain_identities -ne 0 -or
   $row.license_description_bytes -ne 4000 -or $row.outbox_constraint_ready -ne 1 -or
   $row.untrusted_or_disabled_fks -ne 0 -or $row.untrusted_or_disabled_checks -ne 0 -or
   $row.attempt_completion_trigger_ready -ne 1 -or $row.per_run_blob_index_ready -ne 1 -or
   $row.atomic_refresh_ready -ne 1 -or $row.refresh_print_sources_ready -ne 1){
  throw 'Pending-migration post-verification failed.'
}

Write-Host "$expectedDatabase migrations 017-023 are applied and verified." -ForegroundColor Green
