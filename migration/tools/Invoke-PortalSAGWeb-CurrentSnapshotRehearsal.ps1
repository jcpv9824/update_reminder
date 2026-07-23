[CmdletBinding()]
param(
  [string]$ServerName,
  [string]$DatabaseName = 'PortalSAGWeb',
  [string]$SnapshotDirectory,
  [string]$StorageAccountName,
  [string]$ResourceGroupName,
  [string]$BlobContainerName,
  [ValidateRange(0,2)]
  [int]$RehearsalNumber = 0,
  [string]$EvidenceDirectory
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ([string]::IsNullOrWhiteSpace($ServerName)) {
  $ServerName = Read-Host 'NON-PRODUCTION rehearsal SQL Server / instance (server,port)'
}
if ($ServerName.Trim().Equals('data14.sagerp.co,54103',[StringComparison]::OrdinalIgnoreCase)) {
  throw 'REFUSED: data14.sagerp.co,54103 / PortalSAGWeb is the designated production target. Use a separate rehearsal database/server.'
}

if ([string]::IsNullOrWhiteSpace($SnapshotDirectory)) {
  $SnapshotDirectory = Join-Path $PSScriptRoot '..\backups\cosmos-export-prod-20260722-155753'
}
if ($RehearsalNumber -eq 0) {
  $enteredRehearsalNumber = Read-Host 'Certified rehearsal number (1 or 2)'
  if (-not [int]::TryParse($enteredRehearsalNumber,[ref]$RehearsalNumber) -or
      $RehearsalNumber -notin @(1,2)) {
    throw 'The certified rehearsal number must be 1 or 2.'
  }
}
if ([string]::IsNullOrWhiteSpace($EvidenceDirectory)) {
  $EvidenceDirectory = Join-Path $PSScriptRoot '..\work\rehearsal-evidence'
}
$snapshotPath = (Resolve-Path -LiteralPath $SnapshotDirectory).Path
$snapshotName = Split-Path -Leaf $snapshotPath
$expectedSnapshotName = 'cosmos-export-prod-20260722-155753'
$expectedDocuments = 2987L
$expectedWarnings = 464
$manifestPath = Join-Path $PSScriptRoot '..\sql\MANIFEST.sha256'
$prepareScriptPath = Join-Path $PSScriptRoot '..\sql\001_prepare_production_mvp_database.sql'
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw 'The versioned SQL checksum manifest is missing.'
}
if (-not (Test-Path -LiteralPath $prepareScriptPath)) {
  throw 'The versioned SQL database-preparation script is missing.'
}
$manifestSha256 = [Convert]::ToHexString(
  [Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($manifestPath))
).ToLowerInvariant()
$prepareSha256 = [Convert]::ToHexString(
  [Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($prepareScriptPath))
).ToLowerInvariant()
$phaseDurations = [ordered]@{}

function Invoke-RehearsalPhase {
  param(
    [Parameter(Mandatory=$true)][string]$Name,
    [Parameter(Mandatory=$true)][scriptblock]$Action
  )

  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  try {
    & $Action
  }
  finally {
    $stopwatch.Stop()
    $phaseDurations[$Name] = [Math]::Round($stopwatch.Elapsed.TotalSeconds,3)
  }
}

if ($DatabaseName -ne 'PortalSAGWeb') {
  throw 'This certified rehearsal targets only the PortalSAGWeb database.'
}
if ($snapshotName -cne $expectedSnapshotName) {
  throw "The selected snapshot is not the reviewed current snapshot: $expectedSnapshotName."
}

function New-SafeConnection {
  param([System.Management.Automation.PSCredential]$Credential)

  $builder = [System.Data.SqlClient.SqlConnectionStringBuilder]::new()
  $builder['Data Source'] = $ServerName
  $builder['Initial Catalog'] = $DatabaseName
  $builder['Encrypt'] = $true
  $builder['TrustServerCertificate'] = $false
  $builder['Connect Timeout'] = 30
  $builder['Persist Security Info'] = $false
  $builder['MultipleActiveResultSets'] = $false
  $builder['Application Name'] = 'PortalSAGWeb-CurrentSnapshotRehearsal'

  $sqlCredential = [System.Data.SqlClient.SqlCredential]::new($Credential.UserName,$Credential.Password)
  $connection = [System.Data.SqlClient.SqlConnection]::new()
  $connection.ConnectionString = $builder.ConnectionString
  $connection.Credential = $sqlCredential
  return $connection
}

function Get-TargetState {
  param([System.Management.Automation.PSCredential]$Credential)

  $connection = New-SafeConnection $Credential
  try {
    $connection.Open()
    $command = $connection.CreateCommand()
    try {
      $command.CommandText = @'
SELECT
  CAST(SERVERPROPERTY('ProductMajorVersion') AS INT) AS major_version,
  d.compatibility_level,
  d.collation_name,
  CASE WHEN IS_ROLEMEMBER(N'db_owner')=1
         OR HAS_PERMS_BY_NAME(DB_NAME(),N'DATABASE',N'CONTROL')=1 THEN 1 ELSE 0 END AS full_control,
  CASE WHEN IS_ROLEMEMBER(N'portal_runtime')=1 THEN 1 ELSE 0 END AS portal_runtime,
  (SELECT COUNT_BIG(*) FROM sys.tables WHERE is_ms_shipped=0) AS user_table_count,
  CASE WHEN OBJECT_ID(N'migration.schema_migrations',N'U') IS NOT NULL THEN 1 ELSE 0 END AS has_schema_history;
'@
      $reader = $command.ExecuteReader()
      if (-not $reader.Read()) { throw 'SQL target preflight returned no row.' }
      $state = [ordered]@{
        majorVersion = [Convert]::ToInt32($reader.GetValue(0))
        compatibilityLevel = [Convert]::ToInt32($reader.GetValue(1))
        collationName = $reader.GetString(2)
        fullControl = [Convert]::ToInt32($reader.GetValue(3)) -eq 1
        portalRuntime = [Convert]::ToInt32($reader.GetValue(4)) -eq 1
        userTableCount = [Convert]::ToInt64($reader.GetValue(5))
        hasSchemaHistory = [Convert]::ToInt32($reader.GetValue(6)) -eq 1
        migrationRunCount = 0L
        operationalRowCount = 0L
      }
      $reader.Close()
    }
    finally { $command.Dispose() }

    return [pscustomobject]$state
  }
  finally {
    if ($connection.State -ne [Data.ConnectionState]::Closed) { $connection.Close() }
    $connection.Dispose()
  }
}

function Get-ValidatedRunKey {
  param([System.Management.Automation.PSCredential]$Credential)

  $connection = New-SafeConnection $Credential
  try {
    $connection.Open()
    $command = $connection.CreateCommand()
    try {
      $command.CommandText = @'
SELECT TOP (1) run_key
FROM migration.migration_runs
WHERE snapshot_name=@snapshot_name
  AND source_document_count=@document_count
  AND warning_count=@warning_count
  AND status='validated'
ORDER BY run_key DESC;
'@
      $null = $command.Parameters.Add('@snapshot_name',[Data.SqlDbType]::NVarChar,260)
      $null = $command.Parameters.Add('@document_count',[Data.SqlDbType]::BigInt)
      $null = $command.Parameters.Add('@warning_count',[Data.SqlDbType]::Int)
      $command.Parameters['@snapshot_name'].Value = $snapshotName
      $command.Parameters['@document_count'].Value = $expectedDocuments
      $command.Parameters['@warning_count'].Value = $expectedWarnings
      $value = $command.ExecuteScalar()
      if ($null -eq $value -or $value -is [DBNull]) {
        throw 'The current snapshot did not produce a validated migration run.'
      }
      return [long]$value
    }
    finally { $command.Dispose() }
  }
  finally {
    if ($connection.State -ne [Data.ConnectionState]::Closed) { $connection.Close() }
    $connection.Dispose()
  }
}

function Get-RehearsalOutcome {
  param(
    [System.Management.Automation.PSCredential]$Credential,
    [long]$RunKey
  )

  $connection = New-SafeConnection $Credential
  try {
    $connection.Open()
    $command = $connection.CreateCommand()
    try {
      $command.CommandText = @'
SELECT
  mr.status,
  mr.source_document_count,
  mr.warning_count,
  mr.critical_error_count,
  (SELECT COUNT_BIG(*) FROM migration.reconciliation_counts rc
   WHERE rc.run_key=mr.run_key) AS reconciliation_count,
  (SELECT COUNT_BIG(*) FROM migration.reconciliation_counts rc
   WHERE rc.run_key=mr.run_key AND rc.reconciled=0) AS failed_reconciliation_count,
  (SELECT COUNT_BIG(*) FROM migration.validation_results vr
   WHERE vr.run_key=mr.run_key AND vr.severity='critical' AND vr.resolution_status='open') AS open_critical_count,
  (SELECT COUNT_BIG(*) FROM migration.file_transfers ft
   WHERE ft.run_key=mr.run_key AND ft.status='verified') AS verified_file_count,
  (SELECT COUNT_BIG(*) FROM sys.foreign_keys WHERE is_disabled=1 OR is_not_trusted=1)
   +(SELECT COUNT_BIG(*) FROM sys.check_constraints WHERE is_disabled=1 OR is_not_trusted=1)
    AS untrusted_constraint_count
FROM migration.migration_runs mr
WHERE mr.run_key=@run_key;
'@
      $null = $command.Parameters.Add('@run_key',[Data.SqlDbType]::BigInt)
      $command.Parameters['@run_key'].Value = $RunKey
      $reader = $command.ExecuteReader()
      if (-not $reader.Read()) { throw 'The completed rehearsal run could not be verified.' }
      $outcome = [ordered]@{
        status = $reader.GetString(0)
        sourceDocumentCount = $reader.GetInt64(1)
        warningCount = $reader.GetInt32(2)
        criticalErrorCount = $reader.GetInt32(3)
        reconciliationCount = $reader.GetInt64(4)
        failedReconciliationCount = $reader.GetInt64(5)
        openCriticalCount = $reader.GetInt64(6)
        verifiedFileCount = $reader.GetInt64(7)
        untrustedConstraintCount = $reader.GetInt64(8)
      }
      $reader.Close()
      return [pscustomobject]$outcome
    }
    finally { $command.Dispose() }
  }
  finally {
    if ($connection.State -ne [Data.ConnectionState]::Closed) { $connection.Close() }
    $connection.Dispose()
  }
}

Write-Host 'Portal SAG Web - CURRENT SNAPSHOT SQL REHEARSAL' -ForegroundColor Cyan
Write-Host 'Cosmos remains the live response/write source during this rehearsal.'
Write-Host 'One migration credential is kept only in this PowerShell process.'
Write-Host 'The runtime login is rejected; a separate provider migration login is required.'
Write-Host 'Each certified rehearsal must start from a database with zero user tables.'
Write-Host 'No document values, SQL password, connection string, file names, IDs or hashes are printed.'
Write-Host
Write-Host "Server:   $ServerName"
Write-Host "Database: $DatabaseName"
Write-Host "Certified rehearsal: $RehearsalNumber of 2"
Write-Host "Snapshot contract: 17 containers; $expectedDocuments documents; 0 critical errors; $expectedWarnings reviewed warnings."
Write-Host 'Blob contract: 39 private objects; 968128 bytes.'
Write-Host

$validator = Join-Path $PSScriptRoot 'validate-cosmos-business-data.js'
$blobPlanner = Join-Path $PSScriptRoot 'prepare-blob-transfer-package.js'
& node $validator $snapshotPath
if ($LASTEXITCODE -ne 0) { throw 'Current snapshot business validation failed.' }
& node $blobPlanner $snapshotPath
if ($LASTEXITCODE -ne 0) { throw 'Current snapshot private-file validation failed.' }

$migrationUsername = (Read-Host 'Provider SQL migration username (not SAGWebDev)').Trim()
if ([string]::IsNullOrWhiteSpace($migrationUsername)) { throw 'A provider migration username is required.' }
$securePassword = Read-Host 'Provider SQL migration password' -AsSecureString
if (-not $securePassword.IsReadOnly()) { $securePassword.MakeReadOnly() }
$credential = [System.Management.Automation.PSCredential]::new($migrationUsername,$securePassword)

try {
  Write-Host 'Opening strict-TLS preflight...' -ForegroundColor Cyan
  $state = Get-TargetState $credential
  if ($state.majorVersion -ne 15 -or $state.compatibilityLevel -ne 150 -or
      $state.collationName -ne 'Modern_Spanish_CI_AS') {
    throw 'The target does not match the certified SQL Server 2019/compatibility/collation contract.'
  }
  if (-not $state.fullControl -or $state.portalRuntime) {
    throw 'This is not the separate full-control migration identity. Do not elevate or use SAGWebDev.'
  }
  if ($state.userTableCount -ne 0) {
    throw "Certified rehearsal $RehearsalNumber must start from zero user tables; found $($state.userTableCount). Obtain a provider-created empty PortalSAGWeb database. This tool will not delete or reset evidence."
  }

  Write-Host 'Target and migration identity preflight passed.' -ForegroundColor Green
  $confirmation = Read-Host 'Type RUN CURRENT SNAPSHOT REHEARSAL to execute the complete database-changing rehearsal'
  if ($confirmation -cne 'RUN CURRENT SNAPSHOT REHEARSAL') {
    throw 'Rehearsal cancelled: exact authorization phrase was not provided.'
  }

  $databaseStopwatch = [Diagnostics.Stopwatch]::StartNew()
  try {
    Invoke-RehearsalPhase 'schema-build' {
    & (Join-Path $PSScriptRoot 'Build-PortalSAGWeb-NonProduction.ps1') `
      -ServerName $ServerName -DatabaseName $DatabaseName -EnvironmentTag nonproduction `
      -Credential $credential -Confirmed
    }

    Invoke-RehearsalPhase 'raw-stage' {
      & (Join-Path $PSScriptRoot 'Import-CosmosSnapshot-RawStage.ps1') `
        -SnapshotDirectory $snapshotPath -SourceEnvironment production -Apply `
        -TargetEnvironment nonproduction -ServerName $ServerName -DatabaseName $DatabaseName `
        -Credential $credential -AcceptKnownWarnings -Confirmed
    }

    $runKey = Get-ValidatedRunKey $credential

    Invoke-RehearsalPhase 'operational-core' {
      & (Join-Path $PSScriptRoot 'Load-PortalSAGWeb-OperationalCore.ps1') `
        -ServerName $ServerName -DatabaseName $DatabaseName -RunKey $runKey `
        -TargetEnvironment nonproduction -Credential $credential -Confirmed
    }

    Invoke-RehearsalPhase 'scheduling-workflow' {
      & (Join-Path $PSScriptRoot 'Load-PortalSAGWeb-OperationalSchedulingWorkflow.ps1') `
        -ServerName $ServerName -DatabaseName $DatabaseName -RunKey $runKey `
        -TargetEnvironment nonproduction -Credential $credential -Confirmed
    }

    Invoke-RehearsalPhase 'private-blob-transfer' {
      & (Join-Path $PSScriptRoot 'Transfer-PortalSAGWeb-Blobs.ps1') `
        -ServerName $ServerName -DatabaseName $DatabaseName -RunKey $runKey `
        -SnapshotDirectory $snapshotPath -StorageAccountName $StorageAccountName `
        -ResourceGroupName $ResourceGroupName -BlobContainerName $BlobContainerName `
        -TargetEnvironment nonproduction -Credential $credential -Confirmed
    }

    Invoke-RehearsalPhase 'final-operational' {
      & (Join-Path $PSScriptRoot 'Load-PortalSAGWeb-FinalOperational.ps1') `
        -ServerName $ServerName -DatabaseName $DatabaseName -RunKey $runKey `
        -TargetEnvironment nonproduction -Credential $credential -Confirmed
    }
  }
  finally {
    $databaseStopwatch.Stop()
  }

  $outcome = Get-RehearsalOutcome -Credential $credential -RunKey $runKey
  if ($outcome.status -ne 'completed' -or
      $outcome.sourceDocumentCount -ne $expectedDocuments -or
      $outcome.warningCount -ne $expectedWarnings -or
      $outcome.criticalErrorCount -ne 0 -or
      $outcome.failedReconciliationCount -ne 0 -or
      $outcome.openCriticalCount -ne 0 -or
      $outcome.verifiedFileCount -ne 39 -or
      $outcome.untrustedConstraintCount -ne 0) {
    throw 'The aggregate rehearsal certification outcome did not satisfy Gate D.'
  }

  $evidenceRunDirectory = Join-Path $EvidenceDirectory (
    'rehearsal-{0}-{1}' -f $RehearsalNumber,[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
  )
  [IO.Directory]::CreateDirectory($evidenceRunDirectory) | Out-Null
  $reportPath = Join-Path $evidenceRunDirectory 'rehearsal-report.json'
  $report = [ordered]@{
    version = 1
    success = $true
    rehearsalNumber = $RehearsalNumber
    generatedAtUtc = [DateTime]::UtcNow.ToString('O')
    databasePhaseSeconds = [Math]::Round($databaseStopwatch.Elapsed.TotalSeconds,3)
    phaseDurations = $phaseDurations
    target = [ordered]@{
      server = $ServerName
      database = $DatabaseName
      engineMajorVersion = $state.majorVersion
      compatibilityLevel = $state.compatibilityLevel
      collationName = $state.collationName
      initialUserTableCount = $state.userTableCount
    }
    source = [ordered]@{
      snapshotName = $snapshotName
      sourceDocumentCount = $expectedDocuments
      warningCount = $expectedWarnings
    }
    schema = [ordered]@{
      prepareSha256 = $prepareSha256
      manifestSha256 = $manifestSha256
    }
    outcome = $outcome
  }
  [IO.File]::WriteAllText(
    $reportPath,
    (($report | ConvertTo-Json -Depth 10) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
  )

  Write-Host
  Write-Host 'Current-snapshot SQL rehearsal completed.' -ForegroundColor Green
  Write-Host "Migration run key: $runKey"
  Write-Host "Database phases: $([Math]::Round($databaseStopwatch.Elapsed.TotalMinutes,2)) minutes."
  Write-Host "Sanitized evidence: $reportPath"
  Write-Host 'Cosmos is still the live response/write source. SQL-only cutover was not enabled.' -ForegroundColor Cyan
}
finally {
  $credential = $null
  $securePassword = $null
}
