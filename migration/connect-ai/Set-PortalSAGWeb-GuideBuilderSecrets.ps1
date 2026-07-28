[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$openAiScript = Join-Path $PSScriptRoot 'Set-PortalSAGWeb-GuideOpenAISecret.ps1'
$sqlScript = Join-Path $PSScriptRoot 'Set-PortalSAGWeb-GuideSqlRuntimeSecret.ps1'

Write-Host ''
Write-Host 'Portal SAG Web - GUIDE BUILDER SECRETS' -ForegroundColor Cyan
Write-Host 'This terminal requests exactly two values: the OpenAI API key and the existing SAGWebDev SQL password.'
Write-Host 'Both values are sent directly to the isolated Azure Key Vault and are never printed or written locally.'
Write-Host ''

& $openAiScript
& $sqlScript

$statusDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) 'work\guide-builder-access'
$statusPath = Join-Path $statusDirectory 'secrets-ready.json'
$null = New-Item -ItemType Directory -Path $statusDirectory -Force

[ordered]@{
  version = 1
  vault = 'erpupdsch4645-guide-kv'
  openAiSecretPresent = $true
  sqlRuntimeSecretPresent = $true
  verifiedAtUtc = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding UTF8

Write-Host ''
Write-Host 'Both Guide Builder secrets were stored successfully.' -ForegroundColor Green
