[CmdletBinding()]
param(
  [string]$SubscriptionId = 'edbbf624-b155-4c51-ac57-d02424a7234d',
  [string]$ResourceGroup = 'rg-erp-update-scheduler-prod',
  [string]$FunctionApp = 'erpupdsch4645-api',
  [string]$KeyVaultName = 'erpupdsch4645-kv',
  [string]$SqlServer = 'data14.sagerp.co,54103',
  [string]$SqlDatabase = 'PortalSAGWeb',
  [string]$SqlUsername = 'SAGWebDev',
  [int]$ProbeTimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-AzText([string[]]$Arguments, [string]$FailureMessage) {
  $value = & az @Arguments 2>$null
  if ($LASTEXITCODE -ne 0) { throw $FailureMessage }
  return (@($value) -join "`n").Trim()
}

function Get-AzureToken([string]$Resource) {
  $token = Invoke-AzText @(
    'account','get-access-token','--resource',$Resource,
    '--query','accessToken','--output','tsv','--only-show-errors'
  ) 'Azure did not issue the required access token.'
  if ([string]::IsNullOrWhiteSpace($token)) { throw 'Azure returned an empty access token.' }
  return $token
}

function Invoke-SafeRest(
  [ValidateSet('GET','POST','PUT')][string]$Method,
  [string]$Uri,
  [string]$Token,
  [object]$Body,
  [string]$FailureMessage
) {
  $parameters = @{
    Method = $Method
    Uri = $Uri
    Headers = @{ Authorization = "Bearer $Token" }
    ContentType = 'application/json'
  }
  if ($null -ne $Body) { $parameters.Body = ($Body | ConvertTo-Json -Depth 20 -Compress) }
  try { return Invoke-RestMethod @parameters }
  catch { throw $FailureMessage }
}

function Copy-Settings([object]$Properties) {
  $copy = [ordered]@{}
  if ($null -ne $Properties) {
    foreach ($property in $Properties.PSObject.Properties) { $copy[$property.Name] = [string]$property.Value }
  }
  return $copy
}

function Test-SqlRuntimeAccount([Security.SecureString]$Password) {
  if (-not $Password.IsReadOnly()) { $Password.MakeReadOnly() }
  $connectionString = "Server=tcp:$SqlServer;Database=$SqlDatabase;Encrypt=True;TrustServerCertificate=False;Connect Timeout=15;Application Name=PortalSAGWeb-ProductionDualRead-Preflight;"
  $credential = [System.Data.SqlClient.SqlCredential]::new($SqlUsername, $Password)
  $connection = [System.Data.SqlClient.SqlConnection]::new($connectionString, $credential)
  try {
    $connection.Open()
    $command = $connection.CreateCommand()
    $command.CommandText = @'
SELECT
  DB_NAME() AS database_name,
  CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS major_version,
  d.compatibility_level,
  d.collation_name,
  ISNULL(IS_ROLEMEMBER(N'portal_runtime'), 0) AS is_runtime,
  ISNULL(IS_ROLEMEMBER(N'db_owner'), 0) AS is_owner,
  ISNULL(IS_ROLEMEMBER(N'db_ddladmin'), 0) AS is_ddladmin
FROM sys.databases d
WHERE d.database_id = DB_ID();
'@
    $reader = $command.ExecuteReader()
    if (-not $reader.Read()) { throw 'SQL validation returned no row.' }
    $valid = [string]$reader['database_name'] -eq 'PortalSAGWeb' -and
      [int]$reader['major_version'] -eq 15 -and
      [int]$reader['compatibility_level'] -eq 150 -and
      [string]$reader['collation_name'] -eq 'Modern_Spanish_CI_AS' -and
      [int]$reader['is_runtime'] -eq 1 -and
      [int]$reader['is_owner'] -eq 0 -and
      [int]$reader['is_ddladmin'] -eq 0
    $reader.Close()
    if (-not $valid) { throw 'The SQL account does not match the certified least-privilege runtime contract.' }
  } finally {
    $connection.Dispose()
  }
}

function Wait-RuntimeStatus([string]$ExpectedBackend) {
  $uri = "https://$FunctionApp.azurewebsites.net/api/portal-runtime-status"
  $publicUri = "https://$FunctionApp.azurewebsites.net/api/public/downloads"
  $deadline = [DateTime]::UtcNow.AddSeconds($ProbeTimeoutSeconds)
  do {
    try {
      $status = Invoke-RestMethod -Method Get -Uri $uri -TimeoutSec 20 -Headers @{ 'Cache-Control' = 'no-cache' }
      if ($status.backend -eq $ExpectedBackend -and
          ($ExpectedBackend -eq 'cosmos' -or $status.sqlConnected -eq $true)) {
        $publicStatus = (Invoke-WebRequest -Method Get -Uri $publicUri -UseBasicParsing -TimeoutSec 20).StatusCode
        if ($publicStatus -eq 200) { return $true }
      }
    } catch { }
    Start-Sleep -Seconds 5
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}

Write-Host 'Portal SAG Web - PRODUCTION DUAL-READ ENABLEMENT' -ForegroundColor Cyan
Write-Host 'Cosmos remains the response/write source. SQL receives read-only shadow queries.'
Write-Host 'The SQL password is stored only in Azure Key Vault and is never printed or written locally.'
Write-Host 'Any failed production health probe automatically restores the previous Function App settings.'
Write-Host ''

$confirmation = Read-Host 'Type ENABLE PRODUCTION DUAL READ to continue'
if ($confirmation -cne 'ENABLE PRODUCTION DUAL READ') { throw 'Confirmation did not match; nothing changed.' }

$sqlPassword = Read-Host 'SQL runtime password' -AsSecureString
if (-not $sqlPassword.IsReadOnly()) { $sqlPassword.MakeReadOnly() }
$plainPassword = $null
$armToken = $null
$vaultToken = $null
$previousSettings = $null
$settingsChanged = $false

try {
  Write-Host 'Validating the SQL runtime account locally with strict TLS...'
  Test-SqlRuntimeAccount $sqlPassword
  Write-Host 'SQL least-privilege preflight passed.' -ForegroundColor Green

  & az account set --subscription $SubscriptionId 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'Azure subscription selection failed.' }
  $armToken = Get-AzureToken 'https://management.azure.com/'
  $vaultToken = Get-AzureToken 'https://vault.azure.net'

  $siteId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Web/sites/$FunctionApp"
  $settingsUri = "https://management.azure.com$siteId/config/appsettings"
  $currentResponse = Invoke-SafeRest 'POST' "${settingsUri}/list?api-version=2023-12-01" $armToken $null 'Could not read the current Function App settings.'
  $previousSettings = Copy-Settings $currentResponse.properties
  $nextSettings = Copy-Settings $currentResponse.properties

  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sqlPassword)
  try { $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }

  $secretName = 'portal-sag-sql-runtime-password'
  $secretUri = "https://${KeyVaultName}.vault.azure.net/secrets/${secretName}?api-version=7.4"
  $secretResponse = Invoke-SafeRest 'PUT' $secretUri $vaultToken @{
    value = $plainPassword
    attributes = @{ enabled = $true }
    tags = @{ purpose = 'Portal SAG Web SQL runtime'; managedBy = 'production dual-read launcher' }
  } 'Azure Key Vault did not accept the SQL runtime secret.'
  $plainPassword = $null

  $nextSettings['DATA_BACKEND'] = 'dual-read'
  $nextSettings['SQL_SECURITY_RUNTIME_ENABLED'] = 'false'
  $nextSettings['SQL_SERVER_HOST'] = $SqlServer
  $nextSettings['SQL_DATABASE'] = $SqlDatabase
  $nextSettings['SQL_USERNAME'] = $SqlUsername
  $nextSettings['SQL_PASSWORD'] = "@Microsoft.KeyVault(SecretUri=$($secretResponse.id))"
  $nextSettings['SQL_CONNECTION_TIMEOUT_MS'] = '15000'
  $nextSettings['SQL_REQUEST_TIMEOUT_MS'] = '30000'
  $nextSettings['SQL_POOL_MAX'] = '10'

  $null = Invoke-SafeRest 'PUT' "${settingsUri}?api-version=2023-12-01" $armToken @{ properties = $nextSettings } 'Could not update the Function App settings.'
  $settingsChanged = $true
  & az functionapp restart --resource-group $ResourceGroup --name $FunctionApp --only-show-errors 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'Function App restart failed.' }

  Write-Host 'Waiting for the production dual-read health probe...'
  if (-not (Wait-RuntimeStatus 'dual-read')) { throw 'Production did not pass the dual-read health probe.' }
  Write-Host 'Production dual-read is healthy. Cosmos remains authoritative.' -ForegroundColor Green
} catch {
  $failure = $_.Exception.Message
  if ($settingsChanged -and $null -ne $previousSettings -and $null -ne $armToken) {
    Write-Host 'Health gate failed. Restoring the previous production settings...' -ForegroundColor Yellow
    try {
      $siteId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Web/sites/$FunctionApp"
      $settingsUri = "https://management.azure.com$siteId/config/appsettings"
      $null = Invoke-SafeRest 'PUT' "${settingsUri}?api-version=2023-12-01" $armToken @{ properties = $previousSettings } 'Automatic rollback could not restore Function App settings.'
      & az functionapp restart --resource-group $ResourceGroup --name $FunctionApp --only-show-errors 2>$null
      Write-Host 'Previous settings restored. Cosmos remains the production backend.' -ForegroundColor Green
    } catch {
      throw "Dual-read failed and automatic rollback requires immediate operator review. Original failure: $failure"
    }
  }
  throw $failure
} finally {
  $plainPassword = $null
  $armToken = $null
  $vaultToken = $null
  $sqlPassword = $null
}
