# Constructor de guías — authoritative design

## Status

This document reconciles the six files supplied in `new module` with the live
Portal SAG Web architecture. It supersedes their standalone stack choices,
single permission key, 1 GB upload promise, in-process background work, and any
Cosmos/PostgreSQL/Azure-Speech assumptions.

The feature is code-complete only when its focused tests pass. It remains
disabled by default and is not production-ready until the runtime gates below
are proven.

The API requires `GUIDE_BUILDER_ENABLED=true`, the worker additionally requires
both `GUIDE_WORKER_ENABLED=true` and the deployment-controlled
`GUIDE_WORKER_PROCESSOR_CERTIFIED=true`, and the production frontend includes
the navigation/route only when `VITE_GUIDE_BUILDER_ENABLED=true`.
The Azure Function App never runs Guide Builder jobs: its worker flags remain
false. Processing is owned exclusively by the certified Container Apps Job.
QA and dark production deployments use a manual trigger. The reviewed
production schedule is optional and remains disabled until cutover approval.

## Product contract

- Sidebar module: **Ayudas SAG Web**, sixth after **Auditoría y Visibilidad**.
- Option: **Constructor de guías**.
- Route: `/ayudas/constructor-guias`.
- Flow: upload video → extract evidence → review and answer questions →
  regenerate a grounded draft → finalize → download Markdown.
- The transcript and screenshots are an immutable evidence bundle per source
  video. Regeneration reuses it.
- Finalization requires at least one persisted answer round, a current draft,
  and no unresolved critical evidence conflict.
- First release downloads the manual. It does not publish into a repository or
  Active Manuals.

## API and upload contract

All routes require authentication and the appropriate
`help.guide_builder.*` permission. Ordinary users are owner-scoped;
`view_all`/`super_admin` can see other owners.

1. `POST /guide-sessions` accepts JSON metadata and `Idempotency-Key`.
   It creates an opaque session and returns a short-lived write-only signed
   upload request (`PUT`, URL, required headers, expiry).
2. The browser uploads directly with progress reporting.
3. `POST /guide-sessions/{id}/upload-complete` verifies the provider object
   metadata and atomically queues the durable job.
4. List/detail endpoints return metadata only. Transcript, frames, drafts, and
   final manuals use authenticated text/blob routes or authenticated `302`
   delivery. Signed read URLs, storage locators, prompts, transcript text, and
   draft bodies are not embedded in session JSON.
5. Session initialization and upload completion require idempotency keys.
   Regenerate, finalize, and cancel require the current version/ETag and are not
   automatically retried by the browser. Migration `026` persists an equivalent
   per-session replay key for each operation; same-payload lost-response replay
   returns current state without duplicating answers, jobs, events, or audit.
   Different requests still require the current ETag.

## Persisted state

Migration `026` owns normalized tables for:

- sessions and source metadata;
- immutable/versioned artifacts linked to `content.files`;
- clarification questions and answer rounds;
- durable jobs, attempts, leases, and heartbeats;
- status events;
- AI-run model/version/usage metadata without sensitive content.

Session states are:

`upload_pending`, `queued`, `processing`, `review`, `finalizing`, `completed`,
`failed`, `cancelled`, `deleted`.

Processing stages are:

`ingest`, `transcription`, `frame_extraction`, `vision`, `draft`, `questions`,
`reprocess`, `finalize`, `completed`.

Queue claims use `UPDLOCK`, `READPAST`, and `ROWLOCK`, a finite lease, heartbeat,
maximum five attempts, and deterministic idempotency. No transaction spans a
storage, media, or OpenAI call.

Worker writes and completion are fenced by `(guide_job_key, attempt_no,
claimed_by)` plus an unexpired lease. Heartbeats renew the lease every minute.
Draft/final artifact registration, questions, AI usage, session transition, and
status history commit atomically. A retry after a committed checkpoint detects
the session version and completes the durable job without reapplying outputs.

## Implemented processor checkpoint

The worker now has a bounded CLI entry for a scheduled Azure Container Apps Job
and an explicitly opt-in continuous mode. Its default execution remains closed
unless the feature, worker, and processor-certification flags are all true.

- Initial processing verifies the provider ETag, byte count, MIME, file
  signature, codec, duration, dimensions, and frame rate; creates a streaming
  source hash; extracts accepted M4A audio; persists timestamped transcription,
  interval frames, bounded visual readings, an immutable evidence bundle,
  draft, verification questions, and sanitized AI usage.
- Reprocessing reuses persisted transcript/frame evidence and human answers. It
  does not rerun media extraction or transcription.
- A session accepts at most three answer rounds. On the third round, human
  answers are authoritative and the processor must return no further questions;
  a non-compliant model response terminates with
  `guide_answer_round_limit`.
- Finalization loads the exact requested draft, uses a bounded structured
  response, validates the fixed skeleton, safe links/HTML, evidence citations,
  and unresolved placeholders, then atomically persists the final Markdown.
- Default hard limits allow at most two active sessions and five creations per
  owner/day. Visual analysis defaults to six frames (maximum twelve); prompt
  characters and every model output are capped within code-controlled bounds.
- Cancellation closes active attempts. The worker host removes uncommitted
  upload objects from cancelled sessions and clears their pending locators.
- Temporary directories are always removed. Derived objects created before a
  failed SQL commit are deleted only when SQL confirms they are unreferenced.
- A content-addressed writer reserves its locator in SQL before provider I/O;
  registration consumes that reservation in the same transaction that creates
  `content.files`. Cleanup cannot delete a locator while a writer owns it.
- The initial upload authorization is single-issue: an idempotent replay returns
  session state with `409` and never returns a new signed write URL.
- Generated Markdown rejects HTML and accepts only fragment-only link
  destinations. Backslash network paths, remote resources, nested-label image
  links, and reference definitions pointing outside the document are rejected.
- Every terminal worker failure and lease-exhaustion transition appends durable
  status history in the same SQL transaction.
- Scheduled executions use bounded drain mode: one job is claimed at a time
  until the queue is empty or ten jobs have been processed. The deployment
  hard-caps this value at 25. Continuous mode exists only as an explicit
  operational override.

## Grounding and model contract

- `whisper-1` with `verbose_json` segments provides timestamped transcript
  evidence. Derived audio uses a documented accepted format and stays within
  the transcription upload limit.
- Responses API drafting uses an explicit, pinned configured model; the default
  implementation model may be `gpt-5.6-sol`.
- Evidence identifiers bind to the immutable source hash plus transcript
  segment or frame identity. Timestamp text alone is not an identifier.
- Unknown module hierarchy remains empty until visual evidence or a human answer
  confirms it. The system never guesses it.
- The model receives delimited untrusted evidence and no tools. Structured
  outputs are schema-validated. A deterministic code validator enforces the
  manual skeleton, safe links/paths, citation resolution, and unresolved-field
  policy before finalization.

Primary API references:

- [Speech to text](https://developers.openai.com/api/docs/guides/speech-to-text)
- [Model catalog](https://developers.openai.com/api/docs/models)
- [Latest model guide](https://developers.openai.com/api/docs/guides/latest-model)

## Security, limits, and retention

- MVP upload limit: 100 MB and 15 minutes.
- Verify extension, MIME, file signature, container, codecs, duration, and
  dimensions before processing.
- Media commands use fixed argument arrays, no shell, no network, UUID temp
  directories, and bounded CPU/memory/time/frame/resolution/disk usage.
- Private source and derived objects are encrypted and never public.
- Logs and audit metadata exclude filenames, object locators, signed URLs,
  transcript, frames, answers, drafts, prompts, and final content.
- Per-user/session/day limits bound upload volume, concurrent jobs, frames,
  transcription/model tokens, answer loops, retries, and estimated spend.
- Cancellation, expiry, and deletion are provider-aware and idempotently remove
  temporary and derived objects; an orphan sweep reconciles partial failures.
- Rendered Markdown is treated as untrusted output: HTML and unsafe URL schemes
  are rejected or escaped.

## Required verification

Focused acceptance includes:

- permission catalog, sidebar, protected route, owner/`view_all` isolation;
- upload metadata, direct-upload completion verification, MIME/signature/media
  rejection, progress, cancel, retry, and refresh restoration;
- queue lease/restart/retry/idempotency/concurrency behavior;
- transcript/frame alignment, immutable citations, cached evidence reuse, and
  versioned regeneration;
- prompt-injection, unsafe Markdown, malformed structured output, and unresolved
  contradiction failures;
- finalization rejected before one answer round;
- storage/OpenAI/media failures do not leak details or leave unbounded orphans;
- migration static validation, API tests/build/no-Cosmos guard, frontend
  tests/build, and a disabled-by-default feature flag.

## QA certification evidence — 2026-07-28

The isolated `PortalSAGWeb-TEST` rehearsal used a synthetic 22.72-second
H.264/AAC video containing no customer data. Direct signed upload returned
HTTP 201 and the durable worker recovered a deliberately retried initial job
without duplicating state.

- one completed synthetic session;
- five successful durable jobs: one initial process, three reprocess rounds,
  and one finalization;
- one transcription run and two visual readings, unchanged during all three
  reprocess rounds;
- eleven answered questions and zero open questions;
- eleven current artifacts with no invalid file references;
- zero active jobs and zero orphan object-registration claims;
- final Markdown persisted at 1,720 bytes;
- idempotent replay proven for answers and finalization;
- private Blob upload/read/delete, exact-origin CORS, managed-identity data
  access, and user-delegation signing proven.

The QA environment remains manual and synthetic-only. This evidence certifies
the application behavior; it does not authorize production SQL DDL or feature
exposure.

Release candidate provenance:

- certified source commit: `0dba9b388b0d90bc0e267b7daa49a07bc272dcc1`;
- immutable worker image:
  `erpupdschguideacr.azurecr.io/portal-sag-guide-worker@sha256:2ad787b2a10bc685c68d3ae562ab2090e15cb63143cf28b9796b7db00a7d3730`;
- empty-queue QA execution:
  `erpupdsch4645-guide-qa-job-erscac3`, `Succeeded`, zero claimed/failed jobs;
- production worker: deployed as `erpupdsch4645-guide-prod-job`, manual trigger,
  schedule disabled, never executed;
- production Function App: certified API deployed with all Guide feature and
  worker flags explicitly disabled;
- production Static Web App: certified frontend deployed without the Guide
  route or navigation flag.

## Production enablement gates

Do not expose the route or accept real uploads until all are proven:

1. a fresh verified production restore point, followed by explicit approval
   and application of migration `026`;
2. worker host and release path with pinned, patched `ffmpeg`/`ffprobe`;
3. private provider CORS and signed-write behavior;
4. Key Vault OpenAI secret and project spend/data controls;
5. hard resource/cost limits, metrics, alerts, and runbook;
6. live SQL concurrency proof for heartbeat renewal, attempt fencing, and
   replay under response loss;
7. an approved retention window and scheduled sweep for expired completed
   sessions and historical derived artifacts (cancelled pending uploads and
   ordinary caught-failure orphans are covered; abrupt host-loss reconciliation
   remains part of this gate);
8. synthetic staging smoke test and rollback;
9. explicit production deployment approval.

Gates 2, 3, 6, and 8 have QA evidence. The production route, API feature flag,
worker schedule, and real uploads must remain off until gates 1, 4, 5, 7, and 9
are closed. The current production database lacks a recent verified restore
point suitable for this DDL change.
