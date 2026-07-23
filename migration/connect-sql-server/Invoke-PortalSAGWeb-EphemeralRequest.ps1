[CmdletBinding(DefaultParameterSetName='Inline')]
param(
  [Parameter(ParameterSetName='Inline',Mandatory=$true)]
  [string]$Sql,

  [Parameter(ParameterSetName='File',Mandatory=$true)]
  [string]$SqlFile,

  [Parameter(ParameterSetName='Close',Mandatory=$true)]
  [switch]$CloseSession,

  [Parameter(ParameterSetName='Inline')]
  [Parameter(ParameterSetName='File')]
  [ValidateSet('read','write')]
  [string]$Mode='read',

  [Parameter(ParameterSetName='Inline')]
  [Parameter(ParameterSetName='File')]
  [ValidateRange(1,1800)]
  [int]$TimeoutSeconds=120,

  [Parameter(ParameterSetName='Inline')]
  [Parameter(ParameterSetName='File')]
  [ValidateRange(1,5000)]
  [int]$MaxRows=1000,

  [string]$SessionDirectory
)

$ErrorActionPreference='Stop'
if ([string]::IsNullOrWhiteSpace($SessionDirectory)) {
  $SessionDirectory=Join-Path $PSScriptRoot '..\work\sql-session'
}
$descriptorPath=Join-Path $SessionDirectory 'active.json'
if (-not (Test-Path -LiteralPath $descriptorPath)) {
  throw 'No ephemeral PortalSAGWeb SQL session is active.'
}
$descriptor=Get-Content -Raw -LiteralPath $descriptorPath | ConvertFrom-Json
if ($descriptor.pipeName -notmatch '^PortalSAGWeb-Codex-[a-f0-9]{32}$') { throw 'Invalid ephemeral-session descriptor.' }
$descriptorEnvironment = if ($descriptor.PSObject.Properties.Name -contains 'environment') {
  [string]$descriptor.environment
} elseif ($descriptor.database -eq 'PortalSAGWeb') {
  'production'
} else {
  ''
}
$knownProductionPair = ([string]$descriptor.server).Trim().ToLowerInvariant() -eq 'data14.sagerp.co,54103' -and
  ([string]$descriptor.database).Trim() -eq 'PortalSAGWeb'
$validTarget = ($descriptorEnvironment -eq 'production' -and $descriptor.database -eq 'PortalSAGWeb') -or
  ($descriptorEnvironment -eq 'qa' -and -not $knownProductionPair)
if (-not $validTarget -or
    $descriptor.accessLevel -notin @('full-control','runtime','qa-readonly') -or
    $descriptor.sessionAuthorized -ne $true -or
    $descriptor.approvalMode -ne 'session') {
  throw 'The active session is not an authorized PortalSAGWeb database session.'
}
$sessionProcess=Get-Process -Id ([int]$descriptor.processId) -ErrorAction SilentlyContinue
if ($null -eq $sessionProcess -or $sessionProcess.ProcessName -ne 'pwsh') {
  throw 'The ephemeral SQL session process is no longer running.'
}
if (-not [string]::IsNullOrWhiteSpace([string]$descriptor.processStartTimeUtc)) {
  $expectedStart=if ($descriptor.processStartTimeUtc -is [DateTimeOffset]) {
    $descriptor.processStartTimeUtc.UtcDateTime
  }
  elseif ($descriptor.processStartTimeUtc -is [DateTime]) {
    $descriptor.processStartTimeUtc.ToUniversalTime()
  }
  else {
    [DateTimeOffset]::Parse([string]$descriptor.processStartTimeUtc,[Globalization.CultureInfo]::InvariantCulture).UtcDateTime
  }
  $actualStart=$sessionProcess.StartTime.ToUniversalTime()
  if ([Math]::Abs(($actualStart-$expectedStart).TotalSeconds) -ge 2) {
    throw 'The ephemeral SQL session descriptor is stale.'
  }
}

$requestId=([Guid]::NewGuid().ToString('N')).Substring(0,12)
if ($CloseSession) {
  $request=[ordered]@{ version=1; requestId=$requestId; action='close' }
}
else {
  if ($PSCmdlet.ParameterSetName -eq 'File') {
    $resolvedFile=(Resolve-Path -LiteralPath $SqlFile).Path
    $content=[IO.File]::ReadAllText($resolvedFile)
    $batches=@([regex]::Split($content,'(?im)^\s*GO\s*(?:--.*)?$') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  }
  else {
    $batches=@($Sql)
  }
  $request=[ordered]@{
    version=1
    requestId=$requestId
    action='execute'
    mode=$Mode
    timeoutSeconds=$TimeoutSeconds
    maxRows=$MaxRows
    batches=$batches
  }
}

$pipe=[System.IO.Pipes.NamedPipeClientStream]::new(
  '.',
  [string]$descriptor.pipeName,
  [System.IO.Pipes.PipeDirection]::InOut,
  [System.IO.Pipes.PipeOptions]::None
)
$reader=$null
$writer=$null
try {
  $pipe.Connect(10000)
  $reader=[IO.StreamReader]::new($pipe,[Text.UTF8Encoding]::new($false),$false,65536,$true)
  $writer=[IO.StreamWriter]::new($pipe,[Text.UTF8Encoding]::new($false),65536,$true)
  $writer.AutoFlush=$true
  $writer.WriteLine(($request | ConvertTo-Json -Compress -Depth 8))
  $line=$reader.ReadLine()
  if ([string]::IsNullOrWhiteSpace($line)) { throw 'The ephemeral SQL session returned no response.' }
  $response=$line | ConvertFrom-Json -Depth 12
  if ($response.success -ne $true) { throw ([string]$response.error) }
  $response | ConvertTo-Json -Depth 12
}
finally {
  if ($null -ne $reader) { $reader.Dispose() }
  if ($null -ne $writer) { $writer.Dispose() }
  $pipe.Dispose()
}
