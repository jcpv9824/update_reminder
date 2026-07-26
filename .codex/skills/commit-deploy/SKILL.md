---
name: commit-deploy
description: Prepare, commit, push, deploy, and verify Portal SAG Web changes without staging unrelated work or confusing frontend and API releases. Use when the user asks to commit, publish, release, deploy, promote, monitor a deployment, or prepare rollback evidence.
---

# Portal SAG Commit and Deploy

Treat source control, push, frontend deployment, API deployment, SQL migration,
and infrastructure mutation as distinct actions. Execute only the actions the
user authorized.

## 1. Establish authority

Determine whether the request authorizes:

- commit only
- push to a non-production branch
- push to `main`
- frontend deployment
- API deployment
- production settings/RBAC/timer/storage changes
- SQL migration or data operation
- rollback execution

A request to deploy code does not implicitly authorize production SQL, RBAC,
secret, storage-transfer, provider-switch, maintenance/timer, or destructive
changes.

## 2. Require verification

Use `$test-verification` and obtain a clean, proportionate report. Before a
production release, run CI parity unless the user explicitly accepts a named
gap. Do not release a known failing gate.

## 3. Prepare an exact commit

Inspect:

```powershell
git status --short
git diff --check
git diff -- <intended paths>
```

Stage only explicit paths:

```powershell
git add -- <path-1> <path-2>
git diff --cached --check
git diff --cached --stat
```

Never use `git add .`. Exclude unrelated user changes and generated/sensitive
artifacts, including:

- deployment ZIPs and `.deploy-*`
- `dist`, `node_modules`, `tsconfig.tsbuildinfo`
- `.env*`, local settings, credentials, connection strings
- migration backups/work and production extracts

Use a concise imperative commit message. Record the commit SHA.

## 4. Understand the release topology

The GitHub workflow:

1. installs Node 20.19
2. runs API SQL-only guard, audits, tests, and build
3. runs frontend audits, tests, and build
4. deploys Azure Static Web Apps only after the quality gate

`api_location` is empty. A successful frontend workflow does not publish the
Azure Functions API.

A push to `main` triggers the production frontend deployment. Treat that push
as a production action. Pull requests targeting `main` may create/update a
preview deployment.

Do not use `scripts/deploy-all.ps1` unmodified as the canonical release path: it
stages broadly and does not enforce the current SQL-only gate order.

## 5. Deploy only the authorized component

### Frontend

Push the reviewed commit through the GitHub workflow, wait for terminal status,
and record the workflow/deployment identifier.

### API

API deployment is blocked until the release owner resolves and reviews the
current conflict between `func azure functionapp publish` guidance and the
full-ZIP deployment procedure in the handoff history. Do not choose one by
assumption. Once resolved, package/publish the complete built application,
capture the prior package/version and App Settings, and do not assume a frontend
push updated the API.

### SQL or infrastructure

Stop unless separately authorized and gated. Require:

- target environment confirmation
- QA rehearsal and reconciliation
- backup/restore or viable forward recovery
- exact reviewed script/settings diff
- maintenance/availability plan where relevant
- captured previous state

Never invoke obsolete Cosmos dual-read, cutover, or rollback controllers.

## 6. Verify the deployment

For a production release, verify the applicable gates:

- `/api/portal-runtime-status` is `200` with `backend=sql`,
  `sqlConnected=true`, `sqlSecurityEnabled=true`, `maintenanceMode=false`, and
  `timerDisableState=none`
- read-only authentication/authorization boundaries and protected-route `401`
- all six timers when API/timer behavior changed
- audit persistence and outbox health
- attachment downloads and inline PDF/image/video behavior
- reads for every storage provider still referenced by SQL
- no unusual 5xx, SQL, storage, or timer exceptions in telemetry

Default production verification to read-only probes. Login/refresh/logout, CRUD,
task generation, outbox/mail, uploads, and other state-changing smoke tests
require separate authority, designated synthetic records, cleanup, and
reconciliation.

Record observed evidence without printing secrets, object identities, signed
URLs, connection strings, or production data.

## 7. Contain or roll back on a failed gate

If rollback was pre-authorized, restore the previous SQL-only package and
captured App Settings. Use SQL backup/restore and Blob/S3 version retention only
within that authority, then verify restored health. Cosmos is not a rollback
target.

If rollback was not authorized, perform only safe in-scope containment, preserve
evidence, and request direction instead of mutating production by assumption.

Do not delete legacy objects, downgrade database permissions, or destroy
infrastructure as part of an ordinary code rollback.

## 8. Handoff

Report:

- committed paths and commit SHA
- push branch
- frontend and API deployment status separately
- exact verification/probes
- runtime version now active
- rollback readiness or whether rollback ran
- remaining manual gate
