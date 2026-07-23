/* Static and value-free contract for the protected Blob executor. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildTransferPlan } = require("./prepare-blob-transfer-package");

const root = path.resolve(__dirname, "..", "..");
const scriptPath = path.join(root, "migration", "tools", "Transfer-PortalSAGWeb-Blobs.ps1");
const cmdPath = path.join(root, "migration", "tools", "Run-Blob-Transfer-NonProduction.cmd");
const productionCmdPath = path.join(root, "migration", "tools", "Run-Production-CurrentSnapshot-Blob-Verification.cmd");
assert.ok(fs.existsSync(scriptPath), "Protected non-production Blob executor is missing.");
assert.ok(fs.existsSync(cmdPath), "Double-click non-production Blob launcher is missing.");
assert.ok(fs.existsSync(productionCmdPath), "Double-click production Blob-verification launcher is missing.");

const script = fs.readFileSync(scriptPath, "utf8");
for (const required of [
  "[ValidateSet('nonproduction', 'production-stage')]",
  "TRANSFER BLOBS NONPRODUCTION",
  "VERIFY CURRENT BLOBS PRODUCTION",
  "TargetEnvironment -eq 'production-stage'",
  "data14.sagerp.co,54103",
  "IS_ROLEMEMBER(N'db_owner')",
  "HAS_PERMS_BY_NAME(DB_NAME(),N'DATABASE',N'CONTROL')",
  "EXECUTE AS USER=N'dbo';",
  "REVERT;",
  "permission memberships and grants were preserved",
  "$securePassword.MakeReadOnly()",
  "TrustServerCertificate'] = $false",
  "--auth-mode", "login",
  "enableHttpsTrafficOnly",
  "minimumTlsVersion",
  "allowBlobPublicAccess",
  "properties.publicAccess",
  "migration.usp_register_file_transfer_plan",
  "migration.usp_mark_file_transfer_verified",
  "phase_code='scheduling_workflow'",
  "Get-FileHash -Algorithm SHA256",
  "status IN ('verified','linked')",
  "expectedFiles -ne 39",
  "expectedBytes -ne 968128",
]) assert.ok(script.includes(required), `Blob executor is missing contract: ${required}`);

assert.ok(!/az\s+login/i.test(script), "Executor must not launch or automate an Azure login flow.");
assert.ok(!/--connection-string|AZURE_STORAGE_CONNECTION_STRING|StorageAccountKey|AccountKey|SasToken|SharedAccessSignature|\bSAS\b/i.test(script),
  "Executor must not accept storage keys, connection strings or SAS credentials.");
assert.ok(!/Write-(?:Host|Output)[^\r\n]*(?:sourceId|originalName|sha256|blobName|manifest)/i.test(script),
  "Executor must not print restricted manifest values.");
assert.ok(!/\.Password\s*=|GetNetworkCredential/i.test(script), "Executor must not materialize the SQL password as text.");

const snapshot = path.join(root, "migration", "backups", "cosmos-export-prod-20260722-155753");
const plan = buildTransferPlan(snapshot);
assert.equal(plan.fileCount, 39);
assert.equal(plan.totalBytes, 968128);
assert.equal(new Set(plan.entries.map((item) => item.blobName)).size, 39);

process.stdout.write(
  "PASS protected Blob executor contract: identity auth; private TLS storage; "
  + "39 local/remote hashes; SQL ledger verification; no storage credential inputs.\n"
);
