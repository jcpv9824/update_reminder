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
  throw 'The certified operational loader requires a disposable non-production database named PortalSAGWeb.'
}
if ([string]::IsNullOrWhiteSpace($ServerName)) {
  $ServerName = Read-Host 'NON-PRODUCTION SQL Server / instance (server,port)'
}
if ($ServerName.Trim().Equals('data14.sagerp.co,54103',[StringComparison]::OrdinalIgnoreCase)) {
  throw 'REFUSED: the designated production PortalSAGWeb database cannot be used by the non-production scheduling/workflow loader.'
}
if ($RunKey -le 0) {
  $enteredRunKey = Read-Host 'Validated raw/stage migration run key'
  if (-not [long]::TryParse($enteredRunKey, [ref]$RunKey) -or $RunKey -le 0) {
    throw 'A positive migration run key is required.'
  }
}

Write-Host 'Portal SAG Web - NON-PRODUCTION scheduling/workflow load' -ForegroundColor Cyan
Write-Host 'This phase loads schedules, normalized scheduling scope and consolidated workflow tasks in one transaction.'
Write-Host 'It requires the security/core/licensing phase to be completed for the same migration run.'
Write-Host 'Settings, content, notifications, audit and private file payloads remain untouched.'
Write-Host "Server:   $ServerName"
Write-Host "Database: $DatabaseName"
Write-Host "Run key:  $RunKey"
Write-Host 'No password will be stored or printed.'
Write-Host

if (-not $Confirmed) {
  $confirmation = Read-Host 'Type LOAD SCHEDULING WORKFLOW NONPRODUCTION to continue'
  if ($confirmation -cne 'LOAD SCHEDULING WORKFLOW NONPRODUCTION') {
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
$builder['Application Name'] = 'PortalSAGWeb-OperationalSchedulingWorkflowLoad'

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
    WHERE migration_version='010' AND script_name=N'010_operational_load_scheduling_workflow.sql' AND succeeded=1
  ) THEN 1 ELSE 0 END AS has_010,
  CASE WHEN OBJECT_ID(N'migration.usp_load_operational_scheduling_workflow',N'P') IS NOT NULL THEN 1 ELSE 0 END AS has_loader,
  CASE WHEN EXISTS
  (
    SELECT 1 FROM migration.operational_load_phases
    WHERE run_key=@run_key AND phase_code='security_core_licensing' AND status='completed'
  ) THEN 1 ELSE 0 END AS core_completed
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
    $has010 = [Convert]::ToInt32($reader.GetValue(3))
    $hasLoader = [Convert]::ToInt32($reader.GetValue(4))
    $coreCompleted = [Convert]::ToInt32($reader.GetValue(5))
    $reader.Close()
  }
  finally {
    $preflight.Dispose()
  }

  if ($majorVersion -ne 15) { throw "Expected SQL Server 2019 major version 15; found $majorVersion." }
  if ($compatibilityLevel -ne 150) { throw "Expected compatibility level 150; found $compatibilityLevel." }
  if ($collationName -ne 'Modern_Spanish_CI_AS') { throw "Unexpected collation: $collationName." }
  if ($has010 -ne 1 -or $hasLoader -ne 1) { throw 'Migration 010 is not installed and recorded successfully.' }
  if ($coreCompleted -ne 1) { throw 'The security/core/licensing phase is not completed for this migration run.' }

  Write-Host 'Preflight passed. Starting the transactional scheduling/workflow phase...' -ForegroundColor Cyan
  $command = $connection.CreateCommand()
  try {
    $command.CommandTimeout = 900
    $command.CommandType = [Data.CommandType]::StoredProcedure
    $command.CommandText = 'migration.usp_load_operational_scheduling_workflow'
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
  Write-Host 'NON-PRODUCTION scheduling/workflow phase completed.' -ForegroundColor Green
  Write-Host "Source documents in phase:      $sourceCount"
  Write-Host "Operational and child records:  $targetCount"
  Write-Host 'Next checkpoint: reconcile all phase 010 counts before loading settings/content/notifications/audit.' -ForegroundColor Cyan
}
finally {
  if ($connection.State -ne [Data.ConnectionState]::Closed) { $connection.Close() }
  $connection.Dispose()
  $sqlCredential = $null
  $securePassword = $null
}
