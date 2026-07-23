[CmdletBinding(DefaultParameterSetName = 'DryRun')]
param(
  [Parameter(Mandatory = $true)]
  [string]$SnapshotDirectory,

  [ValidateSet('production', 'nonproduction')]
  [string]$SourceEnvironment = 'production',

  [Parameter(ParameterSetName = 'Apply', Mandatory = $true)]
  [switch]$Apply,

  [Parameter(ParameterSetName = 'Apply', Mandatory = $true)]
  [ValidateSet('nonproduction', 'production-stage')]
  [string]$TargetEnvironment,

  [Parameter(ParameterSetName = 'Apply', Mandatory = $true)]
  [string]$ServerName,

  [Parameter(ParameterSetName = 'Apply')]
  [string]$DatabaseName = 'PortalSAGWeb',

  [Parameter(ParameterSetName = 'Apply')]
  [string]$Username,

  [Parameter(ParameterSetName = 'Apply')]
  [System.Management.Automation.PSCredential]$Credential,

  [Parameter(ParameterSetName = 'Apply')]
  [switch]$Confirmed,

  [Parameter(ParameterSetName = 'Apply')]
  [long]$ResumeRunKey,

  [Parameter(ParameterSetName = 'Apply')]
  [switch]$AcceptKnownWarnings
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$productionServer = 'data14.sagerp.co,54103'
$productionDatabase = 'PortalSAGWeb'
$isProductionTarget = (
  $PSCmdlet.ParameterSetName -eq 'Apply' -and
  $DatabaseName.Equals($productionDatabase, [StringComparison]::OrdinalIgnoreCase) -and
  $ServerName.Trim().Equals($productionServer, [StringComparison]::OrdinalIgnoreCase)
)
if ($PSCmdlet.ParameterSetName -eq 'Apply') {
  if ($TargetEnvironment -eq 'production-stage') {
    if (-not $isProductionTarget) {
      throw 'REFUSED: production-stage mode accepts only the designated production PortalSAGWeb endpoint.'
    }
    if ($SourceEnvironment -cne 'production') {
      throw 'REFUSED: production-stage mode requires a production Cosmos source snapshot.'
    }
  }
  elseif ($isProductionTarget) {
    throw 'REFUSED: the designated production PortalSAGWeb database requires explicit production-stage mode.'
  }
}

$expectedContainers = @(
  'users', 'clients', 'domains', 'databases', 'updateSchedules', 'updateTasks',
  'licenseModules', 'licenseAssignments', 'auditLogs', 'appSettings',
  'emailNotifications', 'securityRateLimits', 'authSessions', 'roles',
  'fuentesFormatos', 'formatosImpresion', 'publicDownloads'
)

function Convert-HexToBytes([string]$hex) {
  $bytes = New-Object byte[] ($hex.Length / 2)
  for ($i = 0; $i -lt $bytes.Length; $i++) {
    $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16)
  }
  return ,$bytes
}

function Get-DocumentPartitionKey([string]$container, $document) {
  switch ($container) {
    'domains' { return $document.clientId }
    'databases' { return $document.clientId }
    'updateSchedules' { return $document.clientId }
    'updateTasks' { return $document.taskBucket }
    'licenseAssignments' { return $document.clientId }
    default { return $document.id }
  }
}

function New-SafeSqlConnection {
  param(
    [string]$DataSource,
    [string]$InitialCatalog,
    [string]$SqlUsername,
    [Security.SecureString]$SecurePassword
  )

  $builder = [System.Data.SqlClient.SqlConnectionStringBuilder]::new()
  $builder['Data Source'] = $DataSource
  $builder['Initial Catalog'] = $InitialCatalog
  $builder['Encrypt'] = $true
  $builder['TrustServerCertificate'] = $false
  $builder['Connect Timeout'] = 15
  $builder['Persist Security Info'] = $false
  $builder['MultipleActiveResultSets'] = $false
  $builder['Application Name'] = 'PortalSAGWeb-RawStageImport'

  $sqlCredential = [System.Data.SqlClient.SqlCredential]::new($SqlUsername, $SecurePassword)
  $connection = [System.Data.SqlClient.SqlConnection]::new()
  $connection.ConnectionString = $builder.ConnectionString
  $connection.Credential = $sqlCredential
  return $connection
}

function Invoke-Scalar {
  param(
    [System.Data.SqlClient.SqlConnection]$Connection,
    [string]$CommandText,
    [hashtable]$Parameters = @{}
  )
  $command = $Connection.CreateCommand()
  try {
    $command.CommandTimeout = 120
    $command.CommandText = $CommandText
    foreach ($entry in $Parameters.GetEnumerator()) {
      $null = $command.Parameters.AddWithValue($entry.Key, $entry.Value)
    }
    return $command.ExecuteScalar()
  }
  finally {
    $command.Dispose()
  }
}

function Invoke-NonQuery {
  param(
    [System.Data.SqlClient.SqlConnection]$Connection,
    [string]$CommandText,
    [hashtable]$Parameters = @{}
  )
  $command = $Connection.CreateCommand()
  try {
    $command.CommandTimeout = 180
    $command.CommandText = $CommandText
    foreach ($entry in $Parameters.GetEnumerator()) {
      $null = $command.Parameters.AddWithValue($entry.Key, $entry.Value)
    }
    return $command.ExecuteNonQuery()
  }
  finally {
    $command.Dispose()
  }
}

function Write-RawContainer {
  param(
    [System.Data.SqlClient.SqlConnection]$Connection,
    [long]$RunKey,
    [string]$ContainerName,
    [object[]]$Documents
  )

  $table = [System.Data.DataTable]::new()
  $null = $table.Columns.Add('run_key', [long])
  $null = $table.Columns.Add('source_container', [string])
  $null = $table.Columns.Add('source_id', [string])
  $null = $table.Columns.Add('source_partition_key', [string])
  $null = $table.Columns.Add('raw_json', [string])
  $null = $table.Columns.Add('document_sha256', [byte[]])
  $null = $table.Columns.Add('source_etag', [string])
  $null = $table.Columns.Add('source_ts', [long])
  $null = $table.Columns.Add('processing_status', [string])

  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    foreach ($document in $Documents) {
      $rawJson = $document | ConvertTo-Json -Depth 100 -Compress
      $documentHash = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($rawJson))
      $partitionKey = Get-DocumentPartitionKey $ContainerName $document

      $row = $table.NewRow()
      $row['run_key'] = $RunKey
      $row['source_container'] = $ContainerName
      $row['source_id'] = [string]$document.id
      $row['source_partition_key'] = if ($null -eq $partitionKey) { [DBNull]::Value } else { [string]$partitionKey }
      $row['raw_json'] = $rawJson
      $row['document_sha256'] = $documentHash
      $row['source_etag'] = if ($null -eq $document._etag) { [DBNull]::Value } else { [string]$document._etag }
      $row['source_ts'] = if ($null -eq $document._ts) { [DBNull]::Value } else { [long]$document._ts }
      $row['processing_status'] = 'staged'
      $table.Rows.Add($row)
    }

    $options = [System.Data.SqlClient.SqlBulkCopyOptions]::CheckConstraints `
      -bor [System.Data.SqlClient.SqlBulkCopyOptions]::TableLock `
      -bor [System.Data.SqlClient.SqlBulkCopyOptions]::UseInternalTransaction
    $bulk = [System.Data.SqlClient.SqlBulkCopy]::new($Connection, $options, $null)
    try {
      $bulk.DestinationTableName = 'migration.raw_documents'
      $bulk.BatchSize = [Math]::Max(1, $Documents.Count)
      $bulk.BulkCopyTimeout = 300
      foreach ($column in $table.Columns) {
        $null = $bulk.ColumnMappings.Add($column.ColumnName, $column.ColumnName)
      }
      $bulk.WriteToServer($table)
    }
    finally {
      $bulk.Close()
      $bulk.Dispose()
    }
  }
  finally {
    $sha256.Dispose()
    $table.Dispose()
  }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$snapshotPath = (Resolve-Path -LiteralPath $SnapshotDirectory).Path
$manifestPath = Join-Path $snapshotPath 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw 'The snapshot manifest.json file is missing.'
}

Write-Host 'Portal SAG Web - restricted Cosmos snapshot intake' -ForegroundColor Cyan
Write-Host 'No document values, IDs, emails, hashes, or secret names will be printed.'

$validatorPath = Join-Path $repoRoot 'migration\tools\validate-cosmos-business-data.js'
& node $validatorPath $snapshotPath
if ($LASTEXITCODE -ne 0) {
  throw 'The aggregate Cosmos business validator failed.'
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$actualContainerNames = @($manifest.containers.PSObject.Properties.Name | Sort-Object)
$expectedSorted = @($expectedContainers | Sort-Object)
if (($actualContainerNames -join '|') -cne ($expectedSorted -join '|')) {
  throw 'The snapshot must contain exactly the 17 expected Cosmos containers.'
}

$documentsByContainer = [ordered]@{}
$totalDocumentCount = 0L
foreach ($containerName in $expectedContainers) {
  $containerInfo = $manifest.containers.$containerName
  if ($containerInfo.status -ne 'ok') {
    throw "Container $containerName is not marked ok in the manifest."
  }

  $containerFile = Join-Path $snapshotPath $containerInfo.file
  if (-not (Test-Path -LiteralPath $containerFile)) {
    throw "Snapshot file missing for container $containerName."
  }

  $actualFileHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $containerFile).Hash.ToLowerInvariant()
  if ($actualFileHash -cne ([string]$containerInfo.sha256).ToLowerInvariant()) {
    throw "Snapshot file hash mismatch for container $containerName."
  }

  $parsedDocuments = Get-Content -Raw -LiteralPath $containerFile | ConvertFrom-Json
  [object[]]$documents = @($parsedDocuments)
  if ($documents.Count -ne [int]$containerInfo.count) {
    throw "Snapshot count mismatch for container $containerName (manifest=$($containerInfo.count), parsed=$($documents.Count))."
  }

  $ids = @($documents | ForEach-Object { [string]$_.id })
  if (@($ids | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0) {
    throw "Container $containerName contains an empty ID."
  }
  if (@($ids | Group-Object | Where-Object Count -gt 1).Count -gt 0) {
    throw "Container $containerName contains duplicate IDs."
  }
  if (@($ids | Where-Object { $_.Length -gt 260 }).Count -gt 0) {
    throw "Container $containerName contains an ID longer than the certified 260-character SQL contract."
  }

  $partitionKeys = @($documents | ForEach-Object { Get-DocumentPartitionKey $containerName $_ } | Where-Object { $null -ne $_ })
  if (@($partitionKeys | Where-Object { ([string]$_).Length -gt 300 }).Count -gt 0) {
    throw "Container $containerName contains a partition key longer than the certified 300-character SQL contract."
  }

  $documentsByContainer[$containerName] = $documents
  $totalDocumentCount += $documents.Count
}

$oversizedAuditEntityIds = @($documentsByContainer['auditLogs'] | Where-Object {
  $null -ne $_.entityId -and ([string]$_.entityId).Length -gt 260
})
if ($oversizedAuditEntityIds.Count -gt 0) {
  throw 'The audit snapshot contains an entity ID longer than the certified 260-character SQL contract.'
}

$oversizedNotificationEntityIds = @($documentsByContainer['emailNotifications'] | Where-Object {
  $entityId = if ($null -ne $_.taskId) { $_.taskId } elseif ($null -ne $_.entityId) { $_.entityId } else { $_.key }
  $null -ne $entityId -and ([string]$entityId).Length -gt 260
})
if ($oversizedNotificationEntityIds.Count -gt 0) {
  throw 'The email notification snapshot contains an entity ID longer than the certified 260-character SQL contract.'
}

$businessReportPath = Join-Path $snapshotPath 'business-validation.json'
if (-not (Test-Path -LiteralPath $businessReportPath)) {
  throw 'The business-validation.json report was not generated.'
}
$businessReport = Get-Content -Raw -LiteralPath $businessReportPath | ConvertFrom-Json
if ($businessReport.sourceExportedAt -ne $manifest.exportedAt) {
  throw 'The business validation report does not belong to this snapshot.'
}
if ([int]$businessReport.criticalErrorCount -ne 0) {
  throw "The snapshot has $($businessReport.criticalErrorCount) critical business validation error(s)."
}
if ([int]$businessReport.documentCount -ne $totalDocumentCount) {
  throw 'The business validation document count does not match the manifest.'
}

Write-Host "Snapshot preflight passed: $($expectedContainers.Count) containers; $totalDocumentCount documents; $($businessReport.checks.Count) semantic checks; 0 critical errors; $($businessReport.warningCount) warnings." -ForegroundColor Green
if ([int]$businessReport.warningCount -gt 0) {
  Write-Host 'Warnings require explicit acceptance for the selected staging load.' -ForegroundColor Yellow
}

if (-not $Apply) {
  Write-Host 'Dry run complete. No SQL connection was opened and no data was written.' -ForegroundColor Cyan
  exit 0
}

if ([int]$businessReport.warningCount -gt 0 -and -not $AcceptKnownWarnings) {
  throw 'Use -AcceptKnownWarnings only after reviewing and approving the documented deterministic transformations.'
}
if ($DatabaseName -ne 'PortalSAGWeb') {
  throw 'The certified schema requires a non-production database named PortalSAGWeb.'
}

Write-Host
Write-Host "Target server:   $ServerName"
Write-Host "Target database: $DatabaseName"
if (-not $Confirmed) {
  $expectedConfirmation = if ($TargetEnvironment -eq 'production-stage') {
    'STAGE CURRENT SNAPSHOT PRODUCTION'
  }
  else {
    'IMPORT RAW STAGE NONPRODUCTION'
  }
  $confirmation = Read-Host "Type $expectedConfirmation to continue"
  if ($confirmation -cne $expectedConfirmation) {
    throw 'Import cancelled: the exact staging confirmation was not provided.'
  }
}

if ($null -ne $Credential) {
  if (-not [string]::IsNullOrWhiteSpace($Username) -and $Username -cne $Credential.UserName) {
    throw 'The explicit SQL username does not match the supplied credential.'
  }
  $Username = $Credential.UserName
  $securePassword = $Credential.Password
}
else {
  if ([string]::IsNullOrWhiteSpace($Username)) {
    $Username = (Read-Host 'SQL Authentication username').Trim()
  }
  $securePassword = Read-Host 'SQL Authentication password' -AsSecureString
}
if ([string]::IsNullOrWhiteSpace($Username)) {
  throw 'The SQL Authentication username is required.'
}
if (-not $securePassword.IsReadOnly()) { $securePassword.MakeReadOnly() }

$connection = New-SafeSqlConnection $ServerName $DatabaseName $Username $securePassword
$runKey = 0L
$sessionExecutingAsDbo = $false
try {
  $connection.Open()

  if ($TargetEnvironment -eq 'production-stage') {
    $permissionCommand = $connection.CreateCommand()
    try {
      $permissionCommand.CommandText = @'
SELECT
  ISNULL(IS_ROLEMEMBER(N'db_owner'), 0) AS is_db_owner,
  ISNULL(HAS_PERMS_BY_NAME(DB_NAME(),N'DATABASE',N'CONTROL'), 0) AS has_database_control;
'@
      $permissionReader = $permissionCommand.ExecuteReader()
      if (-not $permissionReader.Read()) {
        throw 'Unable to verify the production migration capability.'
      }
      $isDbOwner = [Convert]::ToInt32($permissionReader.GetValue(0))
      $hasDatabaseControl = [Convert]::ToInt32($permissionReader.GetValue(1))
      $permissionReader.Close()
      if ($isDbOwner -ne 1 -or $hasDatabaseControl -ne 1) {
        throw 'Production staging requires the supplied login to have both db_owner and database CONTROL.'
      }
    }
    finally {
      $permissionCommand.Dispose()
    }

    $executeAsCommand = $connection.CreateCommand()
    try {
      $executeAsCommand.CommandText = "EXECUTE AS USER=N'dbo';"
      $null = $executeAsCommand.ExecuteNonQuery()
      $sessionExecutingAsDbo = $true
    }
    finally {
      $executeAsCommand.Dispose()
    }
    Write-Host 'Authorized production staging context opened; existing permission memberships and grants were preserved.' -ForegroundColor Yellow
  }

  $preflightCommand = $connection.CreateCommand()
  $preflightCommand.CommandText = @'
SELECT
  CAST(SERVERPROPERTY('ProductMajorVersion') AS INT) AS major_version,
  d.compatibility_level,
  d.collation_name,
  CASE WHEN OBJECT_ID(N'migration.usp_project_raw_to_stage', N'P') IS NULL THEN 0 ELSE 1 END AS has_stage_projector,
  CASE WHEN EXISTS (SELECT 1 FROM migration.schema_migrations WHERE migration_version = '008' AND succeeded = 1) THEN 1 ELSE 0 END AS has_008,
  CASE WHEN EXISTS (SELECT 1 FROM migration.schema_migrations WHERE migration_version = '020' AND succeeded = 1) THEN 1 ELSE 0 END AS has_020,
  ISNULL((SELECT MAX(migration_version) FROM migration.schema_migrations WHERE succeeded = 1), N'008') AS schema_version,
  (
    (SELECT COUNT_BIG(*) FROM core.clients) +
    (SELECT COUNT_BIG(*) FROM core.domains) +
    (SELECT COUNT_BIG(*) FROM core.databases) +
    (SELECT COUNT_BIG(*) FROM licensing.license_modules) +
    (SELECT COUNT_BIG(*) FROM licensing.license_assignments) +
    (SELECT COUNT_BIG(*) FROM scheduling.update_schedules) +
    (SELECT COUNT_BIG(*) FROM workflow.update_tasks) +
    (SELECT COUNT_BIG(*) FROM content.files) +
    (SELECT COUNT_BIG(*) FROM notifications.email_notifications) +
    (SELECT COUNT_BIG(*) FROM audit.audit_logs)
  ) AS operational_row_count
FROM sys.databases AS d
WHERE d.database_id = DB_ID();
'@
  $reader = $preflightCommand.ExecuteReader()
  if (-not $reader.Read()) { throw 'Unable to read SQL preflight metadata.' }
  $majorVersion = $reader.GetInt32(0)
  $compatibilityLevel = $reader.GetByte(1)
  $collationName = $reader.GetString(2)
  $hasProjector = $reader.GetInt32(3)
  $has008 = $reader.GetInt32(4)
  $has020 = $reader.GetInt32(5)
  $schemaVersion = $reader.GetString(6)
  $operationalRowCount = $reader.GetInt64(7)
  $reader.Close()
  $preflightCommand.Dispose()

  if ($majorVersion -ne 15) { throw "Expected SQL Server 2019 major version 15; found $majorVersion." }
  if ($compatibilityLevel -ne 150) { throw "Expected compatibility level 150; found $compatibilityLevel." }
  if ($collationName -ne 'Modern_Spanish_CI_AS') { throw "Unexpected collation: $collationName." }
  if ($hasProjector -ne 1 -or $has008 -ne 1) { throw 'Migration 008 and its stage projector must be installed first.' }
  if ($TargetEnvironment -eq 'production-stage' -and $has020 -ne 1) {
    throw 'Production staging requires the reviewed schema through migration 020.'
  }
  if ($TargetEnvironment -eq 'nonproduction' -and $operationalRowCount -ne 0) {
    throw 'Non-production raw/stage import requires empty operational tables in the disposable database.'
  }

  $snapshotName = Split-Path -Leaf $snapshotPath
  $manifestHash = Convert-HexToBytes ((Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash.ToLowerInvariant())

  if ($ResumeRunKey -gt 0) {
    $resumeCommand = $connection.CreateCommand()
    $resumeCommand.CommandText = 'SELECT snapshot_name, status FROM migration.migration_runs WHERE run_key=@run_key;'
    $null = $resumeCommand.Parameters.Add('@run_key', [Data.SqlDbType]::BigInt)
    $resumeCommand.Parameters['@run_key'].Value = $ResumeRunKey
    $reader = $resumeCommand.ExecuteReader()
    if (-not $reader.Read()) { throw 'The requested resume run does not exist.' }
    $existingSnapshotName = $reader.GetString(0)
    $existingStatus = $reader.GetString(1)
    $reader.Close()
    $resumeCommand.Dispose()
    if ($existingSnapshotName -cne $snapshotName) { throw 'The resume run belongs to a different snapshot.' }
    if ($existingStatus -notin @('staging', 'validating', 'failed', 'validated')) { throw "Run status $existingStatus cannot be resumed." }
    $runKey = $ResumeRunKey
    if ($existingStatus -eq 'validated') {
      Write-Host "Run $runKey is already validated; no data was rewritten." -ForegroundColor Green
      exit 0
    }
    $null = Invoke-NonQuery $connection 'UPDATE migration.migration_runs SET status=''staging'', completed_at=NULL WHERE run_key=@run_key;' @{ '@run_key' = $runKey }
  }
  else {
    $createRun = $connection.CreateCommand()
    $createRun.CommandText = @'
INSERT migration.migration_runs
  (snapshot_name, snapshot_sha256, source_environment, application_version, schema_version,
   status, source_document_count, critical_error_count, warning_count, initiated_by, notes)
OUTPUT INSERTED.run_key
VALUES
  (@snapshot_name, @snapshot_sha256, @source_environment, @application_version, @schema_version,
   'staging', @source_document_count, 0, @warning_count, ORIGINAL_LOGIN(), N'Raw/stage import only; no operational rows loaded.');
'@
    $null = $createRun.Parameters.Add('@snapshot_name', [Data.SqlDbType]::NVarChar, 260)
    $null = $createRun.Parameters.Add('@snapshot_sha256', [Data.SqlDbType]::Binary, 32)
    $null = $createRun.Parameters.Add('@source_environment', [Data.SqlDbType]::NVarChar, 80)
    $null = $createRun.Parameters.Add('@application_version', [Data.SqlDbType]::NVarChar, 80)
    $null = $createRun.Parameters.Add('@schema_version', [Data.SqlDbType]::NVarChar, 40)
    $null = $createRun.Parameters.Add('@source_document_count', [Data.SqlDbType]::BigInt)
    $null = $createRun.Parameters.Add('@warning_count', [Data.SqlDbType]::Int)
    $createRun.Parameters['@snapshot_name'].Value = $snapshotName
    $createRun.Parameters['@snapshot_sha256'].Value = $manifestHash
    $createRun.Parameters['@source_environment'].Value = "cosmos-$SourceEnvironment"
    $createRun.Parameters['@application_version'].Value = '1.0.0'
    $createRun.Parameters['@schema_version'].Value = $schemaVersion
    $createRun.Parameters['@source_document_count'].Value = $totalDocumentCount
    $createRun.Parameters['@warning_count'].Value = [int]$businessReport.warningCount
    $runKey = [long]$createRun.ExecuteScalar()
    $createRun.Dispose()
  }

  $null = Invoke-NonQuery $connection 'DELETE FROM migration.validation_results WHERE run_key=@run_key;' @{ '@run_key' = $runKey }
  foreach ($check in $businessReport.checks) {
    $resolution = if ([int]$check.count -eq 0) { 'resolved' } elseif ($check.severity -eq 'warning' -and $AcceptKnownWarnings) { 'accepted' } else { 'open' }
    $insertValidation = $connection.CreateCommand()
    try {
      $insertValidation.CommandText = @'
INSERT migration.validation_results
  (run_key, rule_code, severity, expected_summary, actual_summary, resolution_status,
   resolution_note, approved_by, approved_at)
VALUES
  (@run_key, @rule_code, @severity, N'count=0', @actual_summary, @resolution_status,
   @resolution_note, @approved_by, @approved_at);
'@
      $null = $insertValidation.Parameters.Add('@run_key', [Data.SqlDbType]::BigInt)
      $null = $insertValidation.Parameters.Add('@rule_code', [Data.SqlDbType]::NVarChar, 160)
      $null = $insertValidation.Parameters.Add('@severity', [Data.SqlDbType]::VarChar, 10)
      $null = $insertValidation.Parameters.Add('@actual_summary', [Data.SqlDbType]::NVarChar, 1000)
      $null = $insertValidation.Parameters.Add('@resolution_status', [Data.SqlDbType]::VarChar, 20)
      $null = $insertValidation.Parameters.Add('@resolution_note', [Data.SqlDbType]::NVarChar, 2000)
      $null = $insertValidation.Parameters.Add('@approved_by', [Data.SqlDbType]::NVarChar, 150)
      $null = $insertValidation.Parameters.Add('@approved_at', [Data.SqlDbType]::DateTime2)
      $insertValidation.Parameters['@run_key'].Value = $runKey
      $insertValidation.Parameters['@rule_code'].Value = [string]$check.id
      $insertValidation.Parameters['@severity'].Value = [string]$check.severity
      $insertValidation.Parameters['@actual_summary'].Value = "count=$($check.count); passed=$($check.passed)"
      $insertValidation.Parameters['@resolution_status'].Value = $resolution
      $insertValidation.Parameters['@resolution_note'].Value = if ($resolution -eq 'accepted') { "Known deterministic transformation reviewed before $TargetEnvironment load." } else { [DBNull]::Value }
      $insertValidation.Parameters['@approved_by'].Value = if ($resolution -eq 'accepted') { 'migration_operator' } else { [DBNull]::Value }
      $insertValidation.Parameters['@approved_at'].Value = if ($resolution -eq 'accepted') { [DateTime]::UtcNow } else { [DBNull]::Value }
      $null = $insertValidation.ExecuteNonQuery()
    }
    finally {
      $insertValidation.Dispose()
    }
  }

  foreach ($containerName in $expectedContainers) {
    $expectedCount = [long]$manifest.containers.$containerName.count
    $existingCount = [long](Invoke-Scalar $connection `
      'SELECT COUNT_BIG(*) FROM migration.raw_documents WHERE run_key=@run_key AND source_container=@container;' `
      @{ '@run_key' = $runKey; '@container' = $containerName })

    if ($existingCount -eq $expectedCount) {
      Write-Host "- $containerName already complete ($expectedCount); skipped."
      continue
    }
    if ($existingCount -ne 0) {
      throw "Container $containerName is partially loaded ($existingCount/$expectedCount). Start a new run rather than deleting evidence silently."
    }

    Write-Host "- staging raw container $containerName ($expectedCount)..."
    Write-RawContainer $connection $runKey $containerName $documentsByContainer[$containerName]
    $null = Invoke-NonQuery $connection @'
UPDATE migration.migration_runs
SET staged_document_count = (SELECT COUNT_BIG(*) FROM migration.raw_documents WHERE run_key=@run_key)
WHERE run_key=@run_key;
'@ @{ '@run_key' = $runKey }
  }

  $projectCommand = $connection.CreateCommand()
  try {
    $projectCommand.CommandTimeout = 600
    $projectCommand.CommandText = 'EXEC migration.usp_project_raw_to_stage @run_key;'
    $null = $projectCommand.Parameters.Add('@run_key', [Data.SqlDbType]::BigInt)
    $projectCommand.Parameters['@run_key'].Value = $runKey
    $null = $projectCommand.ExecuteNonQuery()
  }
  finally {
    $projectCommand.Dispose()
  }

  $reconciliationCommand = $connection.CreateCommand()
  $reconciliationCommand.CommandText = @'
SELECT
  r.status,
  (SELECT COUNT_BIG(*) FROM migration.raw_documents WHERE run_key=@run_key) AS raw_count,
  (SELECT COUNT_BIG(*) FROM migration.reconciliation_counts WHERE run_key=@run_key AND reconciliation_code LIKE N'stage_count:%') AS check_count,
  (SELECT COUNT_BIG(*) FROM migration.reconciliation_counts WHERE run_key=@run_key AND reconciliation_code LIKE N'stage_count:%' AND reconciled=0) AS failed_count,
  (SELECT COUNT_BIG(*) FROM migration.validation_results WHERE run_key=@run_key AND severity='critical' AND resolution_status='open') AS open_critical_count
FROM migration.migration_runs AS r
WHERE r.run_key=@run_key;
'@
  $null = $reconciliationCommand.Parameters.Add('@run_key', [Data.SqlDbType]::BigInt)
  $reconciliationCommand.Parameters['@run_key'].Value = $runKey
  $reader = $reconciliationCommand.ExecuteReader()
  $null = $reader.Read()
  $runStatus = $reader.GetString(0)
  $rawCount = $reader.GetInt64(1)
  $stageCheckCount = $reader.GetInt64(2)
  $failedStageCount = $reader.GetInt64(3)
  $openCriticalCount = $reader.GetInt64(4)
  $reader.Close()
  $reconciliationCommand.Dispose()

  if ($runStatus -ne 'validated' -or $rawCount -ne $totalDocumentCount -or $stageCheckCount -ne 17 -or $failedStageCount -ne 0 -or $openCriticalCount -ne 0) {
    throw 'Raw/stage reconciliation did not satisfy the Gate D checkpoint.'
  }

  Write-Host
  Write-Host "Raw/stage import validated safely. Run key: $runKey" -ForegroundColor Green
  Write-Host "Raw documents: $rawCount; reconciled stage containers: $stageCheckCount; failed: $failedStageCount."
  Write-Host 'Operational tables and Blob Storage were not modified.' -ForegroundColor Cyan
}
catch {
  if ($connection.State -eq [Data.ConnectionState]::Open -and $runKey -gt 0) {
    try {
      $safeMessage = $_.Exception.Message
      if ($safeMessage.Length -gt 1500) { $safeMessage = $safeMessage.Substring(0, 1500) }
      $null = Invoke-NonQuery $connection @'
UPDATE migration.migration_runs
SET status='failed', completed_at=SYSUTCDATETIME(), notes=@notes
WHERE run_key=@run_key;
'@ @{ '@run_key' = $runKey; '@notes' = $safeMessage }
    }
    catch {
      # Preserve the original failure; the run can be inspected by the migrator account.
    }
  }
  throw
}
finally {
  if ($sessionExecutingAsDbo -and $connection.State -eq [Data.ConnectionState]::Open) {
    try {
      $revertCommand = $connection.CreateCommand()
      $revertCommand.CommandText = 'REVERT;'
      $null = $revertCommand.ExecuteNonQuery()
      $revertCommand.Dispose()
    }
    catch {
      # Closing the connection also releases the impersonation context.
    }
  }
  if ($connection.State -ne [Data.ConnectionState]::Closed) { $connection.Close() }
  $connection.Dispose()
  $securePassword = $null
  $documentsByContainer.Clear()
}
