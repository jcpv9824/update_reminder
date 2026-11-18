[CmdletBinding()]
param(
  [ValidateSet('qa','production')]
  [string]$Environment='qa',

  [string]$SessionDirectory,

  [switch]$IncludeCatalog
)

$ErrorActionPreference='Stop'
$repoMigrationRoot=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$sqlDirectory=Join-Path $repoMigrationRoot 'sql'
$manifestPath=Join-Path $sqlDirectory 'MANIFEST.sha256'
$clientPath=Join-Path $repoMigrationRoot 'connect-sql-server\Invoke-PortalSAGWeb-EphemeralRequest.ps1'
if([string]::IsNullOrWhiteSpace($SessionDirectory)){
  $sessionName=if($Environment -eq 'qa'){'sql-session-qa'}else{'sql-session'}
  $SessionDirectory=Join-Path $repoMigrationRoot "work\$sessionName"
}

$descriptorPath=Join-Path $SessionDirectory 'active.json'
if(-not (Test-Path -LiteralPath $descriptorPath)){throw "No active $Environment SQL session was found."}
$descriptor=Get-Content -Raw -LiteralPath $descriptorPath | ConvertFrom-Json
$expectedDatabase=if($Environment -eq 'qa'){'PortalSAGWeb-TEST'}else{'PortalSAGWeb'}
if($descriptor.environment -ne $Environment -or $descriptor.database -ne $expectedDatabase){
  throw "The active session does not target $Environment / $expectedDatabase."
}
if($descriptor.fullControl -ne $true -or $descriptor.accessLevel -ne 'full-control'){
  throw 'The active session is not authorized for full-control migrations.'
}

function Get-Sha256Hex([string]$Path){
  $stream=[IO.File]::OpenRead($Path)
  $sha=[Security.Cryptography.SHA256]::Create()
  try{return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}
  finally{$sha.Dispose();$stream.Dispose()}
}

function Invoke-SessionSql {
  param(
    [Parameter(Mandatory=$true)][string]$Sql,
    [ValidateSet('read','write')][string]$Mode,
    [int]$TimeoutSeconds=600,
    [int]$MaxRows=100
  )
  $json=& $clientPath -Sql $Sql -Mode $Mode -SessionDirectory $SessionDirectory `
    -TimeoutSeconds $TimeoutSeconds -MaxRows $MaxRows
  return $json | ConvertFrom-Json -Depth 12
}

$manifest=@{}
foreach($line in Get-Content -LiteralPath $manifestPath){
  if($line -match '^([a-fA-F0-9]{64})\s{2}(.+\.sql)$'){
    $manifest[$Matches[2]]=$Matches[1].ToLowerInvariant()
  }
}

$migrations=@(
  @{version='017';name='017_normalize_domain_url_identity.sql'},
  @{version='018';name='018_expand_license_module_description.sql'},
  @{version='019';name='019_expand_notification_outbox_types.sql'},
  @{version='020';name='020_allow_outbox_attempt_completion.sql'},
  @{version='021';name='021_atomic_operational_refresh.sql'},
  @{version='022';name='022_refresh_print_source_assignments.sql'},
  @{version='023';name='023_enable_masters_report_outbox.sql'},
  @{version='024';name='024_s3_object_storage.sql'},
  @{version='025';name='025_separate_public_downloads_and_inline_files.sql'},
  @{version='026';name='026_guide_builder.sql'},
  @{version='027';name='027_integration_connections.sql'},
  @{version='028';name='028_company_logo_permissions.sql'},
  @{version='029';name='029_company_storage_labels.sql'},
  @{version='030';name='030_object_storage_profiles.sql'}
)

if($IncludeCatalog){
  $migrations += @(
    @{version='031';name='031_catalog_source_bindings.sql'},
    @{version='032';name='032_catalog_task_execution.sql'},
    @{version='033';name='033_catalog_customer_snapshots.sql'},
    @{version='034';name='034_catalog_source_access.sql'},
    @{version='035';name='035_catalog_sag_discovery_evidence.sql'},
    @{version='036';name='036_catalog_physical_targets.sql'}
  )
  # Check the entire selected package before submitting its first write.
  foreach($entry in $migrations){
    $name=[string]$entry.name
    $path=Join-Path $sqlDirectory $name
    if(-not (Test-Path -LiteralPath $path) -or -not $manifest.ContainsKey($name) -or
       (Get-Sha256Hex $path) -cne $manifest[$name]){
      throw "Catalog deployment package validation failed for $name."
    }
  }
}

foreach($migration in $migrations){
  $version=[string]$migration.version
  $name=[string]$migration.name
  $path=Join-Path $sqlDirectory $name
  if(-not (Test-Path -LiteralPath $path)){throw "Missing migration script: $name"}
  if(-not $manifest.ContainsKey($name)){throw "The manifest does not contain $name."}
  $hash=Get-Sha256Hex $path
  if($hash -cne $manifest[$name]){throw "Manifest checksum mismatch for $name."}

  $statusSql=@"
SELECT migration_version,CONVERT(VARCHAR(64),script_sha256,2) AS script_sha256,succeeded
FROM migration.schema_migrations
WHERE migration_version='$version';
"@
  $status=Invoke-SessionSql -Sql $statusSql -Mode read -TimeoutSeconds 120 -MaxRows 5
  $rows=@($status.resultSets[0].rows)
  if($rows.Count -gt 0){
    if(([string]$rows[0].script_sha256).ToLowerInvariant() -cne $hash -or $rows[0].succeeded -ne $true){
      throw "Migration history for $version conflicts with the reviewed script."
    }
    Write-Host "SKIP $version - already applied with the reviewed checksum." -ForegroundColor Cyan
    continue
  }

  Write-Host "APPLY $version - $name" -ForegroundColor Yellow
  $applyJson=& $clientPath -SqlFile $path -Mode write -SessionDirectory $SessionDirectory `
    -TimeoutSeconds 900 -MaxRows 100
  $null=$applyJson | ConvertFrom-Json -Depth 12

  $historySql=@"
SET XACT_ABORT ON;
BEGIN TRANSACTION;
IF EXISTS(SELECT 1 FROM migration.schema_migrations WHERE migration_version='$version')
  THROW 51980,N'Migration history changed concurrently.',1;
INSERT migration.schema_migrations
  (migration_version,script_name,script_sha256,duration_ms,succeeded)
VALUES
  ('$version',N'$name',0x$hash,0,1);
COMMIT TRANSACTION;
"@
  $null=Invoke-SessionSql -Sql $historySql -Mode write -TimeoutSeconds 120 -MaxRows 10
  Write-Host "PASS $version" -ForegroundColor Green
}

$verificationSql=@'
SELECT
  (SELECT COUNT(*) FROM migration.schema_migrations WHERE migration_version IN ('017','018','019','020','021','022','023','024','025','026','027','028','029','030') AND succeeded=1) AS applied_count,
  (SELECT COUNT_BIG(*) FROM core.domains WHERE RIGHT(domain_name_normalized,1)=N'/') AS trailing_domain_identities,
  COL_LENGTH(N'licensing.license_modules',N'description') AS license_description_bytes,
  (SELECT COUNT(*) FROM sys.check_constraints
   WHERE parent_object_id=OBJECT_ID(N'notifications.email_notifications')
     AND name=N'CK_email_notifications_type'
     AND definition LIKE N'%task_status_notification%'
     AND definition LIKE N'%test_email%'
     AND definition LIKE N'%masters_report%'
     AND is_disabled=0 AND is_not_trusted=0) AS outbox_constraint_ready,
  (SELECT COUNT(*) FROM sys.foreign_keys WHERE is_disabled=1 OR is_not_trusted=1) AS untrusted_or_disabled_fks,
  (SELECT COUNT(*) FROM sys.check_constraints WHERE is_disabled=1 OR is_not_trusted=1) AS untrusted_or_disabled_checks,
  (SELECT COUNT(*) FROM sys.triggers
   WHERE object_id=OBJECT_ID(N'notifications.TR_notification_attempts_append_only')
     AND OBJECT_DEFINITION(object_id) LIKE N'%processing-to-terminal completion%') AS attempt_completion_trigger_ready,
  (SELECT COUNT(*) FROM sys.indexes
   WHERE object_id=OBJECT_ID(N'migration.file_transfers')
     AND name=N'UX_file_transfers_run_blob' AND is_unique=1) AS per_run_blob_index_ready,
  CASE WHEN OBJECT_ID(N'migration.usp_replace_operational_from_validated_run',N'P') IS NULL
    THEN 0 ELSE 1 END AS atomic_refresh_ready,
  CASE WHEN OBJECT_DEFINITION(OBJECT_ID(N'migration.usp_replace_operational_from_validated_run'))
      LIKE N'%EXEC migration.usp_load_operational_final_with_print_sources @run_key;%'
    THEN 1 ELSE 0 END AS refresh_print_sources_ready,
  CASE WHEN OBJECT_ID(N'content.public_files',N'U') IS NOT NULL
      AND OBJECT_ID(N'content.public_file_versions',N'U') IS NOT NULL
    THEN 1 ELSE 0 END AS public_files_ready,
  COLUMNPROPERTY(OBJECT_ID(N'content.public_download_documents'),N'section_key',N'AllowsNull')
    AS downloads_section_optional,
  (SELECT COUNT(*) FROM security.permissions
    WHERE option_key=N'public_files' AND active=1) AS public_files_permission_count,
  (SELECT COUNT(*) FROM sys.tables
    WHERE schema_id=SCHEMA_ID(N'content') AND name LIKE N'guide[_]%') AS guide_table_count,
  CASE WHEN OBJECT_ID(N'content.object_deletion_claims',N'U') IS NULL
    THEN 0 ELSE 1 END AS deletion_claims_ready,
  (SELECT COUNT(*) FROM security.permissions
    WHERE module_key=N'help' AND option_key=N'guide_builder' AND active=1) AS guide_permission_count,
  (SELECT COUNT(*) FROM security.role_permissions
    WHERE role_id=N'super_admin' AND permission_key LIKE N'help.guide_builder.%') AS guide_super_admin_permission_count,
  CASE WHEN OBJECT_ID(N'settings.object_storage_connections',N'U') IS NOT NULL
      AND OBJECT_ID(N'settings.external_database_connections',N'U') IS NOT NULL
    THEN 1 ELSE 0 END AS integration_tables_ready,
  (SELECT COUNT(*) FROM security.permissions
    WHERE module_key=N'configuration' AND option_key=N'integrations' AND active=1) AS integration_permission_count,
  (SELECT COUNT(*) FROM security.role_permissions
    WHERE role_id=N'super_admin' AND permission_key LIKE N'configuration.integrations.%') AS integration_super_admin_permission_count,
  (SELECT COUNT(*) FROM security.permissions
    WHERE module_key=N'implementation' AND option_key=N'company_logo' AND active=1) AS company_logo_permission_count,
  (SELECT COUNT(*) FROM security.role_permissions
    WHERE role_id=N'super_admin' AND permission_key LIKE N'implementation.company[_]logo.%') AS company_logo_super_admin_permission_count,
  (SELECT COUNT(*) FROM security.permissions
    WHERE permission_key LIKE N'implementation.company[_]logo.%'
      AND description LIKE N'Almacenamiento de archivos y logo / %' AND active=1) AS company_storage_label_count,
  COL_LENGTH(N'settings.object_storage_connections',N'database_name') AS storage_database_name_bytes,
  (SELECT COUNT(*) FROM sys.check_constraints
    WHERE parent_object_id=OBJECT_ID(N'settings.object_storage_connections')
      AND name IN (N'CK_object_storage_connections_endpoint', N'CK_object_storage_connections_database')
      AND is_disabled=0 AND is_not_trusted=0) AS storage_profile_check_count;
'@
$verification=Invoke-SessionSql -Sql $verificationSql -Mode read -TimeoutSeconds 120 -MaxRows 10
$row=$verification.resultSets[0].rows[0]
if($row.applied_count -ne 14 -or $row.trailing_domain_identities -ne 0 -or
   $row.license_description_bytes -ne 4000 -or $row.outbox_constraint_ready -ne 1 -or
   $row.untrusted_or_disabled_fks -ne 0 -or $row.untrusted_or_disabled_checks -ne 0 -or
   $row.attempt_completion_trigger_ready -ne 1 -or $row.per_run_blob_index_ready -ne 1 -or
   $row.atomic_refresh_ready -ne 1 -or $row.refresh_print_sources_ready -ne 1 -or
   $row.public_files_ready -ne 1 -or $row.downloads_section_optional -ne 1 -or
   $row.public_files_permission_count -ne 5 -or $row.guide_table_count -ne 8 -or
   $row.deletion_claims_ready -ne 1 -or
   $row.guide_permission_count -ne 8 -or $row.guide_super_admin_permission_count -ne 8 -or
   $row.integration_tables_ready -ne 1 -or $row.integration_permission_count -ne 7 -or
   $row.integration_super_admin_permission_count -ne 7 -or
   $row.company_logo_permission_count -ne 2 -or $row.company_logo_super_admin_permission_count -ne 2 -or
   $row.company_storage_label_count -ne 2 -or
   $row.storage_database_name_bytes -ne 256 -or $row.storage_profile_check_count -ne 2){
  throw 'Pending-migration post-verification failed.'
}

Write-Host "$expectedDatabase migrations 017-030 are applied and verified." -ForegroundColor Green

if($IncludeCatalog){
  $catalogVerificationSql=@'
SELECT
  (SELECT COUNT(*) FROM migration.schema_migrations
    WHERE migration_version IN ('031','032','033','034','035','036') AND succeeded=1) AS catalog_migration_count,
  (SELECT COUNT(*) FROM (VALUES
    (N'settings.catalog_source_bindings'), (N'workflow.catalog_task_executions'),
    (N'workflow.catalog_task_execution_links'), (N'workflow.catalog_task_execution_sources'),
    (N'workflow.catalog_task_execution_events'), (N'core.catalog_customer_source_revisions'),
    (N'settings.catalog_customer_revision_heads'), (N'security.catalog_source_readers'),
    (N'core.catalog_sag_revision_evidence'), (N'core.catalog_physical_targets'),
    (N'core.catalog_physical_target_links')) AS expected(name)
    WHERE OBJECT_ID(expected.name,N'U') IS NOT NULL) AS catalog_tables_ready,
  (SELECT COUNT(*) FROM sys.triggers WHERE is_disabled=0 AND object_id IN (
    OBJECT_ID(N'core.TR_catalog_sag_revision_evidence_sealed',N'TR'),
    OBJECT_ID(N'core.TR_catalog_sag_revision_evidence_assert',N'TR'),
    OBJECT_ID(N'workflow.TR_catalog_task_execution_events_immutable',N'TR'),
    OBJECT_ID(N'settings.TR_catalog_customer_revision_heads_publish',N'TR'),
    OBJECT_ID(N'core.TR_catalog_physical_targets_immutable',N'TR'),
    OBJECT_ID(N'core.TR_catalog_physical_target_links_evidence',N'TR'),
    OBJECT_ID(N'core.TR_domains_catalog_route_retirement',N'TR'))) AS catalog_triggers_ready,
  CASE WHEN COL_LENGTH(N'core.catalog_customer_source_revisions',N'has_sag_inventory_evidence')=1
    THEN 1 ELSE 0 END AS sag_evidence_flag_ready;
'@
  $catalogVerification=Invoke-SessionSql -Sql $catalogVerificationSql -Mode read -TimeoutSeconds 120 -MaxRows 5
  $catalogRow=$catalogVerification.resultSets[0].rows[0]
  if($catalogRow.catalog_migration_count -ne 6 -or $catalogRow.catalog_tables_ready -ne 11 -or
     $catalogRow.catalog_triggers_ready -ne 7 -or $catalogRow.sag_evidence_flag_ready -ne 1){
    throw 'Catalog migration post-verification failed.'
  }
  Write-Host "$expectedDatabase migrations 031-036 are applied and verified." -ForegroundColor Green
}
