[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$connectAiDirectory = $PSScriptRoot
$sqlDirectory = Join-Path (Split-Path $connectAiDirectory -Parent) 'connect-sql-server'

$launchers = @(
  @{
    Path = Join-Path $connectAiDirectory 'Open-PortalSAGWeb-GuideOpenAISecret.cmd'
    WorkingDirectory = $connectAiDirectory
  },
  @{
    Path = Join-Path $connectAiDirectory 'Open-PortalSAGWeb-GuideSqlRuntimeSecret.cmd'
    WorkingDirectory = $connectAiDirectory
  },
  @{
    Path = Join-Path $sqlDirectory 'Open-PortalSAGWeb-FullControl.cmd'
    WorkingDirectory = $sqlDirectory
  }
)

foreach ($launcher in $launchers) {
  if (-not (Test-Path -LiteralPath $launcher.Path -PathType Leaf)) {
    throw "Required access launcher was not found: $($launcher.Path)"
  }

  Start-Process `
    -FilePath $launcher.Path `
    -WorkingDirectory $launcher.WorkingDirectory
}

Write-Host 'Three visible Portal SAG Web access terminals were opened.' -ForegroundColor Green
