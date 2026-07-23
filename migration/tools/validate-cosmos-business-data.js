/* Read-only, value-free semantic validation of a Cosmos migration snapshot. */
const fs = require("fs");
const path = require("path");

const snapshotDir = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!snapshotDir || !fs.existsSync(path.join(snapshotDir, "manifest.json"))) {
  process.stderr.write("Usage: node migration/tools/validate-cosmos-business-data.js <snapshot-directory> [output.json]\n");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(snapshotDir, "manifest.json"), "utf8"));
function load(name) {
  const info = manifest.containers && manifest.containers[name];
  if (!info || info.status !== "ok") throw new Error(`Container unavailable in manifest: ${name}`);
  return JSON.parse(fs.readFileSync(path.join(snapshotDir, info.file || `${name}.json`), "utf8"));
}

const data = Object.fromEntries(Object.keys(manifest.containers || {}).map((name) => [name, load(name)]));
const checks = [];
function add(id, severity, count, description) {
  checks.push({ id, severity, count, passed: count === 0, description });
}
function ids(name) { return new Set((data[name] || []).map((x) => x && x.id).filter(Boolean)); }
function norm(value) { return String(value || "").trim().toLocaleLowerCase("es-CO").replace(/\s+/g, " "); }
function normDomain(value) { return norm(value).replace(/\/+$/, ""); }
function duplicateCount(values) {
  const seen = new Set(); let duplicates = 0;
  for (const value of values.filter(Boolean)) { if (seen.has(value)) duplicates += 1; else seen.add(value); }
  return duplicates;
}
function invalidDateCount(records, fields) {
  let count = 0;
  for (const record of records) for (const field of fields) {
    const value = record && record[field];
    if (value !== undefined && value !== null && value !== "" && !Number.isFinite(Date.parse(value))) count += 1;
  }
  return count;
}
function invalidEnumCount(records, field, allowed, optional = false) {
  return records.filter((record) => {
    const value = record && record[field];
    if ((value === undefined || value === null || value === "") && optional) return false;
    return !allowed.has(value);
  }).length;
}
function formatSourceIds(record) {
  const listed = Array.isArray(record && record.fuenteIds)
    ? [...new Set(record.fuenteIds.map((value) => String(value || "").trim()).filter(Boolean))]
    : [];
  return listed.length > 0 ? listed : [String(record && record.fuenteId || "").trim()].filter(Boolean);
}

const userIds = ids("users");
const clientIds = ids("clients");
const domainIds = ids("domains");
const databaseIds = ids("databases");
const scheduleIds = ids("updateSchedules");
const moduleIds = ids("licenseModules");
const sourceIds = ids("fuentesFormatos");
const sectionIds = new Set(data.publicDownloads.filter((x) => x.type === "section").map((x) => x.id));
const domainById = new Map(data.domains.map((x) => [x.id, x]));
const databaseById = new Map(data.databases.map((x) => [x.id, x]));

add("DUP_USER_EMAIL", "critical", duplicateCount(data.users.map((x) => norm(x.email))), "Duplicate normalized user emails.");
add("DUP_CLIENT_NAME", "critical", duplicateCount(data.clients.filter((x) => x.status !== "deleted").map((x) => norm(x.name))), "Duplicate active client names.");
add("DUP_CLIENT_EXTERNAL", "critical", duplicateCount(data.clients.filter((x) => x.status !== "deleted").map((x) => norm(x.externalId))), "Duplicate non-empty active external IDs.");
add("DUP_DOMAIN", "critical", duplicateCount(data.domains.filter((x) => x.status !== "deleted").map((x) => normDomain(x.domainName))), "Duplicate active normalized domains.");
add("DUP_DATABASE_FINGERPRINT", "critical", duplicateCount(data.databases.filter((x) => x.status !== "deleted").map((x) => [norm(x.dbAccess && x.dbAccess.serverHostPort), norm(x.dbAccess && x.dbAccess.initialCatalog), norm(x.dbAccess && x.dbAccess.userId)].join("\u0000"))), "Duplicate active database connection fingerprints.");
add("DUP_MODULE_NAME", "critical", duplicateCount(data.licenseModules.filter((x) => x.status !== "deleted").map((x) => norm(x.name))), "Duplicate active license module names.");
add("DUP_MODULE_CODE", "critical", duplicateCount(data.licenseModules.filter((x) => x.status !== "deleted").map((x) => norm(x.code))), "Duplicate active non-empty license module codes.");
const taskDedupeGroups = new Map();
for (const task of data.updateTasks.filter((x) => x.dedupeKey)) {
  const key = norm(task.dedupeKey);
  if (!taskDedupeGroups.has(key)) taskDedupeGroups.set(key, []);
  taskDedupeGroups.get(key).push(task);
}
const duplicateTaskGroups = Array.from(taskDedupeGroups.values()).filter((group) => group.length > 1);
const unsafeTaskDuplicateGroups = duplicateTaskGroups.filter((group) => {
  const nonObsolete = group.filter((task) => !(task.status === "cancelled" && task.result === "obsolete"));
  return nonObsolete.length > 1 || group.some((task) => task.status === "cancelled" && task.result !== "obsolete");
});
add("UNSAFE_TASK_DEDUPE", "critical", unsafeTaskDuplicateGroups.length, "Dedupe collisions that cannot use the approved obsolete-task consolidation rule.");
add("MIGRATABLE_TASK_DEDUPE", "warning", duplicateTaskGroups.length, "Dedupe groups consolidated through task_source_aliases and inferred history.");
add("DUP_PUBLIC_SLUG", "critical", duplicateCount(data.publicDownloads.filter((x) => x.status !== "deleted").map((x) => norm(x.slug))), "Duplicate active public slugs.");

add("ORPHAN_DOMAIN_CLIENT", "critical", data.domains.filter((x) => !clientIds.has(x.clientId)).length, "Domains whose client is missing.");
add("ORPHAN_DATABASE_CLIENT", "critical", data.databases.filter((x) => !clientIds.has(x.clientId)).length, "Databases whose client is missing.");
add("ORPHAN_DATABASE_DOMAIN", "critical", data.databases.filter((x) => !domainIds.has(x.domainId)).length, "Databases whose domain is missing.");
add("DATABASE_CLIENT_MISMATCH", "critical", data.databases.filter((x) => domainById.has(x.domainId) && domainById.get(x.domainId).clientId !== x.clientId).length, "Databases whose client differs from their domain client.");
add("ORPHAN_SCHEDULE_CLIENT", "critical", data.updateSchedules.filter((x) => !clientIds.has(x.clientId)).length, "Schedules whose client is missing.");
add("ORPHAN_SCHEDULE_DOMAIN", "critical", data.updateSchedules.filter((x) => x.domainId && !domainIds.has(x.domainId)).length, "Schedules whose optional domain is missing.");
add("ORPHAN_TASK_CLIENT", "critical", data.updateTasks.filter((x) => !clientIds.has(x.clientId)).length, "Tasks whose client is missing.");
const terminalTaskStatuses = new Set(["completed", "cancelled"]);
const taskMissingDomain = data.updateTasks.filter((x) => !domainIds.has(x.domainId));
add("ACTIVE_ORPHAN_TASK_DOMAIN", "critical", taskMissingDomain.filter((x) => !terminalTaskStatuses.has(x.status)).length, "Non-terminal tasks whose domain is missing.");
add("HISTORICAL_ORPHAN_TASK_DOMAIN", "warning", taskMissingDomain.filter((x) => terminalTaskStatuses.has(x.status)).length, "Terminal tasks preserved with nullable FK and source snapshots.");
const taskMissingTarget = data.updateTasks.filter((x) => x.targetType === "domain" ? !domainIds.has(x.targetId) : x.targetType === "database" ? !databaseIds.has(x.targetId) : true);
add("ACTIVE_ORPHAN_TASK_TARGET", "critical", taskMissingTarget.filter((x) => !terminalTaskStatuses.has(x.status)).length, "Non-terminal tasks whose physical target is missing/invalid.");
add("HISTORICAL_ORPHAN_TASK_TARGET", "warning", taskMissingTarget.filter((x) => terminalTaskStatuses.has(x.status)).length, "Terminal tasks preserved with nullable target FK and source snapshots.");
const taskHierarchyMismatch = data.updateTasks.filter((x) => x.targetType === "database" && databaseById.has(x.targetId) && databaseById.get(x.targetId).domainId !== x.domainId);
add("ACTIVE_TASK_TARGET_HIERARCHY", "critical", taskHierarchyMismatch.filter((x) => !terminalTaskStatuses.has(x.status)).length, "Non-terminal database tasks whose target belongs to another domain.");
add("HISTORICAL_TASK_TARGET_HIERARCHY", "warning", taskHierarchyMismatch.filter((x) => terminalTaskStatuses.has(x.status)).length, "Terminal hierarchy mismatch preserved as source snapshot while FK uses actual target hierarchy.");
add("ORPHAN_TASK_ROOT_SCHEDULE", "warning", data.updateTasks.filter((x) => x.rootScheduleId && !scheduleIds.has(x.rootScheduleId)).length, "Task primary schedule missing; requires tombstone/history resolution.");
add("ORPHAN_TASK_SOURCE_SCHEDULE", "warning", data.updateTasks.flatMap((x) => x.sources || []).filter((x) => x.scheduleId && !scheduleIds.has(x.scheduleId)).length, "Task source schedule missing; requires tombstone/history resolution.");

let orphanAssignees = 0;
for (const x of [...data.domains, ...data.databases]) for (const id of x.assignedUpdaterIds || []) if (!userIds.has(id)) orphanAssignees += 1;
for (const x of data.updateSchedules) for (const id of [...(x.assignedUserIds || []), ...(x.databaseAssignedUserIds || [])]) if (!userIds.has(id)) orphanAssignees += 1;
for (const x of data.updateTasks) for (const id of x.assignedUserIds || []) if (!userIds.has(id)) orphanAssignees += 1;
add("ORPHAN_ASSIGNEE", "warning", orphanAssignees, "Assignment rows whose user is missing.");

add("ORPHAN_CLIENT_LICENSE", "critical", data.clients.flatMap((x) => x.licenseModuleIds || []).filter((id) => !moduleIds.has(id)).length, "Embedded client licenses whose module is missing.");
add("ORPHAN_LICENSE_ASSIGNMENT", "critical", data.licenseAssignments.filter((x) => !moduleIds.has(x.moduleId) || (x.clientId && !clientIds.has(x.clientId)) || (x.domainId && !domainIds.has(x.domainId)) || (x.databaseId && !databaseIds.has(x.databaseId))).length, "Explicit license assignments with missing references.");
const invalidFormatSourceContracts = data.formatosImpresion.filter((x) => {
  const rawIds = Array.isArray(x.fuenteIds) ? x.fuenteIds.map((value) => String(value || "").trim()).filter(Boolean) : [];
  const resolved = formatSourceIds(x);
  return resolved.length === 0 || resolved.length > 50 || rawIds.length !== new Set(rawIds).size
    || (rawIds.length > 0 && rawIds[0] !== String(x.fuenteId || "").trim());
}).length;
add("INVALID_FORMAT_SOURCE_CONTRACT", "critical", invalidFormatSourceContracts, "Print formats must have 1-50 distinct sources and keep fuenteId as the first primary source.");
add("ORPHAN_FORMAT_SOURCE", "critical", data.formatosImpresion.flatMap(formatSourceIds).filter((id) => !sourceIds.has(id)).length, "Print-format source memberships whose source is missing.");
const activeFormatSourceNames = data.formatosImpresion.filter((x) => x.status !== "deleted")
  .flatMap((x) => formatSourceIds(x).map((sourceId) => `${sourceId}\u0000${norm(x.nombre)}`));
add("DUP_FORMAT_NAME_PER_SOURCE", "critical", duplicateCount(activeFormatSourceNames), "Duplicate active print-format names within any assigned source.");
add("ORPHAN_FORMAT_LICENSE", "critical", data.formatosImpresion.filter((x) => x.licenciaModuloId && !moduleIds.has(x.licenciaModuloId)).length, "Print formats whose license module is missing.");
add("ORPHAN_PUBLIC_SECTION", "critical", data.publicDownloads.filter((x) => x.type === "document" && !sectionIds.has(x.sectionId)).length, "Public documents whose section is missing.");

const entityStatuses = new Set(["active", "inactive", "deleted"]);
const taskStatuses = new Set(["pending", "in_progress", "completed", "failed", "blocked", "cancelled", "reopened"]);
const environments = new Set(["production", "test", "demo"]);
const frequencies = new Set(["once", "weekly", "interval", "monthly", "manual"]);
add("INVALID_ENTITY_STATUS", "critical", [data.clients, data.domains, data.databases, data.licenseModules, data.fuentesFormatos, data.formatosImpresion, data.publicDownloads].flat().filter((x) => !entityStatuses.has(x.status)).length, "Invalid entity status values.");
add("INVALID_TASK_STATUS", "critical", invalidEnumCount(data.updateTasks, "status", taskStatuses), "Invalid task status values.");
add("INVALID_ENVIRONMENT", "critical", [...data.domains, ...data.databases].filter((x) => !environments.has(x.environment)).length, "Invalid operational environments.");
add("INVALID_FREQUENCY", "critical", invalidEnumCount(data.updateSchedules, "frequencyType", frequencies), "Invalid schedule frequencies.");
add("INVALID_DATES", "critical", invalidDateCount(data.users, ["createdAt", "updatedAt", "lastLoginAt", "passwordUpdatedAt", "passwordExpiresAt", "passwordResetExpiresAt", "passwordResetUsedAt"]) + invalidDateCount(data.clients, ["createdAt", "updatedAt", "deletedAt"]) + invalidDateCount(data.domains, ["createdAt", "updatedAt", "deletedAt", "lastUpdatedAt"]) + invalidDateCount(data.databases, ["createdAt", "updatedAt", "deletedAt", "lastUpdatedAt"]) + invalidDateCount(data.updateTasks, ["createdAt", "updatedAt", "completedAt", "blockedAt", "resolvedAt", "reopenedAt"]) + invalidDateCount(data.updateSchedules, ["createdAt", "updatedAt", "completedAt"]), "Invalid ISO timestamp fields.");

let invalidFormatFiles = 0;
for (const x of data.formatosImpresion) {
  let bytes;
  try { bytes = Buffer.from(String(x.pdfBase64 || ""), "base64"); } catch { bytes = Buffer.alloc(0); }
  if (!bytes.length || bytes.length > 1500000 || bytes.subarray(0, 4).toString("utf8") !== "%PDF" || x.pdfMimeType !== "application/pdf") invalidFormatFiles += 1;
}
add("INVALID_PRINT_FILE", "critical", invalidFormatFiles, "Invalid print-format PDF content, size, signature, or MIME.");

let invalidPublicFiles = 0;
for (const x of data.publicDownloads.filter((item) => item.type === "document")) {
  let bytes;
  try { bytes = Buffer.from(String(x.archivoBase64 || ""), "base64"); } catch { bytes = Buffer.alloc(0); }
  const extension = String(x.archivoNombreOriginal || "").toLowerCase().match(/\.[a-z0-9]{1,8}$/)?.[0] || "";
  const isVideo = [".mp4", ".m4v", ".mov", ".webm"].includes(extension);
  const videoSignatureValid = extension === ".webm"
    ? bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    : bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp";
  if (!bytes.length || bytes.length > (isVideo ? 100000000 : 8000000) || bytes.length !== x.archivoBytes
      || !x.archivoNombreOriginal || !x.archivoMimeType || (isVideo && (!String(x.archivoMimeType).startsWith("video/") || !videoSignatureValid))) invalidPublicFiles += 1;
}
add("INVALID_PUBLIC_FILE", "critical", invalidPublicFiles, "Invalid public file content, byte count, name, MIME, or size.");

const storedRoles = new Set(data.roles.map((x) => x.id));
const defaultRoles = new Set(["super_admin", "database_updater", "domain_updater", "print_formats_admin"]);
const legacyRoles = new Set(["admin", "formatos_impresion.admin", "client_manager", "viewer", "public_downloads.admin"]);
const roleReferences = [...data.users.flatMap((x) => x.roles || []), ...data.updateSchedules.flatMap((x) => [x.assignedRole, x.domainAssignedRole, x.databaseAssignedRole].filter(Boolean)), ...data.updateTasks.map((x) => x.assignedRole).filter(Boolean)];
add("UNKNOWN_ROLE_REFERENCE", "critical", roleReferences.filter((id) => !storedRoles.has(id) && !defaultRoles.has(id) && !legacyRoles.has(id)).length, "Role references absent from stored/default/legacy catalogs.");
add("LEGACY_ROLE_REFERENCE", "warning", roleReferences.filter((id) => legacyRoles.has(id)).length, "Legacy role references requiring canonical alias migration.");
add("ACTIVE_USER_WITHOUT_ROLE", "warning", data.users.filter((x) => x.active !== false && (!Array.isArray(x.roles) || x.roles.length === 0)).length, "Active users without roles preserve the runtime deny-all behavior; no implicit role is assigned.");

function countPlainSecretCandidates(value, currentPath = "") {
  if (!value || typeof value !== "object") return 0;
  let count = 0;
  for (const [key, child] of Object.entries(value)) {
    const fieldPath = currentPath ? `${currentPath}.${key}` : key;
    if (typeof child === "string" && child.length > 0 && /(password|secret|token|connectionstring|credential)/i.test(key) && !/(hash|secretname|configured|version|expires|updated|used|ttl|mustchange|included|notification|sendtemporary)/i.test(key)) count += 1;
    else if (child && typeof child === "object") count += countPlainSecretCandidates(child, fieldPath);
  }
  return count;
}
add("PLAINTEXT_SECRET_CANDIDATE", "critical", Object.values(data).flat().reduce((sum, item) => sum + countPlainSecretCandidates(item), 0), "Potential plaintext secret fields; values are never emitted.");

const criticalErrorCount = checks.filter((x) => x.severity === "critical").reduce((sum, x) => sum + x.count, 0);
const warningCount = checks.filter((x) => x.severity === "warning").reduce((sum, x) => sum + x.count, 0);
const report = {
  generatedAt: new Date().toISOString(),
  sourceExportedAt: manifest.exportedAt,
  documentCount: Object.values(data).reduce((sum, rows) => sum + rows.length, 0),
  criticalErrorCount,
  warningCount,
  checks,
};
const output = process.argv[3] ? path.resolve(process.argv[3]) : path.join(snapshotDir, "business-validation.json");
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`Business validation written: ${output}\n`);
process.stdout.write(`Critical errors: ${criticalErrorCount}; warnings: ${warningCount}; checks: ${checks.length}\n`);
if (criticalErrorCount) process.exitCode = 2;
