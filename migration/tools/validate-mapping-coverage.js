/* Validates that every field name observed by the structural Cosmos profiler is named in the canonical matrix. */
const fs = require("fs");
const path = require("path");

const profilePath = process.argv[2] ? path.resolve(process.argv[2]) : null;
const repoRoot = path.resolve(__dirname, "..", "..");
const matrixPath = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(repoRoot, "docs", "COSMOS_TO_SQL_MIGRATION_MATRIX.md");

if (!profilePath || !fs.existsSync(profilePath)) {
  process.stderr.write("Usage: node migration/tools/validate-mapping-coverage.js <profile.json> [matrix.md]\n");
  process.exit(1);
}
if (!fs.existsSync(matrixPath)) {
  process.stderr.write(`Canonical matrix not found: ${matrixPath}\n`);
  process.exit(1);
}

const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
const matrix = fs.readFileSync(matrixPath, "utf8");
const ignoredSystemFields = new Set(["_rid", "_self", "_etag", "_attachments", "_ts"]);
const gaps = [];

function sourceLeaf(fieldPath) {
  return fieldPath.replace(/\[\]/g, "").split(".").pop();
}

function isNamedInMatrix(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`).test(matrix);
}

for (const [container, containerProfile] of Object.entries(profile.containers || {})) {
  for (const field of containerProfile.fields || []) {
    const fieldPath = field.path;
    const leaf = sourceLeaf(fieldPath);
    if (ignoredSystemFields.has(leaf)) continue;
    if (container === "auditLogs" && /^(before|after|metadata)\./.test(fieldPath)) continue;
    if (!isNamedInMatrix(leaf)) gaps.push({ container, fieldPath });
  }
}

if (gaps.length) {
  process.stderr.write(`Mapping coverage failed: ${gaps.length} field path(s) are not named in the canonical matrix.\n`);
  for (const gap of gaps) process.stderr.write(`- ${gap.container}.${gap.fieldPath}\n`);
  process.exit(2);
}

process.stdout.write(`Mapping coverage passed for ${Object.keys(profile.containers || {}).length} container(s); 0 uncovered observed field paths.\n`);
