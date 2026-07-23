/* Value-free regression contract for migration phase 010. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildPlan } = require("./plan-operational-transform");

const root = path.resolve(__dirname, "..", "..");
const sqlPath = path.join(root, "migration", "sql", "010_operational_load_scheduling_workflow.sql");
assert.ok(fs.existsSync(sqlPath), "Migration 010 scheduling/workflow loader is missing.");
const sql = fs.readFileSync(sqlPath, "utf8");
const runnerPath = path.join(root, "migration", "tools", "Load-PortalSAGWeb-OperationalSchedulingWorkflow.ps1");
assert.ok(fs.existsSync(runnerPath), "Protected non-production phase 010 runner is missing.");
const runner = fs.readFileSync(runnerPath, "utf8");
const correctionPath = path.join(root, "migration", "sql", "014_correct_historical_task_orphan_projection.sql");
assert.ok(fs.existsSync(correctionPath), "Migration 014 historical-orphan correction is missing.");
const correction = fs.readFileSync(correctionPath, "utf8");

for (const required of [
  "usp_load_operational_scheduling_workflow",
  "EXEC migration.usp_assert_operational_load_ready @run_key",
  "phase_code VARCHAR(60)='scheduling_workflow'",
  "ROW_NUMBER() OVER",
  "status='completed'",
  "task_source_consolidated",
  "operational_workflow:update_tasks",
  "operational_workflow:task_source_aliases",
  "operational_workflow:task_status_history",
  "WHEN N'admin' THEN N'super_admin'",
  "SET processing_status='loaded'",
]) assert.ok(sql.includes(required), `Migration 010 is missing contract: ${required}`);

const reconciliationCodes = [
  "update_schedules", "schedule_weekdays", "schedule_targets", "schedule_assignees",
  "schedule_reminder_settings", "schedule_reminder_days", "schedule_reminder_emails",
  "scope_groups", "scope_domains", "scope_databases", "licensing_scope",
  "licensing_scope_modules", "licensing_excluded_domains", "licensing_excluded_databases",
  "update_tasks", "task_source_aliases", "task_assignees", "task_sources", "task_reminders",
  "task_reminder_recipients", "task_overdue_alerts", "task_status_history",
];
for (const code of reconciliationCodes) {
  const marker = `N'operational_workflow:${code}'`;
  assert.equal(sql.split(marker).length - 1, 1, `Expected exactly one reconciliation row for ${marker}.`);
}

for (const required of [
  "LOAD SCHEDULING WORKFLOW NONPRODUCTION",
  "$securePassword.MakeReadOnly()",
  "TrustServerCertificate'] = $false",
  "migration.usp_load_operational_scheduling_workflow",
  "migration_version='010'",
  "phase_code='security_core_licensing'",
]) assert.ok(runner.includes(required), `Protected phase 010 runner is missing contract: ${required}`);
assert.ok(!/\.Password\s*=|GetNetworkCredential/i.test(runner), "Runner must not materialize the SQL password as text.");

assert.ok(!/INSERT\s+security[.]auth_sessions/i.test(sql), "Phase 010 must not load sessions.");
assert.ok(!/INSERT\s+security[.]rate_limits/i.test(sql), "Phase 010 must not load rate-limit state.");
for (const required of [
  "client.client_key IS NULL OR domain_record.domain_key IS NULL",
  "database_record.domain_key <> domain_record.domain_key",
  "database_record.client_key <> client.client_key",
  "checkpoint rows are deleted",
  "@header_create_position",
  "STUFF(@patched_definition,@header_create_position,LEN(N'CREATE'),N'ALTER')",
]) assert.ok(correction.includes(required), `Migration 014 is missing contract: ${required}`);

const snapshot = path.join(root, "migration", "backups", "cosmos-export-prod-20260722-155753");
const plan = buildPlan(snapshot);
const expected = {
  "scheduling.update_schedules": 11,
  "scheduling.schedule_weekdays": 7,
  "scheduling.schedule_targets": 6,
  "scheduling.schedule_assignees": 6,
  "scheduling.schedule_reminder_settings": 6,
  "scheduling.schedule_reminder_days": 12,
  "scheduling.schedule_reminder_emails": 0,
  "scheduling.scope_groups": 3,
  "scheduling.scope_domains": 3,
  "scheduling.scope_databases": 2,
  "scheduling.licensing_scope": 2,
  "scheduling.licensing_scope_modules": 2,
  "scheduling.licensing_excluded_domains": 1,
  "scheduling.licensing_excluded_databases": 3,
  "workflow.update_tasks": 341,
  "workflow.task_source_aliases": 32,
  "workflow.task_assignees": 63,
  "workflow.task_sources": 333,
  "workflow.task_reminders": 266,
  "workflow.task_reminder_recipients": 266,
  "workflow.task_overdue_alerts": 2017,
  "workflow.task_status_history": 520,
};
for (const [table, count] of Object.entries(expected)) {
  assert.equal(plan.operationalTableCounts[table], count, `Unexpected certified count for ${table}.`);
}
assert.equal(plan.criticalIssueCount, 0);

const manifest = fs.readFileSync(path.join(root, "migration", "sql", "MANIFEST.sha256"), "utf8");
assert.match(manifest, /[0-9a-f]{64}  010_operational_load_scheduling_workflow[.]sql/);

process.stdout.write(
  "PASS scheduling/workflow contract: 11 schedules; 341 logical tasks; 32 aliases; "
  + "520 history rows; all normalized child counts fixed.\n"
);
