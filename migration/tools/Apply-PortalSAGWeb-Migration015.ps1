[CmdletBinding()]
param(
  [string]$ServerName='data14.sagerp.co,54103',
  [string]$DatabaseName='PortalSAGWeb',
  [string]$Username='SAGWebDev',
  [switch]$Approved
)

$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$expectedHash='7fe0377cd07cf2d8a23a844f2701e1956514eeca1ab1e0af65c9ebd448126fa5'
$scriptName='015_print_format_multiple_sources.sql'

function Convert-HexToBytes([string]$Hex) {
  $bytes=New-Object byte[] ($Hex.Length/2)
  for($index=0;$index -lt $bytes.Length;$index++){$bytes[$index]=[Convert]::ToByte($Hex.Substring($index*2,2),16)}
  return ,$bytes
}

$migrationPath=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\sql\$scriptName")).Path
$actualHash=(Get-FileHash -Algorithm SHA256 -LiteralPath $migrationPath).Hash.ToLowerInvariant()
if($actualHash -cne $expectedHash){throw 'Migration 015 checksum does not match the reviewed manifest.'}
if($DatabaseName -ne 'PortalSAGWeb'){throw 'Migration 015 is restricted to PortalSAGWeb.'}

Write-Host 'Portal SAG Web - apply reviewed migration 015' -ForegroundColor Cyan
Write-Host 'Purpose: add ordered many-to-many print-format source assignments and the atomic final-load wrapper.'
Write-Host 'The legacy primary source remains compatible; no operational content is loaded by this migration.'
Write-Host 'The SQL password is requested in memory and is never stored or printed.'
Write-Host
if(-not $Approved){
  $confirmation=Read-Host 'Type APPLY MIGRATION 015 to continue'
  if($confirmation -cne 'APPLY MIGRATION 015'){throw 'Migration 015 cancelled.'}
} else {
  Write-Host 'Owner approval was provided in the active Codex task.' -ForegroundColor Yellow
}

$securePassword=Read-Host 'SQL Authentication password' -AsSecureString
if(-not $securePassword.IsReadOnly()){$securePassword.MakeReadOnly()}

$builder=[System.Data.SqlClient.SqlConnectionStringBuilder]::new()
$builder['Data Source']=$ServerName
$builder['Initial Catalog']=$DatabaseName
$builder['Encrypt']=$true
$builder['TrustServerCertificate']=$false
$builder['Connect Timeout']=60
$builder['Persist Security Info']=$false
$builder['MultipleActiveResultSets']=$false
$builder['Application Name']='PortalSAGWeb-Migration015'

$credential=[System.Data.SqlClient.SqlCredential]::new($Username,$securePassword)
$connection=[System.Data.SqlClient.SqlConnection]::new()
$connection.ConnectionString=$builder.ConnectionString
$connection.Credential=$credential

try {
  $connection.Open()
  $preflight=$connection.CreateCommand()
  try {
    $preflight.CommandText=@'
SELECT CAST(SERVERPROPERTY('ProductMajorVersion') AS INT),d.compatibility_level,d.collation_name,
 CASE WHEN EXISTS (SELECT 1 FROM migration.schema_migrations WHERE migration_version='014' AND succeeded=1) THEN 1 ELSE 0 END,
 CASE WHEN EXISTS (SELECT 1 FROM migration.operational_load_phases WHERE phase_code='settings_content_notifications_audit' AND status='completed') THEN 1 ELSE 0 END
FROM sys.databases AS d WHERE d.database_id=DB_ID();
'@
    $reader=$preflight.ExecuteReader()
    if(-not $reader.Read()){throw 'Migration 015 preflight returned no row.'}
    $major=[Convert]::ToInt32($reader.GetValue(0))
    $compatibility=[Convert]::ToInt32($reader.GetValue(1))
    $collation=$reader.GetString(2)
    $has014=[Convert]::ToInt32($reader.GetValue(3))
    $finalCompleted=[Convert]::ToInt32($reader.GetValue(4))
    $reader.Close()
  } finally {$preflight.Dispose()}

  if($major -ne 15 -or $compatibility -ne 150 -or $collation -ne 'Modern_Spanish_CI_AS'){
    throw 'The SQL target does not match the certified SQL Server 2019 contract.'
  }
  if($has014 -ne 1){throw 'Migration 014 must be applied and verified before migration 015.'}
  if($finalCompleted -ne 0){throw 'Migration 015 must be installed before the final operational content phase.'}

  $batches=@([regex]::Split([IO.File]::ReadAllText($migrationPath),'(?im)^\s*GO\s*(?:--.*)?$') |
    Where-Object {-not [string]::IsNullOrWhiteSpace($_)})
  try {
    foreach($batch in $batches){
      $command=$connection.CreateCommand()
      try{$command.CommandTimeout=600;$command.CommandText=$batch;$null=$command.ExecuteNonQuery()}
      finally{$command.Dispose()}
    }
  } catch {
    $rollback=$connection.CreateCommand()
    try{$rollback.CommandText='IF @@TRANCOUNT>0 ROLLBACK TRANSACTION;';$null=$rollback.ExecuteNonQuery()}
    finally{$rollback.Dispose()}
    throw
  }

  $history=$connection.CreateCommand()
  try {
    $history.CommandText=@'
IF NOT EXISTS (SELECT 1 FROM migration.schema_migrations WHERE migration_version='015')
  INSERT migration.schema_migrations
    (migration_version,script_name,script_sha256,duration_ms,succeeded)
  VALUES ('015',@script_name,@script_sha256,0,1);
ELSE IF NOT EXISTS
(
  SELECT 1 FROM migration.schema_migrations
  WHERE migration_version='015' AND script_name=@script_name AND script_sha256=@script_sha256 AND succeeded=1
)
  THROW 51530,N'Migration 015 history conflicts with the reviewed checksum.',1;
'@
    $null=$history.Parameters.Add('@script_name',[Data.SqlDbType]::NVarChar,260)
    $null=$history.Parameters.Add('@script_sha256',[Data.SqlDbType]::Binary,32)
    $history.Parameters['@script_name'].Value=$scriptName
    $history.Parameters['@script_sha256'].Value=Convert-HexToBytes $expectedHash
    $null=$history.ExecuteNonQuery()
  } finally {$history.Dispose()}

  $verification=$connection.CreateCommand()
  try {
    $verification.CommandText=@'
SELECT
 CASE WHEN OBJECT_ID(N'content.print_format_source_assignments',N'U') IS NOT NULL THEN 1 ELSE 0 END,
 CASE WHEN OBJECT_ID(N'content.v_public_print_formats',N'V') IS NOT NULL THEN 1 ELSE 0 END,
 CASE WHEN OBJECT_ID(N'migration.usp_load_print_format_source_assignments',N'P') IS NOT NULL THEN 1 ELSE 0 END,
 CASE WHEN OBJECT_ID(N'migration.usp_load_operational_final_with_print_sources',N'P') IS NOT NULL THEN 1 ELSE 0 END,
 (SELECT COUNT(*) FROM sys.triggers WHERE parent_id IN (OBJECT_ID(N'content.print_formats'),OBJECT_ID(N'content.print_format_source_assignments')) AND is_disabled=0),
 (SELECT COUNT(*) FROM migration.schema_migrations WHERE migration_version='015' AND succeeded=1),
 (SELECT COUNT(*) FROM sys.foreign_keys WHERE is_disabled=1 OR is_not_trusted=1),
 (SELECT COUNT(*) FROM sys.check_constraints WHERE is_disabled=1 OR is_not_trusted=1);
'@
    $reader=$verification.ExecuteReader()
    $null=$reader.Read()
    $values=0..7 | ForEach-Object {[Convert]::ToInt32($reader.GetValue($_))}
    $reader.Close()
  } finally {$verification.Dispose()}

  if($values[0] -ne 1 -or $values[1] -ne 1 -or $values[2] -ne 1 -or $values[3] -ne 1 -or $values[4] -lt 2 -or $values[5] -ne 1 -or $values[6] -ne 0 -or $values[7] -ne 0){
    throw 'Migration 015 post-verification failed.'
  }

  Write-Host
  Write-Host 'Migration 015 succeeded and was verified.' -ForegroundColor Green
  Write-Host 'Bridge, indexes, two views, two triggers and atomic final-load wrapper: installed.'
}
finally {
  if($connection.State -ne [Data.ConnectionState]::Closed){$connection.Close()}
  $connection.Dispose()
  $credential=$null
  $securePassword=$null
}
