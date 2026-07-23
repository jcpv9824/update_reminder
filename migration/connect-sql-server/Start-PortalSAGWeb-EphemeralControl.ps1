[CmdletBinding()]
param(
  [string]$ServerName = 'data14.sagerp.co,54103',
  [string]$DatabaseName = 'PortalSAGWeb',
  [string]$Username = '',
  [switch]$RequireFullControl,
  [switch]$AllowElevatedRuntimeLogin,
  [ValidateSet('production','qa')]
  [string]$Environment = 'production',
  [string]$SessionDirectory
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ([string]::IsNullOrWhiteSpace($SessionDirectory)) {
  $SessionDirectory = Join-Path $PSScriptRoot '..\work\sql-session'
}
function Convert-SqlValue($Value) {
  if ($null -eq $Value -or $Value -is [DBNull]) { return $null }
  if ($Value -is [byte[]]) { return '0x' + [Convert]::ToHexString($Value).ToLowerInvariant() }
  if ($Value -is [DateTime]) { return $Value.ToUniversalTime().ToString('O') }
  if ($Value -is [DateTimeOffset]) { return $Value.ToUniversalTime().ToString('O') }
  if ($Value -is [Guid]) { return $Value.ToString('D') }
  return $Value
}

function Invoke-SqlBatches {
  param(
    [System.Data.SqlClient.SqlConnection]$Connection,
    [string[]]$Batches,
    [int]$TimeoutSeconds,
    [int]$MaxRows
  )

  $allResultSets = @()
  $recordsAffected = 0
  $batchNumber = 0
  foreach ($batch in $Batches) {
    $batchNumber++
    if ([string]::IsNullOrWhiteSpace($batch)) { continue }
    $command = $Connection.CreateCommand()
    $reader = $null
    try {
      $command.CommandTimeout = $TimeoutSeconds
      $command.CommandText = $batch
      $reader = $command.ExecuteReader()
      $resultNumber = 0
      do {
        $resultNumber++
        if ($reader.FieldCount -gt 0) {
          $columns = @()
          for ($columnIndex = 0; $columnIndex -lt $reader.FieldCount; $columnIndex++) {
            $columns += $reader.GetName($columnIndex)
          }
          $rows = @()
          $totalRows = 0
          while ($reader.Read()) {
            $totalRows++
            if ($rows.Count -ge $MaxRows) { continue }
            $row = [ordered]@{}
            for ($columnIndex = 0; $columnIndex -lt $reader.FieldCount; $columnIndex++) {
              $row[$columns[$columnIndex]] = Convert-SqlValue $reader.GetValue($columnIndex)
            }
            $rows += [pscustomobject]$row
          }
          $allResultSets += [pscustomobject]@{
            batch = $batchNumber
            result = $resultNumber
            columns = $columns
            rows = $rows
            totalRows = $totalRows
            truncated = ($totalRows -gt $rows.Count)
          }
        }
      } while ($reader.NextResult())
      if ($reader.RecordsAffected -gt 0) { $recordsAffected += $reader.RecordsAffected }
    }
    finally {
      if ($null -ne $reader) { $reader.Dispose() }
      $command.Dispose()
    }
  }
  return [pscustomobject]@{ resultSets = $allResultSets; recordsAffected = $recordsAffected }
}

function New-CurrentUserPipe {
  param([string]$PipeName)

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $security = [System.IO.Pipes.PipeSecurity]::new()
  $security.SetOwner($identity.User)
  $security.SetAccessRuleProtection($true, $false)
  $rule = [System.IO.Pipes.PipeAccessRule]::new(
    $identity.User,
    [System.IO.Pipes.PipeAccessRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
  )
  $security.AddAccessRule($rule)
  return [System.IO.Pipes.NamedPipeServerStreamAcl]::Create(
    $PipeName,
    [System.IO.Pipes.PipeDirection]::InOut,
    1,
    [System.IO.Pipes.PipeTransmissionMode]::Byte,
    [System.IO.Pipes.PipeOptions]::None,
    65536,
    65536,
    $security,
    [System.IO.HandleInheritability]::None,
    [System.IO.Pipes.PipeAccessRights]0
  )
}

$sessionTitle = if ($Environment -eq 'qa' -and $RequireFullControl) { 'Portal SAG Web QA - EPHEMERAL FULL-CONTROL MIGRATION SESSION' }
  elseif ($Environment -eq 'qa') { 'Portal SAG Web QA - EPHEMERAL DATABASE SESSION' }
  elseif ($RequireFullControl) { 'Portal SAG Web - EPHEMERAL FULL-CONTROL MIGRATION SESSION' }
  else { 'Portal SAG Web - EPHEMERAL DATABASE SESSION' }
Write-Host $sessionTitle -ForegroundColor Cyan
Write-Host 'The SQL password remains only in this process memory and is never written or printed.'
Write-Host 'Closing this window revokes the session immediately.'
Write-Host 'One exact authorization phrase enables requests for the lifetime of this terminal.'
Write-Host 'After authorization, write requests do not require individual approval prompts.'
if ($RequireFullControl) {
  if ($Environment -eq 'production') {
    if ($AllowElevatedRuntimeLogin) {
      Write-Host 'Owner-approved exception: SAGWebDev is accepted only if SQL proves db_owner + database CONTROL.' -ForegroundColor Yellow
      Write-Host 'After migration, SAGWebDev must be returned to portal_runtime-only permissions.' -ForegroundColor Yellow
    }
    else {
      Write-Host 'This launcher accepts only the separate provider migration login.' -ForegroundColor Yellow
      Write-Host 'SAGWebDev is runtime-only in production and is rejected before its password is requested.' -ForegroundColor Yellow
    }
  }
  else {
    Write-Host 'QA accepts any SQL login whose effective QA permissions include db_owner and database CONTROL.' -ForegroundColor Yellow
    Write-Host 'Using SAGWebDev on QA does not change or elevate its production permissions.' -ForegroundColor Yellow
  }
}
else {
  Write-Host 'A migration login receives full control; SAGWebDev receives only its existing portal_runtime permissions.' -ForegroundColor Yellow
}
Write-Host
$ServerName = Read-Host "SQL Server / instance [$ServerName]" | ForEach-Object { if ($_){$_}else{$ServerName} }
$DatabaseName = Read-Host "Database [$DatabaseName]" | ForEach-Object { if ($_){$_}else{$DatabaseName} }
if ([string]::IsNullOrWhiteSpace($ServerName) -or [string]::IsNullOrWhiteSpace($DatabaseName)) {
  throw 'Server and database are required.'
}
$knownProductionServer = 'data14.sagerp.co,54103'
if ($Environment -eq 'production' -and $DatabaseName -ne 'PortalSAGWeb') {
  throw 'The production controller is restricted to PortalSAGWeb.'
}
if ($Environment -eq 'qa' -and
    $ServerName.Trim().ToLowerInvariant() -eq $knownProductionServer -and
    $DatabaseName.Trim() -eq 'PortalSAGWeb') {
  throw 'The QA controller refuses the known production server/database pair.'
}
$usernamePrompt = if ([string]::IsNullOrWhiteSpace($Username)) { 'SQL Authentication migration username' } else { "SQL Authentication migration username [$Username]" }
$enteredUsername = Read-Host $usernamePrompt
if (-not [string]::IsNullOrWhiteSpace($enteredUsername)) { $Username = $enteredUsername.Trim() }
if ([string]::IsNullOrWhiteSpace($Username)) { throw 'A separate full-control migration username is required.' }
if ($Environment -eq 'production' -and $RequireFullControl -and
    -not $AllowElevatedRuntimeLogin -and $Username -ieq 'SAGWebDev') {
  throw 'SAGWebDev is the least-privilege application runtime login. Enter the separate provider migration login instead.'
}
$securePassword = Read-Host 'SQL Authentication password' -AsSecureString
if (-not $securePassword.IsReadOnly()) { $securePassword.MakeReadOnly() }

$builder = [System.Data.SqlClient.SqlConnectionStringBuilder]::new()
$builder['Data Source'] = $ServerName
$builder['Initial Catalog'] = $DatabaseName
$builder['Encrypt'] = $true
$builder['TrustServerCertificate'] = $false
$builder['Connect Timeout'] = 15
$builder['Persist Security Info'] = $false
$builder['MultipleActiveResultSets'] = $false
$builder['Application Name'] = "PortalSAGWeb-$Environment-EphemeralCodexControl"

$sqlCredential = [System.Data.SqlClient.SqlCredential]::new($Username, $securePassword)
$connection = [System.Data.SqlClient.SqlConnection]::new()
$connection.ConnectionString = $builder.ConnectionString
$connection.Credential = $sqlCredential
$descriptorPath = $null
$sessionId = [Guid]::NewGuid().ToString('N')
$pipeName = "PortalSAGWeb-Codex-$sessionId"
$keepRunning = $true

try {
  Write-Host 'Opening encrypted connection...'
  $connection.Open()

  $preflight = $connection.CreateCommand()
  try {
    $preflight.CommandText = @'
SELECT
  CAST(SERVERPROPERTY('ProductMajorVersion') AS INT) AS major_version,
  d.compatibility_level,
  d.collation_name,
  DB_NAME() AS database_name,
  SUSER_SNAME() AS login_name,
  USER_NAME() AS database_user,
  IS_ROLEMEMBER('db_owner') AS is_db_owner,
  IS_ROLEMEMBER('portal_runtime') AS is_portal_runtime,
  HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','CONTROL') AS has_database_control,
  HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','CONNECT') AS has_database_connect
FROM sys.databases AS d
WHERE d.database_id=DB_ID();
'@
    $reader = $preflight.ExecuteReader()
    if (-not $reader.Read()) { throw 'Connection preflight returned no row.' }
    $majorVersion = [Convert]::ToInt32($reader.GetValue(0))
    $compatibilityLevel = [Convert]::ToInt32($reader.GetValue(1))
    $collationName = $reader.GetString(2)
    $connectedDatabase = $reader.GetString(3)
    $loginName = $reader.GetString(4)
    $databaseUser = $reader.GetString(5)
    $isDbOwner = [Convert]::ToInt32($reader.GetValue(6))
    $isPortalRuntime = [Convert]::ToInt32($reader.GetValue(7))
    $hasControl = [Convert]::ToInt32($reader.GetValue(8))
    $hasConnect = [Convert]::ToInt32($reader.GetValue(9))
    $reader.Close()
  }
  finally {
    $preflight.Dispose()
  }

  if ($majorVersion -ne 15) { throw "Expected SQL Server 2019 major version 15; found $majorVersion." }
  if ($compatibilityLevel -ne 150) { throw "Expected compatibility level 150; found $compatibilityLevel." }
  if ($collationName -ne 'Modern_Spanish_CI_AS') { throw "Unexpected collation: $collationName." }
  if ($connectedDatabase -ne $DatabaseName) { throw "Connected to unexpected database: $connectedDatabase." }
  $accessLevel = if ($isDbOwner -eq 1 -and $hasControl -eq 1) { 'full-control' }
    elseif ($isPortalRuntime -eq 1) { 'runtime' }
    elseif ($Environment -eq 'qa' -and $hasConnect -eq 1) { 'qa-readonly' }
    else { throw 'The supplied login is neither the full-control migrator nor a portal_runtime member.' }
  if ($RequireFullControl -and $accessLevel -ne 'full-control') {
    throw 'The supplied login does not have the required db_owner + database CONTROL migration capability.'
  }
  $temporarilyElevatedRuntimeLogin = (
    $Environment -eq 'production' -and
    $RequireFullControl -and
    $AllowElevatedRuntimeLogin -and
    $Username -ieq 'SAGWebDev'
  )
  if ($temporarilyElevatedRuntimeLogin) {
    Write-Host 'WARNING: the application runtime login currently has migration-level permissions.' -ForegroundColor Red
    Write-Host 'Do not enable SQL runtime until this login is returned to portal_runtime-only access.' -ForegroundColor Red
  }

  Write-Host
  Write-Host "This grants unattended $accessLevel database access to the current Windows user while this terminal remains open." -ForegroundColor Yellow
  if ($accessLevel -eq 'runtime') {
    Write-Host 'Runtime mode permits application DML only; SQL Server continues to reject schema changes.' -ForegroundColor Yellow
  }
  elseif ($accessLevel -eq 'qa-readonly') {
    Write-Host 'QA discovery mode is read-only. The controller rejects every write request.' -ForegroundColor Yellow
  }
  $sessionAuthorization = (Read-Host 'Type AUTHORIZE DATABASE ACCESS FOR THIS SESSION').Trim()
  if ($sessionAuthorization -cne 'AUTHORIZE DATABASE ACCESS FOR THIS SESSION') {
    throw 'Database session authorization did not match; the session was not opened.'
  }

  [IO.Directory]::CreateDirectory($SessionDirectory) | Out-Null
  $SessionDirectory = (Resolve-Path -LiteralPath $SessionDirectory).Path
  $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $SessionDirectory '/inheritance:r' '/grant:r' "$currentIdentity`:(OI)(CI)F" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the local session directory ACL.' }

  $descriptorPath = Join-Path $SessionDirectory 'active.json'
  if (Test-Path -LiteralPath $descriptorPath) {
    $existing = Get-Content -Raw -LiteralPath $descriptorPath | ConvertFrom-Json
    $existingProcess = Get-Process -Id ([int]$existing.processId) -ErrorAction SilentlyContinue
    $isMatchingSessionProcess = $false
    if ($null -ne $existingProcess -and $existingProcess.ProcessName -eq 'pwsh') {
      if (-not [string]::IsNullOrWhiteSpace([string]$existing.processStartTimeUtc)) {
        $expectedStart = if ($existing.processStartTimeUtc -is [DateTimeOffset]) {
          $existing.processStartTimeUtc.UtcDateTime
        }
        elseif ($existing.processStartTimeUtc -is [DateTime]) {
          $existing.processStartTimeUtc.ToUniversalTime()
        }
        else {
          [DateTimeOffset]::Parse([string]$existing.processStartTimeUtc,[Globalization.CultureInfo]::InvariantCulture).UtcDateTime
        }
        $actualStart = $existingProcess.StartTime.ToUniversalTime()
        $isMatchingSessionProcess = [Math]::Abs(($actualStart-$expectedStart).TotalSeconds) -lt 2
      }
      elseif (-not [string]::IsNullOrWhiteSpace([string]$existing.startedAtUtc)) {
        $descriptorStarted = if ($existing.startedAtUtc -is [DateTimeOffset]) {
          $existing.startedAtUtc.UtcDateTime
        }
        elseif ($existing.startedAtUtc -is [DateTime]) {
          $existing.startedAtUtc.ToUniversalTime()
        }
        else {
          [DateTimeOffset]::Parse([string]$existing.startedAtUtc,[Globalization.CultureInfo]::InvariantCulture).UtcDateTime
        }
        $processStarted = $existingProcess.StartTime.ToUniversalTime()
        $isMatchingSessionProcess = $processStarted -le $descriptorStarted -and ($descriptorStarted-$processStarted).TotalHours -lt 1
      }
    }
    if ($isMatchingSessionProcess) { throw 'Another ephemeral SQL control session is already active.' }
    Remove-Item -LiteralPath $descriptorPath -Force
  }

  $sessionProcess = Get-Process -Id $PID -ErrorAction Stop

  $descriptor = [ordered]@{
    version = 2
    sessionId = $sessionId
    pipeName = $pipeName
    processId = $PID
    processName = $sessionProcess.ProcessName
    processStartTimeUtc = $sessionProcess.StartTime.ToUniversalTime().ToString('O')
    server = $ServerName
    database = $connectedDatabase
    environment = $Environment
    login = $loginName
    databaseUser = $databaseUser
    engineMajorVersion = $majorVersion
    compatibilityLevel = $compatibilityLevel
    fullControl = ($accessLevel -eq 'full-control')
    runtimeAccess = ($accessLevel -eq 'runtime')
    temporarilyElevatedRuntimeLogin = $temporarilyElevatedRuntimeLogin
    accessLevel = $accessLevel
    sessionAuthorized = $true
    approvalMode = 'session'
    startedAtUtc = [DateTime]::UtcNow.ToString('O')
  }
  [IO.File]::WriteAllText(
    $descriptorPath,
    (($descriptor | ConvertTo-Json -Depth 4) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
  )

  Write-Host
  Write-Host 'EPHEMERAL DATABASE SESSION READY.' -ForegroundColor Green
  Write-Host "Server engine: SQL Server 2019; database: $connectedDatabase"
  Write-Host "Login/user: $loginName / $databaseUser; access level: $accessLevel."
  Write-Host 'Write authorization: active for this terminal session; no per-request prompts.'
  Write-Host 'Leave this window open. Close it at any time to revoke access.' -ForegroundColor Yellow

  while ($keepRunning -and $connection.State -eq [Data.ConnectionState]::Open) {
    $pipe = New-CurrentUserPipe $pipeName
    $streamReader = $null
    $streamWriter = $null
    try {
      $pipe.WaitForConnection()
      $streamReader = [IO.StreamReader]::new($pipe, [Text.UTF8Encoding]::new($false), $false, 65536, $true)
      $streamWriter = [IO.StreamWriter]::new($pipe, [Text.UTF8Encoding]::new($false), 65536, $true)
      $streamWriter.AutoFlush = $true
      $line = $streamReader.ReadLine()
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      $request = $line | ConvertFrom-Json
      $requestId = [string]$request.requestId
      if ($requestId -notmatch '^[a-f0-9]{12}$') { throw 'Invalid request identifier.' }

      if ($request.action -eq 'close') {
        $streamWriter.WriteLine((@{ success=$true; requestId=$requestId; closed=$true } | ConvertTo-Json -Compress))
        $keepRunning = $false
        continue
      }

      if ($request.action -ne 'execute') { throw 'Unsupported request action.' }
      $mode = [string]$request.mode
      if ($mode -notin @('read','write')) { throw 'Request mode must be read or write.' }
      if ($accessLevel -eq 'qa-readonly' -and $mode -eq 'write') {
        throw 'Write requests are disabled for this QA discovery session.'
      }
      $timeoutSeconds = [Math]::Min([Math]::Max([int]$request.timeoutSeconds, 1), 1800)
      $maxRows = [Math]::Min([Math]::Max([int]$request.maxRows, 1), 5000)
      $batches = @($request.batches | ForEach-Object { [string]$_ })
      if ($batches.Count -eq 0 -or ($batches -join '').Length -eq 0) { throw 'No SQL batch was supplied.' }
      if (($batches -join '').Length -gt 5MB) { throw 'Request exceeds the 5 MB SQL limit.' }

      $sha = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($batches -join "`nGO`n")))
      $requestHash = [Convert]::ToHexString($sha).ToLowerInvariant()
      Write-Host
      Write-Host "Request $requestId | mode=$mode | batches=$($batches.Count) | sha256=$requestHash"

      if ($mode -eq 'write') { Write-Host 'Write authorized by the active terminal session.' -ForegroundColor Yellow }

      try {
        $execution = Invoke-SqlBatches -Connection $connection -Batches $batches -TimeoutSeconds $timeoutSeconds -MaxRows $maxRows
        $response = [ordered]@{
          success = $true
          requestId = $requestId
          mode = $mode
          sha256 = $requestHash
          recordsAffected = $execution.recordsAffected
          resultSets = $execution.resultSets
        }
        $streamWriter.WriteLine(($response | ConvertTo-Json -Compress -Depth 12))
        Write-Host "Request $requestId completed." -ForegroundColor Green
      }
      catch {
        $safeMessage = $_.Exception.Message
        if ($safeMessage.Length -gt 1500) { $safeMessage = $safeMessage.Substring(0,1500) }
        $streamWriter.WriteLine((@{ success=$false; requestId=$requestId; error=$safeMessage } | ConvertTo-Json -Compress))
        Write-Host "Request $requestId failed: $safeMessage" -ForegroundColor Red
      }
    }
    catch {
      if ($null -ne $streamWriter) {
        $safeMessage = $_.Exception.Message
        if ($safeMessage.Length -gt 1500) { $safeMessage = $safeMessage.Substring(0,1500) }
        try { $streamWriter.WriteLine((@{ success=$false; error=$safeMessage } | ConvertTo-Json -Compress)) } catch {}
      }
      Write-Host "Session request error: $($_.Exception.Message)" -ForegroundColor Red
    }
    finally {
      if ($null -ne $streamReader) { $streamReader.Dispose() }
      if ($null -ne $streamWriter) { $streamWriter.Dispose() }
      $pipe.Dispose()
    }
  }
}
finally {
  if ($null -ne $descriptorPath -and (Test-Path -LiteralPath $descriptorPath)) {
    try {
      $currentDescriptor = Get-Content -Raw -LiteralPath $descriptorPath | ConvertFrom-Json
      if ($currentDescriptor.sessionId -eq $sessionId) { Remove-Item -LiteralPath $descriptorPath -Force }
    }
    catch {}
  }
  if ($connection.State -ne [Data.ConnectionState]::Closed) { $connection.Close() }
  $connection.Dispose()
  $sqlCredential = $null
  $securePassword = $null
  Write-Host 'Ephemeral SQL session closed; credentials released from process memory.' -ForegroundColor Cyan
}
