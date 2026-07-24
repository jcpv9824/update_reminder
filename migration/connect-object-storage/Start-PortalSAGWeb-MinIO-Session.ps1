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
Write-Host 'Portal SAG Web - EPHEMERAL MINIO CONNECTION' -ForegroundColor Cyan
Write-Host 'Access and secret keys remain only in process memory and are never written or printed.'
Write-Host 'TLS is mandatory. Object names and existing object values are never displayed.'
Write-Host ''

$endpointInput = Read-Required 'MinioEndpoint (hostname or https:// endpoint)'
$sslInput = (Read-Host 'MinioUseSSL [true]').Trim().ToLowerInvariant()
if ([string]::IsNullOrWhiteSpace($sslInput)) { $sslInput = 'true' }
if ($sslInput -notin @('true','1','yes','y')) {
  throw 'MinioUseSSL must be true for the production Portal SAG Web integration.'
}

$portInput = (Read-Host 'MinioPort [443]').Trim()
if ([string]::IsNullOrWhiteSpace($portInput)) { $portInput = '443' }
$port = 0
if (-not [int]::TryParse($portInput, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
  throw 'MinioPort must be an integer between 1 and 65535.'
}

$hostName = $endpointInput
if ($endpointInput -match '^https?://') {
  $uri = [Uri]$endpointInput
  if ($uri.Scheme -cne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') {
    throw 'MinioEndpoint must be a root HTTPS endpoint without credentials, path, query, or fragment.'
  }
  $hostName = $uri.Host
  if (-not $uri.IsDefaultPort -and $uri.Port -ne $port) {
    throw 'MinioPort does not match the port embedded in MinioEndpoint.'
  }
}
if ($hostName -notmatch '^[A-Za-z0-9.-]+$') {
  throw 'MinioEndpoint hostname is not valid.'
}

$bucket = Read-Required 'MinioBucketName'
if ($bucket -notmatch '^(?!.*\.\.)(?!-)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$') {
  throw 'MinioBucketName is not a valid S3 bucket name.'
}

$accessKeySecure = Read-Host 'MinioAccessKey' -AsSecureString
$secretKeySecure = Read-Host 'MinioSecretKey' -AsSecureString
$writeChoice = (Read-Host 'Run reversible write/read/delete permission probe? [y/N]').Trim().ToLowerInvariant()
$probeMode = if ($writeChoice -in @('y','yes')) { 'write' } else { 'readonly' }

$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$apiDirectory = Join-Path $repository 'api'
$probeScript = Join-Path $apiDirectory 'scripts\check-minio-connection.js'
if (-not (Test-Path -LiteralPath $probeScript)) { throw 'The MinIO probe script is missing.' }
$node = (Get-Command node -ErrorAction Stop).Source

$accessKey = $null
$secretKey = $null
$process = $null
$startInfo = $null
try {
  $accessKey = Convert-SecureStringToMemory $accessKeySecure
  $secretKey = Convert-SecureStringToMemory $secretKeySecure
  if ([string]::IsNullOrWhiteSpace($accessKey) -or [string]::IsNullOrWhiteSpace($secretKey)) {
    throw 'Both MinIO credentials are required.'
  }

  $endpoint = "https://${hostName}:$port"
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $node
  $startInfo.Arguments = '"' + $probeScript + '"'
  $startInfo.WorkingDirectory = $apiDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.EnvironmentVariables['OBJECT_STORAGE_ENDPOINT'] = $endpoint
  $startInfo.EnvironmentVariables['OBJECT_STORAGE_REGION'] = 'us-east-1'
  $startInfo.EnvironmentVariables['OBJECT_STORAGE_BUCKET'] = $bucket
  $startInfo.EnvironmentVariables['OBJECT_STORAGE_ACCESS_KEY_ID'] = $accessKey
  $startInfo.EnvironmentVariables['OBJECT_STORAGE_SECRET_ACCESS_KEY'] = $secretKey
  $startInfo.EnvironmentVariables['MINIO_PROBE_MODE'] = $probeMode

  Write-Host ''
  Write-Host 'Opening strict-TLS S3 connection...' -ForegroundColor Cyan
  $process = [Diagnostics.Process]::Start($startInfo)
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  if ($stdout) { Write-Host $stdout.TrimEnd() }
  if ($stderr) { Write-Host $stderr.TrimEnd() -ForegroundColor Yellow }
  if ($process.ExitCode -ne 0) { throw "MinIO validation ended with error code $($process.ExitCode)." }
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
Write-Host 'Finished safely. No credentials or MinIO object values were stored.' -ForegroundColor Green
