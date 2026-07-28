# Portal SAG Web — Agent Operating Protocol

This file governs work in the entire repository. The root Codex agent is the
orchestrator and remains accountable for the final result. Specialized agents
may investigate or implement bounded work, but they do not replace root-level
integration, verification, or user communication.

## Read before changing code

- Read [ARCHITECTURE.md](ARCHITECTURE.md) for runtime boundaries and data rules.
- Read [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) before changing the frontend.
- Read the closest domain document under `docs/`.
- Inspect `git status --short` and preserve unrelated user changes.
- Treat current code and current runtime documentation as authoritative when an
  older migration or handoff document describes retired Cosmos/dual-read flows.

## Orchestration model

Use the smallest useful team. A one-file, low-risk change does not require the
full pipeline. Cross-boundary, security-sensitive, data, and production work
does.

| Work | Primary agents |
|---|---|
| UI/page/navigation | `frontend`, then `qa-release` |
| API/business behavior | `api-domain`, then `qa-release` |
| SQL schema, query, migration | `sql-data`, `api-domain`, then `qa-release` |
| Permissions/auth/sensitive data | owning agent plus `security-adversary` |
| Storage/Azure/release incident | `platform-storage`, `qa-release`, and the owning data/API agent |
| Full-stack feature | `frontend`, `api-domain`, and `sql-data` in parallel after contracts are agreed |

Agent briefs live in `.codex/agents/`. The root agent should give every worker a
concrete scope, relevant files, constraints, expected evidence, and whether it
may edit. Do not send multiple agents to edit the same files unless the root
agent explicitly coordinates ownership.

## Delivery workflow

1. **Discover**
   - Translate the request into observable acceptance criteria.
   - Inspect the affected route, API handler, service/repository, SQL objects,
     tests, permissions, configuration, and deployment path.
   - Identify whether the request authorizes code changes only, deployment,
     production configuration, data migration, or destructive operations.

2. **Define boundaries**
   - For cross-layer changes, define request/response types, validation,
     permission keys, SQL transaction ownership, idempotency, and error
     behavior before parallel implementation.
   - Do not create ceremony for an isolated, obvious change.

3. **Implement**
   - Keep business rules in `api/src/lib`, HTTP adaptation in
     `api/src/functions`, SQL access in SQL repositories, and UI behavior in
     `frontend/src`.
   - Make migrations additive, versioned, rerunnable where the migration
     framework expects it, and SQL Server 2019 compatible.
   - Add or update focused tests with the implementation.

4. **Verify**
   - Use `$test-verification`.
   - Start with focused tests, then expand according to shared impact and risk.
   - Never claim a check ran when it did not.
   - There is no lint script. TypeScript validation is part of `npm run build`.

5. **Review**
   - The root agent integrates the complete diff.
   - Use `security-adversary` for auth, authorization, uploads, signed URLs,
     secrets, SQL, timers, outbox, concurrency, or destructive behavior.
   - Resolve review findings or explicitly report residual risk.

6. **Commit and deploy**
   - Use `$commit-deploy` only when the user requested commit, push, release, or
     deployment.
   - Stage exact paths; never use `git add .`.
   - A push to `main` deploys the frontend after CI. It does not deploy the API.
   - Production deployment, SQL migration, App Settings/RBAC changes, provider
     switches, maintenance/timer changes, storage transfer/deletion, and
     rollback require explicit scoped authority.

## Non-negotiable architecture rules

- SQL Server is the only operational database. Do not add Cosmos SDKs,
  adapters, settings, fallbacks, dual-read, or Cosmos rollback logic.
- The production SQL contract is SQL Server 2019, compatibility level 150.
- Do not store file bytes or secrets in SQL.
- Private object storage may be Azure Blob or SeaweedFS through its S3 gateway.
  Persist the provider and locator so historical objects remain readable after
  a provider switch. A write-provider switch never authorizes deleting Blob or
  rewriting historical locators.
- Backend authorization is authoritative. Sidebar and route hiding are UX only.
- Keep option access, option-specific actions, and task visibility as separate
  authorization concepts.
- Multi-object writes that represent one business operation must use one SQL
  transaction. Timer/outbox work must be idempotent and recoverable.
- Preserve append-only audit and delivery history.
- Never print, commit, log, audit, or return in JSON credentials, connection
  strings, Key Vault secret values, signed URLs, or production document
  contents. A short-lived read URL may appear only in the intended `302`
  redirect response of a file-serving endpoint. The guide-builder upload
  contract may return a short-lived, write-only URL scoped to a
  server-generated object key, declared type, and size; never log or persist
  that URL.
- Database patches must not silently downgrade existing owner/runtime
  permissions. Permission changes require an explicit, reviewed objective.

## Working tree and generated artifacts

The repository may already be dirty. Do not overwrite or delete unrelated
changes. Exclude deployment ZIPs, `.deploy-*`, `dist`, `node_modules`,
`tsconfig.tsbuildinfo`, local settings, migration backups/work, and credentials
unless the user explicitly placed a specific artifact in scope.

## Communication and completion

- Give concise progress updates during tool-heavy work.
- Lead the handoff with the outcome.
- Report changed files, exact verification performed, deployment status, and
  remaining risks or manual gates.
- “Done” means the requested behavior is implemented and verified at the
  requested scope—not merely coded.

## Retrospective: Constructor de guías

### Went well

- Bounded frontend/backend ownership avoided edit conflicts.
- Freezing permissions and DTOs early worked.
- The QA agent caught real idempotency, migration-runner, deletion-state, and
  worker-leasing defects.

### Went wrong

- The QA agent initially audited an unrelated module due to context bleed.
- The first frontend/API contracts disagreed on statuses and response shape.
- Parallel full-suite execution caused two unrelated frontend timeouts that
  disappeared when rerun alone.
- The supplied design had conflicting stacks, an unsupported 1 GB promise, and
  the wrong transcription timestamp model.

### Improve next time

- Provide agents a machine-readable API/DTO contract and exact source manifest
  before delegation.
- Require a final cross-agent contract test.
- Run full suites only after agents stop editing.
- Isolate the security agent from earlier task history.
- Treat worker/runtime implementation as a separate milestone.
