/* Value-free regression for source identifier capacity proven by the certified snapshot. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const snapshot = path.join(root, "migration", "backups", "cosmos-export-prod-20260722-155753");
const manifest = JSON.parse(fs.readFileSync(path.join(snapshot, "manifest.json"), "utf8"));
let maximumIdLength = 0;
let overContract = 0;
for (const [container, info] of Object.entries(manifest.containers)) {
  assert.equal(info.status, "ok", `Container is not available: ${container}`);
  const documents = JSON.parse(fs.readFileSync(path.join(snapshot, info.file), "utf8"));
  for (const document of documents) {
    const length = String(document.id || "").length;
    maximumIdLength = Math.max(maximumIdLength, length);
    if (length > 260) overContract += 1;
  }
}

const tasks = JSON.parse(fs.readFileSync(path.join(snapshot, "updateTasks.json"), "utf8"));
const overLegacyTaskLimit = tasks.filter((task) => String(task.id || "").length > 150).length;
const maximumTaskIdLength = Math.max(...tasks.map((task) => String(task.id || "").length));
assert.equal(overLegacyTaskLimit, 126, "The real regression fixture for IDs above 150 changed.");
assert.equal(maximumTaskIdLength, 156, "The certified maximum task ID length changed.");
assert.equal(overContract, 0, "A source ID exceeds the 260-character relational contract.");

const migration = fs.readFileSync(
  path.join(root, "migration", "sql", "012_expand_task_source_identifiers.sql"), "utf8",
);
for (const contract of [
  "migration.raw_documents ALTER COLUMN source_id NVARCHAR(260)",
  "migration.file_transfers ALTER COLUMN source_id NVARCHAR(260)",
  "migration.stage_update_tasks ALTER COLUMN source_id NVARCHAR(260)",
  "workflow.update_tasks ALTER COLUMN source_id NVARCHAR(260)",
  "workflow.task_source_aliases ALTER COLUMN alias_source_id NVARCHAR(260)",
]) assert.ok(migration.includes(contract), `Migration 012 is missing: ${contract}`);

const importer = fs.readFileSync(
  path.join(root, "migration", "tools", "Import-CosmosSnapshot-RawStage.ps1"), "utf8",
);
assert.ok(importer.includes("longer than the certified 260-character SQL contract"));
assert.ok(importer.includes("longer than the certified 300-character SQL contract"));

process.stdout.write(
  `PASS identifier capacity: ${overLegacyTaskLimit} task IDs exceed 150; maximum ${maximumTaskIdLength}; `
  + `all source IDs fit NVARCHAR(260) (global max ${maximumIdLength}).\n`,
);
