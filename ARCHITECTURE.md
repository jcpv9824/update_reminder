# Portal SAG Web Architecture

This is the current implementation contract for Portal SAG Web. It describes
the live SQL-only application, not the historical Cosmos migration path.

## Runtime topology

```text
Browser
  → React/Vite frontend on Azure Static Web Apps
  → HTTPS /api
  → Node.js 20 Azure Functions v4
      → SQL Server 2019 (operational data)
      → Azure Key Vault (secret values)
      → Azure Blob or SeaweedFS through its S3 gateway (private object bytes)
      → OpenAI API (guide transcription and grounded drafting)
      → configured email provider
```

The frontend and API are deployed separately. The GitHub workflow validates
both projects but deploys only `frontend/dist`; `api_location` is empty. API
publication is an independent release action.

Guide processing is durable background work, not an in-request or detached
Function promise. SQL owns the queue, lease, attempts, status, and recovery
contract. A timer worker may remain disabled for local/QA work, but production
enablement requires a proven host with pinned `ffmpeg`/`ffprobe`, bounded
resources, health checks, and release automation.

## Exact stack

### Frontend

- React 18.3 and strict TypeScript
- Vite 8
- React Router DOM 7
- TanStack Query 5 for server state
- React Context for authentication
- Local React state for forms, filters, dialogs, and page state
- Vitest, jsdom, and Testing Library
- Handwritten global CSS in `frontend/src/styles.css`

### API

- Azure Functions v4 on Node.js 20.19+
- Strict TypeScript
- `mssql` for SQL Server access
- Direct parameterized queries; there is no ORM
- Zod for input validation
- JWT access tokens, rotating refresh sessions, bcrypt hashes
- SendGrid or Nodemailer for mail delivery
- Azure Identity/Key Vault
- Azure Blob SDK and AWS S3 SDK for selectable private object storage
- Vitest

### Data platform

- SQL Server 2019, engine major version 15
- Database `PortalSAGWeb`
- Compatibility level 150
- Collation `Modern_Spanish_CI_AS`
- Versioned DDL under `migration/sql`
- SQL stores metadata and object locators; storage providers store bytes
- API-visible record identity generally uses `source_id`; relational joins use
  narrow internal keys

## Repository organization

| Path | Responsibility |
|---|---|
| `frontend/src/pages` | Route-level UI and page orchestration |
| `frontend/src/components` | Reusable UI and the application shell |
| `frontend/src/api` | Typed HTTP client |
| `frontend/src/types.ts` | Shared frontend DTO and API types |
| `frontend/src/auth` | Authentication and session context |
| `frontend/src/permissionAccess.ts`, `permissionModel.ts`, `App.tsx`, `components/AppLayout.tsx` | Frontend permission UX |
| `frontend/src/tests` | Component, route, permission, and client tests |
| `api/src/functions` | HTTP and timer entry points; transport adaptation |
| `api/src/lib` | Business rules, validation, repositories, security, storage, mail, transactions |
| `api/src/tests` | Unit, repository-contract, auth, timer, and workflow tests |
| `migration/sql` | Ordered SQL Server 2019 migrations and reconciliation SQL |
| `migration/tools` | Migration launchers and static contract validators |
| `docs` | Product, permission, storage, migration, and operating decisions |
| `.github/workflows` | CI and frontend Static Web Apps deployment |

## Frontend rules

- Use `frontend/src/api/client.ts`; do not add ad hoc fetch wrappers.
- Use TanStack Query for server state, stable query-key arrays, and the smallest
  valid invalidation prefix after mutations.
- Do not introduce Redux, Zustand, a form library, or a UI framework without an
  explicit architecture decision.
- Keep route protection and sidebar visibility permission-driven.
- Frontend permission checks improve UX; they never replace API authorization.
- Reuse `components/Comunes.tsx` and existing page/test patterns before adding
  a new primitive.

## API layering

```text
Function handler
  → authenticate and authorize
  → validate transport input
  → domain/service operation
  → SQL repository / object-storage / mail boundary
  → map typed result to HTTP response
```

- Function handlers should remain thin.
- Put reusable behavior and business invariants in `api/src/lib`.
- SQL reads/writes belong in `*SqlRepository` or `*SqlWriteRepository`
  modules, not inline in page handlers.
- Parameterize every SQL value. Dynamic identifiers must come from a closed
  allowlist and be quoted safely.
- Use `runSqlTransaction` when one business operation changes multiple records,
  audit history, or outbox state.
- Validate at the external boundary and retain strict internal types.
- Return controlled client errors; do not expose SQL, secret, or provider
  details.

## SQL domain model

The schema is separated by business responsibility:

| Schema | Purpose |
|---|---|
| `security` | Users, roles, permissions, user-role links, sessions, rate limits |
| `core` | Environments, clients, domains, databases, assignees, access profiles |
| `licensing` | License modules and assignments |
| `scheduling` | Schedules, targets, assignees, reminders, scopes, licensing scope |
| `workflow` | Update tasks, sources/aliases, status history, reminders, overdue alerts |
| `settings` | Email and alert/reminder configuration |
| `content` | File metadata, print formats/sources, downloads, public inline files |
| `notifications` | Notification recipients, attempts, and durable outbox history |
| `audit` | Append-only audit events |
| `migration` | Migration history, raw/staging data, reconciliation, phase controls |
| `implementation` | Reserved implementation-domain boundary |

Use normalized bridge tables for many-to-many relationships. Preserve
`source_id` as the stable API-visible identity and migration trace; operational
relationships use SQL keys and constraints.

Guide-builder sessions, artifacts, questions, answers, jobs, attempts, state
events, and AI-run metadata live under `content`. Object bytes remain in the
selected private storage provider.

## Data consistency and concurrency

- Declare the transaction owner at the service/write-repository boundary.
- Use database constraints as the last line of defense for uniqueness,
  referential integrity, valid states, and mutually exclusive targets.
- Design timer and manual generation paths around deterministic idempotency
  keys so retries cannot duplicate tasks, reminders, or messages.
- Write durable notification/outbox work in the same transaction as the
  triggering state change.
- Claim outbox/timer work atomically, record attempts, and make interrupted work
  recoverable.
- Claim long-running guide jobs with short SQL transactions, leases,
  heartbeats, bounded retries, and deterministic idempotency. Never hold a SQL
  transaction open while calling storage, media tools, or OpenAI.
- Cascades must be explicit. Prefer controlled service transactions over
  surprising broad database cascades.
- Add indexes from demonstrated query shapes and foreign-key access paths; do
  not index every column.

Known gap: task status changes currently commit before task-notification enqueue,
which occurs in a separate operation. Treat atomic task-transition/outbox
delivery as required remediation when that flow is modified; do not describe
the present behavior as atomic.

## Authentication and authorization

- Access JWTs live in frontend memory.
- Refresh tokens use secure cookies and server-side hashed rotating sessions.
- Permission keys follow `<module>.<option>.<action>`.
- Option visibility (`*.view`), action permission, and task record visibility
  are independent checks.
- `super_admin` remains universal, but ordinary roles receive only declared
  permissions.
- Every protected endpoint performs all applicable backend permission and
  object-level checks.
- SQL runtime permissions should normally be least privilege. The
  owner-approved production exception currently leaves `SAGWebDev` with
  `db_owner` and `CONTROL`; database patches must not downgrade it incidentally,
  and the exception remains a documented security risk.
- Secret values belong in Key Vault or process memory, never SQL or source
  control.

## Object storage contract

`OBJECT_STORAGE_PROVIDER` selects the destination for new writes:

- `azure_blob`
- `seaweedfs` (new writes through the SeaweedFS S3 gateway)

Each stored record retains its provider and immutable locator. Reads,
replacements, cleanup, signed URLs, inline display, attachment delivery, and
video range behavior must dispatch by the record’s provider—not only the
current write switch.

The guide builder has one narrow direct-upload exception: an authenticated
session-init operation may return a short-lived, write-only signed URL scoped
to a server-generated locator, declared content type, and declared size. The
browser uploads bytes directly, then calls an authenticated completion endpoint
that verifies provider metadata before a durable job is queued. Read URLs remain
behind authenticated API routes and `302` responses. Storage CORS is restricted
to the portal origin and required methods/headers.

Provider switching does not migrate bytes. A physical transfer requires its
own inventory, hash/size reconciliation, QA proof, rollback window, and explicit
production authority. Never store object bytes in SQL.

The write-provider name `seaweedfs` is an explicit runtime choice. SQL keeps
the provider-neutral historical S3 locator value `s3` for SeaweedFS objects so
existing schema constraints and rows are not rewritten merely because the S3
implementation changed.

Azure Blob remains selectable while SeaweedFS is introduced. Retiring Blob is
a separate gated migration: copy and reconcile every Blob-backed object, update
its SQL locator transactionally, prove historical reads and rollback, then
remove Blob configuration and RBAC only after an approved zero-read window.

## SQL migrations

- Keep ordered scripts in `migration/sql`. Compute the reviewed script SHA-256
  with `Get-FileHash`, update `MANIFEST.sha256`, and run the validators.
- Applied migrations `002` through `025` are historical; migration `026`
  introduces the guide-builder schema. Add later changes as new numbered
  migrations rather than rewriting them.
- Target SQL Server 2019 syntax and compatibility 150.
- Make schema changes additive when possible and preserve history.
- Include preconditions, transactional behavior where valid, and postconditions.
- Validate scripts statically before any live execution.
- Rehearse write migrations in the designated QA database with backup/rollback
  evidence before production.
- Do not use obsolete Cosmos dual-read, cutover, or rollback controllers.
- Do not alter production data or permissions merely to make a test pass.

## Deployment and operations

Required local CI parity:

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

There is no lint script. Do not invent one.

Production health must prove SQL-only runtime, authentication boundaries,
timers, task idempotency, audit persistence and outbox behavior, both relevant
object-storage read paths, and absence of unusual 5xx/SQL/storage failures.
Rollback restores the previous SQL-only package and captured App Settings, then
uses SQL backups and object version retention where data recovery is required.
Cosmos is not a rollback target.

## Guide-builder security and AI contract

- Feature flags are off by default until the schema, worker, private storage
  CORS, OpenAI secret, cost limits, and rollback gates are proven.
  Production UI also requires `VITE_GUIDE_BUILDER_ENABLED=true`; the API and
  worker require `GUIDE_BUILDER_ENABLED=true` and both
  `GUIDE_WORKER_ENABLED=true`/`GUIDE_WORKER_PROCESSOR_CERTIFIED=true`
  respectively.
- The MVP accepts a maximum 100 MB video and 15 minutes. File extension, MIME,
  signature, codec, duration, dimensions, and media structure are validated
  before AI processing.
- Run `ffmpeg`/`ffprobe` with fixed argument arrays, `shell: false`, UUID temp
  paths, no network, and bounded time, memory, CPU, frames, resolution, and disk.
- Use `whisper-1` verbose JSON segments where timestamped evidence alignment is
  required. Do not claim segment timestamps from a model that does not provide
  them.
- Treat narration, on-screen text, transcript, frames, answers, examples, and
  style guidance as untrusted evidence, never executable instructions.
- AI calls have no tools, network authority, secret access, database mutation,
  or publication authority. Use strict structured outputs and fail closed.
- Cache verified transcript and frame evidence. Regeneration creates versioned
  drafts and must not repeat transcription or vision extraction.
- Finalization requires at least one persisted answer round, a current draft,
  no unresolved critical contradiction, and a deterministic code validator.
- Store usage metadata and limits, not prompts, transcripts, screenshots,
  answers, or manuals in logs/audit events. Use private encrypted storage and
  provider-aware cancellation, expiry, and orphan cleanup.
- First release is download-only. Repository/manual publication is a separate,
  disabled mutation requiring its own permission, review, audit, and rollback.

## Primary references

- `docs/PORTAL_SAG_WEB_APP_GUIDELINES.md`
- `docs/PERMISSIONS_AND_TASK_VISIBILITY_DESIGN.md`
- `docs/GUIDE_BUILDER_DESIGN.md`
- `docs/ENGINEERING_SKILLS_AND_TESTING.md`
- `docs/OBJECT_STORAGE_PROVIDER_SWITCH.md`
- `docs/SQL_SERVER_MIGRATION_RUNBOOK.md`
- `DESPLIEGUE.md`
