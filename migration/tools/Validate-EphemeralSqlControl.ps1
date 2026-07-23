[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$sessionRoot = Join-Path $PSScriptRoot '..\connect-sql-server'
$serverPath = Join-Path $sessionRoot 'Start-PortalSAGWeb-EphemeralControl.ps1'
$clientPath = Join-Path $sessionRoot 'Invoke-PortalSAGWeb-EphemeralRequest.ps1'
$launcherPath = Join-Path $sessionRoot 'Open-PortalSAGWeb-EphemeralControl.cmd'
$qaLauncherPath = Join-Path $sessionRoot 'Open-PortalSAGWeb-QA-FullControl.cmd'
$qaDiscoveryLauncherPath = Join-Path $sessionRoot 'Open-PortalSAGWeb-QA-Discovery.cmd'
$productionFullControlLauncherPath = Join-Path $sessionRoot 'Open-PortalSAGWeb-FullControl.cmd'

foreach ($path in @($serverPath, $clientPath, $launcherPath, $qaLauncherPath, $qaDiscoveryLauncherPath,$productionFullControlLauncherPath)) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing ephemeral-control artifact: $path" }
}

foreach ($path in @($serverPath, $clientPath)) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count -gt 0) {
    throw "PowerShell parser rejected $path`: $($errors[0].Message)"
  }
}

$server = Get-Content -Raw -LiteralPath $serverPath
$client = Get-Content -Raw -LiteralPath $clientPath
$launcher = Get-Content -Raw -LiteralPath $launcherPath
$qaLauncher = Get-Content -Raw -LiteralPath $qaLauncherPath
$qaDiscoveryLauncher = Get-Content -Raw -LiteralPath $qaDiscoveryLauncherPath
$productionFullControlLauncher = Get-Content -Raw -LiteralPath $productionFullControlLauncherPath

$requiredServerPatterns = @(
  "Read-Host 'SQL Authentication password' -AsSecureString",
  '$securePassword.MakeReadOnly()',
  "`$builder['Encrypt'] = `$true",
  "`$builder['TrustServerCertificate'] = `$false",
  '[System.Data.SqlClient.SqlCredential]::new',
  '[Convert]::ToInt32($reader.GetValue(1))',
  '[System.IO.Pipes.NamedPipeServerStreamAcl]::Create',
  '[System.IO.Pipes.PipeSecurity]::new',
  'AUTHORIZE DATABASE ACCESS FOR THIS SESSION',
  "approvalMode = 'session'",
  "accessLevel = `$accessLevel",
  "IS_ROLEMEMBER('portal_runtime')",
  'Write authorized by the active terminal session.',
  "HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','CONTROL')",
  "ValidateSet('production','qa')",
  '[switch]$AllowElevatedRuntimeLogin',
  'ownerApprovedElevatedRuntimeLogin = $ownerApprovedElevatedRuntimeLogin',
  "permissionMutationPolicy = 'preserve-existing'",
  "EXECUTE AS USER=N'dbo';",
  "executionContext = `$(if (`$sessionExecutingAsDbo) { 'session-scoped-dbo' } else { 'login-user' })",
  'The QA controller refuses the known production server/database pair.',
  "elseif (`$Environment -eq 'qa' -and `$hasConnect -eq 1) { 'qa-readonly' }",
  'Write requests are disabled for this QA discovery session.',
  "Remove-Item -LiteralPath `$descriptorPath"
)
foreach ($pattern in $requiredServerPatterns) {
  if (-not $server.Contains($pattern)) { throw "Ephemeral server is missing safety contract: $pattern" }
}

foreach ($forbidden in @('Export-Clixml', 'ConvertFrom-SecureString', 'ConvertTo-SecureString', 'TrustServerCertificate=true')) {
  if ($server -match [regex]::Escape($forbidden) -or $client -match [regex]::Escape($forbidden)) {
    throw "Forbidden credential persistence/bypass found: $forbidden"
  }
}

if ($client -match '(?i)password|credential') {
  throw 'The request client must never accept or read credentials.'
}
if (-not $client.Contains('[System.IO.Pipes.NamedPipeClientStream]::new')) {
  throw 'The request client is not using the local named pipe.'
}
if ($server.Contains('APPROVE WRITE')) {
  throw 'Per-request write approval prompts must not be present in session-authorization mode.'
}
if (-not $client.Contains("`$descriptor.approvalMode -ne 'session'")) {
  throw 'The request client does not require a session-authorized descriptor.'
}
if (-not $client.Contains("`$descriptor.accessLevel -notin @('full-control','runtime','qa-readonly')")) {
  throw 'The request client does not validate the SQL access level.'
}
if (-not $launcher.Contains('Start-PortalSAGWeb-EphemeralControl.ps1')) {
  throw 'The visible launcher does not start the ephemeral control process.'
}
foreach ($pattern in @('-Environment qa','-RequireFullControl','sql-session-qa')) {
  if (-not $qaLauncher.Contains($pattern)) { throw "The QA launcher is missing safety contract: $pattern" }
}
foreach ($pattern in @('-Environment qa','PortalSAGWeb-TEST','sql-session-qa')) {
  if (-not $qaDiscoveryLauncher.Contains($pattern)) { throw "The QA discovery launcher is missing safety contract: $pattern" }
}
foreach ($pattern in @('-RequireFullControl','-AllowElevatedRuntimeLogin')) {
  if (-not $productionFullControlLauncher.Contains($pattern)) {
    throw "The production full-control launcher is missing its explicit owner-approved exception contract: $pattern"
  }
}
if (-not $client.Contains('$validTarget') -or -not $client.Contains('$knownProductionPair')) {
  throw 'The request client does not distinguish authorized QA from the known production pair.'
}

Write-Host 'PASS ephemeral SQL control: parser, TLS, memory-only credential, current-user pipe, isolated QA/production targets, full-control/runtime capability detection and one-time session authorization.' -ForegroundColor Green
