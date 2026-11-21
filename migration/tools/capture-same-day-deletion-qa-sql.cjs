// Test-only extractor. Invokes the compiled delete path with recording SQL
// requests and maps trusted constant SQL to connection-local shadow tables.
const Module = require("node:module");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const fixtureDate = new Date("2026-11-20T15:00:00Z");
const notification = { notificationKey: 4, attemptNo: 2 };
const source = {
  task_key: 11, source_id: "original-task", client_source_id: "qa-client",
  domain_source_id: "qa-domain", target_type: "domain", target_source_id: "qa-domain",
  task_date: fixtureDate, status: "pending", result: null, notes: null,
};
const expected = ["lock", "remove", "detach", "exclusive", "history", "cancel", "suppress"];
const snapshots = {};
const tables = {
  "scheduling.update_schedules": "#schedules",
  "workflow.catalog_task_execution_sources": "#attachments",
  "workflow.catalog_task_execution_links": "#executionLinks",
  "workflow.catalog_task_executions": "#executions",
  "workflow.update_tasks": "#tasks",
  "workflow.task_status_history": "#history",
  "workflow.task_sources": "#taskSources",
  "notifications.email_notifications": "#notices",
  "notifications.email_notification_attempts": "#attempts",
  "notifications.email_notification_recipients": "#recipients",
};
class Request {
  input() { return this; }
  async query(statement) {
    const phase = expected[Object.keys(snapshots).length];
    if (!phase) throw new Error("Unexpected compiled SQL request");
    const marker = {
      lock: "SELECT schedule_key FROM scheduling.update_schedules",
      remove: "UPDATE scheduling.update_schedules SET active=0,deleted_at=@now",
      detach: "UPDATE provenance SET detached_at=",
      exclusive: "SELECT DISTINCT task.task_key",
      history: "INSERT workflow.task_status_history",
      cancel: "INSERT @removed SELECT DISTINCT",
      suppress: "SELECT @lockedKey=notification_key",
    }[phase];
    if (!statement.includes(marker)) throw new Error("Compiled SQL path changed");
    let shadow = statement;
    for (const [real, temp] of Object.entries(tables)) shadow = shadow.replaceAll(real, temp);
    if (/\b(?:scheduling|workflow|notifications|core|security|migration|settings|dbo)\s*\./i.test(shadow) ||
      /\b(?:exec(?:ute)?|openquery|openrowset|use|truncate|alter|drop|create|merge)\b/i.test(shadow)) {
      throw new Error("Compiled batch would escape the local shadow fixture");
    }
    snapshots[phase] = shadow;
    return { recordset: phase === "lock" ? [{ schedule_key: 1 }]
      : phase === "remove" ? [{ deleted_at: fixtureDate }] : phase === "exclusive" ? [source] : [] };
  }
}
const load = Module._load;
// Block direct DB bootstrap and all external package loading from the two
// compiled repositories. This extractor never opens any real connection.
Module._load = function (name, parent, ...args) {
  if (name === "mssql") return {
    Request, NVarChar: () => {}, DateTime2: () => {}, VarChar: () => {}, BigInt: 0, Int: 0,
    ISOLATION_LEVEL: { READ_COMMITTED: 2 },
  };
  if (name === "./sqlTransaction") return { runSqlTransaction: async (work) => work({}) };
  if (name === "./auditSqlWriter") return { writeSqlAuditLog: async () => {} };
  if (name === "./sql" || name === "./password") return {};
  if (!name.startsWith(".") && !path.isAbsolute(name) && !name.startsWith("node:")) {
    throw new Error("Unexpected package in QA extraction");
  }
  return load.call(this, name, parent, ...args);
};
(async () => {
  try {
    const dir = path.join(root, "api", "dist", "src", "lib");
    const { deleteSqlSchedule } = require(path.join(dir, "schedulingSqlWriteRepository.js"));
    const { suppressSqlEmailClaim } = require(path.join(dir, "emailOutboxSqlRepository.js"));
    const deleted = await deleteSqlSchedule({ id: "original" }, { id: "qa", email: "qa@example.invalid" });
    await suppressSqlEmailClaim(notification, "qa");
    if (deleted.deleted !== true || deleted.cancelledTasks !== 1 || Object.keys(snapshots).length !== expected.length) {
      throw new Error("Expected all shadows of the delete path");
    }
    process.stdout.write(JSON.stringify(snapshots));
  } catch {
    process.stderr.write("Could not capture the exact compiled delete/outbox statements offline (phase: "
      + (expected[Object.keys(snapshots).length] ?? "result") + ").\n");
    process.exitCode = 1;
  }
})();
