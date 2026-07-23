[CmdletBinding()]
param(
  [string]$ServerName='data14.sagerp.co,54103',
  [string]$DatabaseName='PortalSAGWeb',
  [string]$Username='SAGWebDev',
  [switch]$Approved
)

$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$expectedHash='168abab49719650eb0f9eb4795bb67c4e50cbc364719912605c863c9bb0db979'
$scriptName='016_public_download_video_assets_and_source_cleanup.sql'

function Convert-HexToBytes([string]$Hex) {
  $bytes=New-Object byte[] ($Hex.Length/2)
  for($index=0;$index -lt $bytes.Length;$index++){$bytes[$index]=[Convert]::ToByte($Hex.Substring($index*2,2),16)}
  return ,$bytes
}

function Get-Sha256Hex([string]$Path) {
  $stream=[IO.File]::OpenRead($Path)
  $sha256=[Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-','').ToLowerInvariant()
  }
  finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

$migrationPath=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\sql\$scriptName")).Path
$actualHash=Get-Sha256Hex $migrationPath
if($actualHash -cne $expectedHash){throw 'Migration 016 checksum does not match the reviewed manifest.'}
if($DatabaseName -ne 'PortalSAGWeb'){throw 'Migration 016 is restricted to PortalSAGWeb.'}

Write-Host 'Portal SAG Web - apply reviewed migration 016' -ForegroundColor Cyan
Write-Host 'Purpose: support document/video public assets and remove print-source descriptions.'
Write-Host 'No file bytes are stored in SQL; the existing final loader is upgraded transactionally.'
Write-Host 'The SQL password is requested in memory and is never stored or printed.'
Write-Host
if(-not $Approved){
  $confirmation=Read-Host 'Type APPLY MIGRATION 016 to continue'
  if($confirmation -cne 'APPLY MIGRATION 016'){throw 'Migration 016 cancelled.'}
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
$builder['Application Name']='PortalSAGWeb-Migration016'

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
 CASE WHEN EXISTS (SELECT 1 FROM migration.schema_migrations WHERE migration_version='015' AND succeeded=1) THEN 1 ELSE 0 END
FROM sys.databases AS d WHERE d.database_id=DB_ID();
'@
    $reader=$preflight.ExecuteReader()
    if(-not $reader.Read()){throw 'Migration 016 preflight returned no row.'}
    $major=[Convert]::ToInt32($reader.GetValue(0))
    $compatibility=[Convert]::ToInt32($reader.GetValue(1))
    $collation=$reader.GetString(2)
    $has015=[Convert]::ToInt32($reader.GetValue(3))
    $reader.Close()
  } finally {$preflight.Dispose()}

  if($major -ne 15 -or $compatibility -ne 150 -or $collation -ne 'Modern_Spanish_CI_AS'){
    throw 'The SQL target does not match the certified SQL Server 2019 contract.'
  }
  if($has015 -ne 1){throw 'Migration 015 must be applied and verified before migration 016.'}

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
IF NOT EXISTS (SELECT 1 FROM migration.schema_migrations WHERE migration_version='016')
  INSERT migration.schema_migrations
    (migration_version,script_name,script_sha256,duration_ms,succeeded)
  VALUES ('016',@script_name,@script_sha256,0,1);
ELSE IF NOT EXISTS
(
  SELECT 1 FROM migration.schema_migrations
  WHERE migration_version='016' AND script_name=@script_name AND script_sha256=@script_sha256 AND succeeded=1
)
  THROW 51630,N'Migration 016 history conflicts with the reviewed checksum.',1;
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
 CASE WHEN COL_LENGTH(N'content.print_format_sources',N'description') IS NULL THEN 1 ELSE 0 END,
 CASE WHEN COL_LENGTH(N'content.public_download_documents',N'asset_kind') IS NOT NULL THEN 1 ELSE 0 END,
 CASE WHEN OBJECT_ID(N'content.v_public_download_assets',N'V') IS NOT NULL THEN 1 ELSE 0 END,
 CASE WHEN EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'content.public_download_documents') AND name=N'IX_public_download_documents_section_kind_status' AND is_disabled=0) THEN 1 ELSE 0 END,
 CASE WHEN OBJECT_DEFINITION(OBJECT_ID(N'migration.usp_load_operational_settings_content_notifications_audit')) LIKE N'%asset_kind%' THEN 1 ELSE 0 END,
 (SELECT COUNT(*) FROM migration.schema_migrations WHERE migration_version='016' AND succeeded=1),
 (SELECT COUNT(*) FROM sys.foreign_keys WHERE is_disabled=1 OR is_not_trusted=1),
 (SELECT COUNT(*) FROM sys.check_constraints WHERE is_disabled=1 OR is_not_trusted=1);
'@
    $reader=$verification.ExecuteReader()
    $null=$reader.Read()
    $values=0..7 | ForEach-Object {[Convert]::ToInt32($reader.GetValue($_))}
    $reader.Close()
  } finally {$verification.Dispose()}

  if($values[0] -ne 1 -or $values[1] -ne 1 -or $values[2] -ne 1 -or $values[3] -ne 1 -or $values[4] -ne 1 -or $values[5] -ne 1 -or $values[6] -ne 0 -or $values[7] -ne 0){
    throw 'Migration 016 post-verification failed.'
  }

  Write-Host
  Write-Host 'Migration 016 succeeded and was verified.' -ForegroundColor Green
  Write-Host 'Public assets support document/video classification; print-source descriptions are removed.'
}
finally {
  if($connection.State -ne [Data.ConnectionState]::Closed){$connection.Close()}
  $connection.Dispose()
  $credential=$null
  $securePassword=$null
}
