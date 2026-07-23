# Portal SAG Web — Production Cutover Preflight

Date: 2026-07-22
Target: `data14.sagerp.co,54103` / `PortalSAGWeb`
Decision: **NO-GO — cutover not started**

## Production state verified read-only

- The deployed Function App reports `backend=dual-read`, `sqlConnected=true`, and `sqlSecurityEnabled=false`.
- Azure App Settings confirm `DATA_BACKEND=dual-read` and `SQL_SECURITY_RUNTIME_ENABLED=false`.
- No timer-disable App Settings are currently present. Timers therefore must be stopped explicitly during a future approved cutover window.
- SQL Server is major version 15, compatibility 150, collation `Modern_Spanish_CI_AS`, recovery model FULL, RCSI ON, and snapshot isolation ON.
- `SAGWebDev` remains correctly restricted: member of `portal_runtime`, not `db_owner`, and without database CONTROL.
- The latest visible full backup finished at `2026-07-22T00:40:13Z`; no differential or transaction-log backup was visible. A current restore point and tested restore procedure are not proven.

## Data currently present

| Entity | Current SQL rows |
|---|---:|
| Clients | 40 |
| Domains | 45 |
| Databases | 55 |
| License modules | 21 |
| License assignments | 55 |
| Schedules | 10 |
| Workflow tasks | 338 |
| Files | 39 |
| Audit logs | 2,183 |

These are rehearsal-run rows, not the certified final production dataset. The reviewed 2026-07-22 Cosmos snapshot contains newer scheduling, task, audit, session, rate-limit, content, and format state.

## Critical failed gates

1. **Gate A — backup/restore:** no current cutover restore point or restore rehearsal is proven; FULL recovery shows no visible log backup.
2. **Gate C — schema:** migration 017 is not reflected in the current data; 44 domain uniqueness identities still end in `/`.
3. **Gate D — data:** SQL contains the older rehearsal dataset and has not reconciled the current 17-container snapshot.
4. **Gate E — behavior:** SQL mutations remain deliberately blocked for licensing, schedules, tasks, users, roles, settings/email side effects, public downloads, print formats, timers, task generation, and client/domain/database cascades.
5. **Gate E — deployment:** the locally completed Client/Domain/Database SQL writers have not been deployed to production.
6. **Gate F — rehearsal:** two clean rehearsals on a separate non-production SQL/Blob target have not been completed.
7. **Gate F — authority:** the runtime login cannot apply migrations or final loaders, and no working provider-controlled migration login is available in the active session.

## Changes deliberately not executed

- Production maintenance mode was not enabled.
- Timers were not stopped because the cutover did not pass preflight.
- No production SQL row, schema, Blob object, or secret was changed.
- No API/frontend package was deployed.
- `DATA_BACKEND` was not changed to `sql`.
- Cosmos remains the production source of truth and write system.

## Required sequence before retrying cutover

1. Finish and test every remaining SQL mutation and side-effect path.
2. Deploy the SQL-capable package while retaining `dual-read` and `SQL_SECURITY_RUNTIME_ENABLED=false`.
3. Provision a separate rehearsal SQL database and private Blob target.
4. Complete two clean migrations using the current snapshot and migrations `002..018+`; reconcile every Gate D count/hash/relationship.
5. Prove permissions, timers, task generation, email idempotency, concurrency, files, backup/restore, and rollback.
6. Obtain a provider-controlled migration identity for production; never elevate `SAGWebDev`.
7. Create and verify a current production backup/restore point immediately before the window.
8. Re-run this preflight. Only a complete PASS may start maintenance and final snapshot/load.

The owner has explicitly designated this SQL database as the production target. That designation does not waive the safety gates or authorize switching an incomplete application to SQL.

## Safe retry after initial corrections

The read-only preflight was rerun after implementing local SQL writes for Licenciamiento and task status transitions. Production remained unchanged:

- Function App still reports `DATA_BACKEND=dual-read`, SQL connected, and `SQL_SECURITY_RUNTIME_ENABLED=false`;
- no timer-disable application settings are active, so a maintenance cutover window has not started;
- the production SQL column for license descriptions still has the old 1,000-character capacity (`COL_LENGTH=2000` bytes), confirming migration 018 is not applied;
- 44 normalized domain identities still end in `/`, confirming migration 017/current final data load is not applied;
- current counts remain 21 modules, 55 non-deleted normalized assignments and 338 workflow tasks.

Decision remains **NO-GO**. The local corrections passed unit/build/parser validation and rollback-only live smokes with zero persisted deltas, but they are not deployed and do not satisfy the remaining schema, behavior, rehearsal, backup/restore, and migration-authority gates.

## Owner-authorized refresh before final load

After the owner explicitly instructed to update SQL with the new data and proceed, a new read-only Cosmos snapshot was captured at `2026-07-22T17:34:16Z`. The connection string remained process-local and was neither printed nor written to configuration files.

- 17/17 containers and 2,987 documents exported successfully;
- every container count and SHA-256 is identical to the reviewed `15:57:53Z` snapshot, so there is no source-data drift between the two captures;
- structural profile: 0 critical errors;
- canonical field mapping coverage: 0 gaps;
- business validation: 44 checks, 0 critical errors, 464 known deterministic warnings;
- operational plan: 341 logical tasks, 32 aliases, 39 private files, 0 critical transformation issues;
- Blob contract: 39 files, 968,128 bytes, 0 failures.

No SQL/Blob write, maintenance switch, timer stop, deployment, or backend change was executed. The source snapshot is ready, but the production load still cannot begin without a current restore point, the provider-controlled migration identity, completed behavior Gate E, and two clean rehearsals.
