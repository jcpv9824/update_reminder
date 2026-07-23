"use strict";

const sql = require("mssql");

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

async function main() {
  const hostValue = required("SQL_SERVER_HOST");
  const comma = hostValue.lastIndexOf(",");
  const server = comma > 0 ? hostValue.slice(0, comma) : hostValue;
  const port = comma > 0 ? Number(hostValue.slice(comma + 1)) : Number(process.env.SQL_SERVER_PORT || 1433);
  const pool = await sql.connect({
    server, port, database: required("SQL_DATABASE"), user: required("SQL_USERNAME"),
    password: required("SQL_PASSWORD"), connectionTimeout: 15000, requestTimeout: 30000,
    options: { encrypt: true, trustServerCertificate: false, enableArithAbort: true, appName: "PortalSAGWeb-LocalValidation" },
  });
  try {
    const result = await pool.request().query(`
      SELECT
        CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS major_version,
        DB_NAME() AS database_name,
        DATABASEPROPERTYEX(DB_NAME(),'Collation') AS collation_name,
        (SELECT compatibility_level FROM sys.databases WHERE database_id=DB_ID()) AS compatibility_level,
        ISNULL(IS_ROLEMEMBER(N'portal_runtime'),0) AS is_portal_runtime,
        ISNULL(IS_ROLEMEMBER(N'db_owner'),0) AS is_db_owner,
        ISNULL(IS_ROLEMEMBER(N'db_ddladmin'),0) AS is_db_ddladmin,
        ISNULL(IS_ROLEMEMBER(N'portal_migrator'),0) AS is_portal_migrator;
    `);
    const row = result.recordset[0];
    const contractOk = row && row.major_version === 15 && row.database_name === "PortalSAGWeb"
      && row.collation_name === "Modern_Spanish_CI_AS" && row.compatibility_level === 150;
    const leastPrivilegeOk = row && row.is_portal_runtime === 1 && row.is_db_owner === 0
      && row.is_db_ddladmin === 0 && row.is_portal_migrator === 0;
    if (!contractOk) throw new Error("The SQL endpoint does not match the certified PortalSAGWeb contract.");
    if (!leastPrivilegeOk) throw new Error("The SQL login is not the required least-privilege portal_runtime account.");
    process.stdout.write("SQL runtime validation succeeded: certified database and least-privilege role.\n");
  } finally {
    await pool.close();
  }
}

main().catch((error) => {
  process.stderr.write(`SQL runtime validation failed: ${error.message}\n`);
  process.exitCode = 1;
});
