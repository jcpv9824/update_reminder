[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ServerName,

  [string]$DatabaseName = 'PortalSAGWeb',

  [string]$Username,

  [System.Management.Automation.PSCredential]$Credential,

  [switch]$Confirmed,

  [Parameter(Mandatory = $true)]
  [ValidateSet('nonproduction')]
  [string]$EnvironmentTag,

  [string]$SqlDirectory
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ([string]::IsNullOrWhiteSpace($SqlDirectory)) {
  $SqlDirectory = Join-Path $PSScriptRoot '..\sql'
}

if ($DatabaseName -ne 'PortalSAGWeb') {
  throw 'The certified scripts require a disposable database named PortalSAGWeb on a non-production SQL Server instance.'
}
if ($ServerName.Trim().Equals('data14.sagerp.co,54103',[StringComparison]::OrdinalIgnoreCase)) {
  throw 'REFUSED: data14.sagerp.co,54103 / PortalSAGWeb is the designated production target and cannot be used by the non-production build tool.'
}

Write-Host 'Portal SAG Web - NON-PRODUCTION relational build' -ForegroundColor Cyan
Write-Host 'This tool refuses to create a database. The empty disposable database must already exist.'
Write-Host "Server:   $ServerName"
Write-Host "Database: $DatabaseName"
Write-Host 'No password will be stored or printed.'
Write-Host

if (-not $Confirmed) {
  $confirmation = Read-Host 'Type BUILD NONPRODUCTION to confirm this is not the production server'
  if ($confirmation -cne 'BUILD NONPRODUCTION') {
    throw 'Build cancelled: the exact non-production confirmation was not provided.'
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

$sqlDirectoryPath = (Resolve-Path -LiteralPath $SqlDirectory).Path
$manifestPath = Join-Path $sqlDirectoryPath 'MANIFEST.sha256'
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw 'The SQL checksum manifest is missing.'
}

$manifest = [ordered]@{}
foreach ($line in Get-Content -LiteralPath $manifestPath) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  if ($line -notmatch '^([0-9a-f]{64})\s{2}(.+\.sql)$') {
    throw "Invalid manifest line: $line"
  }
  $manifest[$Matches[2]] = $Matches[1]
}

foreach ($entry in $manifest.GetEnumerator()) {
  $scriptPath = Join-Path $sqlDirectoryPath $entry.Key
  if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Missing SQL script: $($entry.Key)"
  }
  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $scriptPath).Hash.ToLowerInvariant()
  if ($actualHash -cne $entry.Value) {
    throw "Checksum mismatch for $($entry.Key). Regenerate and review the manifest before building."
  }
}

function Convert-HexToBytes([string]$hex) {
  $bytes = New-Object byte[] ($hex.Length / 2)
  for ($i = 0; $i -lt $bytes.Length; $i++) {
    $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16)
  }
  return ,$bytes
}

function Invoke-SqlBatchScript {
  param(
    [System.Data.SqlClient.SqlConnection]$Connection,
    [string]$Path
  )
  $sqlText = [System.IO.File]::ReadAllText($Path)
  $batches = [Text.RegularExpressions.Regex]::Split($sqlText, '(?im)^\s*GO\s*(?:--.*)?$')
  foreach ($batch in $batches) {
    if ([string]::IsNullOrWhiteSpace($batch)) { continue }
    $command = $Connection.CreateCommand()
    try {
      $command.CommandTimeout = 180
      $command.CommandText = $batch
      $null = $command.ExecuteNonQuery()
    }
    finally {
      $command.Dispose()
    }
  }
}

$builder = [System.Data.SqlClient.SqlConnectionStringBuilder]::new()
$builder['Data Source'] = $ServerName
$builder['Initial Catalog'] = $DatabaseName
$builder['Encrypt'] = $true
$builder['TrustServerCertificate'] = $false
$builder['Connect Timeout'] = 15
$builder['Persist Security Info'] = $false
$builder['Application Name'] = 'PortalSAGWeb-NonProductionBuild'

$sqlCredential = [System.Data.SqlClient.SqlCredential]::new($Username, $securePassword)
$connection = [System.Data.SqlClient.SqlConnection]::new()
$connection.ConnectionString = $builder.ConnectionString
$connection.Credential = $sqlCredential
try {
  $connection.Open()

  $preflight = $connection.CreateCommand()
  $preflight.CommandText = @'
SELECT
  CAST(SERVERPROPERTY('ProductMajorVersion') AS INT) AS major_version,
  d.compatibility_level,
  d.collation_name,
  (SELECT COUNT(*) FROM sys.tables WHERE is_ms_shipped = 0) AS user_table_count
FROM sys.databases AS d
WHERE d.database_id = DB_ID();
'@
  $reader = $preflight.ExecuteReader()
  if (-not $reader.Read()) { throw 'Unable to read the target database preflight.' }
  $majorVersion = $reader.GetInt32(0)
  $compatibilityLevel = $reader.GetByte(1)
  $collationName = $reader.GetString(2)
  $userTableCount = $reader.GetInt32(3)
  $reader.Close()
  $preflight.Dispose()

  if ($majorVersion -ne 15) { throw "Expected SQL Server 2019 major version 15; found $majorVersion." }
  if ($compatibilityLevel -ne 150) { throw "Expected compatibility level 150; found $compatibilityLevel." }
  if ($collationName -ne 'Modern_Spanish_CI_AS') { throw "Expected Modern_Spanish_CI_AS; found $collationName." }
  if ($userTableCount -ne 0) { throw "The disposable database is not empty ($userTableCount user table(s)). Recreate it before this clean build." }

  Write-Host 'Preflight passed. Applying isolation settings and versioned schema...' -ForegroundColor Cyan
  Invoke-SqlBatchScript -Connection $connection -Path (Join-Path $sqlDirectoryPath '001_prepare_production_mvp_database.sql')
  $connection.ChangeDatabase($DatabaseName)

  foreach ($entry in $manifest.GetEnumerator()) {
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "Applying $($entry.Key)..."
    Invoke-SqlBatchScript -Connection $connection -Path (Join-Path $sqlDirectoryPath $entry.Key)
    $stopwatch.Stop()

    $history = $connection.CreateCommand()
    try {
      $history.CommandText = @'
INSERT migration.schema_migrations
  (migration_version, script_name, script_sha256, duration_ms, succeeded)
VALUES
  (@version, @script_name, @script_sha256, @duration_ms, 1);
'@
      $version = [IO.Path]::GetFileNameWithoutExtension($entry.Key).Split('_')[0]
      $null = $history.Parameters.Add('@version', [Data.SqlDbType]::VarChar, 40)
      $null = $history.Parameters.Add('@script_name', [Data.SqlDbType]::NVarChar, 260)
      $null = $history.Parameters.Add('@script_sha256', [Data.SqlDbType]::Binary, 32)
      $null = $history.Parameters.Add('@duration_ms', [Data.SqlDbType]::BigInt)
      $history.Parameters['@version'].Value = $version
      $history.Parameters['@script_name'].Value = $entry.Key
      $history.Parameters['@script_sha256'].Value = Convert-HexToBytes $entry.Value
      $history.Parameters['@duration_ms'].Value = $stopwatch.ElapsedMilliseconds
      $null = $history.ExecuteNonQuery()
    }
    finally {
      $history.Dispose()
    }
  }

  $verification = $connection.CreateCommand()
  $verification.CommandText = @'
SELECT
  (SELECT COUNT(*) FROM sys.tables WHERE is_ms_shipped = 0) AS user_table_count,
  (SELECT COUNT(*) FROM sys.foreign_keys) AS foreign_key_count,
  (SELECT COUNT(*) FROM sys.check_constraints) AS check_constraint_count,
  (SELECT COUNT(*) FROM security.permissions) AS permission_count,
  (SELECT COUNT(*) FROM migration.schema_migrations WHERE succeeded = 1) AS applied_migration_count;
'@
  $reader = $verification.ExecuteReader()
  $null = $reader.Read()
  Write-Host
  Write-Host 'NON-PRODUCTION build succeeded.' -ForegroundColor Green
  Write-Host "User tables:          $($reader.GetInt32(0))"
  Write-Host "Foreign keys:         $($reader.GetInt32(1))"
  Write-Host "Check constraints:    $($reader.GetInt32(2))"
  Write-Host "Permission catalog:   $($reader.GetInt32(3))"
  Write-Host "Recorded migrations:  $($reader.GetInt32(4))"
  $reader.Close()
  $verification.Dispose()
}
finally {
  if ($connection.State -ne [Data.ConnectionState]::Closed) { $connection.Close() }
  $connection.Dispose()
  $sqlCredential = $null
  $securePassword = $null
}
