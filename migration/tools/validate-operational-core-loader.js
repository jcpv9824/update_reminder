/* Value-free regression checks for migration 009 and the certified snapshot. */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { buildPlan, canonicalRoleId } = require("./plan-operational-transform");

const root = path.resolve(__dirname, "..", "..");
const sqlPath = path.join(root, "migration", "sql", "009_operational_load_control_and_core.sql");
const snapshot = path.join(root, "migration", "backups", "cosmos-export-prod-20260722-155753");
const sql = fs.readFileSync(sqlPath, "utf8");
const read = (name) => JSON.parse(fs.readFileSync(path.join(snapshot, `${name}.json`), "utf8"));

for (const required of [
  "usp_assert_operational_load_ready",
  "usp_load_operational_security_core_licensing",
  "operational_load_phases",
  "file_transfers",
  "tokenVersion')),0) + 1",
  "CASE WHEN s.status='deleted' THEN CONVERT(BIT,0) ELSE CONVERT(BIT,1) END AS active",
  "WHEN N'admin' THEN N'super_admin'",
  "WHEN N'client_manager' THEN N'client_operations_manager'",
  "WHEN N'viewer' THEN N'audit_viewer'",
]) assert.ok(sql.includes(required), `Missing migration 009 contract: ${required}`);

assert.ok(!/INSERT\s+security[.]auth_sessions/i.test(sql), "Legacy sessions must not be loaded.");
assert.ok(!/INSERT\s+security[.]rate_limits/i.test(sql), "Legacy rate-limit windows must not be loaded.");

const databases = read("databases");
const fingerprint = (record) => crypto.createHash("sha256").update([
  record.dbAccess && record.dbAccess.serverHostPort,
  record.dbAccess && record.dbAccess.initialCatalog,
  record.dbAccess && record.dbAccess.userId,
].map((value) => String(value || "").trim().toLocaleLowerCase("es-CO")).join("\0")).digest("hex");
const activeFingerprints = databases.filter((record) => record.status !== "deleted").map(fingerprint);
assert.equal(new Set(activeFingerprints).size, activeFingerprints.length, "Active access fingerprints must be unique.");
assert.ok(databases.every((record) => String(record.dbAccess && record.dbAccess.passwordSecretName || "").trim()),
  "Every database must retain a secret reference.");

const plan = buildPlan(snapshot);
assert.equal(plan.operationalTableCounts["core.database_access_profiles"], databases.length,
  "Every historical database keeps its own access-profile/secret reference.");

const seededRoles = new Set(["super_admin", "database_updater", "domain_updater", "print_formats_admin"]);
const definedRoles = new Set(read("roles").map((role) => canonicalRoleId(role.id)));
for (const user of read("users")) {
  for (const role of user.roles || []) {
    const canonical = canonicalRoleId(role);
    assert.ok(seededRoles.has(canonical) || definedRoles.has(canonical), "Every assigned role must exist after migration.");
  }
}

const manifest = fs.readFileSync(path.join(root, "migration", "sql", "MANIFEST.sha256"), "utf8");
assert.match(manifest, /[0-9a-f]{64}  009_operational_load_control_and_core[.]sql/);

process.stdout.write(
  `PASS operational core loader contract: ${databases.length} access profiles; `
  + `${activeFingerprints.length} active unique fingerprints; forced session boundary; all assigned roles resolvable.\n`
);
