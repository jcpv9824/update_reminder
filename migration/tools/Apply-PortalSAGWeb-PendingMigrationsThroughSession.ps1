[CmdletBinding()]
param(
  [ValidateSet('qa','production')]
  [string]$Environment='qa',

  [string]$SessionDirectory,

  [switch]$IncludeCatalog,

  [switch]$IncludeCatalogOwnerPublisher,

  [switch]$IncludeCatalogErpOwnerPublisher,

  [switch]$IncludeCatalogObservedInventory,
  [switch]$IncludeCatalogDirectoryV2
)

$ErrorActionPreference='Stop'
if($IncludeCatalogOwnerPublisher -and -not $IncludeCatalog){
  throw 'The optional owner publisher requires -IncludeCatalog as well.'
}
if($IncludeCatalogErpOwnerPublisher -and -not ($IncludeCatalog -and $IncludeCatalogOwnerPublisher)){
  throw 'The ERP owner publisher requires both -IncludeCatalog and -IncludeCatalogOwnerPublisher.'
}
if($IncludeCatalogObservedInventory -and -not ($IncludeCatalog -and $IncludeCatalogOwnerPublisher)){
  throw 'Observed inventory requires both -IncludeCatalog and -IncludeCatalogOwnerPublisher.'
}
if($IncludeCatalogDirectoryV2 -and -not ($IncludeCatalog -and $IncludeCatalogOwnerPublisher -and $IncludeCatalogObservedInventory)){
  throw 'Catalog directory v2 requires the catalog, SAG owner publisher and observed inventory.'
}
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
    @{version='036';name='036_catalog_physical_targets.sql'},
    @{version='037';name='037_catalog_reporting_profiles.sql'},
    @{version='038';name='038_catalog_match_key_registry.sql'},
    @{version='039';name='039_catalog_physical_registration_time.sql'},
    @{version='040';name='040_catalog_sag_license_module_map.sql'},
    @{version='041';name='041_catalog_sag_license_approval_versions.sql'},
    @{version='042';name='042_catalog_operational_links.sql'},
    @{version='043';name='043_catalog_domain_scope.sql'},
    @{version='044';name='044_catalog_schedule_operation_approvals.sql'},
    @{version='045';name='045_catalog_schedule_operation_token_check.sql'},
    @{version='046';name='046_catalog_schedule_population_approvals.sql'},
    @{version='047';name='047_catalog_manual_day_intents.sql'},
    @{version='048';name='048_catalog_task_origin_receipts.sql'},
    @{version='049';name='049_catalog_once_observations.sql'},
    @{version='050';name='050_catalog_once_completion_witnesses.sql'},
    @{version='051';name='051_catalog_refresh_queue.sql'},
    @{version='052';name='052_catalog_sag_company_evidence.sql'},
    @{version='053';name='053_catalog_sag_v2_publication.sql'},
    @{version='054';name='054_catalog_sql_target_instance_identity.sql'},
    @{version='055';name='055_catalog_sag_target_observations.sql'},
    @{version='056';name='056_catalog_sag_target_link_proof.sql'},
    @{version='057';name='057_catalog_sag_target_runtime_gate.sql'},
    @{version='058';name='058_catalog_sql_target_instance_enrollment.sql'},
    @{version='059';name='059_catalog_sag_v2_license_approval.sql'}
  )
  if($IncludeCatalogOwnerPublisher){
    $migrations += @{version='064';name='064_catalog_sag_owner_publisher.sql'}
  }
  if($IncludeCatalogErpOwnerPublisher){
    $migrations += @{version='065';name='065_catalog_erp_owner_publisher.sql'}
  }
  if($IncludeCatalogObservedInventory){
    $migrations += @{version='066';name='066_catalog_sag_database_names.sql'}
  }
  if($IncludeCatalogDirectoryV2){
    $migrations += @{version='067';name='067_catalog_sag_customer_directory.sql'}
  }
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
    WHERE migration_version IN ('031','032','033','034','035','036','037','038','039','040','041','042','043','044','045','046','047','048','049','050','051','052','053','054','055','056','057','058','059') AND succeeded=1) AS catalog_migration_count,
  (SELECT COUNT(*) FROM (VALUES
    (N'settings.catalog_source_bindings'), (N'workflow.catalog_task_executions'),
    (N'workflow.catalog_task_execution_links'), (N'workflow.catalog_task_execution_sources'),
    (N'workflow.catalog_task_execution_events'), (N'core.catalog_customer_source_revisions'),
    (N'settings.catalog_customer_revision_heads'), (N'security.catalog_source_readers'),
    (N'core.catalog_sag_revision_evidence'), (N'core.catalog_physical_targets'),
    (N'core.catalog_physical_target_links'),(N'settings.catalog_reporting_profiles'),
    (N'settings.catalog_match_key_registry'), (N'settings.catalog_sag_license_module_map'),
    (N'settings.catalog_sag_license_module_approvals'),(N'core.catalog_operational_owners'),
    (N'core.catalog_operational_links'),(N'core.catalog_operational_link_approvals'),
    (N'scheduling.catalog_schedule_operation_approvals'), (N'scheduling.catalog_schedule_population_approvals'),
    (N'scheduling.catalog_manual_day_intents'), (N'workflow.catalog_task_origin_receipts'),
    (N'scheduling.catalog_once_observations'), (N'scheduling.catalog_once_observation_pairs'),
    (N'settings.catalog_source_head_events'), (N'scheduling.catalog_once_source_witnesses'),
    (N'scheduling.catalog_once_closure_scan_cursors'), (N'settings.catalog_source_refresh_jobs'),
    (N'settings.catalog_source_refresh_attempts'),(N'core.catalog_sag_company_revision_rows'),
    (N'core.catalog_sql_target_instance_identities'),(N'core.catalog_sag_company_location_observations'),
    (N'core.catalog_sag_company_location_seals')) AS expected(name)
    WHERE OBJECT_ID(expected.name,N'U') IS NOT NULL) AS catalog_tables_ready,
  (SELECT COUNT(*) FROM sys.triggers WHERE is_disabled=0 AND object_id IN (
    OBJECT_ID(N'core.TR_catalog_sag_revision_evidence_sealed',N'TR'),
    OBJECT_ID(N'core.TR_catalog_sag_revision_evidence_assert',N'TR'),
    OBJECT_ID(N'workflow.TR_catalog_task_execution_events_immutable',N'TR'),
    OBJECT_ID(N'settings.TR_catalog_customer_revision_heads_publish',N'TR'),
    OBJECT_ID(N'core.TR_catalog_physical_targets_immutable',N'TR'),
    OBJECT_ID(N'core.TR_catalog_physical_target_links_evidence',N'TR'),
    OBJECT_ID(N'core.TR_domains_catalog_route_retirement',N'TR'),
    OBJECT_ID(N'settings.TR_catalog_reporting_profiles_evidence',N'TR'),
    OBJECT_ID(N'settings.TR_catalog_match_key_registry_immutable',N'TR'),
    OBJECT_ID(N'core.TR_catalog_customer_revision_requires_match_key',N'TR'),
    OBJECT_ID(N'core.TR_catalog_physical_target_links_register',N'TR'),
    OBJECT_ID(N'core.TR_catalog_physical_target_links_registered_at_immutable',N'TR'),
    OBJECT_ID(N'settings.TR_catalog_sag_license_module_map_stamp',N'TR'),
    OBJECT_ID(N'settings.TR_catalog_sag_license_module_map_immutable',N'TR'),
    OBJECT_ID(N'settings.TR_catalog_sag_license_module_approvals_stamp',N'TR'),
    OBJECT_ID(N'settings.TR_catalog_sag_license_module_approvals_immutable',N'TR'),
    OBJECT_ID(N'core.TR_catalog_operational_owner_register',N'TR'),
    OBJECT_ID(N'core.TR_catalog_operational_link_register',N'TR'),
    OBJECT_ID(N'core.TR_catalog_operational_owner_retire',N'TR'),
    OBJECT_ID(N'core.TR_catalog_operational_link_retire',N'TR'),
    OBJECT_ID(N'core.TR_catalog_operational_approval_stamp',N'TR'),
    OBJECT_ID(N'core.TR_catalog_operational_approval_immutable',N'TR'),
    OBJECT_ID(N'scheduling.TR_catalog_schedule_operation_approvals_register',N'TR'),
    OBJECT_ID(N'scheduling.TR_catalog_schedule_operation_approvals_retire',N'TR'),
    OBJECT_ID(N'scheduling.TR_catalog_schedule_population_approvals_register',N'TR'),
    OBJECT_ID(N'scheduling.TR_catalog_schedule_population_approvals_retire',N'TR'),
    OBJECT_ID(N'scheduling.TR_catalog_manual_day_intents_register',N'TR'),
    OBJECT_ID(N'scheduling.TR_catalog_manual_day_intents_immutable',N'TR'),
    OBJECT_ID(N'workflow.TR_catalog_task_origin_receipts_register',N'TR'),
    OBJECT_ID(N'workflow.TR_catalog_task_origin_receipts_immutable',N'TR'),
    OBJECT_ID(N'scheduling.TR_catalog_once_observations_append_only',N'TR'),
    OBJECT_ID(N'scheduling.TR_catalog_once_observation_pairs_append_only',N'TR'),
    OBJECT_ID(N'settings.TR_catalog_source_heads_record_event',N'TR'),
    OBJECT_ID(N'scheduling.TR_catalog_once_observations_capture_sources',N'TR'),
    OBJECT_ID(N'settings.TR_catalog_source_head_events_append_only',N'TR'),
    OBJECT_ID(N'scheduling.TR_catalog_once_source_witnesses_append_only',N'TR'),
    OBJECT_ID(N'settings.tr_catalog_source_refresh_attempts_immutable',N'TR'),
    OBJECT_ID(N'core.TR_catalog_sag_company_revision_rows_guard',N'TR'),
    OBJECT_ID(N'core.TR_catalog_sag_company_revision_seal',N'TR'),
    OBJECT_ID(N'core.TR_catalog_sql_target_instance_identities_insert',N'TR'),
    OBJECT_ID(N'core.TR_catalog_sql_target_instance_identities_immutable',N'TR'),
    OBJECT_ID(N'core.TR_catalog_sag_company_location_observations_guard',N'TR'),
    OBJECT_ID(N'core.TR_catalog_sag_company_location_seals_stamp',N'TR'),
    OBJECT_ID(N'core.TR_catalog_sag_company_location_seals_immutable',N'TR'))) AS catalog_triggers_ready,
  CASE WHEN OBJECT_ID(N'core.catalog_operational_link_evidence',N'V') IS NOT NULL
    THEN 1 ELSE 0 END AS catalog_operational_evidence_ready,
  (SELECT COUNT(*) FROM sys.indexes WHERE is_disabled=0 AND is_unique=1 AND has_filter=1
    AND ((object_id=OBJECT_ID(N'core.catalog_operational_owners',N'U')
      AND name IN (N'UX_catalog_operational_owner_customer',N'UX_catalog_operational_owner_client'))
      OR (object_id=OBJECT_ID(N'core.catalog_operational_links',N'U') AND name=N'UX_catalog_operational_link_edge'))
  ) AS catalog_operational_uniqueness_ready,
  (SELECT COUNT(*) FROM sys.indexes i
    WHERE i.object_id=OBJECT_ID(N'core.domains',N'U')
      AND i.name=N'UX_domains_client_environment_name_active' AND i.is_unique=1 AND i.is_disabled=0 AND i.has_filter=1
      AND LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(i.filter_definition,N'[',N''),N']',N''),N'(',N''),N')',N''),N' ',N''))=N'status<>''deleted'''
      AND (SELECT COUNT(*) FROM sys.index_columns ic
        WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal>0)=3
      AND (SELECT COUNT(*) FROM sys.index_columns ic JOIN sys.columns c
        ON c.object_id=ic.object_id AND c.column_id=ic.column_id
        WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id
          AND ((ic.key_ordinal=1 AND c.name=N'client_key') OR (ic.key_ordinal=2 AND c.name=N'environment_id')
            OR (ic.key_ordinal=3 AND c.name=N'domain_name_normalized')))=3
  ) AS catalog_domain_scope_ready,
  (SELECT COUNT(*) FROM sys.indexes WHERE object_id=OBJECT_ID(N'core.domains',N'U')
    AND name=N'UX_domains_name_active') AS legacy_global_domain_index_count,
  (SELECT COUNT(*) FROM sys.check_constraints
    WHERE parent_object_id=OBJECT_ID(N'scheduling.catalog_schedule_operation_approvals',N'U')
      AND name=N'CK_catalog_schedule_operation_approvals_id' AND is_disabled=0 AND is_not_trusted=0
      AND definition COLLATE Latin1_General_100_BIN2=N'([operation_id] like N''[A-Za-z0-9]%'' AND NOT replace([operation_id],N''-'',N'''') like N''%[^A-Za-z0-9._:]%'' AND datalength([operation_id])=(2)*len([operation_id]))'
  ) AS catalog_operation_token_check_ready,
  (SELECT COUNT(*) FROM sys.indexes i
    WHERE i.object_id=OBJECT_ID(N'scheduling.catalog_schedule_population_approvals',N'U')
      AND i.name=N'UX_catalog_schedule_population_approvals_open' AND i.is_disabled=0 AND i.is_unique=1 AND i.has_filter=1
      AND LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(i.filter_definition,N'[',N''),N']',N''),N'(',N''),N')',N''),N' ',N''))=N'retired_atisnull'
      AND (SELECT COUNT(*) FROM sys.index_columns ic WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal>0)=1
      AND EXISTS (SELECT 1 FROM sys.index_columns ic WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal=1
        AND ic.column_id=COLUMNPROPERTY(i.object_id,N'portal_environment',N'ColumnId'))
  ) AS catalog_population_open_index_ready,
  (SELECT COUNT(*) FROM sys.check_constraints
    WHERE parent_object_id=OBJECT_ID(N'scheduling.catalog_schedule_population_approvals',N'U')
      AND name IN (N'CK_catalog_schedule_population_approvals_environment',N'CK_catalog_schedule_population_approvals_counts',
        N'CK_catalog_schedule_population_approvals_validity') AND is_disabled=0 AND is_not_trusted=0
  ) AS catalog_population_constraints_ready,
  (SELECT COUNT(*) FROM sys.key_constraints k
    JOIN sys.indexes i ON i.object_id=k.parent_object_id AND i.index_id=k.unique_index_id
    WHERE k.parent_object_id=OBJECT_ID(N'scheduling.catalog_manual_day_intents',N'U')
      AND k.name=N'PK_catalog_manual_day_intents' AND k.type='PK' AND i.is_disabled=0
      AND (SELECT COUNT(*) FROM sys.index_columns ic JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
        WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ((ic.key_ordinal=1 AND c.name=N'portal_environment')
          OR (ic.key_ordinal=2 AND c.name=N'task_date') OR (ic.key_ordinal=3 AND c.name=N'schedule_key')
          OR (ic.key_ordinal=4 AND c.name=N'schedule_version')))=4
      AND (SELECT COUNT(*) FROM sys.index_columns ic WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal>0)=4
  ) AS catalog_manual_intent_key_ready,
  CASE WHEN DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NULL OR
    (SELECT COUNT(*) FROM sys.database_permissions
      WHERE class=1 AND major_id=OBJECT_ID(N'scheduling.catalog_manual_day_intents',N'U') AND minor_id=0
        AND grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime') AND state='D' AND permission_name IN ('UPDATE','DELETE'))=2
    THEN 1 ELSE 0 END AS catalog_manual_intent_immutability_ready,
  (SELECT COUNT(*) FROM sys.key_constraints k
    JOIN sys.indexes i ON i.object_id=k.parent_object_id AND i.index_id=k.unique_index_id
    WHERE k.parent_object_id=OBJECT_ID(N'workflow.catalog_task_origin_receipts',N'U')
      AND k.name=N'PK_catalog_task_origin_receipts' AND k.type='PK' AND i.is_disabled=0
      AND (SELECT COUNT(*) FROM sys.index_columns ic JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
        WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ((ic.key_ordinal=1 AND c.name=N'catalog_execution_key')
          OR (ic.key_ordinal=2 AND c.name=N'link_key') OR (ic.key_ordinal=3 AND c.name=N'schedule_key')
          OR (ic.key_ordinal=4 AND c.name=N'schedule_version')))=4
      AND (SELECT COUNT(*) FROM sys.index_columns ic WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal>0)=4
  ) AS catalog_origin_receipt_key_ready,
  (SELECT COUNT(*) FROM sys.foreign_keys
    WHERE parent_object_id=OBJECT_ID(N'workflow.catalog_task_origin_receipts',N'U')
      AND is_disabled=0 AND is_not_trusted=0
      AND ((name=N'FK_catalog_task_origin_receipts_execution' AND referenced_object_id=OBJECT_ID(N'workflow.catalog_task_executions',N'U'))
        OR (name=N'FK_catalog_task_origin_receipts_link' AND referenced_object_id=OBJECT_ID(N'core.catalog_operational_links',N'U'))
        OR (name=N'FK_catalog_task_origin_receipts_schedule' AND referenced_object_id=OBJECT_ID(N'scheduling.update_schedules',N'U')))
  ) AS catalog_origin_receipt_foreign_keys_ready,
  (SELECT COUNT(*) FROM sys.check_constraints
    WHERE parent_object_id=OBJECT_ID(N'workflow.catalog_task_origin_receipts',N'U') AND is_disabled=0 AND is_not_trusted=0
      AND name IN (N'CK_catalog_task_origin_receipts_environment',N'CK_catalog_task_origin_receipts_expiry')
  ) AS catalog_origin_receipt_checks_ready,
  CASE WHEN DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NULL OR
    (SELECT COUNT(*) FROM sys.database_permissions
      WHERE class=1 AND major_id=OBJECT_ID(N'workflow.catalog_task_origin_receipts',N'U') AND minor_id=0
        AND grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime') AND state='D' AND permission_name IN ('UPDATE','DELETE'))=2
    THEN 1 ELSE 0 END AS catalog_origin_receipt_immutability_ready,
  CASE WHEN OBJECT_ID(N'scheduling.record_catalog_once_observations',N'P') IS NOT NULL
    AND OBJECT_ID(N'scheduling.catalog_once_source_fence',N'IF') IS NOT NULL
    AND EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'scheduling.catalog_once_observations',N'U')
      AND name=N'IX_catalog_once_observations_lookup' AND is_disabled=0)
    THEN 1 ELSE 0 END AS catalog_once_observation_writer_ready,
  (SELECT COUNT(*) FROM sys.foreign_keys WHERE is_disabled=0 AND is_not_trusted=0
    AND ((parent_object_id=OBJECT_ID(N'scheduling.catalog_once_observations',N'U')
      AND name IN (N'FK_catalog_once_observations_approval',N'FK_catalog_once_observations_population'))
      OR (parent_object_id=OBJECT_ID(N'scheduling.catalog_once_observation_pairs',N'U')
      AND name IN (N'FK_catalog_once_pairs_observation',N'FK_catalog_once_pairs_link',N'FK_catalog_once_pairs_execution_link',
        N'FK_catalog_once_pairs_execution_source')))) AS catalog_once_observation_foreign_keys_ready,
  (SELECT COUNT(*) FROM sys.check_constraints WHERE is_disabled=0 AND is_not_trusted=0
    AND parent_object_id=OBJECT_ID(N'scheduling.catalog_once_observations',N'U')
    AND name IN (N'CK_catalog_once_observations_environment',N'CK_catalog_once_observations_expected',
      N'CK_catalog_once_observations_deadline')) AS catalog_once_observation_checks_ready,
  CASE WHEN DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NULL OR (
    (SELECT COUNT(*) FROM sys.database_permissions
      WHERE class=1 AND major_id IN (OBJECT_ID(N'scheduling.catalog_once_observations',N'U'),
        OBJECT_ID(N'scheduling.catalog_once_observation_pairs',N'U')) AND minor_id=0
        AND grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime') AND state='D'
        AND permission_name IN ('INSERT','UPDATE','DELETE'))=6
    AND EXISTS (SELECT 1 FROM sys.database_permissions
      WHERE class=1 AND major_id=OBJECT_ID(N'scheduling.record_catalog_once_observations',N'P') AND minor_id=0
        AND grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime') AND state='G' AND permission_name='EXECUTE'))
    THEN 1 ELSE 0 END AS catalog_once_observation_permissions_ready,
  (SELECT COUNT(*) FROM sys.indexes WHERE is_disabled=0
    AND ((object_id=OBJECT_ID(N'settings.catalog_source_head_events',N'U')
      AND name IN (N'IX_catalog_head_events_cutoff',N'UQ_catalog_head_events_source'))
      OR (object_id=OBJECT_ID(N'scheduling.catalog_once_source_witnesses',N'U')
        AND name=N'PK_catalog_once_source_witnesses' AND is_primary_key=1)
      OR (object_id=OBJECT_ID(N'scheduling.catalog_once_closure_scan_cursors',N'U')
        AND name=N'PK_catalog_once_closure_scan_cursors' AND is_primary_key=1))) AS catalog_once_completion_indexes_ready,
  (SELECT COUNT(*) FROM sys.foreign_keys WHERE is_disabled=0 AND is_not_trusted=0
    AND ((parent_object_id=OBJECT_ID(N'settings.catalog_source_head_events',N'U')
      AND name IN (N'FK_catalog_head_events_source',N'FK_catalog_head_events_revision'))
      OR (parent_object_id=OBJECT_ID(N'scheduling.catalog_once_source_witnesses',N'U')
        AND name IN (N'FK_catalog_once_witness_observation',N'FK_catalog_once_witness_event')))) AS catalog_once_completion_foreign_keys_ready,
  (SELECT COUNT(*) FROM sys.check_constraints WHERE is_disabled=0 AND is_not_trusted=0
    AND ((parent_object_id=OBJECT_ID(N'settings.catalog_source_head_events',N'U') AND name=N'CK_catalog_head_events_state')
      OR (parent_object_id=OBJECT_ID(N'scheduling.catalog_once_source_witnesses',N'U')
        AND name IN (N'CK_catalog_once_witness_role',N'CK_catalog_once_witness_key_version'))
      OR (parent_object_id=OBJECT_ID(N'scheduling.catalog_once_closure_scan_cursors',N'U')
        AND name IN (N'CK_catalog_once_cursor_environment',N'CK_catalog_once_cursor_key')))) AS catalog_once_completion_checks_ready,
  CASE WHEN DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NOT NULL
    AND (SELECT COUNT(*) FROM sys.database_permissions WHERE class=1 AND minor_id=0
      AND grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime') AND state='D'
      AND ((major_id IN (OBJECT_ID(N'settings.catalog_source_head_events',N'U'),
        OBJECT_ID(N'scheduling.catalog_once_source_witnesses',N'U')) AND permission_name IN ('INSERT','UPDATE','DELETE'))
        OR (major_id=OBJECT_ID(N'scheduling.catalog_once_closure_scan_cursors',N'U') AND permission_name='DELETE')))=7
    AND (SELECT COUNT(*) FROM sys.database_permissions WHERE class=1 AND minor_id=0
      AND grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime') AND state='G'
      AND ((major_id IN (OBJECT_ID(N'settings.catalog_source_head_events',N'U'),
        OBJECT_ID(N'scheduling.catalog_once_source_witnesses',N'U')) AND permission_name='SELECT')
        OR (major_id=OBJECT_ID(N'scheduling.catalog_once_closure_scan_cursors',N'U')
          AND permission_name IN ('SELECT','INSERT','UPDATE'))))=5
    THEN 1 ELSE 0 END AS catalog_once_completion_permissions_ready,
  (SELECT COUNT(*) FROM sys.indexes WHERE is_disabled=0
    AND ((object_id=OBJECT_ID(N'settings.catalog_source_refresh_jobs',N'U')
      AND name IN (N'PK_catalog_source_refresh_jobs',N'UQ_catalog_source_refresh_jobs_id',
        N'UX_catalog_source_refresh_jobs_open',N'IX_catalog_source_refresh_jobs_claim',N'IX_catalog_source_refresh_jobs_latest'))
      OR (object_id=OBJECT_ID(N'settings.catalog_source_refresh_attempts',N'U')
        AND name IN (N'PK_catalog_source_refresh_attempts',N'UQ_catalog_source_refresh_attempts_event')))) AS catalog_refresh_indexes_ready,
  (SELECT COUNT(*) FROM sys.foreign_keys WHERE is_disabled=0 AND is_not_trusted=0
    AND ((parent_object_id=OBJECT_ID(N'settings.catalog_source_refresh_jobs',N'U')
      AND name=N'FK_catalog_source_refresh_jobs_source' AND referenced_object_id=OBJECT_ID(N'settings.catalog_source_bindings',N'U'))
      OR (parent_object_id=OBJECT_ID(N'settings.catalog_source_refresh_attempts',N'U')
        AND name=N'FK_catalog_source_refresh_attempts_job' AND referenced_object_id=OBJECT_ID(N'settings.catalog_source_refresh_jobs',N'U')))) AS catalog_refresh_foreign_keys_ready,
  (SELECT COUNT(*) FROM sys.check_constraints WHERE is_disabled=0 AND is_not_trusted=0
    AND ((parent_object_id=OBJECT_ID(N'settings.catalog_source_refresh_jobs',N'U')
      AND name IN (N'CK_catalog_refresh_job_environment',N'CK_catalog_refresh_job_match_key',N'CK_catalog_refresh_job_provenance',
        N'CK_catalog_refresh_job_attempt',N'CK_catalog_refresh_job_status',N'CK_catalog_refresh_job_dates'))
      OR (parent_object_id=OBJECT_ID(N'settings.catalog_source_refresh_attempts',N'U')
        AND name IN (N'CK_catalog_refresh_event_kind',N'CK_catalog_refresh_event_attempt')))) AS catalog_refresh_checks_ready,
  CASE WHEN DATABASE_PRINCIPAL_ID(N'portal_runtime') IS NOT NULL
    AND (SELECT COUNT(*) FROM sys.database_permissions WHERE class=1 AND minor_id=0
      AND grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime') AND state='G'
      AND ((major_id=OBJECT_ID(N'settings.catalog_source_refresh_jobs',N'U') AND permission_name IN ('SELECT','INSERT','UPDATE'))
        OR (major_id=OBJECT_ID(N'settings.catalog_source_refresh_attempts',N'U') AND permission_name IN ('SELECT','INSERT'))))=5
    AND (SELECT COUNT(*) FROM sys.database_permissions WHERE class=1 AND minor_id=0
      AND grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime') AND state='D'
      AND ((major_id=OBJECT_ID(N'settings.catalog_source_refresh_jobs',N'U') AND permission_name='DELETE')
        OR (major_id=OBJECT_ID(N'settings.catalog_source_refresh_attempts',N'U') AND permission_name IN ('UPDATE','DELETE'))))=3
    THEN 1 ELSE 0 END AS catalog_refresh_permissions_ready,
  CASE WHEN EXISTS(SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'core.catalog_customer_source_revisions')
      AND name=N'expected_sag_company_rows' AND system_type_id=56 AND is_nullable=1 AND default_object_id=0)
    AND EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'core.catalog_sag_company_revision_rows')
      AND name=N'PK_catalog_sag_company_revision_rows' AND is_primary_key=1 AND is_disabled=0)
    AND EXISTS(SELECT 1 FROM sys.foreign_keys WHERE parent_object_id=OBJECT_ID(N'core.catalog_sag_company_revision_rows')
      AND referenced_object_id=OBJECT_ID(N'core.catalog_customer_source_revisions')
      AND name=N'FK_catalog_sag_company_revision_parent' AND is_disabled=0 AND is_not_trusted=0)
    AND EXISTS(SELECT 1 FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID(N'core.catalog_customer_source_revisions')
      AND name=N'CK_catalog_sag_company_revision_count' AND is_disabled=0 AND is_not_trusted=0)
    AND (SELECT COUNT(*) FROM sys.database_permissions WHERE class=1 AND minor_id=0
      AND major_id=OBJECT_ID(N'core.catalog_sag_company_revision_rows')
      AND grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime') AND state='D'
      AND permission_name IN ('INSERT','UPDATE','DELETE'))=3
    THEN 1 ELSE 0 END AS catalog_sag_company_evidence_ready,
  CASE WHEN EXISTS(SELECT 1 FROM sys.database_principals WHERE name=N'portal_catalog_v2_publisher'
      AND type='R' AND owning_principal_id=DATABASE_PRINCIPAL_ID(N'dbo'))
    AND (SELECT COUNT(*) FROM sys.sql_modules m JOIN sys.objects o ON o.object_id=m.object_id
      JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.type='P' AND s.name=N'settings'
        AND o.name IN(N'catalog_sag_v2_transition_internal',N'reserve_catalog_sag_v2_attempt',
          N'publish_catalog_sag_v2_revision',N'fail_catalog_sag_v2_attempt',N'publish_catalog_sag_v2_with_targets')
        AND COALESCE(o.principal_id,s.principal_id)=DATABASE_PRINCIPAL_ID(N'dbo')
        AND m.execute_as_principal_id IS NULL)=5
    AND (SELECT COUNT(*) FROM sys.database_permissions
      WHERE grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_catalog_v2_publisher')
        AND NOT (class=1 AND minor_id=0
          AND grantor_principal_id=DATABASE_PRINCIPAL_ID(N'dbo') AND state='D'
          AND permission_name IN ('INSERT','UPDATE','DELETE')
          AND ((major_id=ISNULL(OBJECT_ID(N'core.catalog_sag_company_database_names',N'U'),-1)
            AND EXISTS(SELECT 1 FROM migration.schema_migrations WHERE migration_version='066' AND succeeded=1))
            OR (major_id=ISNULL(OBJECT_ID(N'core.catalog_sag_customer_directory_rows',N'U'),-1)
            AND EXISTS(SELECT 1 FROM migration.schema_migrations WHERE migration_version='067' AND succeeded=1)))))=12
    AND (SELECT COUNT(*) FROM sys.database_permissions WHERE class=1 AND minor_id=0
      AND grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_catalog_v2_publisher') AND state='G' AND permission_name='EXECUTE'
      AND major_id IN(OBJECT_ID(N'settings.reserve_catalog_sag_v2_attempt',N'P'),
        OBJECT_ID(N'settings.publish_catalog_sag_v2_revision',N'P'),OBJECT_ID(N'settings.fail_catalog_sag_v2_attempt',N'P'),
        OBJECT_ID(N'settings.publish_catalog_sag_v2_with_targets',N'P')))=4
    AND (SELECT COUNT(*) FROM sys.database_permissions WHERE class=1 AND minor_id=0
      AND grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime') AND state='D' AND permission_name='EXECUTE'
      AND major_id IN(OBJECT_ID(N'settings.catalog_sag_v2_transition_internal',N'P'),
        OBJECT_ID(N'settings.reserve_catalog_sag_v2_attempt',N'P'),OBJECT_ID(N'settings.publish_catalog_sag_v2_revision',N'P'),
        OBJECT_ID(N'settings.fail_catalog_sag_v2_attempt',N'P'),OBJECT_ID(N'settings.publish_catalog_sag_v2_with_targets',N'P')))=5
    AND NOT EXISTS(SELECT 1 FROM sys.database_permissions WHERE class=1 AND minor_id=0
      AND grantee_principal_id=DATABASE_PRINCIPAL_ID(N'public') AND state IN ('G','W') AND permission_name='EXECUTE'
      AND major_id IN(OBJECT_ID(N'settings.catalog_sag_v2_transition_internal',N'P'),
        OBJECT_ID(N'settings.reserve_catalog_sag_v2_attempt',N'P'),OBJECT_ID(N'settings.publish_catalog_sag_v2_revision',N'P'),
        OBJECT_ID(N'settings.fail_catalog_sag_v2_attempt',N'P'),OBJECT_ID(N'settings.publish_catalog_sag_v2_with_targets',N'P')))
    THEN 1 ELSE 0 END AS catalog_sag_v2_publisher_ready,
  CASE WHEN (SELECT COUNT(*) FROM sys.indexes WHERE object_id=OBJECT_ID(N'core.catalog_sql_target_instance_identities',N'U')
      AND is_unique=1 AND is_disabled=0 AND name IN(N'PK_catalog_sql_target_instance_identities',
        N'UQ_catalog_sql_target_instance_identities_proof'))=2
    AND EXISTS(SELECT 1 FROM sys.foreign_keys WHERE parent_object_id=OBJECT_ID(N'core.catalog_sql_target_instance_identities',N'U')
      AND referenced_object_id=OBJECT_ID(N'core.catalog_physical_targets',N'U')
      AND name=N'FK_catalog_sql_target_instance_identities_target' AND is_disabled=0 AND is_not_trusted=0)
    AND (SELECT COUNT(*) FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID(N'core.catalog_sql_target_instance_identities',N'U')
      AND name IN(N'CK_catalog_sql_target_instance_identities_scope',N'CK_catalog_sql_target_instance_identities_ids')
      AND is_disabled=0 AND is_not_trusted=0)=2
    AND (SELECT COUNT(*) FROM sys.database_permissions WHERE class=1 AND minor_id=0
      AND major_id=OBJECT_ID(N'core.catalog_sql_target_instance_identities',N'U')
      AND grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime') AND state='D'
      AND permission_name IN ('INSERT','UPDATE','DELETE'))=3
    THEN 1 ELSE 0 END AS catalog_sql_target_instance_ready,
  CASE WHEN (SELECT COUNT(*) FROM sys.indexes WHERE is_primary_key=1 AND is_disabled=0
      AND ((object_id=OBJECT_ID(N'core.catalog_sag_company_location_observations',N'U')
        AND name=N'PK_catalog_sag_company_location_observations')
        OR (object_id=OBJECT_ID(N'core.catalog_sag_company_location_seals',N'U')
        AND name=N'PK_catalog_sag_company_location_seals')))=2
    AND (SELECT COUNT(*) FROM sys.foreign_keys WHERE is_disabled=0 AND is_not_trusted=0
      AND ((parent_object_id=OBJECT_ID(N'core.catalog_sag_company_location_observations',N'U')
        AND referenced_object_id=OBJECT_ID(N'core.catalog_sag_company_revision_rows',N'U')
        AND name=N'FK_catalog_sag_company_location_observations_company')
        OR (parent_object_id=OBJECT_ID(N'core.catalog_sag_company_location_seals',N'U')
        AND referenced_object_id=OBJECT_ID(N'core.catalog_customer_source_revisions',N'U')
        AND name=N'FK_catalog_sag_company_location_seals_revision')))=2
    AND (SELECT COUNT(*) FROM sys.check_constraints WHERE is_disabled=0 AND is_not_trusted=0
      AND ((parent_object_id=OBJECT_ID(N'core.catalog_sag_company_location_observations',N'U')
        AND name=N'CK_catalog_sag_location_observations_token')
        OR (parent_object_id=OBJECT_ID(N'core.catalog_sag_company_location_seals',N'U')
        AND name=N'CK_catalog_sag_company_location_seals_count')))=2
    AND (SELECT COUNT(*) FROM sys.database_permissions WHERE class=1 AND minor_id=0 AND state='D'
      AND permission_name IN ('SELECT','INSERT','UPDATE','DELETE')
      AND major_id IN (OBJECT_ID(N'core.catalog_sag_company_location_observations',N'U'),
        OBJECT_ID(N'core.catalog_sag_company_location_seals',N'U'))
      AND grantee_principal_id IN (DATABASE_PRINCIPAL_ID(N'portal_runtime'),DATABASE_PRINCIPAL_ID(N'portal_catalog_v2_publisher')))=16
    THEN 1 ELSE 0 END AS catalog_sag_target_observations_ready,
  CASE WHEN (SELECT COUNT(*) FROM sys.objects o
      JOIN sys.schemas s ON s.schema_id=o.schema_id
      JOIN sys.sql_modules m ON m.object_id=o.object_id
      WHERE o.object_id IN (OBJECT_ID(N'settings.verify_catalog_sag_target_link_internal',N'P'),
        OBJECT_ID(N'settings.verify_catalog_sag_target_link',N'P'),OBJECT_ID(N'settings.read_catalog_sag_target_link_candidates',N'P'))
      AND COALESCE(o.principal_id,s.principal_id)=DATABASE_PRINCIPAL_ID(N'dbo')
      AND m.execute_as_principal_id IS NULL)=3
    AND EXISTS (SELECT 1 FROM sys.sql_expression_dependencies
      WHERE referencing_id=OBJECT_ID(N'settings.verify_catalog_sag_target_link',N'P')
        AND referenced_id=OBJECT_ID(N'settings.verify_catalog_sag_target_link_internal',N'P'))
    AND (SELECT COUNT(*) FROM sys.database_permissions WHERE class=1 AND major_id IN
      (OBJECT_ID(N'settings.verify_catalog_sag_target_link_internal',N'P'),
        OBJECT_ID(N'settings.verify_catalog_sag_target_link',N'P'),OBJECT_ID(N'settings.read_catalog_sag_target_link_candidates',N'P')))=3
    AND EXISTS (SELECT 1 FROM sys.database_permissions WHERE class=1 AND minor_id=0
      AND major_id=OBJECT_ID(N'settings.verify_catalog_sag_target_link_internal',N'P')
      AND grantee_principal_id=DATABASE_PRINCIPAL_ID(N'public') AND permission_name=N'EXECUTE' AND state='D')
    AND (SELECT COUNT(*) FROM sys.database_permissions WHERE class=1 AND minor_id=0 AND major_id IN
      (OBJECT_ID(N'settings.verify_catalog_sag_target_link',N'P'),OBJECT_ID(N'settings.read_catalog_sag_target_link_candidates',N'P'))
      AND grantee_principal_id=DATABASE_PRINCIPAL_ID(N'portal_runtime') AND permission_name=N'EXECUTE' AND state='G')=2
    THEN 1 ELSE 0 END AS catalog_sag_target_runtime_ready,
  CASE WHEN EXISTS (SELECT 1 FROM sys.objects o
      JOIN sys.schemas s ON s.schema_id=o.schema_id
      JOIN sys.sql_modules m ON m.object_id=o.object_id
      WHERE o.object_id=OBJECT_ID(N'settings.enroll_catalog_sql_target_instance_internal',N'P')
      AND COALESCE(o.principal_id,s.principal_id)=DATABASE_PRINCIPAL_ID(N'dbo')
      AND m.execute_as_principal_id IS NULL)
    AND (SELECT COUNT(*) FROM sys.database_permissions WHERE class=1
      AND major_id=OBJECT_ID(N'settings.enroll_catalog_sql_target_instance_internal',N'P'))=1
    AND EXISTS (SELECT 1 FROM sys.database_permissions WHERE class=1 AND minor_id=0
      AND major_id=OBJECT_ID(N'settings.enroll_catalog_sql_target_instance_internal',N'P')
      AND grantee_principal_id=DATABASE_PRINCIPAL_ID(N'public') AND permission_name=N'EXECUTE' AND state='D')
    THEN 1 ELSE 0 END AS catalog_sql_target_enrollment_private,
  CASE WHEN EXISTS (SELECT 1 FROM sys.triggers t
      JOIN sys.sql_modules m ON m.object_id=t.object_id
      WHERE t.object_id=OBJECT_ID(N'settings.TR_catalog_sag_license_module_approvals_stamp',N'TR')
        AND t.parent_id=OBJECT_ID(N'settings.catalog_sag_license_module_approvals',N'U')
        AND t.is_disabled=0 AND t.is_instead_of_trigger=1
        AND CHARINDEX(N'sag_admin_v1',m.definition COLLATE Latin1_General_100_BIN2)>0
        AND CHARINDEX(N'sag_admin_v2',m.definition COLLATE Latin1_General_100_BIN2)>0)
    AND EXISTS (SELECT 1 FROM sys.triggers
      WHERE object_id=OBJECT_ID(N'settings.TR_catalog_sag_license_module_approvals_immutable',N'TR')
        AND parent_id=OBJECT_ID(N'settings.catalog_sag_license_module_approvals',N'U')
        AND is_disabled=0 AND is_instead_of_trigger=0)
    THEN 1 ELSE 0 END AS catalog_sag_v2_approvals_ready,
  CASE WHEN COL_LENGTH(N'core.catalog_physical_target_links',N'registered_at') IS NOT NULL
    THEN 1 ELSE 0 END AS physical_registration_time_ready,
  CASE WHEN COL_LENGTH(N'core.catalog_customer_source_revisions',N'has_sag_inventory_evidence')=1
    THEN 1 ELSE 0 END AS sag_evidence_flag_ready;
'@
  $catalogVerification=Invoke-SessionSql -Sql $catalogVerificationSql -Mode read -TimeoutSeconds 120 -MaxRows 5
  $catalogRow=$catalogVerification.resultSets[0].rows[0]
  if($catalogRow.catalog_migration_count -ne 29 -or $catalogRow.catalog_tables_ready -ne 33 -or
     $catalogRow.catalog_triggers_ready -ne 44 -or $catalogRow.sag_evidence_flag_ready -ne 1 -or
     $catalogRow.catalog_operational_evidence_ready -ne 1 -or
     $catalogRow.catalog_operational_uniqueness_ready -ne 3 -or
     $catalogRow.catalog_domain_scope_ready -ne 1 -or $catalogRow.legacy_global_domain_index_count -ne 0 -or
     $catalogRow.catalog_operation_token_check_ready -ne 1 -or
     $catalogRow.catalog_population_open_index_ready -ne 1 -or $catalogRow.catalog_population_constraints_ready -ne 3 -or
     $catalogRow.catalog_manual_intent_key_ready -ne 1 -or $catalogRow.catalog_manual_intent_immutability_ready -ne 1 -or
     $catalogRow.catalog_origin_receipt_key_ready -ne 1 -or $catalogRow.catalog_origin_receipt_immutability_ready -ne 1 -or
     $catalogRow.catalog_origin_receipt_foreign_keys_ready -ne 3 -or $catalogRow.catalog_origin_receipt_checks_ready -ne 2 -or
     $catalogRow.catalog_once_observation_writer_ready -ne 1 -or $catalogRow.catalog_once_observation_permissions_ready -ne 1 -or
     $catalogRow.catalog_once_observation_foreign_keys_ready -ne 6 -or $catalogRow.catalog_once_observation_checks_ready -ne 3 -or
     $catalogRow.catalog_once_completion_indexes_ready -ne 4 -or $catalogRow.catalog_once_completion_foreign_keys_ready -ne 4 -or
     $catalogRow.catalog_once_completion_checks_ready -ne 5 -or $catalogRow.catalog_once_completion_permissions_ready -ne 1 -or
     $catalogRow.catalog_refresh_indexes_ready -ne 7 -or $catalogRow.catalog_refresh_foreign_keys_ready -ne 2 -or
     $catalogRow.catalog_refresh_checks_ready -ne 8 -or $catalogRow.catalog_refresh_permissions_ready -ne 1 -or
     $catalogRow.catalog_sag_company_evidence_ready -ne 1 -or $catalogRow.catalog_sag_v2_publisher_ready -ne 1 -or
     $catalogRow.catalog_sql_target_instance_ready -ne 1 -or $catalogRow.catalog_sag_target_observations_ready -ne 1 -or
     $catalogRow.catalog_sag_target_runtime_ready -ne 1 -or
     $catalogRow.catalog_sql_target_enrollment_private -ne 1 -or $catalogRow.catalog_sag_v2_approvals_ready -ne 1 -or
     $catalogRow.physical_registration_time_ready -ne 1){
    throw 'Catalog migration post-verification failed.'
  }
  Write-Host "$expectedDatabase migrations 031-059 are applied and verified." -ForegroundColor Green

  if($IncludeCatalogOwnerPublisher){
    $ownerVerificationSql=@'
DECLARE @delegate int=DATABASE_PRINCIPAL_ID(N'portal_catalog_v2_owner_delegate'),
  @publisherRole int=DATABASE_PRINCIPAL_ID(N'portal_catalog_v2_publisher');
SELECT CASE WHEN EXISTS(SELECT 1 FROM migration.schema_migrations WHERE migration_version='064' AND succeeded=1)
  AND EXISTS(SELECT 1 FROM sys.database_principals WHERE principal_id=@delegate AND type='S' AND authentication_type=0)
  AND (SELECT COUNT(*) FROM sys.database_role_members WHERE member_principal_id=@delegate)=1
  AND EXISTS(SELECT 1 FROM sys.database_role_members WHERE member_principal_id=@delegate AND role_principal_id=@publisherRole)
  AND NOT EXISTS(SELECT 1 FROM sys.database_permissions WHERE grantor_principal_id=@delegate
    OR (grantee_principal_id=@delegate AND NOT (class=0 AND major_id=0 AND minor_id=0
      AND state='G' AND permission_name='CONNECT' AND grantor_principal_id=DATABASE_PRINCIPAL_ID(N'dbo'))))
  AND NOT EXISTS(SELECT 1 FROM sys.schemas WHERE principal_id=@delegate)
  AND NOT EXISTS(SELECT 1 FROM sys.objects WHERE principal_id=@delegate)
  AND NOT EXISTS(SELECT 1 FROM sys.database_principals WHERE owning_principal_id=@delegate)
  AND EXISTS(SELECT 1 FROM sys.sql_modules WHERE object_id=OBJECT_ID(N'settings.catalog_sag_v2_owner_dispatch_internal',N'P')
    AND execute_as_principal_id=@delegate)
  AND (SELECT COUNT(*) FROM sys.sql_modules WHERE execute_as_principal_id IS NULL AND object_id IN (
    OBJECT_ID(N'settings.reserve_catalog_sag_v2_owner_attempt',N'P'),
    OBJECT_ID(N'settings.publish_catalog_sag_v2_owner_with_targets',N'P'),
    OBJECT_ID(N'settings.fail_catalog_sag_v2_owner_attempt',N'P')))=3
  AND NOT EXISTS(SELECT 1 FROM sys.database_permissions WHERE class=1 AND major_id IN (
    OBJECT_ID(N'settings.catalog_sag_v2_owner_dispatch_internal',N'P'),
    OBJECT_ID(N'settings.reserve_catalog_sag_v2_owner_attempt',N'P'),
    OBJECT_ID(N'settings.publish_catalog_sag_v2_owner_with_targets',N'P'),
    OBJECT_ID(N'settings.fail_catalog_sag_v2_owner_attempt',N'P')))
  THEN 1 ELSE 0 END AS owner_publisher_ready;
'@
    $ownerVerification=Invoke-SessionSql -Sql $ownerVerificationSql -Mode read -TimeoutSeconds 120 -MaxRows 5
    if($ownerVerification.resultSets[0].rows[0].owner_publisher_ready -ne 1){
      throw 'Optional owner publisher migration post-verification failed.'
    }
    Write-Host "$expectedDatabase optional owner publisher migration 064 is applied and verified." -ForegroundColor Green
  }

  if($IncludeCatalogErpOwnerPublisher){
    $erpOwnerVerificationSql=@'
DECLARE @delegate int=DATABASE_PRINCIPAL_ID(N'portal_catalog_erp_owner_delegate');
SELECT CASE WHEN EXISTS(SELECT 1 FROM migration.schema_migrations WHERE migration_version='065' AND succeeded=1)
  AND EXISTS(SELECT 1 FROM sys.database_principals WHERE principal_id=@delegate AND type='S' AND authentication_type=0)
  AND NOT EXISTS(SELECT 1 FROM sys.database_role_members WHERE member_principal_id=@delegate)
  AND NOT EXISTS(SELECT 1 FROM sys.schemas WHERE principal_id=@delegate)
  AND NOT EXISTS(SELECT 1 FROM sys.objects WHERE principal_id=@delegate)
  AND NOT EXISTS(SELECT 1 FROM sys.database_principals WHERE owning_principal_id=@delegate)
  AND NOT EXISTS(SELECT 1 FROM sys.database_permissions WHERE grantor_principal_id=@delegate
    OR (grantee_principal_id=@delegate AND NOT (class=0 AND major_id=0 AND minor_id=0
        AND state='G' AND permission_name='CONNECT' AND grantor_principal_id=DATABASE_PRINCIPAL_ID(N'dbo'))))
  AND EXISTS(SELECT 1 FROM sys.sql_modules WHERE object_id=OBJECT_ID(N'settings.catalog_erp_owner_dispatch_internal',N'P')
    AND execute_as_principal_id=@delegate)
  AND (SELECT COUNT(*) FROM sys.sql_modules WHERE execute_as_principal_id IS NULL AND object_id IN (
    OBJECT_ID(N'settings.reserve_catalog_erp_owner_attempt',N'P'),
    OBJECT_ID(N'settings.publish_catalog_erp_owner',N'P'),
    OBJECT_ID(N'settings.fail_catalog_erp_owner_attempt',N'P')))=3
  AND NOT EXISTS(SELECT 1 FROM sys.database_permissions WHERE class=1 AND major_id IN (
    OBJECT_ID(N'settings.catalog_erp_owner_dispatch_internal',N'P'),
    OBJECT_ID(N'settings.reserve_catalog_erp_owner_attempt',N'P'),
    OBJECT_ID(N'settings.publish_catalog_erp_owner',N'P'),
    OBJECT_ID(N'settings.fail_catalog_erp_owner_attempt',N'P')))
  THEN 1 ELSE 0 END AS erp_owner_publisher_ready;
'@
    $erpOwnerVerification=Invoke-SessionSql -Sql $erpOwnerVerificationSql -Mode read -TimeoutSeconds 120 -MaxRows 5
    if($erpOwnerVerification.resultSets[0].rows[0].erp_owner_publisher_ready -ne 1){
      throw 'Optional ERP owner publisher migration post-verification failed.'
    }
    Write-Host "$expectedDatabase optional ERP owner publisher migration 065 is applied and verified." -ForegroundColor Green
  }
  if($IncludeCatalogObservedInventory){
    $observedVerificationSql=@'
DECLARE @sidecar int=OBJECT_ID(N'core.catalog_sag_company_database_names',N'U');
DECLARE @delegate int=DATABASE_PRINCIPAL_ID(N'portal_catalog_v2_owner_delegate');
DECLARE @inner int=OBJECT_ID(N'settings.catalog_sag_v2_owner_database_names_internal',N'P');
DECLARE @outer int=OBJECT_ID(N'settings.publish_catalog_sag_v2_owner_with_database_names',N'P');
DECLARE @runtimeRole int=DATABASE_PRINCIPAL_ID(N'portal_runtime'),
  @publisherRole int=DATABASE_PRINCIPAL_ID(N'portal_catalog_v2_publisher'),
  @grantor int=DATABASE_PRINCIPAL_ID(N'dbo');
SELECT CASE WHEN EXISTS(SELECT 1 FROM migration.schema_migrations WHERE migration_version='066' AND succeeded=1)
  AND EXISTS(SELECT 1 FROM sys.triggers WHERE object_id=OBJECT_ID(N'core.TR_catalog_sag_company_database_names_guard',N'TR')
    AND parent_id=@sidecar AND is_disabled=0)
  AND EXISTS(SELECT 1 FROM sys.sql_modules WHERE object_id=@inner AND execute_as_principal_id=@delegate)
  AND EXISTS(SELECT 1 FROM sys.sql_modules WHERE object_id=@outer AND execute_as_principal_id IS NULL)
  AND (SELECT COUNT(*) FROM sys.database_permissions WHERE class=1 AND major_id=@sidecar)=7
  AND (SELECT COUNT(*) FROM sys.database_permissions WHERE class=1 AND major_id=@sidecar AND minor_id=0
    AND grantor_principal_id=@grantor AND (
      (grantee_principal_id=@runtimeRole AND state='G' AND permission_name='SELECT')
      OR (grantee_principal_id IN (@runtimeRole,@publisherRole) AND state='D' AND permission_name IN ('INSERT','UPDATE','DELETE'))))=7
  AND NOT EXISTS(SELECT 1 FROM sys.database_permissions WHERE class=1 AND major_id IN (@inner,@outer))
  THEN 1 ELSE 0 END AS observed_inventory_ready;
'@
    $observedVerification=Invoke-SessionSql -Sql $observedVerificationSql -Mode read -TimeoutSeconds 120 -MaxRows 5
    if($observedVerification.resultSets[0].rows[0].observed_inventory_ready -ne 1){
      throw 'Optional observed inventory migration post-verification failed.'
    }
    Write-Host "$expectedDatabase optional observed inventory migration 066 is applied and verified." -ForegroundColor Green
  }
  if($IncludeCatalogDirectoryV2){
    $directoryVerificationSql=$observedVerificationSql.
      Replace('catalog_sag_company_database_names','catalog_sag_customer_directory_rows').
      Replace('catalog_sag_v2_owner_database_names_internal','catalog_sag_v2_owner_directory_internal').
      Replace('publish_catalog_sag_v2_owner_with_database_names','publish_catalog_sag_v2_owner_with_directory').
      Replace("migration_version='066'","migration_version='067'").
      Replace('observed_inventory_ready','directory_v2_ready')
    $result=Invoke-SessionSql -Sql $directoryVerificationSql -Mode read -TimeoutSeconds 120 -MaxRows 5
    if($result.resultSets[0].rows[0].directory_v2_ready -ne 1){
      throw 'Optional catalog directory v2 migration post-verification failed.'
    }
    Write-Host "$expectedDatabase optional catalog directory migration 067 is applied and verified." -ForegroundColor Green
  }
}
