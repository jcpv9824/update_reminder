[CmdletBinding()]
param(
  [string]$ServerName='data14.sagerp.co,54103',
  [string]$DatabaseName='PortalSAGWeb',
  [string]$Username,
  [switch]$Approved
)

$ErrorActionPreference='Stop'
$expectedHash='3fd7b5caa4e96df5ebcd72c7fdb45904dba06f21ad6c0a829727d491bbcfdf8d'
$scriptName='019_expand_notification_outbox_types.sql'

function Get-Sha256Hex([string]$Path) {
  $stream=[IO.File]::OpenRead($Path)
  $sha256=[Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
  finally { $sha256.Dispose(); $stream.Dispose() }
}

function Convert-HexToBytes([string]$Hex) {
  $bytes=New-Object byte[] ($Hex.Length/2)
  for($index=0;$index -lt $bytes.Length;$index++){$bytes[$index]=[Convert]::ToByte($Hex.Substring($index*2,2),16)}
  return ,$bytes
}

$migrationPath=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\sql\$scriptName")).Path
if((Get-Sha256Hex $migrationPath) -cne $expectedHash){throw 'Migration 019 checksum does not match the reviewed manifest.'}
if($DatabaseName -notin @('PortalSAGWeb','PortalSAGWeb-TEST')){
  throw 'Migration 019 is restricted to PortalSAGWeb or PortalSAGWeb-TEST.'
}

Write-Host 'Portal SAG Web - apply reviewed migration 019' -ForegroundColor Cyan
Write-Host 'Purpose: enable durable task-status and test-email outbox messages.'
Write-Host 'Existing notifications and delivery history are preserved.'
Write-Host 'The supplied login must have effective database CONTROL.' -ForegroundColor Yellow
if(-not $Approved){
  $confirmation=Read-Host 'Type APPLY MIGRATION 019 to continue'
  if($confirmation -cne 'APPLY MIGRATION 019'){throw 'Migration 019 cancelled.'}
}
if([string]::IsNullOrWhiteSpace($Username)){$Username=Read-Host 'SQL Authentication migration username'}
$securePassword=Read-Host 'SQL Authentication password' -AsSecureString
if(-not $securePassword.IsReadOnly()){$securePassword.MakeReadOnly()}

$builder=[System.Data.SqlClient.SqlConnectionStringBuilder]::new()
$builder['Data Source']=$ServerName
$builder['Initial Catalog']=$DatabaseName
$builder['Encrypt']=$true
$builder['TrustServerCertificate']=$false
$builder['Connect Timeout']=60
$builder['Persist Security Info']=$false
$builder['Application Name']='PortalSAGWeb-Migration019'
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
 CASE WHEN EXISTS (SELECT 1 FROM migration.schema_migrations WHERE migration_version='018' AND succeeded=1) THEN 1 ELSE 0 END,
 HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','CONTROL')
FROM sys.databases AS d WHERE d.database_id=DB_ID();
'@
    $reader=$preflight.ExecuteReader()
    if(-not $reader.Read()){throw 'Migration 019 preflight returned no row.'}
    $major=[Convert]::ToInt32($reader.GetValue(0))
    $compatibility=[Convert]::ToInt32($reader.GetValue(1))
    $collation=$reader.GetString(2)
    $has018=[Convert]::ToInt32($reader.GetValue(3))
    $hasControl=[Convert]::ToInt32($reader.GetValue(4))
    $reader.Close()
  } finally {$preflight.Dispose()}
  if($major -ne 15 -or $compatibility -ne 150 -or $collation -ne 'Modern_Spanish_CI_AS'){
    throw 'The SQL target does not match the certified SQL Server 2019 contract.'
  }
  if($has018 -ne 1){throw 'Migration 018 must be applied before migration 019.'}
  if($hasControl -ne 1){throw 'The login does not have database CONTROL required for migration 019.'}

  foreach($batch in @([regex]::Split([IO.File]::ReadAllText($migrationPath),'(?im)^\s*GO\s*(?:--.*)?$') |
      Where-Object {-not [string]::IsNullOrWhiteSpace($_)})) {
    $command=$connection.CreateCommand()
    try{$command.CommandTimeout=600;$command.CommandText=$batch;$null=$command.ExecuteNonQuery()}
    finally{$command.Dispose()}
  }

  $history=$connection.CreateCommand()
  try {
    $history.CommandText=@'
IF NOT EXISTS (SELECT 1 FROM migration.schema_migrations WHERE migration_version='019')
  INSERT migration.schema_migrations(migration_version,script_name,script_sha256,duration_ms,succeeded)
  VALUES('019',@script_name,@script_sha256,0,1);
ELSE IF NOT EXISTS
(
  SELECT 1 FROM migration.schema_migrations
  WHERE migration_version='019' AND script_name=@script_name AND script_sha256=@script_sha256 AND succeeded=1
)
  THROW 51930,N'Migration 019 history conflicts with the reviewed checksum.',1;
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
SET XACT_ABORT ON;
BEGIN TRANSACTION;
DECLARE @now DATETIME2(3)=SYSUTCDATETIME();
INSERT notifications.email_notifications
  (source_id,notification_type,entity_type,entity_source_id,idempotency_key,subject,status,attempt_count,next_attempt_at,metadata_json,created_at,created_by,updated_at,updated_by)
VALUES
  (N'migration_019_task_test',N'task_status_notification',N'task',N'migration_019',N'migration_019_task_test',N'test',N'pending',0,@now,N'{}',@now,N'migration-019',@now,N'migration-019'),
  (N'migration_019_email_test',N'test_email',N'settings',N'migration_019',N'migration_019_email_test',N'test',N'pending',0,@now,N'{}',@now,N'migration-019',@now,N'migration-019');
ROLLBACK TRANSACTION;
SELECT
 (SELECT COUNT(*) FROM migration.schema_migrations WHERE migration_version='019' AND succeeded=1),
 (SELECT COUNT(*) FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID(N'notifications.email_notifications') AND name=N'CK_email_notifications_type' AND is_disabled=0 AND is_not_trusted=0);
'@
    $reader=$verification.ExecuteReader();$null=$reader.Read()
    $historyCount=[Convert]::ToInt32($reader.GetValue(0));$constraintCount=[Convert]::ToInt32($reader.GetValue(1));$reader.Close()
  } finally {$verification.Dispose()}
  if($historyCount -ne 1 -or $constraintCount -ne 1){throw 'Migration 019 post-verification failed.'}
  Write-Host 'Migration 019 succeeded and was verified.' -ForegroundColor Green
}
finally {
  if($connection.State -ne [Data.ConnectionState]::Closed){$connection.Close()}
  $connection.Dispose();$credential=$null;$securePassword=$null
}
