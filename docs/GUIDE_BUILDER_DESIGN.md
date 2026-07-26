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
   automatically retried. A durable request ledger for safe lost-response
   replay is a production-enablement gate for those three operations.

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

## Production enablement gates

Do not expose the route or accept real uploads until all are proven:

1. migration `026` rehearsed with rollback evidence;
2. worker host and release path with pinned, patched `ffmpeg`/`ffprobe`;
3. private provider CORS and signed-write behavior;
4. Key Vault OpenAI secret and project spend/data controls;
5. hard resource/cost limits, metrics, alerts, and runbook;
6. heartbeat renewal, lease fencing, and durable replay for every mutation;
7. retention, cancellation, expiry, and orphan cleanup;
8. synthetic staging smoke test and rollback;
9. explicit production deployment approval.
