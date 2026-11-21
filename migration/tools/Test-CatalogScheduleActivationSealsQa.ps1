# Default: parse the fixture locally, without loading a SQL session.
[CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='High')]
param(
  [string]$SessionDirectory,
  [switch]$ExecuteFixtures
)

$ErrorActionPreference='Stop'
$sql=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'qa/catalog_schedule_activation_seals.sql'))
$scriptDom=Get-ChildItem -Path 'C:/Program Files/Microsoft SQL Server Management Studio*' `
  -Filter 'Microsoft.SqlServer.TransactSql.ScriptDom.dll' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if(!$scriptDom){ throw 'SQL Server 2019 ScriptDom parser is not available.' }
Add-Type -Path $scriptDom.FullName
$parser=[Microsoft.SqlServer.TransactSql.ScriptDom.TSql150Parser]::new($true)
$reader=[IO.StringReader]::new($sql)
try { $parseErrors=$null; $null=$parser.Parse($reader,[ref]$parseErrors) } finally { $reader.Dispose() }
if($parseErrors.Count){ throw "Invalid SQL Server 2019 rehearsal syntax at line $($parseErrors[0].Line)." }
if(!$ExecuteFixtures){
  Write-Output 'PASS SQL Server 2019 syntax: activation seal QA fixture; no SQL session used.'
  return
}

if([string]::IsNullOrWhiteSpace($SessionDirectory)){ throw 'Explicit QA session directory required for executing fixtures.' }
$session=(Resolve-Path -LiteralPath $SessionDirectory).Path
$descriptor=Get-Content -Raw -LiteralPath (Join-Path $session 'active.json') | ConvertFrom-Json
if($descriptor.database -cne 'PortalSAGWeb-TEST' -or $descriptor.environment -cne 'qa' -or
    $descriptor.fullControl -isnot [bool] -or !$descriptor.fullControl -or $descriptor.accessLevel -cne 'full-control' -or
    $descriptor.sessionAuthorized -isnot [bool] -or !$descriptor.sessionAuthorized){
  throw 'An authorized full-control session for exact Portal QA is required.'
}
if(!$PSCmdlet.ShouldProcess('PortalSAGWeb-TEST','Run eight synthetic seal assertions in rollback-only transactions')){ return }
$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
try {
  $result=(& $invoke -SessionDirectory $session -Sql $sql -Mode write -TimeoutSeconds 90 -MaxRows 1) | ConvertFrom-Json -Depth 12
} catch { throw 'QA did not confirm the activation seal fixture.' }
if($result.success -ne $true -or @($result.resultSets).Count -ne 1 -or
  @($result.resultSets[0].rows).Count -ne 1 -or $result.resultSets[0].truncated){
  throw 'QA did not confirm the activation seal fixture.'
}
$row=$result.resultSets[0].rows[0]
if($row.targetDatabase -cne 'PortalSAGWeb-TEST' -or $row.passed -ne 8 -or $row.rolledBack -ne $true){
  throw 'QA did not return all eight seal assertions with rollback.'
}
Write-Output 'PASS QA: 8 activation seal assertions; synthetic rows rolled back.'
