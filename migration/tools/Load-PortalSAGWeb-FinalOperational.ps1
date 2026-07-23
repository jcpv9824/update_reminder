[CmdletBinding()]
param(
  [string]$ServerName,
  [string]$DatabaseName = 'PortalSAGWeb',
  [string]$Username,
  [System.Management.Automation.PSCredential]$Credential,
  [switch]$Confirmed,
  [long]$RunKey,
  [ValidateSet('nonproduction')]
  [string]$TargetEnvironment = 'nonproduction'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($DatabaseName -ne 'PortalSAGWeb') {
  throw 'The certified final loader requires a disposable non-production database named PortalSAGWeb.'
}
if ([string]::IsNullOrWhiteSpace($ServerName)) {
  $ServerName = Read-Host 'NON-PRODUCTION SQL Server / instance (server,port)'
}
if ($ServerName.Trim().Equals('data14.sagerp.co,54103',[StringComparison]::OrdinalIgnoreCase)) {
  throw 'REFUSED: the designated production PortalSAGWeb database cannot be used by the non-production final operational loader.'
}
if ($RunKey -le 0) {
  $enteredRunKey = Read-Host 'Validated raw/stage migration run key'
  if (-not [long]::TryParse($enteredRunKey, [ref]$RunKey) -or $RunKey -le 0) {
    throw 'A positive migration run key is required.'
  }
}

Write-Host 'Portal SAG Web - NON-PRODUCTION final operational load' -ForegroundColor Cyan
Write-Host 'This phase loads settings, verified document/video metadata, multi-source print formats, notification idempotency and append-only audit.'
Write-Host 'Every private Blob object must already be registered and byte/hash verified.'
Write-Host 'It requires the scheduling/workflow phase to be completed for the same migration run.'
Write-Host "Server:   $ServerName"
Write-Host "Database: $DatabaseName"
Write-Host "Run key:  $RunKey"
Write-Host 'No password will be stored or printed.'
Write-Host

if (-not $Confirmed) {
  $confirmation = Read-Host 'Type LOAD FINAL OPERATIONAL NONPRODUCTION to continue'
  if ($confirmation -cne 'LOAD FINAL OPERATIONAL NONPRODUCTION') {
    throw 'Operational load cancelled: exact non-production confirmation was not provided.'
  }
}
if ($null -ne $Credential) {
  if (-not [string]::IsNullOrWhiteSpace($Username) -and $Username -cne $Credential.UserName) {
    throw 'The explicit SQL username does not match the supplied credential.'
  }
  $Username = $Credential.UserName
  $securePassword = $Credential.Password
}
else {
  if ([string]::IsNullOrWhiteSpace($Username)) {
    $Username = Read-Host 'SQL Authentication username'
  }
  $securePassword = Read-Host 'SQL Authentication password' -AsSecureString
}
if (-not $securePassword.IsReadOnly()) {
  $securePassword.MakeReadOnly()
}

$builder = [System.Data.SqlClient.SqlConnectionStringBuilder]::new()
$builder['Data Source'] = $ServerName
$builder['Initial Catalog'] = $DatabaseName
$builder['Encrypt'] = $true
$builder['TrustServerCertificate'] = $false
$builder['Connect Timeout'] = 60
$builder['Persist Security Info'] = $false
$builder['MultipleActiveResultSets'] = $false
$builder['Application Name'] = 'PortalSAGWeb-FinalOperationalLoad'

$sqlCredential = [System.Data.SqlClient.SqlCredential]::new($Username, $securePassword)
$connection = [System.Data.SqlClient.SqlConnection]::new()
$connection.ConnectionString = $builder.ConnectionString
$connection.Credential = $sqlCredential

try {
  Write-Host 'Opening encrypted non-production connection...'
  $connection.Open()

  $preflight = $connection.CreateCommand()
  try {
    $preflight.CommandText = @'
SELECT
  CAST(SERVERPROPERTY('ProductMajorVersion') AS INT) AS major_version,
  d.compatibility_level,
  d.collation_name,
  CASE WHEN EXISTS
  (
    SELECT 1 FROM migration.schema_migrations
    WHERE migration_version='011'
      AND script_name=N'011_operational_load_settings_content_notifications_audit.sql' AND succeeded=1
  ) THEN 1 ELSE 0 END AS has_011,
  CASE WHEN OBJECT_ID(N'migration.usp_load_operational_settings_content_notifications_audit',N'P') IS NOT NULL
    THEN 1 ELSE 0 END AS has_loader,
  CASE WHEN EXISTS
  (
    SELECT 1 FROM migration.schema_migrations
    WHERE migration_version='015' AND script_name=N'015_print_format_multiple_sources.sql' AND succeeded=1
  ) THEN 1 ELSE 0 END AS has_015,
  CASE WHEN OBJECT_ID(N'migration.usp_load_operational_final_with_print_sources',N'P') IS NOT NULL
    THEN 1 ELSE 0 END AS has_multi_source_wrapper,
  CASE WHEN EXISTS
  (
    SELECT 1 FROM migration.schema_migrations
    WHERE migration_version='016' AND script_name=N'016_public_download_video_assets_and_source_cleanup.sql' AND succeeded=1
  ) THEN 1 ELSE 0 END AS has_016,
  CASE WHEN COL_LENGTH(N'content.public_download_documents',N'asset_kind') IS NOT NULL
    AND OBJECT_ID(N'content.v_public_download_assets',N'V') IS NOT NULL THEN 1 ELSE 0 END AS has_asset_model,
  CASE WHEN EXISTS
  (
    SELECT 1 FROM migration.operational_load_phases
    WHERE run_key=@run_key AND phase_code='scheduling_workflow' AND status='completed'
  ) THEN 1 ELSE 0 END AS workflow_completed,
  CASE WHEN EXISTS
  (
    SELECT 1 FROM migration.operational_load_phases
    WHERE run_key=@run_key AND phase_code='settings_content_notifications_audit' AND status='completed'
  ) THEN 1 ELSE 0 END AS final_completed,
  (SELECT COUNT_BIG(*) FROM migration.stage_print_formats WHERE run_key=@run_key)
    +(SELECT COUNT_BIG(*) FROM migration.stage_public_downloads WHERE run_key=@run_key AND record_type='document') AS expected_files,
  (SELECT COUNT_BIG(*) FROM migration.file_transfers
    WHERE run_key=@run_key AND source_container IN (N'formatosImpresion',N'publicDownloads')) AS planned_files,
  (SELECT COUNT_BIG(*) FROM migration.file_transfers
    WHERE run_key=@run_key AND source_container IN (N'formatosImpresion',N'publicDownloads') AND status='verified') AS verified_files
FROM sys.databases AS d
WHERE d.database_id=DB_ID();
'@
    $null = $preflight.Parameters.Add('@run_key', [Data.SqlDbType]::BigInt)
    $preflight.Parameters['@run_key'].Value = $RunKey
    $reader = $preflight.ExecuteReader()
    if (-not $reader.Read()) { throw 'Database preflight returned no row.' }
    $majorVersion = [Convert]::ToInt32($reader.GetValue(0))
    $compatibilityLevel = [Convert]::ToInt32($reader.GetValue(1))
    $collationName = $reader.GetString(2)
    $has011 = [Convert]::ToInt32($reader.GetValue(3))
    $hasLoader = [Convert]::ToInt32($reader.GetValue(4))
    $has015 = [Convert]::ToInt32($reader.GetValue(5))
    $hasMultiSourceWrapper = [Convert]::ToInt32($reader.GetValue(6))
    $has016 = [Convert]::ToInt32($reader.GetValue(7))
    $hasAssetModel = [Convert]::ToInt32($reader.GetValue(8))
    $workflowCompleted = [Convert]::ToInt32($reader.GetValue(9))
    $finalCompleted = [Convert]::ToInt32($reader.GetValue(10))
    $expectedFiles = [Convert]::ToInt64($reader.GetValue(11))
    $plannedFiles = [Convert]::ToInt64($reader.GetValue(12))
    $verifiedFiles = [Convert]::ToInt64($reader.GetValue(13))
    $reader.Close()
  }
  finally {
    $preflight.Dispose()
  }

  if ($majorVersion -ne 15) { throw "Expected SQL Server 2019 major version 15; found $majorVersion." }
  if ($compatibilityLevel -ne 150) { throw "Expected compatibility level 150; found $compatibilityLevel." }
  if ($collationName -ne 'Modern_Spanish_CI_AS') { throw "Unexpected collation: $collationName." }
  if ($has011 -ne 1 -or $hasLoader -ne 1) { throw 'Migration 011 is not installed and recorded successfully.' }
  if ($has015 -ne 1 -or $hasMultiSourceWrapper -ne 1) { throw 'Migration 015 multi-source print-format support is not installed successfully.' }
  if ($has016 -ne 1 -or $hasAssetModel -ne 1) { throw 'Migration 016 document/video asset support is not installed successfully.' }
  if ($workflowCompleted -ne 1) { throw 'The scheduling/workflow phase is not completed for this migration run.' }
  if ($finalCompleted -ne 1 -and ($expectedFiles -le 0 -or $plannedFiles -ne $expectedFiles -or $verifiedFiles -ne $expectedFiles)) {
    throw "Private Blob verification is incomplete: expected $expectedFiles; planned $plannedFiles; verified $verifiedFiles."
  }

  Write-Host 'Preflight passed. Starting the final transactional phase...' -ForegroundColor Cyan
  $command = $connection.CreateCommand()
  try {
    $command.CommandTimeout = 900
    $command.CommandType = [Data.CommandType]::StoredProcedure
    $command.CommandText = 'migration.usp_load_operational_final_with_print_sources'
    $null = $command.Parameters.Add('@run_key', [Data.SqlDbType]::BigInt)
    $command.Parameters['@run_key'].Value = $RunKey
    $reader = $command.ExecuteReader()
    if (-not $reader.Read()) { throw 'The loader returned no checkpoint row.' }
    $status = $reader.GetString(2)
    $sourceCount = if ($reader.IsDBNull(3)) { 0 } else { $reader.GetInt64(3) }
    $targetCount = if ($reader.IsDBNull(4)) { 0 } else { $reader.GetInt64(4) }
    $reader.Close()
  }
  finally {
    $command.Dispose()
  }

  if ($status -ne 'completed') { throw "The loader ended in unexpected status: $status." }
  Write-Host
  Write-Host 'NON-PRODUCTION final operational phase completed.' -ForegroundColor Green
  Write-Host "Source documents in phase:     $sourceCount"
  Write-Host "Operational and child records: $targetCount"
  Write-Host 'Next checkpoint: full business-output, permission, timer, file and rollback rehearsal.' -ForegroundColor Cyan
}
finally {
  if ($connection.State -ne [Data.ConnectionState]::Closed) { $connection.Close() }
  $connection.Dispose()
  $sqlCredential = $null
  $securePassword = $null
}
