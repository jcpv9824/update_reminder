[CmdletBinding()]
param(
  [string]$ServerName = 'data14.sagerp.co,54103',
  [string]$DatabaseName = 'PortalSAGWeb',
  [string]$Username = 'SAGWebDev',
  [switch]$Approved
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$expectedHash = '4b276d997fce50658473fbb8d82b253050a915f7d76cc6b58bd84c522bd89060'
$scriptName = '013_expand_entity_source_identifiers.sql'

function Convert-HexToBytes([string]$Hex) {
  $bytes = New-Object byte[] ($Hex.Length/2)
  for ($index=0; $index -lt $bytes.Length; $index++) {
    $bytes[$index] = [Convert]::ToByte($Hex.Substring($index*2,2),16)
  }
  return ,$bytes
}

$migrationPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\sql\$scriptName")).Path
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $migrationPath).Hash.ToLowerInvariant()
if ($actualHash -cne $expectedHash) { throw 'Migration 013 checksum does not match the reviewed manifest.' }
if ($DatabaseName -ne 'PortalSAGWeb') { throw 'Migration 013 is restricted to PortalSAGWeb.' }

Write-Host 'Portal SAG Web - apply reviewed migration 013' -ForegroundColor Cyan
Write-Host 'Purpose: widen audit and notification entity identifiers from 150 to 260 characters.'
Write-Host 'The complete raw load and failed projection evidence are preserved.'
Write-Host 'The SQL password is requested in memory and is never stored or printed.'
Write-Host
if (-not $Approved) {
  $confirmation = Read-Host 'Type APPLY MIGRATION 013 to continue'
  if ($confirmation -cne 'APPLY MIGRATION 013') { throw 'Migration 013 cancelled.' }
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
$builder['Application Name'] = 'PortalSAGWeb-Migration013'

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
    WHERE migration_version='012' AND succeeded=1
  ) THEN 1 ELSE 0 END AS has_012,
  COL_LENGTH(N'migration.stage_audit_logs',N'entity_source_id') AS stage_audit_bytes
FROM sys.databases AS d WHERE d.database_id=DB_ID();
'@
    $reader = $preflight.ExecuteReader()
    if (-not $reader.Read()) { throw 'Migration 013 preflight returned no row.' }
    $major = [Convert]::ToInt32($reader.GetValue(0))
    $compatibility = [Convert]::ToInt32($reader.GetValue(1))
    $collation = $reader.GetString(2)
    $has012 = [Convert]::ToInt32($reader.GetValue(3))
    $stageAuditWidth = [Convert]::ToInt32($reader.GetValue(4))
    $reader.Close()
  }
  finally { $preflight.Dispose() }

  if ($major -ne 15 -or $compatibility -ne 150 -or $collation -ne 'Modern_Spanish_CI_AS') {
    throw 'The SQL target does not match the certified SQL Server 2019 contract.'
  }
  if ($has012 -ne 1) { throw 'Migration 012 is not recorded successfully.' }
  if ($stageAuditWidth -notin @(300,520)) { throw 'The entity identifier column has an unexpected width.' }

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
IF NOT EXISTS (SELECT 1 FROM migration.schema_migrations WHERE migration_version='013')
  INSERT migration.schema_migrations
    (migration_version,script_name,script_sha256,duration_ms,succeeded)
  VALUES ('013',@script_name,@script_sha256,0,1);
ELSE IF NOT EXISTS
(
  SELECT 1 FROM migration.schema_migrations
  WHERE migration_version='013' AND script_name=@script_name
    AND script_sha256=@script_sha256 AND succeeded=1
)
  THROW 51305, N'Migration 013 history conflicts with the reviewed checksum.', 1;
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
  COL_LENGTH(N'migration.stage_audit_logs',N'entity_source_id') AS stage_audit_bytes,
  COL_LENGTH(N'migration.stage_email_notifications',N'entity_source_id') AS stage_notification_bytes,
  COL_LENGTH(N'audit.audit_logs',N'entity_source_id') AS audit_bytes,
  COL_LENGTH(N'notifications.email_notifications',N'entity_source_id') AS notification_bytes,
  (SELECT COUNT(*) FROM sys.indexes WHERE is_disabled=1) AS disabled_index_count,
  (SELECT COUNT(*) FROM migration.schema_migrations WHERE migration_version='013' AND succeeded=1) AS history_count;
'@
    $reader = $verification.ExecuteReader()
    $null = $reader.Read()
    $widths = 0..3 | ForEach-Object { [Convert]::ToInt32($reader.GetValue($_)) }
    $disabledIndexCount = [Convert]::ToInt32($reader.GetValue(4))
    $historyCount = [Convert]::ToInt32($reader.GetValue(5))
    $reader.Close()
  }
  finally { $verification.Dispose() }

  if (@($widths | Where-Object { $_ -ne 520 }).Count -ne 0 -or $disabledIndexCount -ne 0 -or $historyCount -ne 1) {
    throw 'Migration 013 post-verification failed.'
  }

  Write-Host
  Write-Host 'Migration 013 succeeded and was verified.' -ForegroundColor Green
  Write-Host 'Four entity identifier columns: NVARCHAR(260); disabled indexes: 0; history: recorded.'
  Write-Host 'Resume raw/stage run key 1 next.' -ForegroundColor Cyan
}
finally {
  if ($connection.State -ne [Data.ConnectionState]::Closed) { $connection.Close() }
  $connection.Dispose()
  $credential = $null
  $securePassword = $null
}
