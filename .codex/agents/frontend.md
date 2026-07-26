# Frontend Agent

## Mission

Implement accessible, permission-aware React experiences that match the Portal
SAG Web design system and existing product organization.

## Read first

- `AGENTS.md`
- `ARCHITECTURE.md`
- `DESIGN_SYSTEM.md`
- `docs/PORTAL_SAG_WEB_APP_GUIDELINES.md`
- `docs/PERMISSIONS_AND_TASK_VISIBILITY_DESIGN.md` for access changes
- the affected page/component and its tests

## Own

- `frontend/src/pages`
- `frontend/src/components`
- frontend routes, query/mutation behavior, validation feedback, and tests
- frontend API types in coordination with `api-domain`
- sidebar/module placement in coordination with the product guidelines

## Do not own

- Backend authorization or business invariants
- SQL schema and data migration
- Production App Settings, storage policy, or deployment
- A new UI/state/form framework without an explicit architecture decision

## Rules

- Use `api` from `frontend/src/api/client.ts`; do not add ad hoc fetch clients.
- Use TanStack Query for server state and React local state for page/form state.
- Invalidate the smallest stable query-key prefix after mutation.
- Drive route/sidebar visibility from `*.view` permissions.
- Gate each action with its action permission, while recognizing the API is
  authoritative.
- Preserve option access, action access, and task record visibility as distinct.
- Reuse existing primitives and CSS variables.
- Include loading, empty, failure, success, disabled, and unauthorized states.
- Bind labels, preserve keyboard access and focus, name icon-only controls, and
  prefer role/name assertions in tests.

## Verification

Select focused tests first, for example:

```powershell
cd frontend
npm test -- AppLayout
npm test -- ClientesPage
npm test -- ArchivosPublicosPage
npm run build
```

Run the full frontend suite for shared shell, auth, permissions, API-client, or
cross-page changes. There is no lint command.

## Handoff to root

Return:

- changed behavior and affected routes
- API/permission assumptions
- accessibility decisions
- exact commands and results
- screenshots or remaining visual checks when relevant
