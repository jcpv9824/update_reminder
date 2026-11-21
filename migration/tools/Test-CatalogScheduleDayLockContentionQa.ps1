# Default is local syntax validation. No persistent fixture rows are needed.
[CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='High')]
param(
  [string]$HolderSessionDirectory,
  [string]$ObserverSessionDirectory,
  [switch]$ExecuteContention
)
$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'qa/catalog_schedule_day_lock_contention.sql'))
$dom=Get-ChildItem -Path 'C:/Program Files/Microsoft SQL Server Management Studio*' `
  -Filter 'Microsoft.SqlServer.TransactSql.ScriptDom.dll' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if(!$dom){ throw 'SQL Server 2019 ScriptDom parser is not available.' }
Add-Type -Path $dom.FullName
$parser=[Microsoft.SqlServer.TransactSql.ScriptDom.TSql150Parser]::new($true)
$fixtureReader=[IO.StringReader]::new("DECLARE @fixtureMode varchar(1)='P',@daysAgo smallint=432;`n"+$source)
try { $issues=$null; $null=$parser.Parse($fixtureReader,[ref]$issues) } finally { $fixtureReader.Dispose() }
if($issues.Count){ throw "Invalid SQL Server 2019 concurrency fixture at line $($issues[0].Line)." }
if(!$ExecuteContention){
  Write-Output 'PASS SQL Server 2019 syntax: two-session QA contention fixture; no SQL session used.'
  return
}

function Read-QaSession([string]$Path) {
  if([string]::IsNullOrWhiteSpace($Path)){ throw 'Supply both explicitly authorized Portal QA session directories.' }
  $resolved=(Resolve-Path -LiteralPath $Path).Path
  $info=Get-Content -Raw -LiteralPath (Join-Path $resolved 'active.json') | ConvertFrom-Json
  if($info.database -cne 'PortalSAGWeb-TEST' -or $info.environment -cne 'qa' -or
    $info.accessLevel -cne 'full-control' -or $info.fullControl -isnot [bool] -or !$info.fullControl -or
    $info.sessionAuthorized -isnot [bool] -or !$info.sessionAuthorized -or
    $info.pipeName -cnotmatch '^PortalSAGWeb-Codex-[a-f0-9]{32}$' -or !$info.processId){
    throw 'Each session must be an independently authorized full-control Portal QA session.'
  }
  return @{ path=$resolved; server=[string]$info.server; controller=[int]$info.processId; pipe=[string]$info.pipeName }
}
$holder=Read-QaSession $HolderSessionDirectory
$observer=Read-QaSession $ObserverSessionDirectory
if($holder.path -eq $observer.path -or $holder.controller -eq $observer.controller -or $holder.pipe -eq $observer.pipe -or
    !$holder.server -or $holder.server -cne $observer.server){
  throw 'The fixture needs two separate connections to the same Portal QA database.'
}
if(!$PSCmdlet.ShouldProcess('PortalSAGWeb-TEST','Hold synthetic day locks briefly and verify contention from a second authorized connection')){ return }
$invoke=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1')).Path
$age=Get-Random -Minimum 211 -Maximum 1000
function FixtureSql([ValidateSet('H','P','R')][string]$Mode) {
  return "DECLARE @fixtureMode varchar(1)='$Mode',@daysAgo smallint=$age;`n"+$source
}
function Read-Result([string]$Response){
  $envelope=$Response | ConvertFrom-Json -Depth 12
  if($envelope.success -ne $true -or @($envelope.resultSets).Count -ne 1 -or @($envelope.resultSets[0].rows).Count -ne 1 -or
    $envelope.resultSets[0].truncated){throw 'QA application lock response was not verified.'}
  $row=$envelope.resultSets[0].rows[0]
  if($row.targetDatabase -cne 'PortalSAGWeb-TEST' -or $row.rolledBack -ne $true -or $row.connectionId -le 0 -or
    $row.businessDate -cnotmatch '^\d{4}-\d{2}-\d{2}$' -or
    $row.observedUtcMs -isnot [long] -or $row.releasedUtcMs -isnot [long] -or
    $row.observedUtcMs -le 0 -or $row.releasedUtcMs -lt $row.observedUtcMs){
    throw 'QA sent an invalid application lock result.'
  }
  return $row
}

$job=$null
try {
  $job=Start-ThreadJob -ArgumentList $invoke,$holder.path,(FixtureSql H) -ScriptBlock {
    param($script,$path,$sql)
    $ErrorActionPreference='Stop'
    & $script -SessionDirectory $path -Sql $sql -Mode write -TimeoutSeconds 30 -MaxRows 1
  }
  $seen=$null
  $watch=[Diagnostics.Stopwatch]::StartNew()
  do {
    $probe=Read-Result ((& $invoke -SessionDirectory $observer.path -Sql (FixtureSql P) -Mode write -TimeoutSeconds 5 -MaxRows 1) -join "`n")
    if($probe.databaseResult -eq -1 -and $probe.domainResult -eq -1){ $seen=$probe; break }
    if($job.State -in @('Failed','Stopped','Completed')){break}
    Start-Sleep -Milliseconds 125
  } while ($watch.Elapsed.TotalSeconds -lt 18)
  if(!$seen){ throw 'Both locks were not observed concurrently; no PASS was recorded.' }
  if(!(Wait-Job -Job $job -Timeout 24) -or $job.State -ne 'Completed'){ throw 'The holder rollback was not confirmed.' }
  $held=Read-Result ((Receive-Job -Job $job -ErrorAction Stop) -join "`n")
  $again=Read-Result ((& $invoke -SessionDirectory $observer.path -Sql (FixtureSql R) -Mode write -TimeoutSeconds 5 -MaxRows 1) -join "`n")
  if($held.databaseResult -lt 0 -or $held.domainResult -lt 0 -or $again.databaseResult -lt 0 -or $again.domainResult -lt 0 -or
    $held.connectionId -eq $seen.connectionId -or $again.connectionId -ne $seen.connectionId -or
    $held.businessDate -cne $seen.businessDate -or $again.businessDate -cne $seen.businessDate -or
    $seen.observedUtcMs -lt $held.observedUtcMs -or $seen.observedUtcMs -ge $held.releasedUtcMs -or
    $again.observedUtcMs -lt $held.releasedUtcMs){
    throw 'The result did not prove same-day lock contention and release on two connections.'
  }
  Write-Output 'PASS QA: both same-day locks blocked the second SQL connection until rollback, then both were reacquired; no rows written.'
} finally {
  if($job){
    if($job.State -notin @('Failed','Stopped','Completed')) { Stop-Job -Job $job -ErrorAction SilentlyContinue }
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  }
}
