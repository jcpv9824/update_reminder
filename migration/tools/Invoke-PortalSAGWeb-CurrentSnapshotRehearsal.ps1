[CmdletBinding()]
param(
  [string]$ServerName,
  [string]$DatabaseName = 'PortalSAGWeb',
  [string]$SnapshotDirectory,
  [string]$StorageAccountName,
  [string]$ResourceGroupName,
  [string]$BlobContainerName
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
$snapshotPath = (Resolve-Path -LiteralPath $SnapshotDirectory).Path
$snapshotName = Split-Path -Leaf $snapshotPath
$expectedSnapshotName = 'cosmos-export-prod-20260722-155753'
$expectedDocuments = 2987L
$expectedWarnings = 464

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

    if ($state.hasSchemaHistory) {
      $detail = $connection.CreateCommand()
      try {
        $detail.CommandText = @'
SELECT
  (SELECT COUNT_BIG(*) FROM migration.migration_runs) AS migration_run_count,
  (SELECT COUNT_BIG(*) FROM core.clients)
   +(SELECT COUNT_BIG(*) FROM core.domains)
   +(SELECT COUNT_BIG(*) FROM core.databases)
   +(SELECT COUNT_BIG(*) FROM licensing.license_modules)
   +(SELECT COUNT_BIG(*) FROM licensing.license_assignments)
   +(SELECT COUNT_BIG(*) FROM scheduling.update_schedules)
   +(SELECT COUNT_BIG(*) FROM workflow.update_tasks)
   +(SELECT COUNT_BIG(*) FROM content.files)
   +(SELECT COUNT_BIG(*) FROM notifications.email_notifications)
   +(SELECT COUNT_BIG(*) FROM audit.audit_logs) AS operational_row_count;
'@
        $reader = $detail.ExecuteReader()
        if (-not $reader.Read()) { throw 'SQL target detail preflight returned no row.' }
        $state.migrationRunCount = $reader.GetInt64(0)
        $state.operationalRowCount = $reader.GetInt64(1)
        $reader.Close()
      }
      finally { $detail.Dispose() }
    }
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

Write-Host 'Portal SAG Web - CURRENT SNAPSHOT SQL REHEARSAL' -ForegroundColor Cyan
Write-Host 'Cosmos remains the live response/write source during this rehearsal.'
Write-Host 'One migration credential is kept only in this PowerShell process.'
Write-Host 'The runtime login is rejected; a separate provider migration login is required.'
Write-Host 'The target must be empty or a clean schema build with zero prior migration runs.'
Write-Host 'No document values, SQL password, connection string, file names, IDs or hashes are printed.'
Write-Host
Write-Host "Server:   $ServerName"
Write-Host "Database: $DatabaseName"
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
  if ($state.operationalRowCount -ne 0 -or $state.migrationRunCount -ne 0) {
    throw "The target still contains prior rehearsal data (operational rows=$($state.operationalRowCount); migration runs=$($state.migrationRunCount)). Obtain a provider backup/restore point and a clean PortalSAGWeb target before continuing; this tool will not delete evidence silently."
  }
  if ($state.userTableCount -gt 0 -and -not $state.hasSchemaHistory) {
    throw 'The non-empty target is not a recognized clean Portal SAG schema.'
  }

  Write-Host 'Target and migration identity preflight passed.' -ForegroundColor Green
  $confirmation = Read-Host 'Type RUN CURRENT SNAPSHOT REHEARSAL to execute the complete database-changing rehearsal'
  if ($confirmation -cne 'RUN CURRENT SNAPSHOT REHEARSAL') {
    throw 'Rehearsal cancelled: exact authorization phrase was not provided.'
  }

  if ($state.userTableCount -eq 0) {
    & (Join-Path $PSScriptRoot 'Build-PortalSAGWeb-NonProduction.ps1') `
      -ServerName $ServerName -DatabaseName $DatabaseName -EnvironmentTag nonproduction `
      -Credential $credential -Confirmed
  }

  & (Join-Path $PSScriptRoot 'Import-CosmosSnapshot-RawStage.ps1') `
    -SnapshotDirectory $snapshotPath -SourceEnvironment production -Apply `
    -TargetEnvironment nonproduction -ServerName $ServerName -DatabaseName $DatabaseName `
    -Credential $credential -AcceptKnownWarnings -Confirmed

  $runKey = Get-ValidatedRunKey $credential

  & (Join-Path $PSScriptRoot 'Load-PortalSAGWeb-OperationalCore.ps1') `
    -ServerName $ServerName -DatabaseName $DatabaseName -RunKey $runKey `
    -TargetEnvironment nonproduction -Credential $credential -Confirmed

  & (Join-Path $PSScriptRoot 'Load-PortalSAGWeb-OperationalSchedulingWorkflow.ps1') `
    -ServerName $ServerName -DatabaseName $DatabaseName -RunKey $runKey `
    -TargetEnvironment nonproduction -Credential $credential -Confirmed

  & (Join-Path $PSScriptRoot 'Transfer-PortalSAGWeb-Blobs.ps1') `
    -ServerName $ServerName -DatabaseName $DatabaseName -RunKey $runKey `
    -SnapshotDirectory $snapshotPath -StorageAccountName $StorageAccountName `
    -ResourceGroupName $ResourceGroupName -BlobContainerName $BlobContainerName `
    -TargetEnvironment nonproduction -Credential $credential -Confirmed

  & (Join-Path $PSScriptRoot 'Load-PortalSAGWeb-FinalOperational.ps1') `
    -ServerName $ServerName -DatabaseName $DatabaseName -RunKey $runKey `
    -TargetEnvironment nonproduction -Credential $credential -Confirmed

  Write-Host
  Write-Host 'Current-snapshot SQL rehearsal completed.' -ForegroundColor Green
  Write-Host "Migration run key: $runKey"
  Write-Host 'Cosmos is still the live response/write source. SQL-only cutover was not enabled.' -ForegroundColor Cyan
}
finally {
  $credential = $null
  $securePassword = $null
}
