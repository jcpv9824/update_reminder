# Engineering Skills and Testing Guide

## Purpose

This document defines the engineering practices Codex should follow when working on Portal SAG Web. It exists so future changes are made as disciplined product work: understand the stack, select the right tests before coding, preserve security and permissions, then implement with the smallest safe change.

## Detected Stack

### Frontend

- React 18 with TypeScript.
- Vite 8 for development and production builds.
- React Router for routes and default navigation.
- TanStack Query for server state.
- CSS in `frontend/src/styles.css` using the app's corporate variables.
- Testing with Vitest, jsdom, Testing Library, and `frontend/src/tests/setup.ts`.
- Icons from `lucide-react`.

### Backend

- Azure Functions v4 with Node.js and TypeScript.
- HTTP functions and timer-triggered automation in `api/src/functions`.
- Business logic in `api/src/lib`.
- SQL Server 2019 as the production operational database.
- Cosmos DB has been removed from the runtime and the Azure account was deleted on 2026-07-24; restricted historical snapshots remain retention evidence only.
- Provider-managed S3/MinIO object storage for public-download and print-format file payloads.
- Azure Key Vault via `@azure/keyvault-secrets` and `@azure/identity`.
- Email through SendGrid/Nodemailer.
- Authentication and security with JWT, bcryptjs, rate limiting, sessions, and zod validation.
- Testing with Vitest in a Node environment.

### Deployment and Operations

- Azure Static Web Apps for the frontend.
- Azure Functions for the API.
- SQL Server and provider-managed S3/MinIO for operational persistence; Key Vault for application secrets.
- Cosmos retirement requires a SQL-only deployment, zero container activity, a final encrypted snapshot and a proven SQL restore.
- PowerShell deployment and hardening scripts.
- Node.js requirement: `>=20.19.0`.

## Required Engineering Skills

### 1. Product Context

Treat Portal SAG Web as a multi-module operations portal, not just a scheduler. Preserve the module model documented in `docs/PORTAL_SAG_WEB_APP_GUIDELINES.md`, including the default **Tareas** entry point.

### 2. Frontend Architecture

Use existing React patterns, page components, shared components, CSS variables, and Spanish labels. Keep layouts stable, searchable, and role-aware. Avoid adding new UI libraries unless the value is clear and the dependency is small.

### 3. Backend Architecture

Keep endpoint handlers thin and move reusable behavior into `api/src/lib`. Validate inputs, preserve DTO sanitization, and never expose secrets in API responses, logs, audit snapshots, or tests.

### 4. Security and Permissions

Preserve route protection on the frontend and object/role authorization on the backend. Treat passwords, connection strings, JWTs, cookies, SMTP credentials, database access values, and Key Vault secret names as sensitive.

### 5. Data and Business Rules

Respect the domain model: clients, domains, databases, licenses, schedules, tasks, users, roles, audit logs, settings, forced public downloads, and inline public files. When changing task or schedule behavior, check deduplication, idempotency, recurrence, visibility, assignment, reminders, and audit side effects.

### 6. Testing Discipline

Choose tests before implementation. Run a relevant baseline when practical, write or update tests for the desired behavior, implement, then rerun the focused suite and the required build.

### 7. Documentation Discipline

Update docs when a change renames concepts, moves navigation, modifies workflow order, changes security posture, or alters deployment/testing commands.

## Test Selection Before Developing

Before editing code, identify the smallest test set that can catch the expected regression. Use this decision table.

| Change Type | Tests to Choose Before Coding |
| --- | --- |
| Sidebar, routes, labels, module placement | `cd frontend && npm test -- AppLayout`; add/update layout tests first |
| Page UI, forms, filters, modals | Focused page test, for example `npm test -- ClientesPage` or `npm test -- FrecuenciasPage` |
| Shared frontend component | Component test, for example `npm test -- SelectorBuscable` |
| Frontend API client behavior | `npm test -- ApiClient` |
| Date/domain/parser utility | Utility test, for example `npm test -- fechas dominio dbAccessParser` |
| Backend endpoint behavior | Function or service tests closest to the endpoint; add service tests when possible |
| Schedule/task generation | `cd api && npm test -- scheduleEngine taskGeneration completionFlow windowGeneration` |
| Task visibility/authorization | `cd api && npm test -- taskVisibility objectAuthorization permissions` plus impacted frontend page tests |
| Role/permission model | Read `docs/PERMISSIONS_AND_TASK_VISIBILITY_DESIGN.md` first; add resolver, migration, role editor, and task visibility tests before implementation |
| Authentication, sessions, passwords, rate limits | `cd api && npm test -- authSecurity authSessions password jwt rateLimit resetTokens` |
| Email/reminder behavior | `cd api && npm test -- emailTemplates emailService reminderLogic sendOverdueAlerts sendBlockedReminders taskNotifications` |
| Audit logging/sanitization | `cd api && npm test -- auditLog` and any sanitization script checks related to the change |
| Public downloads or formats | Relevant frontend page tests plus API tests for public DTO/download behavior |
| Dependency or build configuration | `npm run build` in the impacted package and the focused tests that import the changed dependency |
| Docs-only change | No code tests required, but inspect links/paths and run `rg` to ensure renamed terms stay consistent |

## Test Workflow

1. Read the impacted source and existing tests.
2. Select the focused tests from the table above.
3. Run the selected tests before editing when the current behavior is uncertain or the area is risky.
4. Add or update tests to describe the requested behavior before implementation whenever the behavior is testable.
5. Implement the smallest coherent change.
6. Rerun the focused tests.
7. Run `npm run build` for any package whose TypeScript or dependency graph changed.
8. Broaden to the full frontend/API test suite when touching shared behavior, security, permissions, scheduling, or cross-page contracts.

## Required Verification Commands

Use the relevant commands from this list:

```powershell
cd frontend
npm test -- AppLayout
npm run build
```

```powershell
cd api
npm test
npm run build
```

Run both frontend and API builds when a change crosses the client/server boundary.

## Completion Criteria

A change is complete only when:

- The requested behavior is implemented.
- Role visibility and authorization remain intact.
- Sensitive data is not exposed.
- Focused tests pass.
- Required TypeScript/build checks pass.
- Documentation and reusable Codex guidance are updated when the product model changes.
