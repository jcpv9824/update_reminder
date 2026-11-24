[CmdletBinding()]
param(
  [string]$SqlDirectory
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($SqlDirectory)) {
  $SqlDirectory = Join-Path $PSScriptRoot '..\sql'
}
$expected = @(
  '000_database_intake_readonly.sql',
  '001_prepare_production_mvp_database.sql',
  '002_migration_history_and_schemas.sql',
  '003_security_core.sql',
  '004_licensing_scheduling_workflow.sql',
  '005_settings_notifications_content_audit.sql',
  '006_staging.sql',
  '007_indexes_constraints_permissions.sql',
  '008_stage_projection_procedure.sql',
  '009_operational_load_control_and_core.sql',
  '010_operational_load_scheduling_workflow.sql',
  '011_operational_load_settings_content_notifications_audit.sql',
  '012_expand_task_source_identifiers.sql',
  '013_expand_entity_source_identifiers.sql',
  '014_correct_historical_task_orphan_projection.sql',
  '015_print_format_multiple_sources.sql',
  '016_public_download_video_assets_and_source_cleanup.sql',
  '017_normalize_domain_url_identity.sql',
  '018_expand_license_module_description.sql',
  '019_expand_notification_outbox_types.sql',
  '020_allow_outbox_attempt_completion.sql',
  '021_atomic_operational_refresh.sql',
  '022_refresh_print_source_assignments.sql',
  '023_enable_masters_report_outbox.sql',
  '024_s3_object_storage.sql',
  '025_separate_public_downloads_and_inline_files.sql',
  '026_guide_builder.sql',
  '027_integration_connections.sql',
  '028_company_logo_permissions.sql',
  '029_company_storage_labels.sql',
  '030_object_storage_profiles.sql',
  '031_catalog_source_bindings.sql',
  '032_catalog_task_execution.sql',
  '033_catalog_customer_snapshots.sql',
  '034_catalog_source_access.sql',
  '035_catalog_sag_discovery_evidence.sql',
  '036_catalog_physical_targets.sql',
  '037_catalog_reporting_profiles.sql',
  '038_catalog_match_key_registry.sql',
  '039_catalog_physical_registration_time.sql',
  '040_catalog_sag_license_module_map.sql',
  '041_catalog_sag_license_approval_versions.sql',
  '042_catalog_operational_links.sql',
  '043_catalog_domain_scope.sql',
  '044_catalog_schedule_operation_approvals.sql',
  '045_catalog_schedule_operation_token_check.sql',
  '046_catalog_schedule_population_approvals.sql',
  '047_catalog_manual_day_intents.sql',
  '048_catalog_task_origin_receipts.sql',
  '049_catalog_once_observations.sql',
  '050_catalog_once_completion_witnesses.sql',
  '051_catalog_refresh_queue.sql',
  '052_catalog_sag_company_evidence.sql',
  '053_catalog_sag_v2_publication.sql',
  '054_catalog_sql_target_instance_identity.sql',
  '055_catalog_sag_target_observations.sql',
  '056_catalog_sag_target_link_proof.sql',
  '057_catalog_sag_target_runtime_gate.sql',
  '058_catalog_sql_target_instance_enrollment.sql',
  '059_catalog_sag_v2_license_approval.sql',
  '060_user_business_areas.sql',
  '061_whats_new_configuration_and_permissions.sql',
  '062_whats_new_entries_and_testing.sql',
  '063_whats_new_reports_outbox.sql',
  '064_catalog_sag_owner_publisher.sql',
  '065_catalog_erp_owner_publisher.sql',
  '066_catalog_sag_database_names.sql',
  '067_catalog_sag_customer_directory.sql',
  '068_user_area.sql',
  '070_schedule_manual_environment.sql',
  '071_catalog_schedule_activation_snapshots.sql',
  '072_catalog_schedule_copy_intents.sql',
  '073_catalog_historical_schedule_company_locations.sql',
  '074_catalog_schedule_population_sag_v2.sql',
  '075_catalog_schedule_copy_proposals.sql',
  '076_catalog_schedule_copy_review_receipts.sql',
  '077_catalog_schedule_copy_review_consumption.sql',
  '078_catalog_schedule_draft_proposals.sql',
  '079_catalog_schedule_draft_review_receipts.sql',
  '080_catalog_schedule_draft_materialization.sql',
  '081_catalog_schedule_draft_runtime_execute.sql',
  '082_catalog_schedule_activation_seals.sql'
)

$resolvedSqlDirectory = (Resolve-Path -LiteralPath $SqlDirectory).Path
$missing = @($expected | Where-Object { -not (Test-Path -LiteralPath (Join-Path $resolvedSqlDirectory $_)) })
if ($missing.Count -gt 0) {
  throw "Missing required SQL migration scripts: $($missing -join ', ')"
}

$scriptDom = Get-ChildItem -Path 'C:\Program Files\Microsoft SQL Server Management Studio*' `
  -Filter 'Microsoft.SqlServer.TransactSql.ScriptDom.dll' -Recurse -ErrorAction SilentlyContinue |
  Select-Object -First 1

if (-not $scriptDom) {
  throw 'SQL Server ScriptDom was not found. Install SQL Server Management Studio 21 or provide an equivalent SQL Server 2019 parser.'
}

Add-Type -Path $scriptDom.FullName
$parser = [Microsoft.SqlServer.TransactSql.ScriptDom.TSql150Parser]::new($true)
$failed = $false

foreach ($name in $expected) {
  $path = Join-Path $resolvedSqlDirectory $name
  $reader = [System.IO.StringReader]::new([System.IO.File]::ReadAllText($path))
  try {
    $parseErrors = $null
    $null = $parser.Parse($reader, [ref]$parseErrors)
  }
  finally {
    $reader.Dispose()
  }

  if ($parseErrors.Count -eq 0) {
    if ($name -cin @('064_catalog_sag_owner_publisher.sql','065_catalog_erp_owner_publisher.sql','066_catalog_sag_database_names.sql','067_catalog_sag_customer_directory.sql',
      '072_catalog_schedule_copy_intents.sql','073_catalog_historical_schedule_company_locations.sql','074_catalog_schedule_population_sag_v2.sql',
      '075_catalog_schedule_copy_proposals.sql','076_catalog_schedule_copy_review_receipts.sql','077_catalog_schedule_copy_review_consumption.sql',
      '078_catalog_schedule_draft_proposals.sql','079_catalog_schedule_draft_review_receipts.sql','080_catalog_schedule_draft_materialization.sql',
      '082_catalog_schedule_activation_seals.sql')) {
      # The outer parser sees these fixed module definitions only as string
      # literals; independently parse each batch that SQL Server will compile.
      $moduleText=[System.IO.File]::ReadAllText($path)
      $modules=[regex]::Matches($moduleText,"EXEC sys\.sp_executesql N'((?:[^']|'')*)';")
      $expectedModules=if($name -ceq '072_catalog_schedule_copy_intents.sql'){2}
        elseif($name -eq '073_catalog_historical_schedule_company_locations.sql'){3}
        elseif($name -eq '074_catalog_schedule_population_sag_v2.sql'){1}
        elseif($name -eq '075_catalog_schedule_copy_proposals.sql'){2}
        elseif($name -eq '076_catalog_schedule_copy_review_receipts.sql'){3}
        elseif($name -eq '077_catalog_schedule_copy_review_consumption.sql'){1}
        elseif($name -eq '078_catalog_schedule_draft_proposals.sql'){4}
        elseif($name -eq '079_catalog_schedule_draft_review_receipts.sql'){3}
        elseif($name -eq '080_catalog_schedule_draft_materialization.sql'){3}
        elseif($name -eq '082_catalog_schedule_activation_seals.sql'){4}
        elseif($name -cin @('066_catalog_sag_database_names.sql','067_catalog_sag_customer_directory.sql')){3}else{4}
      if($modules.Count -ne $expectedModules){
        throw "Expected exactly $expectedModules fixed module definitions in $name."
      }
      foreach($module in $modules){
        $moduleReader=[System.IO.StringReader]::new($module.Groups[1].Value.Replace("''","'"))
        try {
          $moduleErrors=$null
          $null=$parser.Parse($moduleReader,[ref]$moduleErrors)
        } finally {
          $moduleReader.Dispose()
        }
        if($moduleErrors.Count){
          throw "Invalid nested SQL Server 2019 module in ${name}: $($moduleErrors[0].Message)"
        }
      }
    }
    Write-Host "PASS $name" -ForegroundColor Green
    continue
  }

  $failed = $true
  Write-Host "FAIL $name" -ForegroundColor Red
  foreach ($parseError in $parseErrors) {
    Write-Host ("  line {0}, column {1}: {2}" -f $parseError.Line, $parseError.Column, $parseError.Message)
  }
}

if ($failed) {
  exit 1
}

Write-Host 'All scripts parse successfully with the SQL Server 2019 (TSql150) grammar.' -ForegroundColor Cyan
