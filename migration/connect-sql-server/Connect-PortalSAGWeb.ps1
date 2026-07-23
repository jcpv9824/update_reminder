[CmdletBinding()]
param(
  [string]$Server = "data14.sagerp.co,54103",
  [string]$Database = "PortalSAGWeb",
  [string]$Username,
  [ValidateRange(5, 120)]
  [int]$ConnectTimeoutSeconds = 15,
  [switch]$TrustServerCertificate,
  [switch]$RunIntake,
  [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Read-WithDefault {
  param(
    [Parameter(Mandatory)] [string]$Prompt,
    [Parameter(Mandatory)] [string]$DefaultValue
  )

  $value = Read-Host "$Prompt [$DefaultValue]"
  if ([string]::IsNullOrWhiteSpace($value)) { return $DefaultValue }
  return $value.Trim()
}

function New-SafeConnectionString {
  param(
    [Parameter(Mandatory)] [string]$DataSource,
    [Parameter(Mandatory)] [string]$InitialCatalog,
    [Parameter(Mandatory)] [int]$TimeoutSeconds,
    [Parameter(Mandatory)] [bool]$AllowUntrustedCertificate
  )

  $builder = [System.Data.SqlClient.SqlConnectionStringBuilder]::new()
  # Use canonical SQL keywords through the indexer. This avoids a PowerShell 7
  # binder issue with the legacy System.Data.SqlClient property setters.
  $builder["Data Source"] = $DataSource
  $builder["Initial Catalog"] = $InitialCatalog
  $builder["Encrypt"] = $true
  $builder["TrustServerCertificate"] = $AllowUntrustedCertificate
  $builder["Connect Timeout"] = $TimeoutSeconds
  $builder["Persist Security Info"] = $false
  $builder["MultipleActiveResultSets"] = $false
  $builder["Application Name"] = "PortalSAGWeb-Migration-Intake"
  return $builder.ConnectionString
}

function Convert-DataTableRows {
  param([Parameter(Mandatory)] [System.Data.DataTable]$Table)

  foreach ($row in $Table.Rows) {
    $values = [ordered]@{}
    foreach ($column in $Table.Columns) {
      $value = $row[$column.ColumnName]
      $values[$column.ColumnName] = if ($value -is [DBNull]) { $null } else { $value }
    }
    [pscustomobject]$values
  }
}

function Invoke-ConnectionSummary {
  param([Parameter(Mandatory)] [System.Data.SqlClient.SqlConnection]$Connection)

  $command = $Connection.CreateCommand()
  try {
    $command.CommandTimeout = 30
    $command.CommandText = @"
SELECT
  CAST(SERVERPROPERTY('ServerName') AS NVARCHAR(128)) AS server_name,
  CAST(SERVERPROPERTY('Edition') AS NVARCHAR(128)) AS edition,
  CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(128)) AS product_version,
  DB_NAME() AS database_name,
  SUSER_SNAME() AS login_name,
  USER_NAME() AS database_user,
  d.compatibility_level,
  d.collation_name,
  d.is_read_committed_snapshot_on,
  d.snapshot_isolation_state_desc,
  d.is_encrypted,
  (SELECT COUNT(*) FROM sys.tables WHERE is_ms_shipped = 0) AS user_table_count
FROM sys.databases AS d
WHERE d.name = DB_NAME();
"@
    $table = [System.Data.DataTable]::new("connection_summary")
    $reader = $command.ExecuteReader()
    try {
      $table.Load($reader)
    } finally {
      $reader.Dispose()
    }
    return @(Convert-DataTableRows -Table $table)
  } finally {
    $command.Dispose()
  }
}

function Invoke-ReadOnlyIntake {
  param([Parameter(Mandatory)] [System.Data.SqlClient.SqlConnection]$Connection)

  $intakePath = Join-Path $PSScriptRoot "..\sql\000_database_intake_readonly.sql"
  $resolvedPath = (Resolve-Path -LiteralPath $intakePath).Path
  $sql = Get-Content -Raw -LiteralPath $resolvedPath

  $command = $Connection.CreateCommand()
  $adapter = $null
  $dataSet = [System.Data.DataSet]::new("PortalSAGWebDatabaseIntake")
  try {
    $command.CommandTimeout = 120
    $command.CommandText = $sql
    $adapter = [System.Data.SqlClient.SqlDataAdapter]::new($command)
    [void]$adapter.Fill($dataSet)

    Write-Host ""
    Write-Host "Read-only database intake" -ForegroundColor Cyan
    Write-Host "No data or schema changes were executed." -ForegroundColor DarkGray

    $resultNumber = 0
    foreach ($table in $dataSet.Tables) {
      $resultNumber += 1
      Write-Host ""
      Write-Host "Result set $resultNumber" -ForegroundColor Yellow
      $rows = @(Convert-DataTableRows -Table $table)
      if ($rows.Count -eq 0) {
        Write-Host "(no rows)" -ForegroundColor DarkGray
      } else {
        $rows | Format-Table -AutoSize -Wrap | Out-Host
      }
    }
  } finally {
    if ($null -ne $adapter) { $adapter.Dispose() }
    $command.Dispose()
    $dataSet.Dispose()
  }
}

function Write-FriendlySqlError {
  param([Parameter(Mandatory)] [System.Data.SqlClient.SqlException]$SqlError)

  Write-Host ""
  Write-Host "Connection failed." -ForegroundColor Red
  if ($SqlError.Message -match "error:\s*26|servidor o instancia especificado|server or instance specified|instance-specific") {
    Write-Host "The SQL endpoint could not be reached. Confirm DNS/VPN/firewall and use the provider FQDN with its fixed TCP port." -ForegroundColor Yellow
    Write-Host "Configured endpoint: $Server" -ForegroundColor Yellow
    return
  }
  switch ($SqlError.Number) {
    18456 {
      Write-Host "SQL Server rejected the username or password (error 18456). Verify the SQL Authentication login with the provider." -ForegroundColor Yellow
    }
    4060 {
      Write-Host "The login cannot open database '$Database' (error 4060). Ask the provider to map the login to this database." -ForegroundColor Yellow
    }
    26 {
      Write-Host "The named SQL instance could not be located (error 26). Confirm VPN/firewall, SQL Browser, or request a FQDN and fixed TCP port." -ForegroundColor Yellow
    }
    53 {
      Write-Host "The SQL Server host is unreachable (error 53). Confirm DNS/VPN/firewall and the provider allowlist." -ForegroundColor Yellow
    }
    default {
      if ($SqlError.Message -match "certificate|SSL|TLS|trust") {
        Write-Host "The server certificate could not be validated. The preferred fix is a provider certificate trusted by this machine." -ForegroundColor Yellow
        Write-Host "Use -TrustServerCertificate only as a temporary diagnostic after verifying the server identity with the provider." -ForegroundColor Yellow
      } else {
        Write-Host "SQL error $($SqlError.Number): $($SqlError.Message)" -ForegroundColor Yellow
      }
    }
  }
}

Write-Host "Portal SAG Web - safe SQL Server connection" -ForegroundColor Cyan
Write-Host "The password is requested as a SecureString and is never saved or printed." -ForegroundColor DarkGray
Write-Host ""

if (-not $ValidateOnly) {
  $Server = Read-WithDefault -Prompt "SQL Server / instance" -DefaultValue $Server
  $Database = Read-WithDefault -Prompt "Database" -DefaultValue $Database
}

$connectionString = New-SafeConnectionString `
  -DataSource $Server `
  -InitialCatalog $Database `
  -TimeoutSeconds $ConnectTimeoutSeconds `
  -AllowUntrustedCertificate ([bool]$TrustServerCertificate)

if ($ValidateOnly) {
  Write-Host "Script validation succeeded." -ForegroundColor Green
  Write-Host "Server: $Server"
  Write-Host "Database: $Database"
  Write-Host "Encrypt: True"
  Write-Host "TrustServerCertificate: $([bool]$TrustServerCertificate)"
  exit 0
}

if ([string]::IsNullOrWhiteSpace($Username)) {
  $Username = (Read-Host "SQL Authentication username").Trim()
}
if ([string]::IsNullOrWhiteSpace($Username)) {
  throw "The SQL Authentication username is required."
}

$securePassword = Read-Host "SQL Authentication password" -AsSecureString
$securePassword.MakeReadOnly()
$credential = [System.Data.SqlClient.SqlCredential]::new($Username, $securePassword)
$connection = [System.Data.SqlClient.SqlConnection]::new()

try {
  $connection.ConnectionString = $connectionString
  $connection.Credential = $credential

  Write-Host ""
  Write-Host "Opening encrypted connection..." -ForegroundColor Cyan
  $connection.Open()

  Write-Host "Connection succeeded." -ForegroundColor Green
  $summary = @(Invoke-ConnectionSummary -Connection $connection)
  $summary | Format-List | Out-Host

  $runIntakeNow = [bool]$RunIntake
  if (-not $RunIntake) {
    $answer = Read-Host "Run the complete read-only database intake now? [y/N]"
    $runIntakeNow = $answer.Trim().ToLowerInvariant() -in @("y", "yes", "s", "si", "sí")
  }

  if ($runIntakeNow) {
    Invoke-ReadOnlyIntake -Connection $connection
  }

  Write-Host ""
  Write-Host "Finished safely. No credentials were stored and no database changes were made." -ForegroundColor Green
} catch [System.Data.SqlClient.SqlException] {
  Write-FriendlySqlError -SqlError $_.Exception
  exit 1
} finally {
  if ($connection.State -ne [System.Data.ConnectionState]::Closed) {
    $connection.Close()
  }
  $connection.Dispose()
  $securePassword.Dispose()
}
