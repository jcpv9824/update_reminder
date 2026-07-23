# Permissions and Task Visibility Design

## Status

The new permission model, role lifecycle safeguards, and removal of unused hard-coded authorization helpers exist locally. The protected role-ID migration is ready to run immediately after an approved deployment. Do not deploy permission changes until the user explicitly approves deployment.

## Core Principle

Portal SAG Web uses two related but separate concepts:

1. **Access permissions** decide whether a user can open an option and perform actions inside it.
2. **Task visibility** decides which task records a user can see after they have access to the Tareas option.

Opening `Actualizaciones > Tareas` is not enough to see every task. A user must also have task visibility for domain tasks, database tasks, or both.

## Why Not Universal CRUD

Not every option has the same actions. Some options fit CRUD well; others have specialized operations like reveal password, resend credentials, complete task, reopen task, send report, replace PDF, or test email.

Use **option-specific action schemas**. CRUD is a reusable starting point, not a forced rule.

Permission keys should follow:

```text
<module>.<option>.<action>
```

Examples:

```text
updates.tasks.view
updates.tasks.complete
updates.tasks.reopen
updates.schedules.create
clients.databases.reveal_connection
configuration.users.reset_password
configuration.roles.manage_permissions
configuration.print_formats.replace_pdf
configuration.alerts.test_email
implementation.public_downloads.replace_file
visibility.audit.view
```

## Module and Option Catalog

| Module | Option | Permission Prefix |
| --- | --- | --- |
| Clientes | Clientes | `clients.clients` |
| Clientes | Dominios | `clients.domains` |
| Clientes | Bases de Datos | `clients.databases` |
| Clientes | Licenciamiento | `clients.licensing` |
| Actualizaciones | Tareas | `updates.tasks` |
| Actualizaciones | Programar Actualizaciones | `updates.schedules` |
| Implementación | Descargas Públicas | `implementation.public_downloads` |
| Configuración | Alertas y Correos | `configuration.alerts` |
| Configuración | Usuarios y Roles | `configuration.users`, `configuration.roles` |
| Configuración | Formatos de Impresión | `configuration.print_formats` |
| Auditoría y Visibilidad | Auditoría | `visibility.audit` |
| Auditoría y Visibilidad | Tablero | `visibility.dashboard` |

## Option Action Schemas

Each option declares its supported actions. The role editor must render only the actions supported by that option.

### Clientes

`clients.clients`

- `view`
- `create`
- `edit`
- `delete`
- `deactivate`
- `reactivate`
- `assign_licenses`
- `view_related`

`clients.domains`

- `view`
- `create`
- `edit`
- `delete`
- `deactivate`
- `reactivate`
- `view_related_databases`

`clients.databases`

- `view`
- `create`
- `edit`
- `delete`
- `deactivate`
- `reactivate`
- `view_connection`
- `copy_connection_part`
- `reveal_password`

`clients.licensing`

- `view`
- `create`
- `edit`
- `delete`
- `deactivate`
- `reactivate`

### Actualizaciones

`updates.tasks`

- `view`
- `start`
- `complete`
- `block`
- `resolve_block`
- `fail`
- `cancel`
- `reopen`
- `view_database_connection`
- `copy_database_connection_part`
- `reveal_database_password`

Task actions still require task visibility. For example, `updates.tasks.complete` does not allow completing a database task unless the user can see that database task.

`updates.schedules`

- `view`
- `create`
- `edit`
- `delete`
- `deactivate`
- `reactivate`
- `preview_scope`
- `generate_tasks`

### Implementación

`implementation.public_downloads`

- `view`
- `create_section`
- `edit_section`
- `delete_section`
- `create_document`
- `edit_document`
- `delete_document`
- `replace_file`

Las claves internas `*_document` se conservan por compatibilidad, pero en la interfaz representan archivos públicos y cubren tanto documentos como videos. Las secciones son categorías y prefijos de URL, no archivos duplicados.

### Configuración

`configuration.alerts`

- `view`
- `edit`
- `test_email`
- `send_report`
- `test_administrative_reminder`

`configuration.users`

- `view`
- `create`
- `edit`
- `deactivate`
- `reactivate`
- `reset_password`
- `resend_credentials`
- `assign_roles`

`configuration.roles`

- `view`
- `create`
- `edit`
- `delete`
- `deactivate`
- `reactivate`
- `manage_permissions`
- `manage_task_visibility`

`configuration.print_formats`

- `view`
- `create_source`
- `edit_source`
- `delete_source`
- `create_format`
- `edit_format`
- `delete_format`
- `replace_pdf`

### Auditoría y Visibilidad

`visibility.audit`

- `view`
- `export`

`visibility.dashboard`

- `view`

## Task Visibility Contract

Task visibility is not an access permission. It is a role parameter.

Use:

```ts
type TaskVisibilityLevel = "none" | "assigned" | "all";

type TaskVisibility = {
  domain: TaskVisibilityLevel;
  database: TaskVisibilityLevel;
};
```

Meaning:

- `none`: user cannot see tasks of that type.
- `assigned`: user sees only tasks explicitly assigned to them or assigned to their role according to the existing assignment rules.
- `all`: user sees all tasks of that type.

`super_admin` ignores this setting and sees everything.

## Schedule Role Assignment

Role-based schedule assignment uses the same task-access contract. A role can be selected as responsible for domain or database tasks only when it is active and has both:

- `updates.tasks.view`.
- Task visibility other than `none` for the corresponding target type.

This lets custom roles participate in schedules without fixed role IDs. The schedule editor filters available roles for each target type, and the backend validates submitted roles on creation and update. Individual-user assignment remains a separate mode and does not require a responsible role.

Examples:

| Role | Required Page Permission | Task Visibility |
| --- | --- | --- |
| Database updater | `updates.tasks.view` | `{ domain: "none", database: "assigned" }` |
| Domain updater | `updates.tasks.view` | `{ domain: "assigned", database: "none" }` |
| Database task supervisor | `updates.tasks.view` | `{ domain: "none", database: "all" }` |
| Update supervisor | `updates.tasks.view` | `{ domain: "all", database: "all" }` |

## Super Admin

`super_admin` is a protected role:

- Has all permissions.
- Has all task visibility.
- Cannot be deleted.
- Cannot be edited in a way that removes its universal access.
- Existing users with `admin` must migrate to `super_admin`.

## Default Roles

Create these initial roles, but keep them editable except for the protected behavior of `super_admin`.

| Role ID | Name | Defaults |
| --- | --- | --- |
| `super_admin` | Super Administrador | all permissions, all task visibility |
| `database_updater` | Actualizador de Bases de Datos | task page/action permissions including database connection actions; task visibility `{ domain: "none", database: "assigned" }` |
| `domain_updater` | Actualizador de Dominios | task page/action permissions excluding database connection actions; task visibility `{ domain: "assigned", database: "none" }` |
| `print_formats_admin` | Administrador de Formatos de Impresión | print format permissions |

## Role Editor Behavior

- Show permissions grouped by module and option.
- Selecting a module selects all supported actions for all options inside that module.
- Selecting an option selects all supported actions for that option.
- Users can unselect individual actions.
- Do not render actions that are not supported by an option.
- Show task visibility controls separately from module permissions.
- Show `super_admin` as protected.

## Role Lifecycle

- Only active role definitions can be assigned to users.
- System/default roles remain editable, but are not deleted from the catalog.
- Custom roles can be deleted only when they are not assigned to users, active schedules, or open tasks.
- Deactivating any role is blocked by the same reference check. Reassign users and schedules, and close or reassign open tasks first.
- Role creation, update, and deletion must remain auditable.

## Backend Enforcement

Frontend visibility is convenience only. Backend must enforce every permission.

Required helpers:

```ts
hasPermission(user, "updates.tasks.view")
hasAnyPermission(user, ["updates.tasks.complete", "updates.tasks.reopen"])
canViewTask(user, task)
canPerformTaskAction(user, task, "complete")
```

`canViewTask` must:

1. Allow `super_admin`.
2. Require `updates.tasks.view`.
3. Check task type visibility (`domain` or `database`).
4. If visibility is `assigned`, apply current task assignment rules.
5. If visibility is `all`, allow all tasks of that target type.

## Migration Strategy

Use two phases.

### Phase 1: Compatibility

- Introduce role definitions and permission resolver.
- Migrate existing `admin` users to `super_admin`.
- Map old roles to new role definitions.
- Keep compatibility with existing `roles: string[]` while backend begins resolving role definitions.
- Keep existing assignment-based task safety.
- Provide `/roles` endpoints for listing merged default/custom roles, creating custom roles, and editing role definitions.
- Keep `super_admin` protected even if stored role data tries to remove universal permissions or task visibility.
- Enforce merged role definitions in task list, task detail, and task status endpoints.
- Keep updater roles operational by default: action permissions allow work, while task visibility still restricts records.
- Keep only direct mappings during migration: `admin` to `super_admin` and `formatos_impresion.admin` to `print_formats_admin`.
- Resolve frontend sidebar visibility and protected routes through `*.view` permissions, not hard-coded module role arrays.
- Normalize legacy role IDs at API boundaries so persisted `admin` appears to the app as `super_admin`.
- Allow authenticated users to read role definitions because the frontend needs them to resolve custom-role navigation.
- Enforce granular `configuration.users.*` and `configuration.roles.*` permissions in user and role mutation endpoints.
- Enforce granular `visibility.audit.view` and `configuration.alerts.*` permissions in audit, email-alert settings, and configured-report endpoints.
- Enforce granular `implementation.public_downloads.*` and `configuration.print_formats.*` permissions in public-download and print-format admin endpoints.
- Enforce granular `updates.schedules.*` permissions in scheduled-update endpoints and manual task generation.
- Enforce granular `clients.clients.*`, `clients.domains.*`, and `clients.databases.*` permissions in client/domain/database endpoints, while preserving task-bound database credential access through `updates.tasks.*` permissions.
- Enforce granular `clients.licensing.*` permissions in license module and license assignment endpoints.
- Enforce `configuration.alerts.test_administrative_reminder` for administrative reminder test sends.
- Resolve task "assigned to me" filtering through role-definition assignment helpers, including migrated legacy role IDs.
- Store new setup-created administrators as `super_admin`, normalize setup-touched legacy `admin` roles, and use `super_admin` as the canonical alert-recipient role while resolving existing `admin` users through recipient aliases.

### Phase 2: Cleanup

- Retire `client_manager`, `viewer`, and `public_downloads.admin` from the default catalog.
- Run `POST /setup/migrate-role-ids` with the deployment setup secret immediately after deployment. The operation first rejects any retired role that still has a user, active-schedule, or open-task reference.
- Persist direct user-role mappings: `admin` to `super_admin`, and `formatos_impresion.admin` to `print_formats_admin`; migrate configured alert recipients and remove stored legacy role definitions.
- Remove hard-coded role checks after all functions use permission helpers.
- Remove obsolete labels and assumptions.
- Keep migration tests permanently.

## Required Tests Before Implementation

Add these tests before changing behavior:

- Permission catalog exposes only supported actions per option.
- Selecting a module selects all actions for its child options.
- Selecting an option selects only its supported actions.
- `super_admin` has all permissions and all task visibility.
- Existing `admin` migrates to `super_admin`.
- Database updater can open Tareas and see assigned database tasks only.
- Domain updater can open Tareas and see assigned domain tasks only.
- A role with database task visibility `all` sees all database tasks, but no domain tasks unless configured.
- A role with task page access but task visibility `none/none` opens Tareas but sees no tasks.
- Backend rejects task actions when the user lacks either action permission or task visibility.
- Schedule role assignment rejects inactive roles and roles without matching `updates.tasks.view` and task visibility.
- Inactive roles cannot be assigned to users, and referenced roles cannot be deactivated or deleted.
- Frontend sidebar hides modules/options without `view` permission.

## Non-Goals Until Approved

- Do not deploy this permission model yet.
- Do not run the role-ID migration until the approved deployment is complete and the setup secret is available.
- Do not make every option use the same CRUD actions.
- Do not rely on frontend-only checks for security.
