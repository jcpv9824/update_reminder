[CmdletBinding()]
param(
  [string]$SubscriptionId = 'edbbf624-b155-4c51-ac57-d02424a7234d',
  [string]$ResourceGroup = 'rg-erp-update-scheduler-prod',
  [string]$FunctionApp = 'erpupdsch4645-api',
  [int]$ProbeTimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$timerNames = @(
  'generateDailyUpdateTasks',
  'sendScheduledReminders',
  'sendOverdueAlerts',
  'sendAdministrativeReminders',
  'sendBlockedReminders',
  'processEmailOutbox'
)

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

function Invoke-ArmRest(
  [string]$Method,
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
  if ($null -ne $Body) {
    $parameters.Body = ($Body | ConvertTo-Json -Depth 20 -Compress)
  }
  try { return Invoke-RestMethod @parameters }
  catch { throw $FailureMessage }
}

function Copy-Settings([object]$Properties) {
  $copy = [ordered]@{}
  foreach ($property in $Properties.PSObject.Properties) {
    $copy[$property.Name] = [string]$property.Value
  }
  return $copy
}

function Restart-FunctionApp {
  & az functionapp restart `
    --resource-group $ResourceGroup `
    --name $FunctionApp `
    --only-show-errors 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'Function App restart failed.' }
}

function Wait-MaintenanceStatus {
  $statusUri = "https://$FunctionApp.azurewebsites.net/api/portal-runtime-status"
  $mutationProbeUri = "https://$FunctionApp.azurewebsites.net/api/portal-maintenance-mutation-probe"
  $deadline = [DateTime]::UtcNow.AddSeconds($ProbeTimeoutSeconds)
  do {
    try {
      $status = Invoke-RestMethod `
        -Method Get `
        -Uri $statusUri `
        -TimeoutSec 20 `
        -Headers @{ 'Cache-Control' = 'no-cache' }
      $mutationProbe = Invoke-WebRequest `
        -Method Post `
        -Uri $mutationProbeUri `
        -UseBasicParsing `
        -SkipHttpErrorCheck `
        -TimeoutSec 20
      $probeBody = $mutationProbe.Content | ConvertFrom-Json
      if ($status.backend -eq 'dual-read' -and
          $status.sqlConnected -eq $true -and
          $status.sqlSecurityEnabled -eq $false -and
          $status.maintenanceMode -eq $true -and
          $status.timerDisableState -eq 'all' -and
          $mutationProbe.StatusCode -eq 503 -and
          $probeBody.code -eq 'PORTAL_MAINTENANCE') {
        return $true
      }
    }
    catch { }
    Start-Sleep -Seconds 5
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}

Write-Host 'Portal SAG Web - ENTER PRODUCTION MAINTENANCE' -ForegroundColor Cyan
Write-Host 'This blocks every mutating HTTP request and all six timers while keeping read-only routes available.'
Write-Host 'The backend remains dual-read; Cosmos is still the source of truth.'
Write-Host 'A failed maintenance probe automatically restores the previous Function App settings.'
Write-Host

$confirmation = Read-Host 'Type ENTER PRODUCTION MAINTENANCE to continue'
if ($confirmation -cne 'ENTER PRODUCTION MAINTENANCE') {
  throw 'Confirmation did not match; nothing changed.'
}

$armToken = $null
$previousSettings = $null
$settingsUri = $null
try {
  & az account set --subscription $SubscriptionId 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'Azure subscription selection failed.' }

  $armToken = Get-ArmToken
  $siteId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Web/sites/$FunctionApp"
  $settingsUri = "https://management.azure.com$siteId/config/appsettings"
  $current = Invoke-ArmRest `
    'POST' `
    "${settingsUri}/list?api-version=2023-12-01" `
    $armToken `
    $null `
    'Could not read the current Function App settings.'
  $previousSettings = Copy-Settings $current.properties

  if ($previousSettings['DATA_BACKEND'] -ne 'dual-read' -or
      $previousSettings['SQL_SECURITY_RUNTIME_ENABLED'] -ne 'false') {
    throw 'Maintenance entry requires production to be healthy in dual-read with SQL security disabled.'
  }

  $nextSettings = [ordered]@{}
  foreach ($key in $previousSettings.Keys) {
    $nextSettings[$key] = $previousSettings[$key]
  }
  $nextSettings['PORTAL_MAINTENANCE_MODE'] = 'true'
  foreach ($timerName in $timerNames) {
    $nextSettings["AzureWebJobs.$timerName.Disabled"] = 'true'
  }

  $null = Invoke-ArmRest `
    'PUT' `
    "${settingsUri}?api-version=2023-12-01" `
    $armToken `
    @{ properties = $nextSettings } `
    'Azure did not accept the production maintenance settings.'
  Restart-FunctionApp

  if (-not (Wait-MaintenanceStatus)) {
    throw 'Production maintenance settings were applied, but the safety probes did not pass.'
  }

  Write-Host 'Production maintenance is active and verified.' -ForegroundColor Green
  Write-Host 'Mutations return HTTP 503; all six timers are disabled; read-only routes remain available.'
}
catch {
  $failure = $_
  if ($null -ne $previousSettings -and $null -ne $settingsUri -and $null -ne $armToken) {
    try {
      $null = Invoke-ArmRest `
        'PUT' `
        "${settingsUri}?api-version=2023-12-01" `
        $armToken `
        @{ properties = $previousSettings } `
        'Could not restore the previous Function App settings.'
      Restart-FunctionApp
    }
    catch {
      throw 'Maintenance entry failed and automatic restoration also failed. Treat this as an incident.'
    }
  }
  throw $failure
}
finally {
  $armToken = $null
  $previousSettings = $null
}
