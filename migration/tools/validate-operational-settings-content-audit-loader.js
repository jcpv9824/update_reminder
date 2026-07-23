/* Value-free regression contract for migration phase 011. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildPlan } = require("./plan-operational-transform");
const { buildTransferPlan } = require("./prepare-blob-transfer-package");

const root = path.resolve(__dirname, "..", "..");
const sqlPath = path.join(root, "migration", "sql", "011_operational_load_settings_content_notifications_audit.sql");
assert.ok(fs.existsSync(sqlPath), "Migration 011 settings/content/notifications/audit loader is missing.");
const sql = fs.readFileSync(sqlPath, "utf8");
const runnerPath = path.join(root, "migration", "tools", "Load-PortalSAGWeb-FinalOperational.ps1");
assert.ok(fs.existsSync(runnerPath), "Protected non-production phase 011 runner is missing.");
const runner = fs.readFileSync(runnerPath, "utf8");
const multiSourcePath = path.join(root, "migration", "sql", "015_print_format_multiple_sources.sql");
assert.ok(fs.existsSync(multiSourcePath), "Migration 015 multi-source print-format model is missing.");
const multiSourceSql = fs.readFileSync(multiSourcePath, "utf8");
const assetMigrationPath = path.join(root, "migration", "sql", "016_public_download_video_assets_and_source_cleanup.sql");
assert.ok(fs.existsSync(assetMigrationPath), "Migration 016 public document/video asset model is missing.");
const assetMigrationSql = fs.readFileSync(assetMigrationPath, "utf8");

for (const required of [
  "usp_load_operational_settings_content_notifications_audit",
  "EXEC migration.usp_assert_operational_load_ready @run_key",
  "phase_code VARCHAR(60)='settings_content_notifications_audit'",
  "phase_code='scheduling_workflow' AND status='completed'",
  "status<>'verified'",
  "expected_sha256",
  "INSERT content.files",
  "SET status='linked'",
  "INSERT audit.audit_logs",
  "operational_final:audit_logs",
  "SET processing_status='loaded'",
]) assert.ok(sql.includes(required), `Migration 011 is missing contract: ${required}`);

assert.ok(!/pdfBase64|archivoBase64/i.test(sql), "Phase 011 must never project Base64 into operational SQL.");
assert.ok(!/INSERT\s+security[.]auth_sessions/i.test(sql), "Phase 011 must not load sessions.");
assert.ok(!/INSERT\s+security[.]rate_limits/i.test(sql), "Phase 011 must not load rate-limit state.");
for (const required of [
  "content.print_format_source_assignments",
  "content.v_public_print_formats",
  "usp_load_print_format_source_assignments",
  "usp_load_operational_final_with_print_sources",
  "operational_final:print_format_source_assignments",
  "JSON_QUERY(r.raw_json,'$.fuenteIds')",
  "Every print format must retain its primary source assignment",
]) assert.ok(multiSourceSql.includes(required), `Migration 015 is missing contract: ${required}`);

for (const required of [
  "asset_kind VARCHAR(20)",
  "asset_kind IN (''document'',''video'')",
  "content.v_public_download_assets",
  "LOWER(COALESCE(d.file_mime_type",
  "ALTER TABLE content.print_format_sources DROP COLUMN description",
]) assert.ok(assetMigrationSql.includes(required), `Migration 016 is missing contract: ${required}`);

for (const required of [
  "LOAD FINAL OPERATIONAL NONPRODUCTION",
  "$securePassword.MakeReadOnly()",
  "TrustServerCertificate'] = $false",
  "migration.usp_load_operational_settings_content_notifications_audit",
  "migration_version='011'",
  "migration_version='015'",
  "migration_version='016'",
  "migration.usp_load_operational_final_with_print_sources",
  "status='verified'",
]) assert.ok(runner.includes(required), `Protected phase 011 runner is missing contract: ${required}`);
assert.ok(!/\.Password\s*=|GetNetworkCredential/i.test(runner), "Runner must not materialize the SQL password as text.");

const baseSchema = fs.readFileSync(path.join(root, "migration", "sql", "002_migration_history_and_schemas.sql"), "utf8");
assert.match(baseSchema, /status IN \([^)]*'completed'/, "Migration runs must support a completed terminal state.");

const reconciliationCodes = [
  "email_settings", "default_reminder_days", "alert_recipient_roles", "alert_recipient_emails",
  "overdue_alert_weekdays", "blocked_reminder_days", "administrative_reminders",
  "administrative_reminder_recipients", "files", "print_format_sources", "print_formats",
  "print_format_files", "public_download_sections", "public_download_documents",
  "public_download_files", "email_notifications", "email_notification_recipients",
  "email_notification_attempts", "audit_logs", "linked_file_transfers",
];
for (const code of reconciliationCodes) {
  const marker = `N'operational_final:${code}'`;
  assert.equal(sql.split(marker).length - 1, 1, `Expected exactly one reconciliation row for ${marker}.`);
}

const snapshot = path.join(root, "migration", "backups", "cosmos-export-prod-20260722-155753");
const plan = buildPlan(snapshot);
const expected = {
  "settings.email_settings": 1,
  "settings.default_reminder_days": 1,
  "settings.alert_recipient_roles": 1,
  "settings.alert_recipient_emails": 2,
  "settings.overdue_alert_weekdays": 1,
  "settings.blocked_reminder_days": 3,
  "settings.administrative_reminders": 2,
  "settings.administrative_reminder_recipients": 2,
  "content.files": 39,
  "content.print_format_sources": 13,
  "content.print_formats": 37,
  "content.print_format_source_assignments": 37,
  "content.print_format_files": 37,
  "content.public_download_sections": 2,
  "content.public_download_documents": 2,
  "content.public_download_files": 2,
  "notifications.email_notifications": 6,
  "notifications.email_notification_recipients": 6,
  "audit.audit_logs": 2250,
};
for (const [table, count] of Object.entries(expected)) {
  assert.equal(plan.operationalTableCounts[table], count, `Unexpected certified count for ${table}.`);
}
assert.equal(plan.criticalIssueCount, 0);

const transferPlan = buildTransferPlan(snapshot);
assert.equal(transferPlan.fileCount, 39);
assert.equal(transferPlan.totalBytes, 968128);
assert.equal(transferPlan.entries.filter((item) => item.sourceContainer === "formatosImpresion").length, 37);
assert.equal(transferPlan.entries.filter((item) => item.sourceContainer === "publicDownloads").length, 2);

const phaseSourceCount = 1 + 6 + 13 + 37 + 4 + 2250;
const phaseTargetCount = Object.values(expected).reduce((sum, count) => sum + count, 0);
assert.equal(phaseSourceCount, 2311);
assert.equal(phaseTargetCount, 2444);

const manifest = fs.readFileSync(path.join(root, "migration", "sql", "MANIFEST.sha256"), "utf8");
assert.match(manifest, /[0-9a-f]{64}  011_operational_load_settings_content_notifications_audit[.]sql/);
assert.match(manifest, /[0-9a-f]{64}  015_print_format_multiple_sources[.]sql/);
assert.match(manifest, /[0-9a-f]{64}  016_public_download_video_assets_and_source_cleanup[.]sql/);

process.stdout.write(
  "PASS final operational contract: 2311 source documents; 2444 target rows; "
  + "37 print-format source assignments; 39 verified file links; 2250 append-only audit rows; 0 critical issues.\n"
);
