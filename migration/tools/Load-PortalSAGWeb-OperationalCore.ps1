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
  throw 'REFUSED: the designated production PortalSAGWeb database cannot be used by the non-production operational core loader.'
}
if ($RunKey -le 0) {
  $enteredRunKey = Read-Host 'Validated raw/stage migration run key'
  if (-not [long]::TryParse($enteredRunKey, [ref]$RunKey) -or $RunKey -le 0) {
    throw 'A positive migration run key is required.'
  }
}

Write-Host 'Portal SAG Web - NON-PRODUCTION operational core load' -ForegroundColor Cyan
Write-Host 'This phase loads roles, users, clients, domains, databases and licensing in one transaction.'
Write-Host 'Legacy sessions and rate-limit windows are intentionally excluded.'
Write-Host 'Private files, schedules, tasks, settings, content links and audit remain untouched.'
Write-Host "Server:   $ServerName"
Write-Host "Database: $DatabaseName"
Write-Host "Run key:  $RunKey"
Write-Host 'No password will be stored or printed.'
Write-Host

if (-not $Confirmed) {
  $confirmation = Read-Host 'Type LOAD OPERATIONAL CORE NONPRODUCTION to continue'
  if ($confirmation -cne 'LOAD OPERATIONAL CORE NONPRODUCTION') {
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
$builder['Application Name'] = 'PortalSAGWeb-OperationalCoreLoad'

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
    WHERE migration_version='009' AND script_name=N'009_operational_load_control_and_core.sql' AND succeeded=1
  ) THEN 1 ELSE 0 END AS has_009,
  CASE WHEN OBJECT_ID(N'migration.usp_load_operational_security_core_licensing',N'P') IS NOT NULL THEN 1 ELSE 0 END AS has_loader
FROM sys.databases AS d
WHERE d.database_id=DB_ID();
'@
    $reader = $preflight.ExecuteReader()
    if (-not $reader.Read()) { throw 'Database preflight returned no row.' }
    $majorVersion = $reader.GetInt32(0)
    $compatibilityLevel = [Convert]::ToInt32($reader.GetValue(1))
    $collationName = $reader.GetString(2)
    $has009 = $reader.GetInt32(3)
    $hasLoader = $reader.GetInt32(4)
    $reader.Close()
  }
  finally {
    $preflight.Dispose()
  }

  if ($majorVersion -ne 15) { throw "Expected SQL Server 2019 major version 15; found $majorVersion." }
  if ($compatibilityLevel -ne 150) { throw "Expected compatibility level 150; found $compatibilityLevel." }
  if ($collationName -ne 'Modern_Spanish_CI_AS') { throw "Unexpected collation: $collationName." }
  if ($has009 -ne 1 -or $hasLoader -ne 1) { throw 'Migration 009 is not installed and recorded successfully.' }

  Write-Host 'Preflight passed. Starting the transactional core phase...' -ForegroundColor Cyan
  $command = $connection.CreateCommand()
  try {
    $command.CommandTimeout = 900
    $command.CommandType = [Data.CommandType]::StoredProcedure
    $command.CommandText = 'migration.usp_load_operational_security_core_licensing'
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
  Write-Host 'NON-PRODUCTION operational core phase completed.' -ForegroundColor Green
  Write-Host "Source documents in phase: $sourceCount"
  Write-Host "Operational root records:  $targetCount"
  Write-Host 'Next checkpoint: reconcile the core phase before schedules/workflow are loaded.' -ForegroundColor Cyan
}
finally {
  if ($connection.State -ne [Data.ConnectionState]::Closed) { $connection.Close() }
  $connection.Dispose()
  $sqlCredential = $null
  $securePassword = $null
}
