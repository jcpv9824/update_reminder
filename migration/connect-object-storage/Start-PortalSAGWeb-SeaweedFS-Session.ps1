[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Read-Required([string]$Prompt) {
  $value = (Read-Host $Prompt).Trim()
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "$Prompt is required."
  }
  return $value
}

function Convert-SecureStringToMemory([Security.SecureString]$Value) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

Write-Host ''
Write-Host 'Portal SAG Web - EPHEMERAL SEAWEEDFS S3 CONNECTION' -ForegroundColor Cyan
Write-Host 'Access and secret keys remain only in process memory and are never written or printed.'
Write-Host 'TLS is mandatory. Object names and existing object values are never displayed.'
Write-Host ''

$endpointInput = Read-Required 'SeaweedFSEndpoint (hostname or root https:// S3 gateway endpoint)'
$sslInput = (Read-Host 'SeaweedFSUseSSL [true]').Trim().ToLowerInvariant()
if ([string]::IsNullOrWhiteSpace($sslInput)) { $sslInput = 'true' }
if ($sslInput -notin @('true','1','yes','y')) {
  throw 'SeaweedFSUseSSL must be true for the production Portal SAG Web integration.'
}

$endpointUri = $null
$defaultPort = 443
if ($endpointInput -match '^https?://') {
  $endpointUri = [Uri]$endpointInput
  if (-not $endpointUri.IsDefaultPort) { $defaultPort = $endpointUri.Port }
}
$portInput = (Read-Host "SeaweedFSPort [$defaultPort]").Trim()
if ([string]::IsNullOrWhiteSpace($portInput)) { $portInput = [string]$defaultPort }
$port = 0
if (-not [int]::TryParse($portInput, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
  throw 'SeaweedFSPort must be an integer between 1 and 65535.'
}

$hostName = $endpointInput
if ($endpointUri) {
  if ($endpointUri.Scheme -cne 'https' -or $endpointUri.UserInfo -or $endpointUri.Query -or $endpointUri.Fragment -or $endpointUri.AbsolutePath -ne '/') {
    throw 'SeaweedFSEndpoint must be a root HTTPS endpoint without credentials, path, query, or fragment.'
  }
  $hostName = $endpointUri.DnsSafeHost
  if (-not $endpointUri.IsDefaultPort -and $endpointUri.Port -ne $port) {
    throw 'SeaweedFSPort does not match the port embedded in SeaweedFSEndpoint.'
  }
}
if ($hostName -notmatch '^[A-Za-z0-9.-]+$') {
  throw 'SeaweedFSEndpoint hostname is not valid.'
}

$bucket = Read-Required 'SeaweedFSBucketName'
if ($bucket -notmatch '^(?!.*\.\.)(?!-)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$') {
  throw 'SeaweedFSBucketName is not a valid S3 bucket name.'
}

$regionInput = (Read-Host 'SeaweedFSRegion [us-east-1]').Trim()
$region = if ([string]::IsNullOrWhiteSpace($regionInput)) { 'us-east-1' } else { $regionInput }
if ($region -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$') {
  throw 'SeaweedFSRegion is not valid.'
}

$accessKeySecure = Read-Host 'SeaweedFSAccessKey' -AsSecureString
$secretKeySecure = Read-Host 'SeaweedFSSecretKey' -AsSecureString
$writeChoice = (Read-Host 'Run reversible write/read/delete permission probe? [y/N]').Trim().ToLowerInvariant()
$probeMode = if ($writeChoice -in @('y','yes')) { 'write' } else { 'readonly' }

$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$apiDirectory = Join-Path $repository 'api'
$probeScript = Join-Path $apiDirectory 'scripts\check-seaweedfs-connection.js'
if (-not (Test-Path -LiteralPath $probeScript)) { throw 'The SeaweedFS S3 probe script is missing.' }
$node = (Get-Command node -ErrorAction Stop).Source

$accessKey = $null
$secretKey = $null
$process = $null
$startInfo = $null
try {
  $accessKey = Convert-SecureStringToMemory $accessKeySecure
  $secretKey = Convert-SecureStringToMemory $secretKeySecure
  if ([string]::IsNullOrWhiteSpace($accessKey) -or [string]::IsNullOrWhiteSpace($secretKey)) {
    throw 'Both SeaweedFS S3 credentials are required.'
  }

  $endpoint = if ($port -eq 443) { "https://${hostName}" } else { "https://${hostName}:$port" }
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $node
  $startInfo.Arguments = '"' + $probeScript + '"'
  $startInfo.WorkingDirectory = $apiDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.EnvironmentVariables['SEAWEEDFS_ENDPOINT'] = $endpoint
  $startInfo.EnvironmentVariables['SEAWEEDFS_REGION'] = $region
  $startInfo.EnvironmentVariables['SEAWEEDFS_BUCKET'] = $bucket
  $startInfo.EnvironmentVariables['SEAWEEDFS_FORCE_PATH_STYLE'] = 'true'
  $startInfo.EnvironmentVariables['SEAWEEDFS_ACCESS_KEY_ID'] = $accessKey
  $startInfo.EnvironmentVariables['SEAWEEDFS_SECRET_ACCESS_KEY'] = $secretKey
  $startInfo.EnvironmentVariables['OBJECT_STORAGE_PREFIX'] = 'portal-sag/runtime'
  $startInfo.EnvironmentVariables['SEAWEEDFS_PROBE_MODE'] = $probeMode

  Write-Host ''
  Write-Host 'Opening strict-TLS S3 connection...' -ForegroundColor Cyan
  $process = [Diagnostics.Process]::Start($startInfo)
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  if ($stdout) { Write-Host $stdout.TrimEnd() }
  if ($stderr) { Write-Host $stderr.TrimEnd() -ForegroundColor Yellow }
  if ($process.ExitCode -ne 0) { throw "SeaweedFS S3 validation ended with error code $($process.ExitCode)." }
}
finally {
  $accessKey = $null
  $secretKey = $null
  if ($accessKeySecure) { $accessKeySecure.Dispose() }
  if ($secretKeySecure) { $secretKeySecure.Dispose() }
  if ($process) { $process.Dispose() }
  $startInfo = $null
  [GC]::Collect()
}

Write-Host ''
Write-Host 'Finished safely. No credentials or SeaweedFS object values were stored.' -ForegroundColor Green
