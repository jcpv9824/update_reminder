[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$apiPath = Join-Path $repoRoot 'api'
$frontendPath = Join-Path $repoRoot 'frontend'

function Read-SecretText([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function New-EphemeralSecret {
  $bytes = [byte[]]::new(48)
  [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return [Convert]::ToBase64String($bytes)
}

function Invoke-AzSecretText([string[]]$Arguments, [string]$FailureMessage) {
  $value = & az @Arguments 2>$null
  if ($LASTEXITCODE -ne 0) { throw $FailureMessage }
  return (@($value) -join "`n").Trim()
}

function Get-CosmosConnectionFromAzure {
  if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw 'Azure CLI is required to acquire the Cosmos setting without displaying it.'
  }

  & az account show --output none --only-show-errors 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw 'Azure is not signed in. Run az login, then open this launcher again.'
  }

  $connection = Invoke-AzSecretText @(
    'functionapp','config','appsettings','list',
    '--resource-group','rg-erp-update-scheduler-prod',
    '--name','erpupdsch4645-api',
    '--query',"[?name=='COSMOS_CONNECTION_STRING'].value | [0]",
    '--output','tsv','--only-show-errors'
  ) 'Azure did not allow access to the existing Cosmos application setting.'

  if ($connection -match '^@Microsoft\.KeyVault\(SecretUri=(?<secretUri>https://[^)]+)\)$') {
    $connection = Invoke-AzSecretText @(
      'keyvault','secret','show','--id',$Matches.secretUri,
      '--query','value','--output','tsv','--only-show-errors'
    ) 'The Cosmos setting uses Key Vault, but Azure did not allow access to that secret.'
  }

  if ([string]::IsNullOrWhiteSpace($connection) -or $connection -eq 'null') {
    throw 'The Function App does not contain a usable Cosmos connection setting.'
  }
  if (-not $connection.StartsWith('AccountEndpoint=https://',[StringComparison]::OrdinalIgnoreCase)) {
    throw 'The Azure Cosmos setting is not a usable connection string. Its value was not displayed.'
  }

  return $connection
}

Write-Host 'Portal SAG Web - LOCAL DUAL-READ CONNECTION' -ForegroundColor Cyan
Write-Host 'SQL performs verified shadow reads; Cosmos remains the response source.'
Write-Host 'Cosmos access is acquired from your signed-in Azure session and is never displayed.'
Write-Host 'All timers are disabled. Credentials remain only in process memory.'
Write-Host 'The SQL login must be a portal_runtime member; owner-approved elevated permissions are preserved.'
Write-Host ''

$enteredSqlUser = (Read-Host 'SQL runtime username [SAGWebDev]').Trim()
$sqlUser = if ([string]::IsNullOrWhiteSpace($enteredSqlUser)) { 'SAGWebDev' } else { $enteredSqlUser }
$sqlPassword = Read-SecretText 'SQL runtime password'
$cosmosConnection = $null

$secretNames = @('SQL_PASSWORD','COSMOS_CONNECTION_STRING','JWT_SECRET','RATE_LIMIT_HASH_SECRET')
try {
  Write-Host 'Acquiring the existing Cosmos setting from Azure without displaying it...'
  $cosmosConnection = Get-CosmosConnectionFromAzure
  Write-Host 'Cosmos setting acquired securely.' -ForegroundColor Green

  $env:DATA_BACKEND = 'dual-read'
  $env:SQL_SECURITY_RUNTIME_ENABLED = 'false'
  $env:SQL_SERVER_HOST = 'data14.sagerp.co,54103'
  $env:SQL_DATABASE = 'PortalSAGWeb'
  $env:SQL_USERNAME = $sqlUser
  $env:SQL_PASSWORD = $sqlPassword
  $env:COSMOS_DATABASE_NAME = 'erp-update-scheduler'
  $env:COSMOS_CONNECTION_STRING = $cosmosConnection
  $env:JWT_SECRET = New-EphemeralSecret
  $env:RATE_LIMIT_HASH_SECRET = New-EphemeralSecret
  $env:DEV_AUTH_ENABLED = 'false'
  $env:AUTH_COOKIE_SECURE = 'false'
  $env:AzureWebJobsStorage = 'UseDevelopmentStorage=true'
  foreach ($timer in @(
    'generateDailyUpdateTasks','sendScheduledReminders','sendOverdueAlerts',
    'sendAdministrativeReminders','sendBlockedReminders','processEmailOutbox'
  )) {
    [Environment]::SetEnvironmentVariable("AzureWebJobs.$timer.Disabled",'true','Process')
  }

  Push-Location $apiPath
  try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'The API build failed.' }
    & node scripts/validate-sql-runtime.js
    if ($LASTEXITCODE -ne 0) { throw 'The SQL runtime account validation failed.' }
  } finally { Pop-Location }

  $savedSecrets = @{}
  foreach ($name in $secretNames) {
    $savedSecrets[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  }
  try {
    $escapedFrontendPath = $frontendPath.Replace("'","''")
    Start-Process pwsh -ArgumentList @(
      '-NoExit','-NoLogo','-Command',
      "Set-Location -LiteralPath '$escapedFrontendPath'; npm run dev"
    )
  } finally {
    foreach ($name in $secretNames) {
      [Environment]::SetEnvironmentVariable($name,$savedSecrets[$name],'Process')
    }
  }

  Write-Host ''
  Write-Host 'Connection validated. Starting the API at http://127.0.0.1:7071' -ForegroundColor Green
  Write-Host 'The frontend will be available at http://127.0.0.1:5173'
  Write-Host 'Close this API window to release the SQL and Cosmos credentials.' -ForegroundColor Yellow
  Push-Location $apiPath
  try { & func start }
  finally { Pop-Location }
} finally {
  foreach ($name in $secretNames) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
  foreach ($timer in @(
    'generateDailyUpdateTasks','sendScheduledReminders','sendOverdueAlerts',
    'sendAdministrativeReminders','sendBlockedReminders','processEmailOutbox'
  )) {
    [Environment]::SetEnvironmentVariable("AzureWebJobs.$timer.Disabled",$null,'Process')
  }
  $sqlPassword = $null
  $cosmosConnection = $null
}
