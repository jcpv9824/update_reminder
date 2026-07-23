[CmdletBinding()]
param(
  [string]$ServerName = 'data14.sagerp.co,54103',
  [string]$DatabaseName = 'PortalSAGWeb',
  [string]$Username = 'SAGWebDev',
  [switch]$Approved
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$expectedHash = '1a88af5898c8231f518dcb0601a5e896d4ca05156ed928b9e3b594d1e6a6fba3'
$scriptName = '012_expand_task_source_identifiers.sql'

function Convert-HexToBytes([string]$Hex) {
  $bytes = New-Object byte[] ($Hex.Length/2)
  for ($index=0; $index -lt $bytes.Length; $index++) {
    $bytes[$index] = [Convert]::ToByte($Hex.Substring($index*2,2),16)
  }
  return ,$bytes
}

$migrationPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\sql\$scriptName")).Path
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $migrationPath).Hash.ToLowerInvariant()
if ($actualHash -cne $expectedHash) { throw 'Migration 012 checksum does not match the reviewed manifest.' }
if ($DatabaseName -ne 'PortalSAGWeb') { throw 'Migration 012 is restricted to PortalSAGWeb.' }

Write-Host 'Portal SAG Web - apply reviewed migration 012' -ForegroundColor Cyan
Write-Host 'Purpose: widen generated task source identifiers from 150 to 260 characters.'
Write-Host 'The failed raw import evidence is preserved; no business data is deleted.'
Write-Host 'The SQL password is requested in memory and is never stored or printed.'
Write-Host
if (-not $Approved) {
  $confirmation = Read-Host 'Type APPLY MIGRATION 012 to continue'
  if ($confirmation -cne 'APPLY MIGRATION 012') { throw 'Migration 012 cancelled.' }
}
else {
  Write-Host 'Owner approval was provided in the active Codex task.' -ForegroundColor Yellow
}

if ([string]::IsNullOrWhiteSpace($Username)) { $Username = (Read-Host 'SQL Authentication username').Trim() }
$securePassword = Read-Host 'SQL Authentication password' -AsSecureString
if (-not $securePassword.IsReadOnly()) { $securePassword.MakeReadOnly() }

$builder = [System.Data.SqlClient.SqlConnectionStringBuilder]::new()
$builder['Data Source'] = $ServerName
$builder['Initial Catalog'] = $DatabaseName
$builder['Encrypt'] = $true
$builder['TrustServerCertificate'] = $false
$builder['Connect Timeout'] = 60
$builder['Persist Security Info'] = $false
$builder['MultipleActiveResultSets'] = $false
$builder['Application Name'] = 'PortalSAGWeb-Migration012'

$credential = [System.Data.SqlClient.SqlCredential]::new($Username,$securePassword)
$connection = [System.Data.SqlClient.SqlConnection]::new()
$connection.ConnectionString = $builder.ConnectionString
$connection.Credential = $credential

try {
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
    WHERE migration_version='011' AND succeeded=1
  ) THEN 1 ELSE 0 END AS has_011,
  COL_LENGTH(N'migration.raw_documents',N'source_id') AS raw_source_id_bytes
FROM sys.databases AS d WHERE d.database_id=DB_ID();
'@
    $reader = $preflight.ExecuteReader()
    if (-not $reader.Read()) { throw 'Migration 012 preflight returned no row.' }
    $major = [Convert]::ToInt32($reader.GetValue(0))
    $compatibility = [Convert]::ToInt32($reader.GetValue(1))
    $collation = $reader.GetString(2)
    $has011 = [Convert]::ToInt32($reader.GetValue(3))
    $rawWidth = [Convert]::ToInt32($reader.GetValue(4))
    $reader.Close()
  }
  finally { $preflight.Dispose() }

  if ($major -ne 15 -or $compatibility -ne 150 -or $collation -ne 'Modern_Spanish_CI_AS') {
    throw 'The SQL target does not match the certified SQL Server 2019 contract.'
  }
  if ($has011 -ne 1) { throw 'Migration 011 is not recorded successfully.' }
  if ($rawWidth -notin @(300,520)) { throw 'The source identifier column has an unexpected width.' }

  $migration = $connection.CreateCommand()
  try {
    $migration.CommandTimeout = 600
    $migration.CommandText = [IO.File]::ReadAllText($migrationPath)
    $null = $migration.ExecuteNonQuery()
  }
  finally { $migration.Dispose() }

  $history = $connection.CreateCommand()
  try {
    $history.CommandText = @'
IF NOT EXISTS (SELECT 1 FROM migration.schema_migrations WHERE migration_version='012')
  INSERT migration.schema_migrations
    (migration_version,script_name,script_sha256,duration_ms,succeeded)
  VALUES ('012',@script_name,@script_sha256,0,1);
ELSE IF NOT EXISTS
(
  SELECT 1 FROM migration.schema_migrations
  WHERE migration_version='012' AND script_name=@script_name
    AND script_sha256=@script_sha256 AND succeeded=1
)
  THROW 51205, N'Migration 012 history conflicts with the reviewed checksum.', 1;
'@
    $null = $history.Parameters.Add('@script_name',[Data.SqlDbType]::NVarChar,260)
    $null = $history.Parameters.Add('@script_sha256',[Data.SqlDbType]::Binary,32)
    $history.Parameters['@script_name'].Value = $scriptName
    $history.Parameters['@script_sha256'].Value = Convert-HexToBytes $expectedHash
    $null = $history.ExecuteNonQuery()
  }
  finally { $history.Dispose() }

  $verification = $connection.CreateCommand()
  try {
    $verification.CommandText = @'
SELECT
  COL_LENGTH(N'migration.raw_documents',N'source_id') AS raw_bytes,
  COL_LENGTH(N'migration.file_transfers',N'source_id') AS transfer_bytes,
  COL_LENGTH(N'migration.stage_update_tasks',N'source_id') AS stage_task_bytes,
  COL_LENGTH(N'workflow.update_tasks',N'source_id') AS task_bytes,
  COL_LENGTH(N'workflow.task_source_aliases',N'alias_source_id') AS alias_bytes,
  (SELECT COUNT(*) FROM sys.foreign_keys WHERE is_disabled=1 OR is_not_trusted=1) AS unsafe_fk_count,
  (SELECT COUNT(*) FROM migration.schema_migrations WHERE migration_version='012' AND succeeded=1) AS history_count;
'@
    $reader = $verification.ExecuteReader()
    $null = $reader.Read()
    $widths = 0..4 | ForEach-Object { [Convert]::ToInt32($reader.GetValue($_)) }
    $unsafeFkCount = [Convert]::ToInt32($reader.GetValue(5))
    $historyCount = [Convert]::ToInt32($reader.GetValue(6))
    $reader.Close()
  }
  finally { $verification.Dispose() }

  if (@($widths | Where-Object { $_ -ne 520 }).Count -ne 0 -or $unsafeFkCount -ne 0 -or $historyCount -ne 1) {
    throw 'Migration 012 post-verification failed.'
  }

  Write-Host
  Write-Host 'Migration 012 succeeded and was verified.' -ForegroundColor Green
  Write-Host 'Five identifier columns: NVARCHAR(260); unsafe foreign keys: 0; history: recorded.'
  Write-Host 'Resume raw/stage run key 1 next.' -ForegroundColor Cyan
}
finally {
  if ($connection.State -ne [Data.ConnectionState]::Closed) { $connection.Close() }
  $connection.Dispose()
  $credential = $null
  $securePassword = $null
}
