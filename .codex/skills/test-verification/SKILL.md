---
name: test-verification
description: Select, run, and report proportionate verification for Portal SAG Web changes. Use for test planning, regression checks, TypeScript/build validation, security audits, SQL migration validation, CI-parity checks, or assessing whether a change is ready for QA or release.
---

# Portal SAG Test Verification

Verify the behavior that changed and the boundaries it can affect. Prefer fast,
focused evidence while developing; expand to full gates when shared contracts,
security, persistence, or release readiness demand it.

## 1. Inspect scope

1. Read `git status --short`.
2. Inspect the relevant diff and affected tests.
3. Preserve unrelated user changes and ignore generated deployment artifacts.
4. Classify the change:
   - frontend page/component
   - frontend shell/auth/API client/permissions
   - API handler/domain
   - auth/permissions/security
   - scheduling/timer/outbox
   - SQL repository/migration
   - object storage
   - dependency/release

Do not run production probes or write to a live database merely to verify local
code.

## 2. Run focused checks

Choose names that match existing test files. Examples:

```powershell
# Frontend shell/routes
cd frontend
npm test -- AppLayout

# Frontend page
npm test -- ClientesPage

# Frontend permissions/task visibility
npm test -- AppLayout UsuariosPage permissionAccess TareasPage

# Frontend storage UI
npm test -- ArchivosPublicosPage

# API authorization
cd ..\api
npm test -- permissionModel managementAccess taskAccess taskVisibility roleLifecycle authSecurity

# API scheduling/workflow
npm test -- scheduleEngine taskGeneration completionFlow windowGeneration

# API object storage/content
npm test -- objectStorage publicFilesSqlRepository contentFileSqlSchema
```

After TypeScript or dependency changes, run the affected project build:

```powershell
npm run build
```

There is no lint script. Never report or invoke `npm run lint` unless a linter
and package script are deliberately added first.

## 3. Expand by risk

Run the full affected suite when the change touches shared components, the API
client, authentication, authorization, permission catalogs, SQL transaction
helpers, timers, outbox behavior, storage abstractions, or multiple domains.

```powershell
cd api
npm run check:no-cosmos-runtime
npm test
npm run build

cd ..\frontend
npm test
npm run build
```

Run both complete suites for cross-layer contracts, security-critical changes,
or release candidates.

## 4. Validate SQL and migration tools

For SQL scripts or migration tooling, always run:

```powershell
pwsh -NoProfile -File migration/tools/Validate-SqlServer2019Scripts.ps1
```

Run the additional validators that correspond to changed controllers/loaders:

```powershell
pwsh -NoProfile -File migration/tools/Validate-EphemeralSqlControl.ps1
pwsh -NoProfile -File migration/tools/Validate-ProductionRawStageImporter.ps1
pwsh -NoProfile -File migration/tools/Validate-ProductionOperationalRefresh.ps1
```

These are static/parser contract checks. Do not describe them as a successful
live migration. Live SQL smoke tests require the designated QA database,
authorized credentials/session, and explicit authority for any writes.
`Validate-ProductionSqlCutover.ps1` belongs to the retired Cosmos/dual-read
controller and is not a current SQL-only release gate.

## 5. Run CI parity before release

Use the same order as the GitHub quality gate:

```powershell
cd api
npm ci
npm run check:no-cosmos-runtime
npm run security:audit:prod
npm run security:audit
npm test
npm run build

cd ..\frontend
npm ci
npm run security:audit:prod
npm run security:audit
npm test
npm run build
```

If a full dependency audit fails on a dev-only advisory while the production
audit passes, report both results and assess the actual exposure. Do not hide or
rewrite the result.

## 6. Report evidence

Return:

- exact command
- pass/fail and relevant test count
- what behavior the check covers
- skipped checks and why
- whether the result is locally verified, QA-ready, or release-ready

Never claim:

- a command ran when it did not
- a build proves runtime behavior
- a static SQL validator proves a live migration
- frontend CI deploys the API
- a production probe passed without observing it
