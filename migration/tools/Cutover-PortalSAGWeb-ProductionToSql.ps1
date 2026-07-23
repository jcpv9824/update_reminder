[CmdletBinding()]
param(
  [string]$SubscriptionId = 'edbbf624-b155-4c51-ac57-d02424a7234d',
  [string]$ResourceGroup = 'rg-erp-update-scheduler-prod',
  [string]$FunctionApp = 'erpupdsch4645-api',
  [int]$ProbeTimeoutSeconds = 240
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$expectedSubscription = 'edbbf624-b155-4c51-ac57-d02424a7234d'
$expectedResourceGroup = 'rg-erp-update-scheduler-prod'
$expectedFunctionApp = 'erpupdsch4645-api'
$expectedBlobAccountUrl = 'https://sagwebiastorage.blob.core.windows.net'
$expectedBlobContainer = 'portal-sag-content'
$baseUri = "https://$FunctionApp.azurewebsites.net/api"
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
  ) 'Azure did not issue the required management token.'
  if ([string]::IsNullOrWhiteSpace($token)) {
    throw 'Azure returned an empty management token.'
  }
  return $token
}

function Invoke-ArmRest(
  [ValidateSet('POST','PUT')][string]$Method,
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
  try {
    return Invoke-RestMethod @parameters
  }
  catch {
    throw $FailureMessage
  }
}

function Copy-Settings([object]$Properties) {
  $copy = [ordered]@{}
  foreach ($property in $Properties.PSObject.Properties) {
    $copy[$property.Name] = [string]$property.Value
  }
  return $copy
}

function Copy-SettingsMap([System.Collections.IDictionary]$Settings) {
  $copy = [ordered]@{}
  foreach ($key in $Settings.Keys) {
    $copy[[string]$key] = [string]$Settings[$key]
  }
  return $copy
}

function Restart-FunctionApp {
  & az functionapp restart `
    --resource-group $ResourceGroup `
    --name $FunctionApp `
    --only-show-errors 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw 'Function App restart failed.'
  }
}

function Get-RuntimeStatus {
  return Invoke-RestMethod `
    -Method Get `
    -Uri "$baseUri/portal-runtime-status" `
    -TimeoutSec 20 `
    -Headers @{ 'Cache-Control' = 'no-cache' }
}

function Test-RuntimeStatus(
  [object]$Status,
  [string]$Backend,
  [bool]$SqlConnected,
  [bool]$SqlSecurityEnabled,
  [bool]$MaintenanceMode,
  [string]$TimerDisableState
) {
  return $Status.backend -eq $Backend -and
    $Status.sqlConnected -eq $SqlConnected -and
    $Status.sqlSecurityEnabled -eq $SqlSecurityEnabled -and
    $Status.maintenanceMode -eq $MaintenanceMode -and
    $Status.timerDisableState -eq $TimerDisableState
}

function Wait-ExpectedRuntime(
  [string]$Backend,
  [bool]$SqlConnected,
  [bool]$SqlSecurityEnabled,
  [bool]$MaintenanceMode,
  [string]$TimerDisableState
) {
  $deadline = [DateTime]::UtcNow.AddSeconds($ProbeTimeoutSeconds)
  do {
    try {
      $status = Get-RuntimeStatus
      if (Test-RuntimeStatus $status $Backend $SqlConnected $SqlSecurityEnabled $MaintenanceMode $TimerDisableState) {
        return $true
      }
    }
    catch { }
    Start-Sleep -Seconds 5
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}

function Invoke-StatusProbe([string]$RelativePath, [int[]]$ExpectedStatusCodes) {
  $response = Invoke-WebRequest `
    -Method Get `
    -Uri "$baseUri/$RelativePath" `
    -UseBasicParsing `
    -SkipHttpErrorCheck `
    -TimeoutSec 30 `
    -MaximumRedirection 0
  if ($response.StatusCode -notin $ExpectedStatusCodes) {
    throw "The $RelativePath probe returned an unexpected HTTP status."
  }
  return $response
}

function Test-PublicAndSecurityRoutes([switch]$IncludeBlobDownload) {
  $downloadsResponse = Invoke-StatusProbe 'public/downloads' @(200)
  $null = Invoke-StatusProbe 'public/fuentes-formatos' @(200)
  $null = Invoke-StatusProbe 'public/formatos-impresion' @(200)
  $null = Invoke-StatusProbe 'users' @(401)

  if ($IncludeBlobDownload) {
    try {
      $sections = $downloadsResponse.Content | ConvertFrom-Json
      $firstDocument = @($sections | ForEach-Object { @($_.documents) } | Where-Object { $null -ne $_ }) |
        Select-Object -First 1
      if ($null -eq $firstDocument -or [string]::IsNullOrWhiteSpace([string]$firstDocument.downloadUrl)) {
        throw 'No active public asset was available for the Blob-backed download probe.'
      }
      $assetVerified = $false
      for ($attempt = 1; $attempt -le 3 -and -not $assetVerified; $attempt++) {
        try {
          $assetResponse = Invoke-WebRequest `
            -Method Get `
            -Uri ("https://$FunctionApp.azurewebsites.net" + [string]$firstDocument.downloadUrl) `
            -UseBasicParsing `
            -TimeoutSec 60 `
            -MaximumRedirection 5
          $assetVerified = $assetResponse.StatusCode -eq 200 -and
            $null -ne $assetResponse.Content -and
            $assetResponse.Content.Length -gt 0
        }
        catch {
          $assetVerified = $false
        }
        if (-not $assetVerified -and $attempt -lt 3) {
          Start-Sleep -Seconds 3
        }
      }
      if (-not $assetVerified) {
        throw 'The Blob-backed public asset did not return file content after three attempts.'
      }
    }
    catch {
      if ($_.Exception.Message -eq 'No active public asset was available for the Blob-backed download probe.') {
        throw $_
      }
      throw 'The Blob-backed public asset request failed after three attempts.'
    }
  }
}

function Test-MaintenanceMutationBlock {
  $response = Invoke-WebRequest `
    -Method Post `
    -Uri "$baseUri/portal-maintenance-mutation-probe" `
    -UseBasicParsing `
    -SkipHttpErrorCheck `
    -TimeoutSec 30
  if ($response.StatusCode -ne 503) {
    throw 'The maintenance mutation probe was not blocked with HTTP 503.'
  }
  try {
    $body = $response.Content | ConvertFrom-Json
  }
  catch {
    throw 'The maintenance mutation probe did not return the expected JSON response.'
  }
  if ($body.code -ne 'PORTAL_MAINTENANCE') {
    throw 'The maintenance mutation probe did not return PORTAL_MAINTENANCE.'
  }
}

function Set-FunctionSettings(
  [System.Collections.IDictionary]$Settings,
  [string]$FailureMessage
) {
  $null = Invoke-ArmRest `
    'PUT' `
    "${script:settingsUri}?api-version=2023-12-01" `
    $script:armToken `
    @{ properties = $Settings } `
    $FailureMessage
}

function Restore-PreviousSettings {
  if ($null -eq $script:previousSettings) {
    throw 'No previous settings were available for automatic restoration.'
  }
  Set-FunctionSettings $script:previousSettings 'Automatic rollback could not restore the previous Function App settings.'
  Restart-FunctionApp
  if (-not (Wait-ExpectedRuntime 'dual-read' $true $false $false 'none')) {
    throw 'Previous settings were restored, but the original dual-read health state did not recover.'
  }
  Test-PublicAndSecurityRoutes
}

Write-Host 'Portal SAG Web - PRODUCTION SQL CUTOVER' -ForegroundColor Cyan
Write-Host 'This switches the production runtime from dual-read/Cosmos writes to SQL reads and writes.'
Write-Host 'The controller first enables maintenance and disables all timers, validates SQL and private Blob reads, then resumes service.'
Write-Host 'Any failed gate automatically restores the exact previous Function App settings and verifies dual-read recovery.'
Write-Host 'No credentials, connection strings, secret values, document values, IDs, or file names are printed or stored.'
Write-Host

if ($SubscriptionId -cne $expectedSubscription -or
    $ResourceGroup -cne $expectedResourceGroup -or
    $FunctionApp -cne $expectedFunctionApp) {
  throw 'The requested Azure target does not match the reviewed Portal SAG Web production target.'
}

$confirmation = Read-Host 'Type CUTOVER PRODUCTION TO SQL to continue'
if ($confirmation -cne 'CUTOVER PRODUCTION TO SQL') {
  throw 'Confirmation did not match; nothing changed.'
}

$script:armToken = $null
$script:previousSettings = $null
$script:settingsUri = $null
$settingsChanged = $false

try {
  & az account set --subscription $SubscriptionId 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw 'Azure subscription selection failed.'
  }

  $script:armToken = Get-ArmToken
  $siteId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Web/sites/$FunctionApp"
  $script:settingsUri = "https://management.azure.com$siteId/config/appsettings"
  $current = Invoke-ArmRest `
    'POST' `
    "$($script:settingsUri)/list?api-version=2023-12-01" `
    $script:armToken `
    $null `
    'Could not read the current Function App settings.'
  $script:previousSettings = Copy-Settings $current.properties

  if ($script:previousSettings['DATA_BACKEND'] -cne 'dual-read' -or
      $script:previousSettings['SQL_SECURITY_RUNTIME_ENABLED'] -cne 'false' -or
      ($script:previousSettings.Contains('PORTAL_MAINTENANCE_MODE') -and
        $script:previousSettings['PORTAL_MAINTENANCE_MODE'] -cne 'false') -or
      $script:previousSettings['PUBLIC_DOWNLOADS_STORAGE_ACCOUNT_URL'] -cne $expectedBlobAccountUrl -or
      $script:previousSettings['PUBLIC_DOWNLOADS_STORAGE_CONTAINER'] -cne $expectedBlobContainer) {
    throw 'Production settings do not match the reviewed healthy dual-read and private Blob preflight.'
  }
  foreach ($timerName in $timerNames) {
    if ($script:previousSettings.Contains("AzureWebJobs.$timerName.Disabled")) {
      throw 'At least one production timer is already disabled; resolve the unexpected state before cutover.'
    }
  }
  $preflight = Get-RuntimeStatus
  if (-not (Test-RuntimeStatus $preflight 'dual-read' $true $false $false 'none')) {
    throw 'Production runtime is not healthy in the required dual-read preflight state.'
  }
  Test-PublicAndSecurityRoutes
  Write-Host 'Dual-read, public routes, protected route and private Blob configuration preflight passed.' -ForegroundColor Green

  $maintenanceSettings = Copy-SettingsMap $script:previousSettings
  $maintenanceSettings['DATA_BACKEND'] = 'sql'
  $maintenanceSettings['SQL_SECURITY_RUNTIME_ENABLED'] = 'true'
  $maintenanceSettings['PORTAL_MAINTENANCE_MODE'] = 'true'
  foreach ($timerName in $timerNames) {
    $maintenanceSettings["AzureWebJobs.$timerName.Disabled"] = 'true'
  }

  Write-Host 'Enabling SQL under production maintenance and stopping all six timers...'
  Set-FunctionSettings $maintenanceSettings 'Azure did not accept the guarded SQL cutover settings.'
  $settingsChanged = $true
  Restart-FunctionApp
  if (-not (Wait-ExpectedRuntime 'sql' $true $true $true 'all')) {
    throw 'The guarded SQL runtime did not reach the expected maintenance state.'
  }
  Test-MaintenanceMutationBlock
  Test-PublicAndSecurityRoutes -IncludeBlobDownload
  Write-Host 'Guarded SQL smoke passed: maintenance block, SQL security, public catalogs and private Blob file read.' -ForegroundColor Green

  $finalSettings = Copy-SettingsMap $maintenanceSettings
  $finalSettings['PORTAL_MAINTENANCE_MODE'] = 'false'
  foreach ($timerName in $timerNames) {
    $null = $finalSettings.Remove("AzureWebJobs.$timerName.Disabled")
  }

  Write-Host 'Resuming production service and all six SQL-backed timers...'
  Set-FunctionSettings $finalSettings 'Azure did not accept the final SQL production settings.'
  Restart-FunctionApp
  if (-not (Wait-ExpectedRuntime 'sql' $true $true $false 'none')) {
    throw 'The final SQL runtime did not reach the expected production state.'
  }
  Test-PublicAndSecurityRoutes -IncludeBlobDownload

  Write-Host
  Write-Host 'PRODUCTION SQL CUTOVER SUCCEEDED.' -ForegroundColor Green
  Write-Host 'SQL is the active read/write backend, SQL authorization is enforced, maintenance is off and all six timers are enabled.'
  Write-Host 'Private Blob-backed public assets and unauthenticated security boundaries passed their production probes.'
}
catch {
  $failure = $_.Exception.Message
  if ($settingsChanged) {
    Write-Host 'A cutover gate failed. Restoring the exact previous production settings...' -ForegroundColor Yellow
    try {
      Restore-PreviousSettings
      Write-Host 'Automatic rollback succeeded. Production is healthy in its original dual-read state.' -ForegroundColor Green
    }
    catch {
      throw "SQL cutover failed and automatic rollback requires immediate operator review. Original failure: $failure"
    }
  }
  throw $failure
}
finally {
  $script:armToken = $null
  $script:previousSettings = $null
  $script:settingsUri = $null
}
