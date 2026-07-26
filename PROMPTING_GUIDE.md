# How to Request Portal SAG Web Work

You can write naturally; the templates below make scope, authority, and
completion especially clear. You do not need to choose subagents—the root
orchestrator selects the smallest useful team.

## New feature

```text
Task type: New feature
Goal:
[What the user should be able to do.]

Acceptance criteria:
- [Observable behavior 1]
- [Observable behavior 2]
- [Permission, validation, or error behavior]

Scope:
[Frontend / API / SQL / full stack / storage / deployment]

Data and compatibility:
[Existing records to preserve, migration needs, browser/file behavior.]

Authority:
[Code only / may commit / may deploy to QA / may deploy to production /
 production SQL or configuration changes explicitly authorized.]

Finish when:
[Tests, build, deployment, production probe, or documentation required.]
```

Example:

```text
Task type: New feature
Goal: Let administrators publish images and videos that open inline.
Acceptance criteria:
- Creation requires `implementation.public_files.create_file`; replacement
  requires `implementation.public_files.replace_file`.
- MP4 range requests play in the browser; invalid types are rejected.
- Existing Azure Blob and MinIO records remain readable.
Scope: Full stack, SQL metadata, and object storage.
Authority: Implement and test only; do not deploy or change production.
Finish when: Focused API/frontend tests and both builds pass.
```

## Change or bug fix

```text
Task type: Change / bug fix
Issue:
[What happens now, including the exact message or reproduction.]

Expected behavior:
[What should happen instead.]

Reproduction:
1. [...]
2. [...]

Affected area:
[Optional route, API, table, timer, role, or storage provider.]

Constraints:
[Data that cannot be lost, compatibility, timing, permissions.]

Authority:
[Diagnose only / implement / commit / deploy scope.]

Finish when:
[Regression test and verification expected.]
```

## SQL/data change

```text
Task type: SQL/data change
Goal:
[Schema or data outcome.]

Environment:
[Local / QA / production.]

Expected volume and lock tolerance:
[Rows, maintenance window, availability requirement.]

Safety:
- Backup/restore evidence: [available/not available]
- Rollback or forward-fix: [...]
- Existing permissions that must remain unchanged: [...]

Authority:
[Create scripts only / execute in QA / execute in production.]

Finish when:
[Static validation, QA reconciliation, production evidence.]
```

Production execution must be stated explicitly. Permission to edit a migration
file is not permission to run it against production.

## Release or incident

```text
Task type: Release / incident
Target:
[QA or production resource.]

Version or change:
[Commit/branch or failing behavior.]

Allowed actions:
[Deploy package, change settings, restart, inspect telemetry, rollback, etc.]

Do not change:
[Database, timers, storage provider, RBAC, secrets, other services.]

Success gates:
- [...]

Rollback trigger:
[What must restore the previous state.]
```

## Useful shorthand

- “Diagnose” authorizes read-only investigation, not implementation.
- “Fix it” authorizes scoped code changes and proportionate local verification.
- “Deploy at the end” authorizes the requested deployment only after gates pass;
  it does not automatically authorize production SQL, RBAC, destructive storage,
  or secret changes.
- “Do the migration” should still name the target environment and whether live
  execution is authorized.
- “No backup” does not waive production safety gates; it means the orchestrator
  must stop before an irreversible action that lacks a viable recovery plan.
