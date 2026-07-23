[CmdletBinding()]
param(
  [string]$ServerName = 'data14.sagerp.co,54103',
  [string]$DatabaseName = 'PortalSAGWeb',
  [string]$Username = 'SAGWebDev',
  [switch]$Approved
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$expectedHash = 'f769847d5e51d20e61af6f64b13d3e6f63836cac63136818d306c7bacc819462'
$scriptName = '014_correct_historical_task_orphan_projection.sql'

function Convert-HexToBytes([string]$Hex) {
  $bytes = New-Object byte[] ($Hex.Length/2)
  for ($index=0; $index -lt $bytes.Length; $index++) {
    $bytes[$index] = [Convert]::ToByte($Hex.Substring($index*2,2),16)
  }
  return ,$bytes
}

$migrationPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\sql\$scriptName")).Path
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $migrationPath).Hash.ToLowerInvariant()
if ($actualHash -cne $expectedHash) { throw 'Migration 014 checksum does not match the reviewed manifest.' }
if ($DatabaseName -ne 'PortalSAGWeb') { throw 'Migration 014 is restricted to PortalSAGWeb.' }

Write-Host 'Portal SAG Web - apply reviewed migration 014' -ForegroundColor Cyan
Write-Host 'Purpose: classify incomplete terminal task hierarchies as historical orphans during phase 010.'
Write-Host 'No source, staging, operational, or checkpoint rows are deleted.'
Write-Host 'The SQL password is requested in memory and is never stored or printed.'
Write-Host
if (-not $Approved) {
  $confirmation = Read-Host 'Type APPLY MIGRATION 014 to continue'
  if ($confirmation -cne 'APPLY MIGRATION 014') { throw 'Migration 014 cancelled.' }
}
else {
  Write-Host 'Owner approval was provided in the active Codex task.' -ForegroundColor Yellow
}

$securePassword = Read-Host 'SQL Authentication password' -AsSecureString
if (-not $securePassword.IsReadOnly()) { $securePassword.MakeReadOnly() }

$builder = [System.Data.SqlClient.SqlConnectionStringBuilder]::new()
$builder['Data Source']=$ServerName
$builder['Initial Catalog']=$DatabaseName
$builder['Encrypt']=$true
$builder['TrustServerCertificate']=$false
$builder['Connect Timeout']=60
$builder['Persist Security Info']=$false
$builder['MultipleActiveResultSets']=$false
$builder['Application Name']='PortalSAGWeb-Migration014'

$credential=[System.Data.SqlClient.SqlCredential]::new($Username,$securePassword)
$connection=[System.Data.SqlClient.SqlConnection]::new()
$connection.ConnectionString=$builder.ConnectionString
$connection.Credential=$credential

try {
  $connection.Open()

  $preflight=$connection.CreateCommand()
  try {
    $preflight.CommandText=@'
SELECT
  CAST(SERVERPROPERTY('ProductMajorVersion') AS INT),d.compatibility_level,d.collation_name,
  CASE WHEN EXISTS (SELECT 1 FROM migration.schema_migrations WHERE migration_version='013' AND succeeded=1) THEN 1 ELSE 0 END,
  CASE WHEN OBJECT_ID(N'migration.usp_load_operational_scheduling_workflow',N'P') IS NOT NULL THEN 1 ELSE 0 END
FROM sys.databases d WHERE d.database_id=DB_ID();
'@
    $reader=$preflight.ExecuteReader()
    if(-not $reader.Read()){throw 'Migration 014 preflight returned no row.'}
    $major=[Convert]::ToInt32($reader.GetValue(0))
    $compatibility=[Convert]::ToInt32($reader.GetValue(1))
    $collation=$reader.GetString(2)
    $has013=[Convert]::ToInt32($reader.GetValue(3))
    $hasLoader=[Convert]::ToInt32($reader.GetValue(4))
    $reader.Close()
  }
  finally{$preflight.Dispose()}

  if($major -ne 15 -or $compatibility -ne 150 -or $collation -ne 'Modern_Spanish_CI_AS'){
    throw 'The SQL target does not match the certified SQL Server 2019 contract.'
  }
  if($has013 -ne 1 -or $hasLoader -ne 1){throw 'Migration 013 and the phase-010 loader are required.'}

  $migration=$connection.CreateCommand()
  try{
    $migration.CommandTimeout=600
    $migration.CommandText=[IO.File]::ReadAllText($migrationPath)
    $null=$migration.ExecuteNonQuery()
  }
  finally{$migration.Dispose()}

  $history=$connection.CreateCommand()
  try{
    $history.CommandText=@'
IF NOT EXISTS (SELECT 1 FROM migration.schema_migrations WHERE migration_version='014')
  INSERT migration.schema_migrations
    (migration_version,script_name,script_sha256,duration_ms,succeeded)
  VALUES ('014',@script_name,@script_sha256,0,1);
ELSE IF NOT EXISTS
(
  SELECT 1 FROM migration.schema_migrations
  WHERE migration_version='014' AND script_name=@script_name AND script_sha256=@script_sha256 AND succeeded=1
)
  THROW 51408, N'Migration 014 history conflicts with the reviewed checksum.', 1;
'@
    $null=$history.Parameters.Add('@script_name',[Data.SqlDbType]::NVarChar,260)
    $null=$history.Parameters.Add('@script_sha256',[Data.SqlDbType]::Binary,32)
    $history.Parameters['@script_name'].Value=$scriptName
    $history.Parameters['@script_sha256'].Value=Convert-HexToBytes $expectedHash
    $null=$history.ExecuteNonQuery()
  }
  finally{$history.Dispose()}

  $verification=$connection.CreateCommand()
  try{
    $verification.CommandText=@'
SELECT
 CASE WHEN OBJECT_DEFINITION(OBJECT_ID(N'migration.usp_load_operational_scheduling_workflow'))
   LIKE N'%CASE WHEN client.client_key IS NULL OR domain_record.domain_key IS NULL THEN 1%' THEN 1 ELSE 0 END,
 (SELECT COUNT(*) FROM migration.schema_migrations WHERE migration_version='014' AND succeeded=1),
 (SELECT COUNT(*) FROM sys.foreign_keys WHERE is_disabled=1 OR is_not_trusted=1),
 (SELECT COUNT(*) FROM sys.check_constraints WHERE is_disabled=1 OR is_not_trusted=1);
'@
    $reader=$verification.ExecuteReader()
    $null=$reader.Read()
    $corrected=[Convert]::ToInt32($reader.GetValue(0))
    $historyCount=[Convert]::ToInt32($reader.GetValue(1))
    $unsafeFks=[Convert]::ToInt32($reader.GetValue(2))
    $unsafeChecks=[Convert]::ToInt32($reader.GetValue(3))
    $reader.Close()
  }
  finally{$verification.Dispose()}

  if($corrected -ne 1 -or $historyCount -ne 1 -or $unsafeFks -ne 0 -or $unsafeChecks -ne 0){
    throw 'Migration 014 post-verification failed.'
  }

  Write-Host
  Write-Host 'Migration 014 succeeded and was verified.' -ForegroundColor Green
  Write-Host 'Corrected loader: installed; unsafe constraints: 0; history: recorded.'
  Write-Host 'Retry scheduling/workflow run key 1 next.' -ForegroundColor Cyan
}
finally{
  if($connection.State -ne [Data.ConnectionState]::Closed){$connection.Close()}
  $connection.Dispose()
  $credential=$null
  $securePassword=$null
}
