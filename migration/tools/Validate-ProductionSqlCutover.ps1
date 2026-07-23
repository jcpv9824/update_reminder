[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'Cutover-PortalSAGWeb-ProductionToSql.ps1'
$launcherPath = Join-Path $PSScriptRoot 'Run-Production-Cutover-To-Sql.cmd'

if (-not (Test-Path -LiteralPath $scriptPath)) {
  throw 'The production SQL cutover controller is missing.'
}
if (-not (Test-Path -LiteralPath $launcherPath)) {
  throw 'The production SQL cutover launcher is missing.'
}

$script = Get-Content -Raw -LiteralPath $scriptPath
$launcher = Get-Content -Raw -LiteralPath $launcherPath

$requiredPatterns = @(
  "edbbf624-b155-4c51-ac57-d02424a7234d",
  "rg-erp-update-scheduler-prod",
  "erpupdsch4645-api",
  "CUTOVER PRODUCTION TO SQL",
  "DATA_BACKEND",
  "'sql'",
  "SQL_SECURITY_RUNTIME_ENABLED",
  "PORTAL_MAINTENANCE_MODE",
  "AzureWebJobs.`$timerName.Disabled",
  "generateDailyUpdateTasks",
  "sendScheduledReminders",
  "sendOverdueAlerts",
  "sendAdministrativeReminders",
  "sendBlockedReminders",
  "processEmailOutbox",
  "portal-runtime-status",
  "portal-maintenance-mutation-probe",
  "PORTAL_MAINTENANCE",
  "public/downloads",
  "public/fuentes-formatos",
  "public/formatos-impresion",
  "Invoke-StatusProbe 'users' @(401)",
  "PUBLIC_DOWNLOADS_STORAGE_ACCOUNT_URL",
  "https://sagwebiastorage.blob.core.windows.net",
  "PUBLIC_DOWNLOADS_STORAGE_CONTAINER",
  "portal-sag-content",
  "previousSettings",
  "Restore-PreviousSettings",
  "Wait-ExpectedRuntime"
)

foreach ($pattern in $requiredPatterns) {
  if (-not $script.Contains($pattern)) {
    throw "Production SQL cutover safety contract is missing: $pattern"
  }
}

foreach ($forbidden in @(
  'ALTER ROLE',
  'DROP MEMBER',
  'REVOKE CONTROL',
  'DENY CONTROL',
  'Repurpose-SAGWebDev-As-PortalRuntime'
)) {
  if ($script.IndexOf($forbidden, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
    throw "Production SQL cutover contains a forbidden permission downgrade: $forbidden"
  }
}

if (-not $script.Contains('$null = $finalSettings.Remove("AzureWebJobs.$timerName.Disabled")')) {
  throw 'The final cutover phase must remove timer-disable settings instead of leaving them set.'
}

if (-not $launcher.Contains('Cutover-PortalSAGWeb-ProductionToSql.ps1')) {
  throw 'The launcher does not invoke the production SQL cutover controller.'
}

Write-Host 'PASS production SQL cutover: exact target, maintenance/timer gates, SQL security, public/Blob probes, automatic restoration and no permission downgrade.' -ForegroundColor Green
