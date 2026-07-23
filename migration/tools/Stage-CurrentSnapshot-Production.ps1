[CmdletBinding()]
param(
  [string]$Username = 'SAGWebDev'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$serverName = 'data14.sagerp.co,54103'
$databaseName = 'PortalSAGWeb'
$snapshotDirectory = Join-Path $PSScriptRoot '..\backups\cosmos-export-prod-20260722-155753'
$importerPath = Join-Path $PSScriptRoot 'Import-CosmosSnapshot-RawStage.ps1'
$securePassword = $null
$credential = $null

Write-Host 'Portal SAG Web - PRODUCTION CURRENT SNAPSHOT STAGING' -ForegroundColor Cyan
Write-Host 'This adds one validated raw/staging migration run only.' -ForegroundColor White
Write-Host 'Operational tables, Blob Storage, application settings and database permissions are not modified.' -ForegroundColor Yellow
Write-Host 'Cosmos remains the production response and write source.' -ForegroundColor Yellow
Write-Host
Write-Host "Server:   $serverName"
Write-Host "Database: $databaseName"
Write-Host 'Snapshot contract: 17 containers, 2987 documents, 0 critical errors, 464 reviewed warnings.'
Write-Host

try {
  $enteredUsername = Read-Host "SQL Authentication migration username [$Username]"
  if (-not [string]::IsNullOrWhiteSpace($enteredUsername)) {
    $Username = $enteredUsername.Trim()
  }
  if ([string]::IsNullOrWhiteSpace($Username)) {
    throw 'The SQL Authentication username is required.'
  }

  $securePassword = Read-Host 'SQL Authentication password' -AsSecureString
  if (-not $securePassword.IsReadOnly()) {
    $securePassword.MakeReadOnly()
  }
  $credential = [PSCredential]::new($Username, $securePassword)

  & $importerPath `
    -SnapshotDirectory $snapshotDirectory `
    -SourceEnvironment production `
    -Apply `
    -TargetEnvironment production-stage `
    -ServerName $serverName `
    -DatabaseName $databaseName `
    -Credential $credential `
    -AcceptKnownWarnings
}
finally {
  $credential = $null
  if ($null -ne $securePassword) {
    $securePassword.Dispose()
    $securePassword = $null
  }
}
