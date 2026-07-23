[CmdletBinding()]
param(
  [string]$ServerName,
  [string]$DatabaseName = 'PortalSAGWeb',
  [string]$Username,
  [System.Management.Automation.PSCredential]$Credential,
  [switch]$Confirmed,
  [long]$RunKey,
  [string]$SnapshotDirectory,
  [ValidatePattern('^[a-z0-9]{3,24}$')]
  [string]$StorageAccountName,
  [string]$ResourceGroupName,
  [ValidatePattern('^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$')]
  [string]$BlobContainerName,
  [ValidateSet('nonproduction')]
  [string]$TargetEnvironment = 'nonproduction'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Convert-HexToBytes([string]$Hex) {
  if ($Hex -notmatch '^[0-9a-f]{64}$') { throw 'A transfer hash is malformed.' }
  $bytes = New-Object byte[] 32
  for ($index=0; $index -lt 32; $index++) {
    $bytes[$index] = [Convert]::ToByte($Hex.Substring($index*2,2),16)
  }
  return ,$bytes
}

function Convert-BytesToHex([byte[]]$Bytes) {
  return ([BitConverter]::ToString($Bytes)).Replace('-','').ToLowerInvariant()
}

function Invoke-AzureCli {
  param(
    [Parameter(Mandatory=$true)][string[]]$Arguments,
    [switch]$AsJson,
    [switch]$AsText,
    [string]$FailureMessage = 'Azure operation failed.'
  )
  $output = @(& $script:AzureCliPath @Arguments 2>&1)
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) { throw $FailureMessage }
  $text = ($output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
  if ($AsJson) {
    if ([string]::IsNullOrWhiteSpace($text)) { throw 'Azure returned no metadata.' }
    return $text | ConvertFrom-Json
  }
  if ($AsText) { return $text.Trim() }
}

function Add-Parameter {
  param(
    [System.Data.SqlClient.SqlCommand]$Command,
    [string]$Name,
    [System.Data.SqlDbType]$Type,
    [object]$Value,
    [int]$Size = 0
  )
  $parameter = if ($Size -gt 0) { $Command.Parameters.Add($Name,$Type,$Size) }
    else { $Command.Parameters.Add($Name,$Type) }
  $parameter.Value = $Value
}

function Get-LedgerRecord {
  param([System.Data.SqlClient.SqlConnection]$Connection,[object]$Entry)
  $command = $Connection.CreateCommand()
  try {
    $command.CommandText = @'
SELECT status,original_name,mime_type,expected_byte_count,expected_sha256,blob_container,blob_name
FROM migration.file_transfers
WHERE run_key=@run_key AND source_container=@source_container AND source_id=@source_id AND file_slot=@file_slot;
'@
    Add-Parameter $command '@run_key' ([Data.SqlDbType]::BigInt) $RunKey
    Add-Parameter $command '@source_container' ([Data.SqlDbType]::NVarChar) ([string]$Entry.sourceContainer) 100
    Add-Parameter $command '@source_id' ([Data.SqlDbType]::NVarChar) ([string]$Entry.sourceId) 150
    Add-Parameter $command '@file_slot' ([Data.SqlDbType]::VarChar) ([string]$Entry.fileSlot) 30
    $reader = $command.ExecuteReader()
    try {
      if (-not $reader.Read()) { return $null }
      return [pscustomobject]@{
        status = $reader.GetString(0)
        originalName = $reader.GetString(1)
        mimeType = $reader.GetString(2)
        byteCount = $reader.GetInt64(3)
        sha256 = Convert-BytesToHex ([byte[]]$reader.GetValue(4))
        blobContainer = $reader.GetString(5)
        blobName = $reader.GetString(6)
      }
    }
    finally { $reader.Close() }
  }
  finally { $command.Dispose() }
}

function Test-LedgerMatch {
  param([object]$Ledger,[object]$Entry)
  return $Ledger.originalName -ceq [string]$Entry.originalName `
    -and $Ledger.mimeType -ceq [string]$Entry.mimeType `
    -and $Ledger.byteCount -eq [long]$Entry.byteCount `
    -and $Ledger.sha256 -ceq [string]$Entry.sha256 `
    -and $Ledger.blobContainer -ceq $BlobContainerName `
    -and $Ledger.blobName -ceq [string]$Entry.blobName
}

function Register-TransferPlan {
  param([System.Data.SqlClient.SqlConnection]$Connection,[object]$Entry)
  $command = $Connection.CreateCommand()
  try {
    $command.CommandType = [Data.CommandType]::StoredProcedure
    $command.CommandText = 'migration.usp_register_file_transfer_plan'
    Add-Parameter $command '@run_key' ([Data.SqlDbType]::BigInt) $RunKey
    Add-Parameter $command '@source_container' ([Data.SqlDbType]::NVarChar) ([string]$Entry.sourceContainer) 100
    Add-Parameter $command '@source_id' ([Data.SqlDbType]::NVarChar) ([string]$Entry.sourceId) 150
    Add-Parameter $command '@file_slot' ([Data.SqlDbType]::VarChar) ([string]$Entry.fileSlot) 30
    Add-Parameter $command '@original_name' ([Data.SqlDbType]::NVarChar) ([string]$Entry.originalName) 260
    Add-Parameter $command '@mime_type' ([Data.SqlDbType]::NVarChar) ([string]$Entry.mimeType) 160
    Add-Parameter $command '@expected_byte_count' ([Data.SqlDbType]::BigInt) ([long]$Entry.byteCount)
    Add-Parameter $command '@expected_sha256' ([Data.SqlDbType]::Binary) (Convert-HexToBytes ([string]$Entry.sha256)) 32
    Add-Parameter $command '@blob_container' ([Data.SqlDbType]::NVarChar) $BlobContainerName 63
    Add-Parameter $command '@blob_name' ([Data.SqlDbType]::NVarChar) ([string]$Entry.blobName) 1024
    $null = $command.ExecuteNonQuery()
  }
  finally { $command.Dispose() }
}

function Mark-TransferVerified {
  param(
    [System.Data.SqlClient.SqlConnection]$Connection,
    [object]$Entry,
    [long]$ActualByteCount,
    [string]$ActualSha256,
    [string]$BlobEtag
  )
  $command = $Connection.CreateCommand()
  try {
    $command.CommandType = [Data.CommandType]::StoredProcedure
    $command.CommandText = 'migration.usp_mark_file_transfer_verified'
    Add-Parameter $command '@run_key' ([Data.SqlDbType]::BigInt) $RunKey
    Add-Parameter $command '@source_container' ([Data.SqlDbType]::NVarChar) ([string]$Entry.sourceContainer) 100
    Add-Parameter $command '@source_id' ([Data.SqlDbType]::NVarChar) ([string]$Entry.sourceId) 150
    Add-Parameter $command '@file_slot' ([Data.SqlDbType]::VarChar) ([string]$Entry.fileSlot) 30
    Add-Parameter $command '@actual_byte_count' ([Data.SqlDbType]::BigInt) $ActualByteCount
    Add-Parameter $command '@actual_sha256' ([Data.SqlDbType]::Binary) (Convert-HexToBytes $ActualSha256) 32
    Add-Parameter $command '@blob_etag' ([Data.SqlDbType]::NVarChar) $BlobEtag 200
    $null = $command.ExecuteNonQuery()
  }
  finally { $command.Dispose() }
}

if ($DatabaseName -ne 'PortalSAGWeb') {
  throw 'The protected transfer requires a disposable non-production database named PortalSAGWeb.'
}
if ([string]::IsNullOrWhiteSpace($ServerName)) {
  $ServerName = Read-Host 'NON-PRODUCTION SQL Server / instance (server,port)'
}
if ($ServerName.Trim().Equals('data14.sagerp.co,54103',[StringComparison]::OrdinalIgnoreCase)) {
  throw 'REFUSED: the designated production PortalSAGWeb database cannot be used by the non-production Blob transfer tool.'
}
if ($RunKey -le 0) {
  $enteredRunKey = Read-Host 'Validated raw/stage migration run key'
  if (-not [long]::TryParse($enteredRunKey,[ref]$RunKey) -or $RunKey -le 0) {
    throw 'A positive migration run key is required.'
  }
}
if ([string]::IsNullOrWhiteSpace($SnapshotDirectory)) {
  $SnapshotDirectory = Read-Host 'Restricted Cosmos snapshot directory'
}
if ([string]::IsNullOrWhiteSpace($StorageAccountName)) {
  $StorageAccountName = Read-Host 'NON-PRODUCTION Azure Storage account name'
}
if ([string]::IsNullOrWhiteSpace($ResourceGroupName)) {
  $ResourceGroupName = Read-Host 'Azure resource group name'
}
if ([string]::IsNullOrWhiteSpace($BlobContainerName)) {
  $BlobContainerName = Read-Host 'Private Blob container name'
}
if ($StorageAccountName -notmatch '^[a-z0-9]{3,24}$') {
  throw 'The Azure Storage account name is invalid.'
}
if ([string]::IsNullOrWhiteSpace($ResourceGroupName) -or $ResourceGroupName.Length -gt 90 -or $ResourceGroupName.EndsWith('.')) {
  throw 'The Azure resource group name is invalid.'
}
if ($BlobContainerName -notmatch '^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$') {
  throw 'The private Blob container name is invalid.'
}
$snapshotPath = (Resolve-Path -LiteralPath $SnapshotDirectory).Path
$prepareScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'prepare-blob-transfer-package.js')).Path
$packageDirectory = Join-Path (Join-Path $PSScriptRoot '..\work') ("blob-transfer-{0}" -f (Split-Path $snapshotPath -Leaf))

$node = Get-Command node -ErrorAction Stop
$prepareOutput = @(& $node.Source $prepareScript $snapshotPath $packageDirectory '--prepare' 2>&1)
if ($LASTEXITCODE -ne 0) { throw 'The restricted local transfer package could not be prepared.' }
$prepareOutput = $null

$packagePath = (Resolve-Path -LiteralPath $packageDirectory).Path
$manifestPath = Join-Path $packagePath 'transfer-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'The restricted transfer manifest is missing.' }
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$expectedFiles = [int]$manifest.fileCount
$expectedBytes = [long]$manifest.totalBytes
if ($manifest.version -ne 1 -or $expectedFiles -ne 39 -or $expectedBytes -ne 968128 `
    -or @($manifest.entries).Count -ne $expectedFiles) {
  throw 'The transfer package does not match the certified snapshot contract.'
}

$seenOwners = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$seenBlobs = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$seenLocalFiles = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$validatedBytes = [long]0
$packagePrefix = $packagePath.TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
foreach ($entry in @($manifest.entries)) {
  if ([string]::IsNullOrWhiteSpace([string]$entry.sourceId) `
      -or [string]$entry.sourceContainer -notin @('formatosImpresion','publicDownloads') `
      -or (([string]$entry.sourceContainer -eq 'formatosImpresion' -and [string]$entry.fileSlot -ne 'pdf') `
        -or ([string]$entry.sourceContainer -eq 'publicDownloads' -and [string]$entry.fileSlot -ne 'document')) `
      -or [string]$entry.sha256 -notmatch '^[0-9a-f]{64}$' `
      -or [long]$entry.byteCount -le 0 `
      -or [string]$entry.blobName -notmatch '^portal-sag-import/(?:print-formats|public-downloads)/[0-9a-f]{64}\.[a-z0-9]{1,8}$' `
      -or [string]$entry.localRelativePath -notmatch '^payload/[0-9a-f]{64}\.[a-z0-9]{1,8}$') {
    throw 'A restricted transfer entry is malformed.'
  }
  $ownerKey = "{0}`0{1}`0{2}" -f $entry.sourceContainer,$entry.sourceId,$entry.fileSlot
  if (-not $seenOwners.Add($ownerKey) -or -not $seenBlobs.Add([string]$entry.blobName)) {
    throw 'The transfer package contains a duplicate owner or object name.'
  }
  $localPath = [IO.Path]::GetFullPath((Join-Path $packagePath ([string]$entry.localRelativePath).Replace('/',[IO.Path]::DirectorySeparatorChar)))
  if (-not $localPath.StartsWith($packagePrefix,[StringComparison]::OrdinalIgnoreCase) `
      -or -not $seenLocalFiles.Add($localPath) -or -not (Test-Path -LiteralPath $localPath -PathType Leaf)) {
    throw 'A restricted payload path is invalid or missing.'
  }
  $file = Get-Item -LiteralPath $localPath
  $localHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $localPath).Hash.ToLowerInvariant()
  if ($file.Length -ne [long]$entry.byteCount -or $localHash -cne [string]$entry.sha256) {
    throw 'A restricted local payload failed byte/hash verification.'
  }
  $validatedBytes += $file.Length
  Add-Member -InputObject $entry -NotePropertyName resolvedLocalPath -NotePropertyValue $localPath -Force
}
if ($validatedBytes -ne $expectedBytes) { throw 'The restricted payload aggregate byte count is invalid.' }

$azureCli = Get-Command az.cmd -ErrorAction SilentlyContinue
if (-not $azureCli) { $azureCli = Get-Command az -ErrorAction Stop }
$script:AzureCliPath = $azureCli.Source
Invoke-AzureCli -Arguments @('account','show','--output','none','--only-show-errors') `
  -FailureMessage 'Azure CLI is not signed in. Sign in interactively before running this executor.'

$account = Invoke-AzureCli -AsJson -FailureMessage 'The storage account security posture could not be read.' -Arguments @(
  'storage','account','show','--name',$StorageAccountName,'--resource-group',$ResourceGroupName,
  '--query','{enableHttpsTrafficOnly:enableHttpsTrafficOnly,minimumTlsVersion:minimumTlsVersion,allowBlobPublicAccess:allowBlobPublicAccess}',
  '--output','json','--only-show-errors'
)
if ($account.enableHttpsTrafficOnly -ne $true -or [string]$account.minimumTlsVersion -notin @('TLS1_2','TLS1_3') `
    -or $account.allowBlobPublicAccess -ne $false) {
  throw 'The storage account must enforce HTTPS, TLS 1.2 or newer, and disabled public Blob access.'
}

$blobService = Invoke-AzureCli -AsJson -FailureMessage 'Blob versioning posture could not be read.' -Arguments @(
  'storage','account','blob-service-properties','show','--account-name',$StorageAccountName,
  '--resource-group',$ResourceGroupName,'--output','json','--only-show-errors'
)
if ($blobService.isVersioningEnabled -ne $true) { throw 'Blob versioning must be enabled before migration.' }

$container = Invoke-AzureCli -AsJson -FailureMessage 'The private Blob container could not be read.' -Arguments @(
  'storage','container','show','--name',$BlobContainerName,'--account-name',$StorageAccountName,
  '--auth-mode','login','--output','json','--only-show-errors'
)
if ($null -ne $container.properties.publicAccess -and -not [string]::IsNullOrWhiteSpace([string]$container.properties.publicAccess)) {
  throw 'The Blob container must not allow public access.'
}

Write-Host 'Portal SAG Web - NON-PRODUCTION private Blob transfer' -ForegroundColor Cyan
Write-Host 'Azure access uses the existing interactive identity session.'
Write-Host 'SQL authentication is requested in memory and private files are never printed.'
Write-Host "Files: $expectedFiles"
Write-Host "Bytes: $expectedBytes"
Write-Host
if (-not $Confirmed) {
  $confirmation = Read-Host 'Type TRANSFER BLOBS NONPRODUCTION to continue'
  if ($confirmation -cne 'TRANSFER BLOBS NONPRODUCTION') {
    throw 'Blob transfer cancelled: exact non-production confirmation was not provided.'
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
  if ([string]::IsNullOrWhiteSpace($Username)) { $Username = Read-Host 'SQL Authentication username' }
  $securePassword = Read-Host 'SQL Authentication password' -AsSecureString
}
if (-not $securePassword.IsReadOnly()) { $securePassword.MakeReadOnly() }

$builder = [System.Data.SqlClient.SqlConnectionStringBuilder]::new()
$builder['Data Source'] = $ServerName
$builder['Initial Catalog'] = $DatabaseName
$builder['Encrypt'] = $true
$builder['TrustServerCertificate'] = $false
$builder['Connect Timeout'] = 15
$builder['Persist Security Info'] = $false
$builder['MultipleActiveResultSets'] = $false
$builder['Application Name'] = 'PortalSAGWeb-BlobTransfer'
$sqlCredential = [System.Data.SqlClient.SqlCredential]::new($Username,$securePassword)
$connection = [System.Data.SqlClient.SqlConnection]::new()
$connection.ConnectionString = $builder.ConnectionString
$connection.Credential = $sqlCredential

$verificationDirectory = Join-Path $packagePath '.remote-verification'
try {
  $connection.Open()
  $preflight = $connection.CreateCommand()
  try {
    $preflight.CommandText = @'
SELECT
  CAST(SERVERPROPERTY('ProductMajorVersion') AS INT) AS major_version,
  d.compatibility_level,
  d.collation_name,
  CASE WHEN OBJECT_ID(N'migration.usp_register_file_transfer_plan',N'P') IS NOT NULL
    AND OBJECT_ID(N'migration.usp_mark_file_transfer_verified',N'P') IS NOT NULL THEN 1 ELSE 0 END AS has_file_control,
  CASE WHEN EXISTS
  (
    SELECT 1 FROM migration.schema_migrations
    WHERE migration_version='011' AND script_name=N'011_operational_load_settings_content_notifications_audit.sql' AND succeeded=1
  ) THEN 1 ELSE 0 END AS has_011,
  CASE WHEN EXISTS
  (
    SELECT 1 FROM migration.schema_migrations
    WHERE migration_version='016' AND script_name=N'016_public_download_video_assets_and_source_cleanup.sql' AND succeeded=1
  ) THEN 1 ELSE 0 END AS has_016,
  CASE WHEN EXISTS
  (
    SELECT 1 FROM migration.operational_load_phases
    WHERE run_key=@run_key AND phase_code='scheduling_workflow' AND status='completed'
  ) THEN 1 ELSE 0 END AS workflow_completed,
  CASE WHEN EXISTS
  (
    SELECT 1 FROM migration.operational_load_phases
    WHERE run_key=@run_key AND phase_code='settings_content_notifications_audit' AND status='completed'
  ) THEN 1 ELSE 0 END AS final_completed,
  (SELECT COUNT_BIG(*) FROM migration.stage_print_formats WHERE run_key=@run_key)
    +(SELECT COUNT_BIG(*) FROM migration.stage_public_downloads WHERE run_key=@run_key AND record_type='document') AS expected_files,
  (SELECT status FROM migration.migration_runs WHERE run_key=@run_key) AS run_status
FROM sys.databases AS d WHERE d.database_id=DB_ID();
'@
    Add-Parameter $preflight '@run_key' ([Data.SqlDbType]::BigInt) $RunKey
    $reader = $preflight.ExecuteReader()
    if (-not $reader.Read()) { throw 'Database preflight returned no row.' }
    $majorVersion = [Convert]::ToInt32($reader.GetValue(0))
    $compatibilityLevel = [Convert]::ToInt32($reader.GetValue(1))
    $collationName = $reader.GetString(2)
    $hasFileControl = [Convert]::ToInt32($reader.GetValue(3))
    $has011 = [Convert]::ToInt32($reader.GetValue(4))
    $has016 = [Convert]::ToInt32($reader.GetValue(5))
    $workflowCompleted = [Convert]::ToInt32($reader.GetValue(6))
    $finalCompleted = [Convert]::ToInt32($reader.GetValue(7))
    $sqlExpectedFiles = [Convert]::ToInt64($reader.GetValue(8))
    $runStatus = if ($reader.IsDBNull(9)) { $null } else { $reader.GetString(9) }
    $reader.Close()
  }
  finally { $preflight.Dispose() }

  if ($majorVersion -ne 15 -or $compatibilityLevel -ne 150 -or $collationName -ne 'Modern_Spanish_CI_AS') {
    throw 'The SQL target does not match the certified SQL Server 2019 contract.'
  }
  if ($hasFileControl -ne 1 -or $has011 -ne 1 -or $has016 -ne 1) { throw 'Required migrations 009, 011 and 016 are not installed.' }
  if ($workflowCompleted -ne 1) { throw 'The scheduling/workflow phase is not completed for this run.' }
  if ($sqlExpectedFiles -ne $expectedFiles) { throw 'SQL staging and the restricted package have different file counts.' }
  if ($finalCompleted -ne 1 -and $runStatus -notin @('validated','loading')) {
    throw 'The migration run is not eligible for file transfer.'
  }

  if (-not (Test-Path -LiteralPath $verificationDirectory)) {
    $null = New-Item -ItemType Directory -Path $verificationDirectory
  }
  $verificationPath = (Resolve-Path -LiteralPath $verificationDirectory).Path
  if (-not $verificationPath.StartsWith($packagePrefix,[StringComparison]::OrdinalIgnoreCase)) {
    throw 'The remote verification directory is outside the restricted package.'
  }

  $processed = 0
  foreach ($entry in @($manifest.entries)) {
    $ledger = Get-LedgerRecord $connection $entry
    if ($null -ne $ledger -and -not (Test-LedgerMatch $ledger $entry)) {
      throw 'An existing SQL file ledger row does not match the certified package.'
    }
    if ($null -eq $ledger -or $ledger.status -in @('planned','uploading','failed')) {
      Register-TransferPlan $connection $entry
      $ledger = Get-LedgerRecord $connection $entry
    }

    $exists = Invoke-AzureCli -AsText -FailureMessage 'Blob existence verification failed.' -Arguments @(
      'storage','blob','exists','--account-name',$StorageAccountName,'--container-name',$BlobContainerName,
      '--name',([string]$entry.blobName),'--auth-mode','login','--query','exists','--output','tsv','--only-show-errors'
    )
    if ($exists -ne 'true') {
      try {
        Invoke-AzureCli -FailureMessage 'A private Blob upload failed.' -Arguments @(
          'storage','blob','upload','--account-name',$StorageAccountName,'--container-name',$BlobContainerName,
          '--name',([string]$entry.blobName),'--file',([string]$entry.resolvedLocalPath),
          '--content-type',([string]$entry.mimeType),'--overwrite','false','--auth-mode','login',
          '--output','none','--only-show-errors'
        )
      }
      catch {
        $existsAfterRace = Invoke-AzureCli -AsText -FailureMessage 'Blob upload reconciliation failed.' -Arguments @(
          'storage','blob','exists','--account-name',$StorageAccountName,'--container-name',$BlobContainerName,
          '--name',([string]$entry.blobName),'--auth-mode','login','--query','exists','--output','tsv','--only-show-errors'
        )
        if ($existsAfterRace -ne 'true') { throw }
      }
    }

    $remote = Invoke-AzureCli -AsJson -FailureMessage 'Remote Blob metadata verification failed.' -Arguments @(
      'storage','blob','show','--account-name',$StorageAccountName,'--container-name',$BlobContainerName,
      '--name',([string]$entry.blobName),'--auth-mode','login',
      '--query','{etag:properties.etag,length:properties.contentLength}','--output','json','--only-show-errors'
    )
    $temporaryFile = Join-Path $verificationPath (([Guid]::NewGuid().ToString('N'))+'.verify')
    try {
      Invoke-AzureCli -FailureMessage 'Remote Blob content verification failed.' -Arguments @(
        'storage','blob','download','--account-name',$StorageAccountName,'--container-name',$BlobContainerName,
        '--name',([string]$entry.blobName),'--file',$temporaryFile,'--overwrite','true',
        '--auth-mode','login','--output','none','--only-show-errors'
      )
      $remoteFile = Get-Item -LiteralPath $temporaryFile
      $remoteHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $temporaryFile).Hash.ToLowerInvariant()
      if ($remoteFile.Length -ne [long]$entry.byteCount -or $remoteHash -cne [string]$entry.sha256) {
        if ($ledger.status -notin @('verified','linked')) {
          Mark-TransferVerified $connection $entry $remoteFile.Length $remoteHash ([string]$remote.etag)
        }
        throw 'A remote Blob object failed byte/hash verification.'
      }
      if ($ledger.status -notin @('verified','linked')) {
        Mark-TransferVerified $connection $entry $remoteFile.Length $remoteHash ([string]$remote.etag)
      }
    }
    finally {
      if (Test-Path -LiteralPath $temporaryFile) { Remove-Item -LiteralPath $temporaryFile -Force }
    }
    $processed++
    Write-Progress -Activity 'Verifying private migration files' -Status "$processed of $expectedFiles" `
      -PercentComplete (($processed/$expectedFiles)*100)
  }
  Write-Progress -Activity 'Verifying private migration files' -Completed

  $summary = $connection.CreateCommand()
  try {
    $summary.CommandText = @'
SELECT
  COUNT_BIG(*) AS planned_count,
  SUM(CASE WHEN status IN ('verified','linked') THEN CONVERT(BIGINT,1) ELSE CONVERT(BIGINT,0) END) AS ready_count,
  SUM(CASE WHEN status='failed' THEN CONVERT(BIGINT,1) ELSE CONVERT(BIGINT,0) END) AS failed_count
FROM migration.file_transfers
WHERE run_key=@run_key AND source_container IN (N'formatosImpresion',N'publicDownloads');
'@
    Add-Parameter $summary '@run_key' ([Data.SqlDbType]::BigInt) $RunKey
    $reader = $summary.ExecuteReader()
    $null = $reader.Read()
    $plannedCount = $reader.GetInt64(0)
    $readyCount = if ($reader.IsDBNull(1)) { 0 } else { $reader.GetInt64(1) }
    $failedCount = if ($reader.IsDBNull(2)) { 0 } else { $reader.GetInt64(2) }
    $reader.Close()
  }
  finally { $summary.Dispose() }
  if ($plannedCount -ne $expectedFiles -or $readyCount -ne $expectedFiles -or $failedCount -ne 0) {
    throw 'The final SQL file ledger reconciliation failed.'
  }

  Write-Host
  Write-Host 'NON-PRODUCTION private Blob transfer verified.' -ForegroundColor Green
  Write-Host "Files verified: $readyCount"
  Write-Host "Bytes verified: $expectedBytes"
  Write-Host 'Phase 011 may now pass its verified-file preflight for this migration run.' -ForegroundColor Cyan
}
finally {
  if (Test-Path -LiteralPath $verificationDirectory) {
    $remaining = @(Get-ChildItem -LiteralPath $verificationDirectory -Force)
    if ($remaining.Count -eq 0) { Remove-Item -LiteralPath $verificationDirectory -Force }
  }
  if ($connection.State -ne [Data.ConnectionState]::Closed) { $connection.Close() }
  $connection.Dispose()
  $sqlCredential = $null
  $securePassword = $null
  $manifest = $null
}
