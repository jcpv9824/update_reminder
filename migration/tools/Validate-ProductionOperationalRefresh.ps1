[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$migrationPath = Join-Path $PSScriptRoot '..\sql\021_atomic_operational_refresh.sql'
if (-not (Test-Path -LiteralPath $migrationPath)) {
  throw 'Migration 021 atomic operational refresh is missing.'
}

$sql = Get-Content -Raw -LiteralPath $migrationPath
$requiredPatterns = @(
  "IF DB_NAME() NOT IN (N'PortalSAGWeb',N'PortalSAGWeb-TEST')",
  "DROP CONSTRAINT UQ_file_transfers_blob",
  "CREATE UNIQUE INDEX UX_file_transfers_run_blob",
  "CREATE OR ALTER PROCEDURE migration.usp_replace_operational_from_validated_run",
  "SESSION_CONTEXT(N'portal_production_refresh_authorized')",
  "sp_getapplock",
  "DISABLE TRIGGER audit.TR_audit_logs_append_only",
  "DISABLE TRIGGER workflow.TR_task_status_history_append_only",
  "DISABLE TRIGGER notifications.TR_notification_attempts_append_only",
  "DISABLE TRIGGER content.TR_print_format_source_assignments_rules",
  "DISABLE TRIGGER content.TR_print_formats_source_consistency",
  "ENABLE TRIGGER audit.TR_audit_logs_append_only",
  "ENABLE TRIGGER workflow.TR_task_status_history_append_only",
  "ENABLE TRIGGER notifications.TR_notification_attempts_append_only",
  "ENABLE TRIGGER content.TR_print_format_source_assignments_rules",
  "ENABLE TRIGGER content.TR_print_formats_source_consistency",
  "EXEC migration.usp_load_operational_security_core_licensing @run_key",
  "EXEC migration.usp_load_operational_scheduling_workflow @run_key",
  "EXEC migration.usp_load_operational_settings_content_notifications_audit @run_key",
  "operational_refresh:preserved_sql_audit",
  "COMMIT TRANSACTION"
)
foreach ($pattern in $requiredPatterns) {
  if (-not $sql.Contains($pattern)) {
    throw "Migration 021 safety contract is missing: $pattern"
  }
}

$requiredDeletes = @(
  'audit.audit_logs',
  'notifications.email_notification_attempts',
  'notifications.email_notification_recipients',
  'notifications.email_notifications',
  'content.print_format_files',
  'content.print_format_source_assignments',
  'content.print_formats',
  'content.print_format_sources',
  'content.public_download_files',
  'content.public_download_documents',
  'content.public_download_sections',
  'content.files',
  'settings.administrative_reminder_recipients',
  'settings.administrative_reminders',
  'settings.alert_recipient_emails',
  'settings.alert_recipient_roles',
  'settings.blocked_reminder_days',
  'settings.default_reminder_days',
  'settings.overdue_alert_weekdays',
  'settings.email_settings',
  'workflow.task_reminder_recipients',
  'workflow.task_reminders',
  'workflow.task_overdue_alerts',
  'workflow.task_source_aliases',
  'workflow.task_sources',
  'workflow.task_status_history',
  'workflow.task_assignees',
  'workflow.update_tasks',
  'scheduling.scope_databases',
  'scheduling.scope_domains',
  'scheduling.scope_groups',
  'scheduling.licensing_excluded_databases',
  'scheduling.licensing_excluded_domains',
  'scheduling.licensing_scope_modules',
  'scheduling.licensing_scope',
  'scheduling.schedule_reminder_days',
  'scheduling.schedule_reminder_emails',
  'scheduling.schedule_reminder_settings',
  'scheduling.schedule_assignees',
  'scheduling.schedule_targets',
  'scheduling.schedule_weekdays',
  'scheduling.update_schedules',
  'licensing.license_assignments',
  'licensing.license_modules',
  'core.database_assignees',
  'core.databases',
  'core.database_access_profiles',
  'core.domain_assignees',
  'core.domains',
  'core.clients',
  'security.auth_sessions',
  'security.rate_limits',
  'security.user_roles',
  'security.users'
)
foreach ($table in $requiredDeletes) {
  if ($sql -notmatch "(?im)\bDELETE\s+(?:FROM\s+)?$([regex]::Escape($table))\b") {
    throw "Migration 021 does not clear the reloadable operational table: $table"
  }
}

foreach ($forbidden in @('ALTER ROLE', 'DROP MEMBER', 'REVOKE CONTROL', 'DENY CONTROL')) {
  if ($sql.IndexOf($forbidden, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
    throw "Migration 021 contains a forbidden permission downgrade: $forbidden"
  }
}

Write-Host 'PASS migration 021: per-run Blob ledger, atomic operational replacement, audit preservation, trigger restoration and no permission downgrade.' -ForegroundColor Green
