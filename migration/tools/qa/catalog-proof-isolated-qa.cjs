// Local QA only. Supplies a generated fixture key in place of the Azure Key Vault
// call. The API, SQL, version pinning and location proof checks still run unchanged.
"use strict";
const env = process.env;
const fixtureName = "qa-isolated-catalog-location-fixture";
const fixtureVersion = env.PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION;
const key = env.PORTAL_LOCAL_QA_PROOF_KEY;
if (env.PORTAL_SAG_ENVIRONMENT !== "qa" || env.SQL_DATABASE !== "PortalSAGWeb-TEST" ||
    env.SQL_SERVER_HOST !== "127.0.0.1,41439" || env.SQL_USERNAME !== "portal_fixture_runtime_20261124" ||
    env.KEY_VAULT_URL || env.PORTAL_CATALOG_MATCH_KEY_SECRET_NAME !== fixtureName ||
    !/^[0-9a-f]{32}$/.test(fixtureVersion ?? "") || !/^[0-9a-f]{64}$/.test(key ?? "")) {
  throw new Error("The catalog fixture key requires the isolated, loopback SQL Server.");
}
delete env.PORTAL_LOCAL_QA_PROOF_KEY;
const vault = require("../../../api/dist/src/lib/keyVault");
vault.getSecret = async (name, signal, version) => {
  if (signal?.aborted || name !== fixtureName || version !== fixtureVersion) {
    throw new Error("Only the exact catalog QA fixture secret is available.");
  }
  return key;
};
