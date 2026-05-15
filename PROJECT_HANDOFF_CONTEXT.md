# Project Handoff Context — Programador de Actualizaciones del ERP

Use this document as the main context file when continuing this project with another AI assistant or chatbot.

## How To Use This File In Another Chat

1. Start a new chat with the AI assistant.
2. Upload this file, or paste its full contents into the chat.
3. Say something like:

```text
This is the full project context for my application. Please read it first and use it as the source of truth before suggesting or changing anything. The application already exists; do not rebuild it from scratch. Work incrementally, preserve the architecture, and ask me before doing deployment or destructive changes.
```

4. If you are using a coding agent with access to the repository, also give it the repository path:

```text
C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler
```

5. Ask the new AI to inspect the actual files before editing, because this project evolves quickly and the repository is the final source of truth.

## Project Identity

Application name: **Programador de Actualizaciones del ERP**.

Purpose: manage recurring and special ERP update work across clients, domains, databases/companies, schedules, update tasks, email alerts, reminders, users, roles, audit logs, and email reports.

Language: the UI, business messages, emails, validations, and documentation should remain in **Spanish**.

This is an existing deployed application. It must not be rebuilt from scratch.

## Current Stack

Frontend:

- React
- Vite
- TypeScript
- TanStack Query
- React Router
- Vitest + Testing Library

Backend:

- Azure Functions
- Node.js + TypeScript
- Cosmos DB
- Azure Key Vault
- JWT authentication with email + password
- Vitest

Infrastructure:

- Frontend hosted on Azure Static Web Apps.
- Backend deployed as Azure Function App.
- Backend deployment uses a full ZIP containing `dist` and `node_modules`.
- Database is Azure Cosmos DB.
- Secrets are in Azure Key Vault.

## Repository Location And Structure

Local repository:

```text
C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler
```

Important folders:

```text
erp-update-scheduler/
  api/                  Azure Functions backend
    src/functions/      HTTP functions and timer functions
    src/lib/            shared backend services/utilities
    src/types/          backend data models
    src/tests/          backend tests
  frontend/             React/Vite frontend
    src/pages/          main application pages
    src/components/     shared UI components
    src/tests/          frontend tests
    public/             staticwebapp.config.json
  README.md
  DESPLIEGUE.md
  CAMBIOS_V8.md
```

## Real Azure Resources

Resource Group:

```text
rg-erp-update-scheduler-prod
```

Function App:

```text
erpupdsch4645-api
```

API base:

```text
https://erpupdsch4645-api.azurewebsites.net/api
```

Static Web App:

```text
https://agreeable-wave-07469d50f.7.azurestaticapps.net
```

Cosmos account:

```text
erpupdsch4645-cosmos
```

Cosmos database:

```text
erp-update-scheduler
```

Key Vault:

```text
erpupdsch4645-kv
```

Region:

```text
eastus2
```

GitHub Actions page:

```text
https://github.com/jcpv9824/update_reminder/actions
```

## Cosmos Containers

Known containers:

- `users`
- `clients`
- `domains`
- `databases`
- `updateSchedules`
- `updateTasks`
- `auditLogs`
- `appSettings`
- `emailNotifications`

`emailNotifications` is used for idempotency of administrative monthly reminders.

Recommended creation command if missing:

```powershell
az cosmosdb sql container create `
  --account-name erpupdsch4645-cosmos `
  --resource-group rg-erp-update-scheduler-prod `
  --database-name erp-update-scheduler `
  --name emailNotifications `
  --partition-key-path "/id"
```

## Corporate Palette

Use these colors consistently:

```css
--color-primary: #1C3664;
--color-secondary: #7E99B2;
--color-neutral: #D1D3D2;
--color-accent: #D3C193;
```

Guidance:

- Sidebar and primary buttons: `#1C3664`
- Secondary info/badges: `#7E99B2`
- Soft borders/backgrounds: `#D1D3D2`
- Subtle highlights/accent: `#D3C193`
- Errors: accessible red
- Success: accessible green

Design style:

- Professional
- Minimalist
- Clear
- Operational, not marketing-like
- Easy to scan
- All Spanish

## Roles

Existing or expected roles:

- `admin` / Administrador
- `client_manager` / Administrador de clientes
- `domain_updater` / Actualizador de dominios
- `database_updater` / Actualizador de bases de datos
- `viewer` / Visualizador

General permissions:

- Admin: everything.
- Client manager: manages clients, domains, databases, schedules, and can refresh tasks.
- Domain updater: works domain update tasks.
- Database updater: works database update tasks and can access database connection details when permitted.
- Viewer: read-only; no task action buttons.

## Core Business Concepts

### Clients

Clients are master records. They can have domains and databases through those domains.

Normal lists should hide records with:

```text
status = "deleted"
```

### Domains

Domains belong to clients. Domains have:

- `domainName`
- `environment`
- `status`
- optional current web version
- default schedule/frequency

The normal update frequency is configured on the domain. Databases can inherit the domain frequency.

Domains page now has:

- `Ver bases asociadas`

It replaced the older action:

- `Copiar para publicar`

The domain table still displays the publishable domain as informational text.

### Databases / Companies

Databases belong to domains and clients. Each database represents a company/base to update.

Important database access fields:

- `serverHostPort`
- `initialCatalog`
- `userId`
- `passwordSecretName`

Rules:

- Never store the database password in Cosmos.
- Store the database password in Key Vault.
- Never log passwords.
- Never include passwords in reports.
- Do not remove backend/model fields merely because the frontend hides them.

The databases master table should not show visible columns:

- `Servidor`
- `Versión`

The database table should show a cleaner set:

- Cliente
- Dominio
- Empresa
- Base de datos
- Ambiente
- Estado
- Última actualización
- Acciones

Access details still appear in:

- `Ver acceso`
- database task detail
- database error emails
- copy buttons
- internal connection/access functions

### Schedules

Main schedule/frequency flow:

1. Create client.
2. Create domain and configure its frequency.
3. Create database under the domain.
4. Database inherits domain schedule unless a specific database schedule exists.

Normal domain frequencies use:

```text
origin = "domain_default"
```

Special schedules use:

```text
origin = "special"
```

The Programaciones especiales page should show only special schedules, not normal domain schedules.

### Special Schedules / Programaciones Especiales

The special schedule UI uses hierarchical grouped scope, not one giant mixed selector.

Concept:

```ts
scopeGroups: Array<{
  clientId: string;
  includeAllDomains: boolean;
  domains: Array<{
    domainId: string;
    includeAllDatabases: boolean;
    databaseIds: string[];
  }>;
}>
```

User flow:

- Add client to scope.
- Inside a client, include all active domains or add specific domains.
- Inside a domain, include all active databases or add specific databases.
- Add another client if needed.

Validation rules:

- Do not allow saving with an empty scope.
- Do not allow domains outside selected client.
- Do not allow databases outside selected domain.
- Avoid duplicate domains inside a client.
- Avoid duplicate databases inside a domain.
- If "include all databases" is checked, manual database selection is ignored/cleared.
- If "include all domains" is checked, manual domain selection is hidden/ignored.

Responsibility assignment:

- Assign by role.
- Assign to specific users.

Default role assignment:

- Domain tasks → `domain_updater`
- Database tasks → `database_updater`

Specific user assignment:

- Domain responsible users stored in `assignedUserIds`.
- Database responsible users stored in `databaseAssignedUserIds`.

## Tasks

Task statuses:

- `pending` / Pendiente
- `in_progress` / En progreso
- `completed` / Completada
- `failed` / Fallida
- `blocked` / Bloqueada
- `cancelled` / Cancelada

Historical note: `reopened` may exist from older versions but the current reopen flow sends completed tasks back to `pending`.

Business rules:

Pending:

- Can start.
- Can complete.
- Can block.
- Can cancel if supported.

In progress:

- Can complete.
- Can block.
- Can return to pending if supported.

Blocked:

- Must have a reason/comment.
- Can be resolved through `Resolver bloqueo`.
- Resolution requires a comment.
- New state can be:
  - pending
  - in_progress
  - completed

Completed:

- Should not appear as pending/overdue.
- Can be reopened to pending.
- Reopen should preserve history in audit.

Viewer:

- Must not see task action buttons.

Important task fields added/used:

- `blockedAt`
- `blockedBy`
- `blockReason`
- `resolvedAt`
- `resolvedBy`
- `resolutionComment`
- `reopenedAt`
- `reopenedBy`
- `reopenReason`

Important audit actions:

- `task_started`
- `task_completed`
- `task_blocked`
- `task_block_resolved`
- `task_reopened`
- `task_cancelled`

## Manual Task Refresh

The task page button is now:

```text
Refrescar
```

It replaced:

```text
Generar tareas ahora
```

Endpoint:

```http
POST /api/tasks/refresh
```

Backward compatibility:

```http
POST /api/tasks/generate
```

Rules:

- Refresh/generate pending tasks according to schedules.
- Refresh visual list.
- Do not send emails.
- Do not send reminders.
- Do not send overdue alerts.
- Do not send blocked/error alerts.
- Avoid spam.

UI messages:

- Loading: `Actualizando tareas...`
- Success: `Tareas actualizadas correctamente.`
- Error: `No se pudieron actualizar las tareas.`

Audit:

- `tasks_refreshed_manually`

## Cascading Delete

This project now prefers soft-delete for master records.

Soft-delete fields:

- `status = "deleted"`
- `deletedAt`
- `deletedBy`
- `updatedAt`
- `updatedBy`

Do not delete audit logs.

### Delete Client

Endpoint:

```http
DELETE /api/clients/{id}?cascade=true
```

Without cascade, if dependencies exist, return:

```http
409 Conflict
```

With dependency summary.

Cascade behavior:

- Mark client deleted.
- Mark client domains deleted.
- Mark client databases deleted.
- Delete associated schedules.
- Cancel future/pending non-terminal tasks.
- Preserve audit logs.

Audit:

- `client_deleted_cascade`
- `domain_deleted_cascade`
- `database_deleted_cascade`
- `schedule_deleted_cascade`

### Delete Domain

Endpoint:

```http
DELETE /api/domains/{id}?cascade=true
```

Cascade behavior:

- Mark domain deleted.
- Mark associated databases deleted.
- Delete associated schedules.
- Cancel pending/future non-terminal tasks.
- Preserve audit logs.

### Delete Database

Endpoint:

```http
DELETE /api/databases/{id}?cascade=true
```

Cascade behavior:

- Mark database deleted.
- Delete associated schedules.
- Cancel pending/future non-terminal tasks.
- Preserve audit logs.
- Because this is soft-delete, do not automatically delete the Key Vault secret.

## Related Data Views

### Domains: Ver Bases Asociadas

Endpoint:

```http
GET /api/domains/{id}/databases
```

Rules:

- Requires JWT.
- Excludes deleted/inactive records by default.
- Shows databases only for that domain.

Modal content:

- Dominio
- Cliente
- Ambiente
- associated databases

For each database:

- Empresa
- Base de datos
- Ambiente
- Estado
- Servidor y puerto
- Usuario
- Contraseña hidden
- Copy buttons for server/port, database, user

Password rules:

- Do not reveal automatically.
- Do not store in frontend permanently.
- Do not write to console.
- Revealing/copying password must be audited where supported.

### Clients: Ver Dominios y Bases

Endpoint:

```http
GET /api/clients/{id}/tree
```

Response shape:

```json
{
  "client": {},
  "domains": [
    {
      "domain": {},
      "databases": []
    }
  ]
}
```

Rules:

- Exclude deleted by default.
- Show hierarchy: client → domains → databases.

## Email Alerts And Settings

Settings document:

```text
container: appSettings
id: email-alerts
```

SMTP:

- Password is stored in Key Vault.
- API must never return SMTP password.
- Cosmos stores only secret name/configured flag.
- Audit must never include SMTP password.

Recommended P&A config button fills:

```text
emailProvider = smtp
emailFrom = info@pya.com.co
emailFromName = Programador de Actualizaciones
smtpHost = smtp.office365.com
smtpPort = 587
smtpSecure = false
smtpUser = info@pya.com.co
frontendBaseUrl = https://agreeable-wave-07469d50f.7.azurestaticapps.net
```

It must not fill password.

### Email Recipient Helpers

Backend helper:

```ts
parseSemicolonEmails(value: string): {
  emails: string[];
  invalid: string[];
}
```

Rules:

- Split by semicolon.
- Trim.
- Ignore empty values.
- Validate email format.
- Return invalid emails separately.

Backend helper:

```ts
uniqueEmails(emails: string[]): string[]
```

Rules:

- Trim.
- Lowercase.
- Remove empties.
- Keep valid emails only.
- Deduplicate.

### Overdue Alerts

Overdue task definition:

```text
taskDate < today
and status is not completed
and status is not cancelled
```

Statuses considered overdue:

- pending
- in_progress
- blocked
- failed
- reopened, if old data exists

Settings:

- `overdueAlertsEnabled`
- `overdueAlertRecipientRoleIds`
- `overdueAlertCustomEmails`
- `overdueAlertFrequency`: daily or weekly
- `overdueAlertTime`
- `overdueAlertTimezone`
- `overdueAlertWeekdays`
- `overdueAlertLastSentPeriod`

Rules:

- Daily sends at most once per day.
- Weekly sends only on configured weekdays.
- Do not duplicate same period.
- If disabled, send nothing.
- Resolve recipients by roles + manual emails.
- Deduplicate recipients.

### Blocked/Error Alerts

Concept:

Blocked tasks and update errors are the same alert category:

```text
Alertas de tareas bloqueadas / errores de actualización
```

Settings:

- `blockedAlertsEnabled`
- `blockedAlertRecipientRoleIds`
- `blockedAlertCustomEmails`
- `blockedAlertSendImmediately`
- `blockedAlertIncludeInOverdueSummary`

Rules:

- Blocking a task can send immediate email.
- If no recipients, do not send and do not fail task update.
- Deduplicate recipients.

### Database Error Email

Subject:

```text
Error reportado en actualización de base de datos
```

Must include:

- Tipo: Base de datos
- Cliente
- Dominio registrado
- Dominio para publicar
- Empresa
- Servidor y puerto
- Base de datos
- Usuario
- Fecha programada
- Responsable
- Fecha de reporte
- Problema reportado

Must not include:

- Password
- Full connection string
- Key Vault secret name
- Tokens
- JWT

### Domain Error Email

Similar, but no database technical fields.

Must include:

- Tipo: Dominio
- Cliente
- Dominio registrado
- Dominio para publicar
- Ambiente
- Fecha programada
- Responsable
- Problema reportado

## Master Report Email

Endpoint:

```http
POST /api/reports/masters/send-email
```

Subject:

```text
Reporte maestro ERP — clientes, dominios y empresas
```

Rules:

- Include only active clients.
- Include only active domains.
- Include only active databases.
- Exclude inactive/deleted records.
- Include environment on domain.
- Include environment on database.
- Include domain frequency when available.
- Include active licenses/modules per client from active license assignments.
- License assignments may be client-level, domain-level, or database-level.
- Deduplicate licenses by module id and sort them alphabetically.
- If a client has no active licenses, show `Sin licencias registradas`.
- Do not include secrets.

Must not include:

- Passwords
- SQL users
- Server/IP/port
- Full connection strings
- Key Vault secret names
- Tokens
- JWT
- Password hashes

License data model expected by the V9 report:

- `licenseModules`: records with `id`, `name`, optional `code`, `status`, `active`, `deletedAt`.
- `licenseAssignments`: records with `moduleId` and assignment fields such as `clientId`, `domainId`, `databaseId`, or `targetType` + `targetId`.

Only active modules and active assignments should be rendered. Deleted/inactive modules or assignments are excluded. `DELETE /api/license-modules/{id}` returns `409 Conflict` if the module still has active assignments, including a client summary that a licensing UI can show to explain why deletion is blocked.

## V10 UX And Reminder Corrections

- Business flows must not use browser `alert`, `confirm`, or `prompt`.
- Completed tasks show **Reabrir** and open an app modal. Optional reason. Backend transition is `completed -> pending`, with `task_reopened`.
- Blocked tasks show **Resolver bloqueo** and do not show **Reabrir**. Optional resolution comment. Required target status: pending, in progress, or completed. Backend transition is `blocked -> selected`, with `task_block_resolved`.
- Special schedules keep `scopeGroups`, but domain/database selection should use modal panels with search and checkboxes so users can add multiple items at once.
- Updater reminders have two levels: global defaults from `settings/email-alerts`, and per-schedule/domain overrides in `schedule.reminders`. If no override exists, the scheduled reminder timer uses global defaults.
- Blocked task alerts send immediately by default when blocked alerts are enabled. Optional unresolved-block reminders use days-after-block, time, timezone, and `emailNotifications` idempotency keys.
- Administrative reminders support send rules: first day, last day, last business day, fixed day. Default is last business day. If the month ends Saturday/Sunday, send Friday before and Monday after, preserving the previous month period.
- Actions columns are aligned right; destructive actions stay last.

## Administrative Monthly Reminders

Section in UI:

```text
Recordatorios administrativos
```

Two reminder cards:

1. `Guardar versión mensual de SAG Web`
2. `Crear documento "¿Qué hay de nuevo en SAG Web?"`

Each card has:

- Enable/disable
- Recipients separated by semicolon
- Day of month, 1–28
- Time
- Timezone
- Email subject
- Send test button

Settings shape:

```ts
administrativeReminders?: {
  sagWebVersionReminder: {
    enabled: boolean;
    recipients: string[];
    dayOfMonth: number;
    time: string;
    timezone: string;
    subject: string;
  };
  whatsNewReminder: {
    enabled: boolean;
    recipients: string[];
    dayOfMonth: number;
    time: string;
    timezone: string;
    subject: string;
  };
}
```

Timer:

```text
sendAdministrativeReminders
```

Runs periodically and checks:

- reminder enabled
- day of month matches
- time has arrived
- same reminder/month was not already sent

Idempotency keys:

```text
admin-reminder:sag-web-version:YYYY-MM
admin-reminder:whats-new:YYYY-MM
```

Stored in:

```text
emailNotifications
```

Audit:

- `administrative_reminder_sent`
- `administrative_reminder_failed`
- `admin_reminder_test_sent`
- `admin_reminder_test_failed`
- `administrative_reminder_settings_updated`

Templates use corporate palette.

## Static Web Apps Routing

Keep:

```text
frontend/public/staticwebapp.config.json
```

Required content:

```json
{
  "navigationFallback": {
    "rewrite": "/index.html",
    "exclude": ["/assets/*", "/*.{css,scss,js,png,gif,ico,jpg,svg}"]
  }
}
```

Vite copies this to `dist`.

Manual test:

- Open `/tareas`
- Refresh browser
- It must not return 404

## Authentication

Authentication:

- email + password
- JWT

Do not break:

- login
- JWT
- password reset, if present
- setup first admin endpoints

Dev mode may use headers if `DEV_AUTH_ENABLED=true`.

Never hardcode passwords.

## Audit

Do not delete audit logs.

Audit must not include:

- passwords
- raw connection strings
- secret names when avoidable
- JWT/tokens

Important audit actions include:

- client/domain/database created/updated/deactivated/reactivated
- cascade deleted actions
- schedule created/updated/deleted
- task generated/refreshed/started/completed/blocked/resolved/reopened/cancelled
- database password revealed/copied
- email settings updated
- administrative reminders sent/failed

## Important Backend Files

- `api/src/types/models.ts`: core model types.
- `api/src/lib/cosmos.ts`: Cosmos container names.
- `api/src/lib/permissions.ts`: role and permission rules.
- `api/src/lib/audit.ts`: audit writer and sanitization.
- `api/src/lib/keyVault.ts`: Key Vault access.
- `api/src/lib/settingsService.ts`: email settings and SMTP password handling.
- `api/src/lib/emailTemplates.ts`: email templates.
- `api/src/lib/emailRecipients.ts`: email parsing/deduplication.
- `api/src/lib/reportsService.ts`: master report builder.
- `api/src/lib/taskGenerator.ts`: schedule expansion, inherited database tasks, grouped special scope.
- `api/src/functions/*.ts`: HTTP/timer functions.

## Important Frontend Files

- `frontend/src/types.ts`: frontend model mirror.
- `frontend/src/api/client.ts`: HTTP client with JWT.
- `frontend/src/components/SelectorBuscable.tsx`: searchable selector.
- `frontend/src/components/Comunes.tsx`: modal, alert, status badge, copy button.
- `frontend/src/pages/ClientesPage.tsx`: clients and tree modal.
- `frontend/src/pages/DominiosPage.tsx`: domains and associated databases modal.
- `frontend/src/pages/BasesDeDatosPage.tsx`: database master table and access modal.
- `frontend/src/pages/FrecuenciasPage.tsx`: special schedules grouped UI.
- `frontend/src/pages/TareasPage.tsx`: task board and task state actions.
- `frontend/src/pages/AlertasCorreosPage.tsx`: email settings, alerts, reminders, SMTP.

## Local Commands

Install dependencies:

```powershell
cd "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler\api"
npm install

cd ..\frontend
npm install
```

Run backend locally:

```powershell
cd "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler\api"
npm run build
func start
```

Run frontend locally:

```powershell
cd "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler\frontend"
"VITE_API_BASE_URL=http://localhost:7071/api" | Out-File -FilePath .env.local -Encoding utf8
npm run dev
```

Run tests:

```powershell
cd "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler\api"
npm test
npm run build

cd ..\frontend
npm test
npm run build
```

## Deployment

### Backend Deployment

Use full ZIP with `dist` and `node_modules`.

Do not rely only on `func azure functionapp publish`; previous small packages caused Azure not to detect functions.

Commands:

```powershell
cd "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler\api"

npm install
npm run build

Remove-Item .\api-deploy-full.zip -ErrorAction SilentlyContinue

tar -a -c -f api-deploy-full.zip host.json package.json package-lock.json dist node_modules

az functionapp deployment source config-zip `
  --resource-group rg-erp-update-scheduler-prod `
  --name erpupdsch4645-api `
  --src api-deploy-full.zip

az functionapp restart `
  --name erpupdsch4645-api `
  --resource-group rg-erp-update-scheduler-prod
```

Verify:

```powershell
az functionapp function list `
  --name erpupdsch4645-api `
  --resource-group rg-erp-update-scheduler-prod `
  --output table
```

### Frontend Deployment

Commands:

```powershell
cd "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler\frontend"

"VITE_API_BASE_URL=https://erpupdsch4645-api.azurewebsites.net/api" | Out-File -FilePath .env.production -Encoding utf8

npm install
npm run build

cd "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler"

git status
git add .
git commit -m "Cambios V8 programador actualizaciones"
git push
```

Then wait for GitHub Actions:

```text
https://github.com/jcpv9824/update_reminder/actions
```

Open:

```text
https://agreeable-wave-07469d50f.7.azurestaticapps.net
```

## Current V8 Validation Snapshot

Last known local validation:

Backend:

```text
npm test     -> 21 test files passed, 135 tests passed
npm run build -> OK
```

Frontend:

```text
npm test     -> 14 test files passed, 89 tests passed
npm run build -> OK
```

Frontend local server was started successfully at:

```text
http://127.0.0.1:5173
```

## Manual Test Checklist

Use this checklist after major changes:

- Login with email/password.
- JWT is preserved and expired token behavior works.
- Clients list loads.
- Client `Ver dominios y bases` opens tree modal.
- Delete client with cascade confirmation removes from list.
- Domains list loads.
- Domain action says `Ver bases asociadas`, not `Copiar para publicar`.
- Associated databases modal opens and password is hidden.
- Delete domain with cascade confirmation removes from list.
- Databases table does not show columns `Servidor` or `Versión`.
- Database `Ver acceso` still shows server/port, database and user.
- Delete database with cascade confirmation removes from list.
- Programaciones especiales allows adding multiple clients.
- Programaciones especiales allows domains inside clients.
- Programaciones especiales allows databases inside domains.
- Include all domains and include all databases work.
- Assignment by role works.
- Assignment by users works.
- Task page button says `Refrescar`.
- Refresh updates task list and does not mention emails.
- Pending task can start, complete and block.
- Blocked task shows `Resolver bloqueo`.
- Completed task shows `Reabrir`.
- Viewer does not see action buttons.
- Alertas y correos shows SMTP advanced collapsed.
- Recommended P&A config fills SMTP fields but not password.
- Overdue alerts accept role recipients and semicolon emails.
- Blocked/error alerts accept role recipients and semicolon emails.
- Invalid email shows Spanish error.
- Administrative reminders section is visible.
- Both administrative reminder cards are visible.
- Day of month validation enforces 1–28.
- Test email for administrative reminder works.
- Master report email includes only active records and environment.
- Master report email excludes secrets.
- Refresh `/tareas` in browser does not 404.

## Guardrails For Future AI Work

Future AI assistants should follow these rules:

- Do not rebuild the app.
- Do not change the overall architecture unless explicitly requested.
- Preserve email/password login and JWT.
- Preserve Cosmos DB and Key Vault usage.
- Preserve audit logs and sanitization.
- Preserve Spanish UI.
- Work incrementally.
- Read the actual code before editing.
- Use existing local patterns.
- Add or update tests for behavior changes.
- Run backend and frontend tests/builds before declaring work complete.
- Never hardcode passwords.
- Never include real passwords in docs, tests, commits, or logs.
- Do not delete user changes without explicit approval.
- Avoid exposing database passwords in the frontend or console.

## Known Caveats / Risks

- Special schedules with multiple clients are stored as a single schedule document partitioned by the first client ID. This works for current logic but should be considered if future querying by all client IDs becomes important.
- The administrative reminders require the `emailNotifications` container.
- Email sending is best-effort in some task flows; failures should not block task state changes.
- If no recipients are configured for blocked/overdue alerts, the system should skip sending safely.
- Keep an eye on Azure Functions runtime version support. Deployment notes previously observed Azure rejecting Node 20 in some contexts; use the currently supported Node runtime in Azure.
