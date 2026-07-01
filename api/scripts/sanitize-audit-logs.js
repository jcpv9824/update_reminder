/* eslint-disable no-console */
const { getContainer } = require("../dist/src/lib/cosmos.js");
const { sanitizeStoredAuditLogEntry, writeAuditLog } = require("../dist/src/lib/audit.js");

const apply = process.argv.includes("--apply");

function comparable(value) {
  return JSON.stringify(value, (key, item) => key.startsWith("_") ? undefined : item);
}

async function main() {
  const container = getContainer("auditLogs");
  const { resources } = await container.items.readAll().fetchAll();
  let updated = 0;

  for (const resource of resources) {
    const sanitized = sanitizeStoredAuditLogEntry(resource);
    if (comparable(resource) === comparable(sanitized)) continue;
    updated++;
    if (apply) {
      await container.item(resource.id, resource.clientId).replace(sanitized);
    }
  }

  if (apply && updated > 0) {
    await writeAuditLog({
      entityType: "security",
      entityId: "audit-sanitization",
      action: "audit_logs_sanitized",
      performedBy: "system",
      performedByEmail: "system",
      metadata: { scanned: resources.length, updated },
    });
  }

  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", scanned: resources.length, updated }));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: "audit_sanitization_failed", statusCode: error?.statusCode ?? null }));
  process.exitCode = 1;
});
