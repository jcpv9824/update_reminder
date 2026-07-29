[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)]
  [string]$SessionDirectory,

  [ValidateRange(1,72)]
  [int]$MaximumBackupAgeHours = 36
)

$ErrorActionPreference = 'Stop'
$clientPath = Join-Path $PSScriptRoot '..\connect-sql-server\Invoke-PortalSAGWeb-EphemeralRequest.ps1'
$descriptorPath = Join-Path $SessionDirectory 'active.json'
if (-not (Test-Path -LiteralPath $descriptorPath)) {
  throw 'The production SQL session descriptor is missing.'
}
$descriptor = Get-Content -Raw -LiteralPath $descriptorPath | ConvertFrom-Json

# The production controller may be executing as database user dbo so that the
# owner-approved SAGWebDev session can bypass its portal_runtime DENY. Revert
# only long enough to inspect msdb, then restore the same connection-scoped
# execution context before returning to the caller.
$backupQuery = @"
SELECT
  CASE WHEN EXISTS
  (
    SELECT 1
    FROM msdb.dbo.backupset
    WHERE database_name=N'PortalSAGWeb'
      AND [type]='D'
      AND backup_finish_date IS NOT NULL
      AND DATEDIFF(HOUR,backup_finish_date,GETDATE()) BETWEEN 0 AND $MaximumBackupAgeHours
  )
  THEN 1 ELSE 0 END AS backup_ready
"@

$sql = if ($descriptor.executionContext -eq 'session-scoped-dbo') { @"
SET NOCOUNT ON;
DECLARE @backup_ready BIT=0;
BEGIN TRY
  REVERT;
  SELECT @backup_ready=backup_ready FROM ($backupQuery) AS backup_status;
  USE PortalSAGWeb;
  EXECUTE AS USER=N'dbo';
  SELECT @backup_ready AS backup_ready;
END TRY
BEGIN CATCH
  BEGIN TRY
    USE PortalSAGWeb;
    IF USER_NAME()<>N'dbo' EXECUTE AS USER=N'dbo';
  END TRY
  BEGIN CATCH
  END CATCH;
  THROW;
END CATCH;
"@
} else {
  $backupQuery
}

$json = & $clientPath -Sql $sql -Mode read -SessionDirectory $SessionDirectory `
  -TimeoutSeconds 120 -MaxRows 5
$response = $json | ConvertFrom-Json -Depth 12
$row = $response.resultSets[-1].rows[0]
if ($null -eq $row -or [int]$row.backup_ready -ne 1) {
  throw "No production full backup completed within the last $MaximumBackupAgeHours hours. Migration 027 was not applied."
}

Write-Host "PASS: a production full backup completed within the last $MaximumBackupAgeHours hours." -ForegroundColor Green
