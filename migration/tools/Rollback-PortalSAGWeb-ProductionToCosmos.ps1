[CmdletBinding()]
param(
  [string]$SubscriptionId = 'edbbf624-b155-4c51-ac57-d02424a7234d',
  [string]$ResourceGroup = 'rg-erp-update-scheduler-prod',
  [string]$FunctionApp = 'erpupdsch4645-api',
  [int]$ProbeTimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-AzText([string[]]$Arguments, [string]$FailureMessage) {
  $value = & az @Arguments 2>$null
  if ($LASTEXITCODE -ne 0) { throw $FailureMessage }
  return (@($value) -join "`n").Trim()
}

function Get-ArmToken {
  $token = Invoke-AzText @(
    'account','get-access-token','--resource','https://management.azure.com/',
    '--query','accessToken','--output','tsv','--only-show-errors'
  ) 'Azure did not issue the required access token.'
  if ([string]::IsNullOrWhiteSpace($token)) { throw 'Azure returned an empty access token.' }
  return $token
}

function Invoke-ArmRest([string]$Method, [string]$Uri, [string]$Token, [object]$Body, [string]$FailureMessage) {
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
  foreach ($property in $Properties.PSObject.Properties) { $copy[$property.Name] = [string]$property.Value }
  return $copy
}

function Wait-CosmosStatus {
  $uri = "https://$FunctionApp.azurewebsites.net/api/portal-runtime-status"
  $publicUri = "https://$FunctionApp.azurewebsites.net/api/public/downloads"
  $deadline = [DateTime]::UtcNow.AddSeconds($ProbeTimeoutSeconds)
  do {
    try {
      $status = Invoke-RestMethod -Method Get -Uri $uri -TimeoutSec 20 -Headers @{ 'Cache-Control' = 'no-cache' }
      if ($status.backend -eq 'cosmos' -and $status.sqlConnected -eq $false) {
        $publicStatus = (Invoke-WebRequest -Method Get -Uri $publicUri -UseBasicParsing -TimeoutSec 20).StatusCode
        if ($publicStatus -eq 200) { return $true }
      }
    } catch { }
    Start-Sleep -Seconds 5
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}

Write-Host 'Portal SAG Web - PRODUCTION ROLLBACK TO COSMOS' -ForegroundColor Cyan
Write-Host 'This changes only the runtime selector. SQL data and Key Vault secrets are preserved for investigation.'
Write-Host ''
$confirmation = Read-Host 'Type ROLLBACK PRODUCTION TO COSMOS to continue'
if ($confirmation -cne 'ROLLBACK PRODUCTION TO COSMOS') { throw 'Confirmation did not match; nothing changed.' }

$armToken = $null
try {
  & az account set --subscription $SubscriptionId 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'Azure subscription selection failed.' }
  $armToken = Get-ArmToken
  $siteId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Web/sites/$FunctionApp"
  $settingsUri = "https://management.azure.com$siteId/config/appsettings"
  $current = Invoke-ArmRest 'POST' "${settingsUri}/list?api-version=2023-12-01" $armToken $null 'Could not read the current Function App settings.'
  $settings = Copy-Settings $current.properties
  $settings['DATA_BACKEND'] = 'cosmos'
  $settings['SQL_SECURITY_RUNTIME_ENABLED'] = 'false'
  $null = Invoke-ArmRest 'PUT' "${settingsUri}?api-version=2023-12-01" $armToken @{ properties = $settings } 'Could not set the production backend to Cosmos.'
  & az functionapp restart --resource-group $ResourceGroup --name $FunctionApp --only-show-errors 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'Function App restart failed.' }
  if (-not (Wait-CosmosStatus)) { throw 'Cosmos rollback setting was applied, but the production health probe did not pass in time.' }
  Write-Host 'Rollback verified. Production is serving from Cosmos.' -ForegroundColor Green
} finally {
  $armToken = $null
}
