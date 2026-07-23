# Safe connection to PortalSAGWeb

This folder tests the new SQL Server connection without saving credentials and without modifying the database.

Defaults taken from the SSMS screenshot:

- Server endpoint: `data14.sagerp.co,54103`
- Database: `PortalSAGWeb`
- Expected collation: `Modern_Spanish_CI_AS`

The SSMS label `SAGWebDev` is a saved connection/display name and is not assumed to be the SQL username.

## Easiest method

1. Double-click `Open-PortalSAGWeb-Connection.cmd`.
2. Press Enter to accept the server and database defaults, or type corrected values from the provider.
3. Enter the SQL Authentication username.
4. Enter the password in the protected prompt. The password appears as hidden characters and is not saved.
5. The script opens an encrypted connection and displays only server/database metadata.
6. Answer `y` only if you want to run the complete read-only intake.

The script does not create schemas, tables or users. It does not write a connection file.

## QA full-control session

Use `Open-PortalSAGWeb-QA-FullControl.cmd` for the QA database. It is separate from the production controller:

1. Replace the displayed server and database defaults in the prompts when the QA values differ.
2. Enter the QA SQL username and its password. `SAGWebDev` is acceptable on QA if it is elevated there.
3. The controller verifies the effective permissions: the login must have `db_owner` plus database `CONTROL` on QA. Its production permissions are not changed.
4. Type `AUTHORIZE DATABASE ACCESS FOR THIS SESSION` exactly once.
5. Leave the terminal open while Codex performs QA intake, migrations, and rollback rehearsals.

The QA launcher uses `migration/work/sql-session-qa`, never stores credentials, and refuses the known production pair `data14.sagerp.co,54103 / PortalSAGWeb`. The ordinary production session continues to use its separate descriptor.

## Ephemeral Codex control session

`Open-PortalSAGWeb-EphemeralControl.cmd` creates a temporary, current-Windows-user-only named-pipe session when Codex needs to execute database commands without receiving or storing the SQL password.

1. The operator enters the password directly in the visible terminal.
2. The password remains only inside that PowerShell process as a read-only `SecureString` used by `SqlCredential`.
3. Strict TLS remains enabled (`Encrypt=True`, `TrustServerCertificate=False`).
4. The session verifies SQL Server 2019, database `PortalSAGWeb`, compatibility 150, collation, `db_owner`, and database `CONTROL`.
5. After the login is verified, the operator types `AUTHORIZE DATABASE ACCESS FOR THIS SESSION` once. Read and write requests then execute through the current-user named pipe without per-request approval prompts until that terminal closes.
6. Closing the terminal revokes access immediately and removes the non-secret session descriptor under the Git-ignored `migration/work/` directory.

This provides full control of the `PortalSAGWeb` database only. It neither requests nor requires server-level `sysadmin` or `VIEW SERVER STATE` privileges. It does not authorize production DDL/data changes by itself; backup, rehearsal, and migration gates still apply.

The controller intentionally has no default username. Under the owner decision recorded on 2026-07-23, `SAGWebDev` may open the production full-control controller only when SQL proves both `db_owner` and database `CONTROL`. The controller records `permissionMutationPolicy=preserve-existing` in its non-secret session descriptor and never removes roles or grants when it closes or applies a patch.

This is an explicit exception to the recommended separate-runtime/separate-migrator model. Because the deployed application also uses `SAGWebDev`, retaining `db_owner` increases the impact of a compromised runtime credential. The exception does not waive backup, rehearsal, reconciliation, maintenance, or rollback gates.

The `.cmd` now exposes the two non-secret values you may edit:

```bat
set "SQL_SERVER=data14.sagerp.co,54103"
set "SQL_DATABASE=PortalSAGWeb"
```

Do not add the username or password to the `.cmd`. They are requested after execution by these protected prompts:

```text
SQL Authentication username:
SQL Authentication password:
```

## TLS behavior

Encryption is mandatory and certificate validation is enabled by default:

```text
Encrypt=True
TrustServerCertificate=False
```

If certificate validation fails, ask the infrastructure provider for the correct trusted certificate and server FQDN. Do not permanently disable certificate validation.

For a one-time diagnostic only, after independently confirming the server identity:

```powershell
cd "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler\migration\connect-sql-server"
.\Connect-PortalSAGWeb.ps1 -TrustServerCertificate
```

## Named-instance connectivity

The original `DATA14\INS_D14_03` value is a named SQL Server instance and produced discovery error 26. The launcher now uses the provider endpoint `data14.sagerp.co,54103`, which avoids SQL Browser discovery. If it still produces error 26 or 53, ask the provider to confirm:

- the DNS/FQDN reachable from this computer;
- the fixed TCP port;
- firewall/VPN allowlisting;
- whether SQL Browser/UDP 1434 is required.

With a fixed port, enter the server as:

```text
server.example.internal,1433
```

## What must never be added here

- Passwords.
- Connection strings containing passwords.
- `.env` or local JSON credential files.
- SQL login screenshots containing a password.
- Key Vault secret values.

The repository ignores local files matching `*.local.*`, `*.secret.*` and `*.credential.*`, but the preferred approach is not to create them at all.

## MCP and later application integration

No SQL Server MCP connector is installed in the current Codex environment. The available local `sqlcmd` and .NET SQL client are sufficient for intake and migration scripts.

This launcher is only for human-assisted validation. After the connection and permissions are approved, the application's runtime credential will be stored in Azure Key Vault or supplied through the provider's secure configuration mechanism—not embedded in source code.

## Local project connection

`Open-PortalSAGWeb-LocalDualRead.cmd` starts the local API and frontend connected to the certified SQL database in `dual-read` mode. It prompts securely for:

- the dedicated SQL runtime username and password.

Cosmos remains the response source until cutover, but its connection string is no longer requested from the operator. The launcher retrieves the existing `COSMOS_CONNECTION_STRING` application setting from `erpupdsch4645-api` through the currently signed-in Azure CLI session, keeps it only in process memory, never displays it, and clears it when the API window closes.

Before opening the launcher, sign in once if Azure CLI is not already authenticated:

```powershell
az login
```

Do not copy the Cosmos setting from Azure or paste it into the terminal.

The launcher validates SQL Server 2019, database, compatibility, collation and `portal_runtime` membership before starting anything. It preserves owner-approved elevated roles, disables all six timers and keeps `SQL_SECURITY_RUNTIME_ENABLED=false`.

`SAGWebDev` was restricted on 2026-07-21, then the owner explicitly reversed that operating policy on 2026-07-23. From that decision forward, Portal migration tooling must preserve the login's effective permissions and must not execute `Repurpose-SAGWebDev-As-PortalRuntime.sql`; that downgrade script now fails closed before changing SQL.
