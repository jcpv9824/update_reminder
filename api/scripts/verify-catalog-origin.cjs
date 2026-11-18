#!/usr/bin/env node
// Local, read-only preflight. Never print the file, connection details, rows or driver errors.
const { readFileSync } = require("node:fs");
const { parseEnv } = require("node:util");

async function main() {
  const [filename, contract, ...rest] = process.argv.slice(2);
  if (!filename || rest.length || !["erp_v1", "sag_admin_v1"].includes(contract)) {
    console.error("Usage: node scripts/verify-catalog-origin.cjs <local-env-file> <erp_v1|sag_admin_v1>");
    return 2;
  }
  const profile = parseEnv(readFileSync(filename, "utf8"));
  const { parseCatalogOriginConnectionAddress } = require("../dist/src/lib/catalogOriginConnectionAddress");
  const address = parseCatalogOriginConnectionAddress(profile.SOURCE_SQL_SERVER, profile.SOURCE_SQL_PORT);
  if (!address
    || !profile.SOURCE_SQL_DATABASE?.trim() || !profile.SOURCE_SQL_USER?.trim() || !profile.SOURCE_SQL_PASSWORD) {
    console.log(JSON.stringify({ contract, status: "invalid_local_profile" }));
    return 2;
  }
  const { createCatalogExternalSqlTransport } = require("../dist/src/lib/catalogExternalSqlTransport");
  const { verifyCatalogExternalSource } = require("../dist/src/lib/catalogExternalSourceQueries");
  const transport = createCatalogExternalSqlTransport({
    ...address, database: profile.SOURCE_SQL_DATABASE.trim(),
    username: profile.SOURCE_SQL_USER.trim(), password: profile.SOURCE_SQL_PASSWORD,
  });
  const status = await verifyCatalogExternalSource(transport, contract);
  console.log(JSON.stringify({ contract, status }));
  return status === "verified" ? 0 : 1;
}

main().then(code => { process.exitCode = code; }).catch(() => {
  console.log(JSON.stringify({ status: "preflight_failed" }));
  process.exitCode = 2;
});
