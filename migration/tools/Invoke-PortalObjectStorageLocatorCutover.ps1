[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('PortalSAGWeb','PortalSAGWeb-TEST')][string]$ExpectedDatabase,
  [Parameter(Mandatory)][ValidateSet('cutover','rollback')][string]$Action,
  [Parameter(Mandatory)][string]$ProtectedManifestPath,
  [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ManifestSha256,
  [Parameter(Mandatory)][string]$SessionDirectory,
  [switch]$MaintenanceConfirmed,
  [switch]$BackupVerified,
  [switch]$PublicEndpointsOnly,
  [switch]$Apply
)

# Without -Apply this executes the same update in a transaction and rolls it back.
# Review the runbook; this script verifies inputs, not the capacity/restore/operational gates.
$ErrorActionPreference = 'Stop'
if (-not $MaintenanceConfirmed -or -not $BackupVerified) {
  throw 'A confirmed maintenance window and verified backup are required for preview and apply.'
}
$manifestItem = Get-Item -LiteralPath $ProtectedManifestPath
if ($manifestItem.PSIsContainer -or $manifestItem.Length -lt 2 -or $manifestItem.Length -gt 8000000 -or
    ($manifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'The manifest is not a regular, bounded file.'
}
$insideGit = & git -C $manifestItem.DirectoryName rev-parse --is-inside-work-tree 2>$null
if ($LASTEXITCODE -eq 0 -or $insideGit -eq 'true') {
  throw 'The protected manifest must stay outside Git worktrees.'
}
$manifestBytes = [IO.File]::ReadAllBytes($manifestItem.FullName)
if ($manifestBytes.Length -gt 8000000) { throw 'The manifest exceeds its size limit.' }
$hasher = [Security.Cryptography.SHA256]::Create()
try { $actualSha256 = [Convert]::ToHexString($hasher.ComputeHash($manifestBytes)) }
finally { $hasher.Dispose() }
if ($actualSha256 -ine $ManifestSha256) { throw 'The manifest checksum does not match the reviewed artifact.' }
$manifestText = [Text.UTF8Encoding]::new($false, $true).GetString($manifestBytes).TrimStart([char]0xfeff)
# Hex UTF-16LE is inserted as data only. No user-controlled string can terminate a SQL literal.
$manifestSqlHex = [Convert]::ToHexString([Text.Encoding]::Unicode.GetBytes($manifestText))
$migrationRoot = Split-Path $PSScriptRoot -Parent
$descriptorFile = Join-Path $SessionDirectory 'active.json'
$descriptor = Get-Content -Raw -LiteralPath $descriptorFile | ConvertFrom-Json
if ($descriptor.database -cne $ExpectedDatabase) { throw 'The selected SQL session targets a different database.' }
$expectedEnvironment = if ($ExpectedDatabase -ceq 'PortalSAGWeb') { 'production' } else { 'qa' }
if ($descriptor.environment -cne $expectedEnvironment) { throw 'The selected SQL session targets a different environment.' }
$batchPath = Join-Path $migrationRoot 'discovery/PortalObjectStorageLocatorCutover.sql'
$batch = [IO.File]::ReadAllText($batchPath)
$commitBit = if ($Apply) { 1 } else { 0 }
$publicBit = if ($PublicEndpointsOnly) { 1 } else { 0 }
$requestSql = @"
DECLARE @ExpectedDatabase nvarchar(128) = N'$ExpectedDatabase';
DECLARE @Action varchar(12) = '$Action';
DECLARE @CommitChanges bit = $commitBit;
DECLARE @PublicEndpointsOnly bit = $publicBit;
DECLARE @Manifest nvarchar(max) = CONVERT(nvarchar(max), 0x$manifestSqlHex);
$batch
"@
$deliver = Join-Path $migrationRoot 'connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
try {
  $response = & $deliver -Sql $requestSql -Mode write -SessionDirectory $SessionDirectory -TimeoutSeconds 60 -MaxRows 1 | ConvertFrom-Json
} catch {
  # Return known aggregate-only failure descriptions, never arbitrary server or pipe details.
  $message = $_.Exception.Message
  $safePrefixes = @(
    'Wrong database for the object locator manifest.',
    'Invalid locator action or transaction scope.',
    'The object locator manifest is invalid or exceeds its size limit.',
    'This locator batch requires SQL Server 2019 and compatibility level 150.',
    'The manifest must contain only locator objects.',
    'A manifest locator failed length, prefix, hash, or identity validation.',
    'The manifest has duplicate file identities or more than one destination bucket.',
    'Guide staging or deletion claims still depend on the provider; reconcile them first.',
    'Active public endpoint files differ from the scoped manifest.',
    'Provider file count differs from the manifest; inventory the delta before proceeding.',
    'One or more rows do not match the verified locator manifest.',
    'The locator update did not cover all rows for the previous provider.',
    'Post-update locators did not reconcile with the verified manifest.',
    'Locator transaction failed and was rolled back; details withheld.'
  )
  foreach ($prefix in $safePrefixes) {
    if ($message.StartsWith($prefix, [StringComparison]::Ordinal)) { throw $prefix }
  }
  throw 'Locator request did not return verified confirmation. Inspect aggregate SQL state before retrying.'
}
$results = @($response.resultSets)
$rows = if ($results.Count -eq 1) { @($results[0].rows) } else { @() }
if (-not $response.success -or $rows.Count -ne 1 -or $rows[0].database -cne $ExpectedDatabase -or
    $rows[0].action -cne $Action -or [bool]$rows[0].committed -ne [bool]$Apply -or
    [long]$rows[0].verified_files -lt 1) {
  throw 'Locator response did not match the requested database and mode. Inspect aggregate SQL state before retrying.'
}
[pscustomobject]@{
  database = $ExpectedDatabase
  action = $Action
  committed = [bool]$Apply
  verifiedFiles = [long]$rows[0].verified_files
  requestId = $response.requestId
}
