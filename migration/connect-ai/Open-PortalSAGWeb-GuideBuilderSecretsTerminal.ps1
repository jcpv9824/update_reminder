[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$launcher = Join-Path $PSScriptRoot 'Open-PortalSAGWeb-GuideBuilderSecrets.cmd'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
  throw "Required Guide Builder secret launcher was not found: $launcher"
}

Start-Process -FilePath $launcher -WorkingDirectory $PSScriptRoot
Write-Host 'The visible Guide Builder secret terminal was opened.' -ForegroundColor Green
