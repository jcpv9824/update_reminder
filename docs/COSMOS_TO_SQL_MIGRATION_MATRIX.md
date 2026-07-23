# Mapeo canónico Cosmos DB → SQL Server 2019

Proyecto: **Portal SAG Web**
Fecha original: 2026-05-16

Última revisión: **2026-07-16**


Esta es la única matriz fuente-a-destino vigente. Fue contrastada con el snapshot productivo estructural del 2026-07-16: 17/17 contenedores, 2.890 documentos y cero errores de hash/conteo/ID. No existen secciones con precedencia posterior: cualquier cambio debe editar la regla original y volver a ejecutar el validador de cobertura.

Reglas globales:

- Copiar cada ID Cosmos a `source_id`; generar PK interna `BIGINT` para tablas de volumen. Catálogos textuales estables conservan su clave natural.
- Guardar documento original en `migration.raw_documents`.
- Convertir fechas ISO a `DATETIME2`; fechas `YYYY-MM-DD` a `DATE`.
- Si una fecha inválida aparece, registrar error en `migration.validation_results`.
- No resolver secretos de Key Vault.
- No migrar contraseñas reales.
- No imprimir valores sensibles.
- Preservar registros activos, inactivos y `deleted`.

## 1. Convenciones

| Convención | Regla |
|---|---|
| `copy` | Copiar valor tal como llega, con trim si aplica a texto de usuario. |
| `normalize_text` | Trim, lower, colapsar espacios. |
| `normalize_domain` | Trim, lower, remover slash final. |
| `datetime` | Convertir ISO string a `DATETIME2`. |
| `date` | Convertir `YYYY-MM-DD` a `DATE`. |
| `json` | Guardar JSON serializado controlado. |
| `split_array` | Crear filas hijas desde array. |
| `secret_ref_only` | Copiar solo nombre de secreto, nunca valor. |

Reglas transversales de cobertura:

- `_rid`, `_self`, `_etag`, `_attachments` y `_ts` se conservan únicamente en `migration.raw_documents`; no son columnas operativas.
- Objetos/arrays se consideran cubiertos solo cuando sus campos hijos tienen fila explícita o existe una regla de subárbol raw/JSON aprobada.
- IDs fuente que representan relaciones se resuelven a claves internas `BIGINT`; no se copian como FK `NVARCHAR`.
- El comando `node migration/tools/validate-mapping-coverage.js <profile.json>` debe terminar con cero gaps antes de Gate B.

## 2. `users` → `security`

| Source container | Source field | Target table | Target column | Transform rule | Required | Default if missing | Validation | Sensitive |
|---|---|---|---|---|---|---|---|---|
| users | id | security.users | source_id | copy | yes | fail | unique, not empty | no |
| users | displayName | security.users | display_name | trim | yes | fail | not empty | no |
| users | email | security.users | email | trim | yes | fail | valid email | moderate |
| users | email | security.users | email_normalized | lower(trim(email)) | yes | fail | unique | moderate |
| users | active | security.users | active | boolean | yes | true | bit | no |
| users | passwordHash | security.users | password_hash | copy hash only | no | null | never plain password | yes |
| users | passwordUpdatedAt | security.users | password_updated_at | datetime | no | null | valid datetime | no |
| users | mustChangePassword | security.users | must_change_password | boolean | no | false | bit | no |
| users | passwordExpiresAt | security.users | password_expires_at | datetime | no | derive from passwordUpdatedAt + policy | valid datetime | no |
| users | tokenVersion | security.users | token_version | integer | no | 0 | >= 0 | no |
| users | mfaEnabled, mfaSecretName, mfaEnrolledAt, mfaLastTimeStep, mfaRecoveryCodeHashes | migration.raw_documents | raw_json | preserve only inside encrypted migration snapshot; do not project into operational SQL | no | omit | verify absent from `security.users` and public exports | restricted legacy |
| users | lastLoginAt | security.users | last_login_at | datetime | no | null | valid datetime | no |
| users | passwordResetTokenHash | security.users | password_reset_token_hash | copy hash only | no | null | never plain token | yes |
| users | passwordResetExpiresAt | security.users | password_reset_expires_at | datetime | no | null | valid datetime | yes |
| users | passwordResetUsedAt | security.users | password_reset_used_at | datetime | no | null | valid datetime | yes |
| users | createdAt | security.users | created_at | datetime | yes | import time with warning | valid datetime | no |
| users | createdBy | security.users | created_by | copy | yes | system with warning | FK nullable | no |
| users | updatedAt | security.users | updated_at | datetime | yes | created_at | valid datetime | no |
| users | updatedBy | security.users | updated_by | copy | yes | created_by | FK nullable | no |
| users | roles[] | security.user_roles | role_id | split_array + alias | yes | preserve empty set; no implicit viewer | role exists when present; active user with empty roles keeps deny-all access and produces an owner-review warning | no |
| users | id | security.user_roles | user_key | lookup users.source_id | yes | fail | FK users | no |
| users | full document | migration.raw_documents | raw_json | json | yes | fail | sha256 | may contain sensitive hashes |

## 3. `clients` → `core.clients` and licensing

| Source container | Source field | Target table | Target column | Transform rule | Required | Default if missing | Validation | Sensitive |
|---|---|---|---|---|---|---|---|---|
| clients | id | core.clients | source_id | copy | yes | fail | unique | no |
| clients | externalId | core.clients | external_id | trim | no | null | unique where not deleted if present; may become required later | no |
| clients | name | core.clients | name | trim | yes | fail | not empty | no |
| clients | name | core.clients | name_normalized | normalize_text | yes | fail | unique where not deleted | no |
| clients | status | core.clients | status | copy | yes | active | active/inactive/deleted | no |
| clients | notes | core.clients | notes | trim | no | null | max optional | no |
| clients | createdAt | core.clients | created_at | datetime | yes | import time with warning | valid datetime | no |
| clients | createdBy | core.clients | created_by | copy | yes | system with warning | FK nullable | no |
| clients | updatedAt | core.clients | updated_at | datetime | yes | created_at | valid datetime | no |
| clients | updatedBy | core.clients | updated_by | copy | yes | created_by | FK nullable | no |
| clients | deletedAt | core.clients | deleted_at | datetime | no | null | required if status deleted? warning | no |
| clients | deletedBy | core.clients | deleted_by | copy | no | null | FK nullable | no |
| clients | licenseModuleIds[] | licensing.license_assignments | module_key + target_type=`client` | split_array + reconcile | no | none | module exists; dedupe with explicit assignments | no |
| clients | id | licensing.license_assignments | client_key | lookup source_id for each embedded license | no | none | FK client | no |
| clients | licenseModuleNames[] | migration.raw_documents | raw_json only | preserve in raw | no | none | use modules as source of truth | no |
| clients | full document | migration.raw_documents | raw_json | json | yes | fail | sha256 | no |

## 4. `domains` → `core.domains`

| Source container | Source field | Target table | Target column | Transform rule | Required | Default if missing | Validation | Sensitive |
|---|---|---|---|---|---|---|---|---|
| domains | id | core.domains | source_id | copy | yes | fail | unique | no |
| domains | clientId | core.domains | client_key | lookup clients.source_id | yes | fail | FK clients | no |
| domains | clientName | core.domains | client_name_snapshot | copy | no | lookup client.name | compare warning | no |
| domains | domainName | core.domains | domain_name | trim | yes | fail | starts https:// | no |
| domains | domainName | core.domains | domain_name_normalized | normalize_domain | yes | fail | unique where not deleted | no |
| domains | domainName | core.domains | publishable_domain | derive formatDomainForPublishing | no | null | deterministic | no |
| domains | environment | core.domains | environment_id | normalize to closed catalog | yes | fail/warning | must be production/test/demo | no |
| domains | currentWebVersion | core.domains | current_web_version | trim | no | null | preserve | no |
| domains | status | core.domains | status | copy | yes | active | active/inactive/deleted | no |
| domains | notes | core.domains | notes | trim | no | null | preserve | no |
| domains | lastUpdatedAt | core.domains | last_updated_at | datetime | no | null | valid datetime | no |
| domains | lastUpdatedBy | core.domains | last_updated_by | copy | no | null | FK nullable | no |
| domains | createdAt | core.domains | created_at | datetime | yes | import time with warning | valid | no |
| domains | createdBy | core.domains | created_by | copy | yes | system with warning | FK nullable | no |
| domains | updatedAt | core.domains | updated_at | datetime | yes | created_at | valid | no |
| domains | updatedBy | core.domains | updated_by | copy | yes | created_by | FK nullable | no |
| domains | deletedAt | core.domains | deleted_at | datetime | no | null | warning if status deleted and null | no |
| domains | deletedBy | core.domains | deleted_by | copy | no | null | FK nullable | no |
| domains | assignedUpdaterIds[] | core.domain_assignees | user_key | split_array + dedupe + lookup users.source_id | no | none | user exists warning if missing | no |
| domains | id | core.domain_assignees | domain_key | lookup domains.source_id for each assignee | no | none | FK domain | no |
| domains | full document | migration.raw_documents | raw_json | json | yes | fail | sha256 | no |

## 5. `databases` → `core.databases`

| Source container | Source field | Target table | Target column | Transform rule | Required | Default if missing | Validation | Sensitive |
|---|---|---|---|---|---|---|---|---|
| databases | id | core.databases | source_id | copy | yes | fail | unique | no |
| databases | clientId | core.databases | client_key | lookup clients.source_id | yes | fail | FK clients | no |
| databases | clientName | core.databases | client_name_snapshot | copy | no | lookup client.name | compare warning | no |
| databases | domainId | core.databases | domain_key | lookup domains.source_id | yes | fail | FK domains | no |
| databases | domainName | core.databases | domain_name_snapshot | copy | no | lookup domain.name | compare warning | no |
| databases | companyName | core.databases | company_name | trim | yes | fail | not empty | no |
| databases | environment | core.databases | environment_id | normalize to closed catalog | yes | domain environment? warning | must be production/test/demo | no |
| databases | dbAccess.serverHostPort | core.database_access_profiles | server_host_port | trim | yes | fail | not empty | sensitive technical |
| databases | dbAccess.initialCatalog | core.database_access_profiles | initial_catalog | trim | yes | fail | not empty | no |
| databases | dbAccess.userId | core.database_access_profiles | sql_user_id | trim | yes | fail | not empty | sensitive technical |
| databases | dbAccess.passwordSecretName | core.database_access_profiles | password_secret_name | secret_ref_only | yes | fail | never resolve | yes |
| databases | dbAccess fields | core.database_access_profiles | connection_fingerprint | SHA-256 of canonical host/catalog/user, no password | yes | fail | unique active fingerprint | yes derived |
| databases | status | core.database_access_profiles | active | `status='deleted'` → 0; otherwise 1 | yes | active | only one active profile per fingerprint; retain deleted historical profile and its own secret reference | no |
| databases | generated access profile | core.databases | access_profile_key | create profile then assign FK | yes | fail | FK profile | sensitive technical |
| databases | currentDbVersion | core.databases | current_db_version | trim | no | null | preserve | no |
| databases | status | core.databases | status | copy | yes | active | active/inactive/deleted | no |
| databases | notes | core.databases | notes | trim | no | null | preserve | no |
| databases | lastUpdatedAt | core.databases | last_updated_at | datetime | no | null | valid | no |
| databases | lastUpdatedBy | core.databases | last_updated_by | copy | no | null | FK nullable | no |
| databases | timestamps/delete | core.databases | timestamps/delete columns | datetime/copy | mixed | defaults with warning | valid | no |
| databases | assignedUpdaterIds[] | core.database_assignees | user_key | split_array + dedupe + lookup users.source_id | no | none | user exists warning if missing | no |
| databases | id | core.database_assignees | database_key | lookup databases.source_id for each assignee | no | none | FK database | no |
| databases | full document | migration.raw_documents | raw_json | json | yes | fail | sha256 | may contain secret names |

Important validation:

- `databases.clientId` must equal `domains.clientId` for `databases.domainId`.
- Fingerprints repeated only by an `active`/`deleted` historical pair are retained as two profiles: the deleted profile is inactive and keeps its original `passwordSecretName`. The certified snapshot has 55 profiles, 50 active unique fingerprints and 5 inactive historical profiles.
- Do not include server/user/secret fields in master report validation output.

## 6. `licenseModules` → `licensing.license_modules`

| Source container | Source field | Target table | Target column | Transform rule | Required | Default if missing | Validation | Sensitive |
|---|---|---|---|---|---|---|---|---|
| licenseModules | id | licensing.license_modules | source_id | copy | yes | fail | unique | no |
| licenseModules | name | licensing.license_modules | name | trim | yes | fail | not empty | no |
| licenseModules | name | licensing.license_modules | name_normalized | normalize_text | yes | fail | unique where not deleted | no |
| licenseModules | code | licensing.license_modules | code | trim uppercase if present | no | null/autogen not during migration unless missing and needed | duplicate validation | no |
| licenseModules | code | licensing.license_modules | code_normalized | uppercase normalized | no | null | unique where not null/not deleted | no |
| licenseModules | description | licensing.license_modules | description | trim | no | null | preserve | no |
| licenseModules | status | licensing.license_modules | status | copy | no | derive from active or active | active/inactive/deleted | no |
| licenseModules | active | licensing.license_modules | active_legacy | boolean | no | null | preserve | no |
| licenseModules | notes | licensing.license_modules | notes | trim | no | null | preserve | no |
| licenseModules | timestamps/delete | licensing.license_modules | timestamps/delete columns | datetime/copy | no | null/import time warnings | valid | no |
| licenseModules | full document | migration.raw_documents | raw_json | json | yes | fail | sha256 | no |

Status derivation:

1. If `status` exists, use it.
2. Else if `active === false`, use `inactive`.
3. Else use `active`.

## 7. `licenseAssignments` → `licensing.license_assignments`

| Source container | Source field | Target table | Target column | Transform rule | Required | Default if missing | Validation | Sensitive |
|---|---|---|---|---|---|---|---|---|
| licenseAssignments | id | licensing.license_assignments | source_id | copy | yes | fail | unique | no |
| licenseAssignments | moduleId | licensing.license_assignments | module_key | lookup module source_id | yes | fail | FK module | no |
| licenseAssignments | moduleName | licensing.license_assignments | module_name_snapshot | copy | no | lookup module.name | warning if mismatch | no |
| licenseAssignments | moduleCode | licensing.license_assignments | module_code_snapshot | copy | no | lookup module.code | warning if mismatch | no |
| licenseAssignments | targetType | licensing.license_assignments | target_type | copy | no | infer from databaseId/domainId/clientId | client/domain/database | no |
| licenseAssignments | targetId | migration.stage_license_assignments | target_source_id | copy for reconciliation | no | infer from specific id | must match the selected target-specific source ID | no |
| licenseAssignments | clientId | licensing.license_assignments | client_key | lookup clients.source_id | no | derive from target | FK clients nullable | no |
| licenseAssignments | domainId | licensing.license_assignments | domain_key | lookup domains.source_id | no | null | FK domains nullable | no |
| licenseAssignments | databaseId | licensing.license_assignments | database_key | lookup databases.source_id | no | null | FK databases nullable | no |
| licenseAssignments | environment | licensing.license_assignments | environment_id | normalize production/test/demo; `all` becomes NULL | no | null | FK nullable | no |
| licenseAssignments | status | licensing.license_assignments | status | copy/derive | no | active | active/inactive/deleted | no |
| licenseAssignments | active | licensing.license_assignments | active_legacy | boolean | no | null | preserve | no |
| licenseAssignments | timestamps/delete | licensing.license_assignments | timestamps/delete columns | datetime/copy | no | null/import warnings | valid | no |
| licenseAssignments | full document | migration.raw_documents | raw_json | json | yes | fail | sha256 | no |

Note:

- These records are advanced/reserved. They must not affect current licensing behavior unless feature flag is enabled.

## 8. `updateSchedules` → `scheduling`

### 8.1 Main schedule fields

| Source container | Source field | Target table | Target column | Transform rule | Required | Default if missing | Validation | Sensitive |
|---|---|---|---|---|---|---|---|---|
| updateSchedules | id | scheduling.update_schedules | source_id | copy | yes | fail | unique | no |
| updateSchedules | clientId | scheduling.update_schedules | client_key | lookup client source_id | yes | fail | FK clients | no |
| updateSchedules | clientName | scheduling.update_schedules | client_name_snapshot | copy | no | lookup client.name | warning if mismatch | no |
| updateSchedules | domainId | scheduling.update_schedules | domain_key | lookup domain source_id | no | null | FK domains nullable | no |
| updateSchedules | domainName | scheduling.update_schedules | domain_name_snapshot | copy | no | lookup domain.name | warning if mismatch | no |
| updateSchedules | targetType | scheduling.update_schedules | target_type | copy | yes | fail | domain/database | no |
| updateSchedules | frequencyType | scheduling.update_schedules | frequency_type | copy | yes | fail | once/weekly/interval/monthly/manual | no |
| updateSchedules | everyNWeeks | scheduling.update_schedules | every_n_weeks | integer | no | 1 for weekly | >=1 | no |
| updateSchedules | intervalDays | scheduling.update_schedules | interval_days | integer | no | null | required for interval | no |
| updateSchedules | dayOfMonth | scheduling.update_schedules | day_of_month | integer | no | null | 1-31 for monthly | no |
| updateSchedules | startDate | scheduling.update_schedules | start_date | date | yes | fail | valid date | no |
| updateSchedules | endDate | scheduling.update_schedules | end_date | date | no | null | >= start_date | no |
| updateSchedules | timezone | scheduling.update_schedules | timezone | copy | yes | America/Bogota | valid known string warning | no |
| updateSchedules | assignedRole | scheduling.update_schedules | assigned_role | copy | yes | infer from targetType | role exists/string | no |
| updateSchedules | databaseReminderRecipientsMode | scheduling.update_schedules | database_reminder_recipients_mode | copy | no | roleUsers | allowed values | no |
| updateSchedules | selectionMode | scheduling.update_schedules | selection_mode | copy | no | manual if scopeGroups, licensing if licensingScope else null | manual/licensing | no |
| updateSchedules | manualTargetTypes | scheduling.update_schedules | manual_target_types | copy | no | domains_and_databases | domains_and_databases/domains_only/databases_only | no |
| updateSchedules | assignmentMode | scheduling.update_schedules | assignment_mode | copy | no | role | role/users | no |
| updateSchedules | domainAssignedRole | scheduling.update_schedules | domain_assigned_role | copy | no | domain_updater | role/string | no |
| updateSchedules | databaseAssignedRole | scheduling.update_schedules | database_assigned_role | copy | no | database_updater | role/string | no |
| updateSchedules | origin | scheduling.update_schedules | origin | copy | no | null/normal | known values warning | no |
| updateSchedules | active | scheduling.update_schedules | active | boolean | yes | true | bit | no |
| updateSchedules | completedAt | scheduling.update_schedules | completed_at | datetime | no | null | set when once executed | no |
| updateSchedules | completedReason | scheduling.update_schedules | completed_reason | copy | no | null | known values warning | no |
| updateSchedules | notes | scheduling.update_schedules | notes | trim | no | null | preserve | no |
| updateSchedules | timestamps | scheduling.update_schedules | timestamps | datetime/copy | mixed | import warnings | valid | no |
| updateSchedules | full document | migration.raw_documents | raw_json | json | yes | fail | sha256 | no |

### 8.2 Arrays and child objects

| Source field | Target table | Target columns | Transform rule | Validation |
|---|---|---|---|---|
| targetIds[] | scheduling.schedule_targets | schedule_key, client_key, target_type, domain_key/database_key | split_array + lookup + dedupe | exactly one target FK; composite FK enforces the schedule/target client |
| weekdays[] | scheduling.schedule_weekdays | schedule_key, weekday, kind=`weekly` | split_array | valid weekday |
| preferredWeekdays[] | scheduling.schedule_weekdays | schedule_key, weekday, kind=`preferred` | split_array | valid weekday |
| assignedUserIds[] | scheduling.schedule_assignees | schedule_key, user_key, assignment_kind=`general` | split_array + lookup | user exists warning if missing |
| databaseAssignedUserIds[] | scheduling.schedule_assignees | schedule_key, user_key, assignment_kind=`database` | split_array + lookup | user exists warning if missing |
| reminders.remindersEnabled | scheduling.schedule_reminder_settings | reminders_enabled | copy | boolean |
| reminders.reminderTime | scheduling.schedule_reminder_settings | reminder_time | copy | HH:mm |
| reminders.reminderRecipientsMode | scheduling.schedule_reminder_settings | reminder_recipients_mode | copy | allowed |
| reminders.reminderDaysBefore[] | scheduling.schedule_reminder_days | schedule_key, days_before | split_array | integer >=0 |
| reminders.customReminderEmails[] | scheduling.schedule_reminder_emails | schedule_key, email_normalized | split_array + normalize | valid email |

### 8.3 `scopeGroups`

| Source path | Target table | Target columns | Transform rule | Validation |
|---|---|---|---|---|
| `scopeGroups[].clientId`, `scopeGroups[].includeAllDomains` | scheduling.scope_groups | scope_group_key, schedule_key, client_key, include_all_domains | one row per group | client exists |
| `scopeGroups[].domains[].domainId`, `scopeGroups[].domains[].includeAllDatabases` | scheduling.scope_domains | scope_domain_key, scope_group_key, client_key, domain_key, include_all_databases | one row per domain | composite FK enforces domain belongs to group client |
| scopeGroups[i].domains[j].databaseIds[k] | scheduling.scope_databases | scope_domain_key, client_key, domain_key, database_key | split_array + lookup | composite FK enforces database belongs to domain/client |

### 8.4 `licensingScope`

| Source path | Target table | Target columns | Transform rule | Validation |
|---|---|---|---|---|
| licensingScope | scheduling.licensing_scope | schedule_key, license_match_mode, environment_id, target_types, active_only | one row; `environment=all` becomes NULL | licenseMatchMode any/all, targetTypes allowed |
| licensingScope.licenseModuleIds[] | scheduling.licensing_scope_modules | schedule_key, module_key | split_array + lookup + dedupe | module exists and active if activeOnly |
| licensingScope.excludedDomainIds[] | scheduling.licensing_excluded_domains | schedule_key, domain_key | split_array + lookup + dedupe | domain belongs to resolved licensing scope; excludes only domain task |
| licensingScope.excludedDatabaseIds[] | scheduling.licensing_excluded_databases | schedule_key, database_key | split_array + lookup + dedupe | database belongs to resolved licensing scope; excludes only database task |

One-time schedule rule:

- `frequencyType = once` uses `startDate` as the run date / fecha de actualización.
- Refresh can create future tasks inside the operational window, but the schedule must remain active until `startDate <= today` in the app timezone.
- After its update date is reached and processed, `active` becomes false and `completedReason` should be `one_time_schedule_executed`.
- Migration must preserve executed one-time schedules as inactive history, not convert them to recurring schedules.

## 9. `updateTasks` → `workflow`

### 9.1 Main task fields

| Source container | Source field | Target table | Target column | Transform rule | Required | Default if missing | Validation | Sensitive |
|---|---|---|---|---|---|---|---|---|
| updateTasks | id | workflow.update_tasks | source_id | copy | yes | fail | unique | no |
| updateTasks | dedupeKey | workflow.update_tasks | dedupe_key | copy | no | derive from targetType/targetId/taskDate | unique if possible | no |
| updateTasks | taskDate | workflow.update_tasks | task_date | date | yes | fail | valid date | no |
| updateTasks | taskBucket | workflow.update_tasks | task_bucket | copy | yes | derive | preserve | no |
| updateTasks | clientId | workflow.update_tasks | client_key | lookup client source_id | yes | fail | FK client or approved historical placeholder | no |
| updateTasks | clientName | workflow.update_tasks | client_name_snapshot | copy | yes | lookup client.name | preserve mismatch | no |
| updateTasks | domainId | workflow.update_tasks | domain_key | lookup domain source_id | yes | empty allowed only as approved anomaly | FK domain or historical placeholder | no |
| updateTasks | domainName | workflow.update_tasks | domain_name_snapshot | copy | yes | lookup domain.name | preserve mismatch | no |
| updateTasks | targetType | workflow.update_tasks | target_type | copy | yes | fail | domain/database | no |
| updateTasks | targetId | workflow.update_tasks | target_source_id | copy; resolve domain_key/database_key when present | yes | fail | target exists or terminal historical orphan warning | no |
| updateTasks | targetName | workflow.update_tasks | target_name_snapshot | copy | yes | lookup target | preserve mismatch | no |
| updateTasks | scheduleId | migration.stage_update_tasks | legacy_schedule_id | copy | yes | null with warning | may be synthetic; never force as FK | no |
| updateTasks | rootScheduleId | workflow.update_tasks | primary_schedule_source_id + primary_schedule_key nullable | copy source ID + optional lookup; fallback from normalized legacy scheduleId with warning | no | derive/null | 158/370 present; preserve missing historical roots without fake schedule | no |
| updateTasks | assignedRole | workflow.update_tasks | assigned_role | copy | yes | infer targetType | role/string | no |
| updateTasks | status | workflow.update_tasks | status | copy | yes | pending | allowed status | no |
| updateTasks | result | workflow.update_tasks | result | trim/copy | no | null | preserve; `obsolete` has special recovery semantics for cancelled tasks | no |
| updateTasks | notes | workflow.update_tasks | notes | trim | no | empty/null | preserve | no |
| updateTasks | completedAt | workflow.update_tasks | completed_at | datetime | no | null | required if completed? warning | no |
| updateTasks | completedBy | workflow.update_tasks | completed_by | copy | no | null | FK nullable | no |
| updateTasks | completedWithProblems | workflow.update_tasks | completed_with_problems | boolean | no | false | bit | no |
| updateTasks | problemNote | workflow.update_tasks | problem_note | trim | no | null | preserve | no |
| updateTasks | completionNote | workflow.update_tasks | completion_note | trim | no | null | preserve | no |
| updateTasks | blockedAt | workflow.update_tasks | blocked_at | datetime | no | null | warning if status blocked and null | no |
| updateTasks | blockedBy | workflow.update_tasks | blocked_by | copy | no | null | FK nullable | no |
| updateTasks | blockReason | workflow.update_tasks | block_reason | trim | no | null | preserve | no |
| updateTasks | resolvedAt | workflow.update_tasks | resolved_at | datetime | no | null | valid | no |
| updateTasks | resolvedBy | workflow.update_tasks | resolved_by | copy | no | null | FK nullable | no |
| updateTasks | resolutionComment | workflow.update_tasks | resolution_comment | trim | no | null | preserve | no |
| updateTasks | reopenedAt | workflow.update_tasks | reopened_at | datetime | no | null | valid | no |
| updateTasks | reopenedBy | workflow.update_tasks | reopened_by | copy | no | null | FK nullable | no |
| updateTasks | reopenReason | workflow.update_tasks | reopen_reason | trim | no | null | preserve | no |
| updateTasks | createdAt | workflow.update_tasks | created_at | datetime | yes | import time warning | valid | no |
| updateTasks | createdBy | workflow.update_tasks | created_by | copy | yes | system | preserve | no |
| updateTasks | updatedAt | workflow.update_tasks | updated_at | datetime | yes | created_at | valid | no |
| updateTasks | updatedBy | workflow.update_tasks | updated_by | copy | yes | created_by | preserve | no |
| updateTasks | full document | migration.raw_documents | raw_json | json | yes | fail | sha256 | no |

### 9.2 Task child tables

| Source field | Target table | Target columns | Transform rule | Validation |
|---|---|---|---|---|
| assignedUserIds[] | workflow.task_assignees | task_key, user_key | split_array + lookup + dedupe | user exists warning if missing |
| `sources[].scheduleId`, `sources[].scheduleType`, `sources[].reason`, `sources[].createdAt` | workflow.task_sources | task_key, schedule_source_id, schedule_key nullable, schedule_type, reason, created_at, is_primary | split_array + optional lookup | authoritative; missing historical schedule ID remains as snapshot, not fake FK |
| `remindersSent[].type`, `remindersSent[].daysBefore`, `remindersSent[].sentAt` | workflow.task_reminders | task_key, reminder_type, days_before, sent_at | split_array | valid type/date |
| remindersSent[].recipients[] | workflow.task_reminder_recipients | task_reminder_key, email_normalized | split_array + normalize/dedupe | valid email warning |
| overdueAlertSentDates[] | workflow.task_overdue_alerts | task_key, sent_date | split_array | valid date |

### 9.3 Status history derivation

Because Cosmos stores current task state plus timestamps, generate initial history rows:

| Condition | History action | previous_status | new_status | performed_at | comment |
|---|---|---|---|---|---|
| any task | `task_imported` | null | current status | createdAt or migration time | null |
| completedAt exists | `task_completed` | unknown | completed | completedAt | completionNote/problemNote |
| blockedAt exists | `task_blocked` | unknown | blocked | blockedAt | blockReason |
| resolvedAt exists | `task_block_resolved` | blocked | current status | resolvedAt | resolutionComment |
| reopenedAt exists | `task_reopened` | completed | pending/current | reopenedAt | reopenReason |

Do not invent exact previous transitions beyond what data supports; use `unknown` or null when uncertain.

Task regeneration rule to preserve:

- `status = completed` blocks duplicate task generation for the same `target_type + target_id + task_date`.
- `status = cancelled` with `result = obsolete` must not permanently hide a task required by an active schedule; the application can reactivate it to `pending`.
- Generic user-cancelled tasks should be reviewed before deciding whether they block regeneration in SQL runtime.
- Los 32 grupos duplicados del snapshot cumplen la regla migrable: consolidar una tarea, conservar IDs supersedidos en `task_source_aliases` y generar history inferido.
- Las referencias master/target faltantes aparecen solo en tareas terminales: conservar source IDs/nombres, marcar `is_historical_orphan=1` y dejar FK nullable. Runtime nuevo/no terminal exige FK completa.

## 10. `appSettings/email-alerts` → `settings`

El singleton se normaliza; no existe `settings_json` operativo. El documento completo queda únicamente en raw restringido.

| Campos fuente | Destino | Regla |
|---|---|---|
| `id` | `settings.email_settings.source_id` | Debe ser `email-alerts`. |
| `emailProvider`, `emailFrom`, `emailFromName`, `frontendBaseUrl` | columnas homónimas normalizadas en `settings.email_settings` | Provider `mock|smtp|sendgrid|acs`; validar email/URL. |
| `smtpHost`, `smtpPort`, `smtpSecure`, `smtpUser` | columnas SMTP en `settings.email_settings` | Puerto 1..65535; no son contraseña. |
| `smtpPasswordSecretName` | `settings.email_settings.smtp_password_secret_name` | Copiar solo referencia Key Vault. |
| `smtpPasswordConfigured` | `settings.email_settings.smtp_password_configured` | Booleano informativo. |
| `remindersEnabled`, `defaultReminderTime`, `defaultTimezone` | columnas defaults en `settings.email_settings` | Validar `HH:mm` y timezone. |
| `overdueAlertsEnabled`, `overdueAlertTime`, `overdueAlertTimezone`, `overdueAlertFrequency`, `overdueAlertLastSentPeriod` | columnas overdue en `settings.email_settings` | Frecuencia `daily|weekly`; período nullable. |
| `overdueAlertRecipientsMode` | `settings.email_settings.legacy_overdue_recipient_mode` | Preservar para round-trip inicial; destinatarios efectivos se normalizan. |
| `blockedAlertsEnabled`, `blockedAlertSendImmediately`, `blockedAlertIncludeInOverdueSummary` | columnas blocked en `settings.email_settings` | Booleanos. |
| `blockedReminderEnabled`, `blockedReminderTime`, `blockedReminderTimezone` | columnas reminder de bloqueo | Validar hora/timezone. |
| `passwordNotificationEnabled`, `sendTemporaryPasswordByEmail` | columnas de política en `settings.email_settings` | Booleanos; nunca contienen contraseña. |
| `createdAt`, `createdBy`, `updatedAt`, `updatedBy` | auditoría + `row_version` | Parsear UTC; actor snapshot. |
| `defaultReminderDaysBefore[]` | `settings.default_reminder_days(days_before)` | Dedupe; entero >= 0. |
| `overdueAlertRecipientRoleIds[]` | `settings.alert_recipient_roles(alert_kind='overdue',role_id)` | Rol válido; aliases canónicos. |
| `overdueAlertCustomEmails[]` | `settings.alert_recipient_emails(alert_kind='overdue',email_normalized)` | Trim/lower/dedupe. |
| `overdueAlertWeekdays[]` | `settings.overdue_alert_weekdays(weekday)` | Enum weekday. |
| `blockedAlertRecipientRoleIds[]` | `settings.alert_recipient_roles(alert_kind='blocked',role_id)` | Rol válido; aliases canónicos. |
| `blockedAlertCustomEmails[]` | `settings.alert_recipient_emails(alert_kind='blocked',email_normalized)` | Trim/lower/dedupe. |
| `blockedReminderDaysAfter[]` | `settings.blocked_reminder_days(days_after)` | Dedupe; entero >= 0. |
| `customAdminAlertEmails[]` | `settings.alert_recipient_emails(alert_kind='overdue', source_kind='legacy')` | Campo legado; reconciliar con arrays nuevos y registrar divergencia. |
| `administrativeReminders.sagWebVersionReminder.*` | `settings.administrative_reminders` fila `sag_web_version` | Mapear `enabled`, `sendRule`, `dayOfMonth`, `time`, `timezone`, `subject`; validar regla/día. |
| `administrativeReminders.sagWebVersionReminder.recipients[]` | `settings.administrative_reminder_recipients` | Email normalizado/dedupe. |
| `administrativeReminders.whatsNewReminder.*` | `settings.administrative_reminders` fila `whats_new` | Mismas columnas y validaciones. |
| `administrativeReminders.whatsNewReminder.recipients[]` | `settings.administrative_reminder_recipients` | Email normalizado/dedupe. |
| documento completo | `migration.raw_documents.raw_json` | Cifrado/restringido; SHA-256. |

Si aparece `smtpPassword` u otra credencial en claro, no se proyecta: error crítico, saneamiento y aprobación antes de continuar.

## 11. `emailNotifications` → `notifications`

| Campo fuente | Destino | Regla |
|---|---|---|
| `id` | `notifications.email_notifications.source_id` + `idempotency_key` | Copiar; unique. |
| `type` | `notification_type` | En snapshot: `administrative_reminder`; permitir catálogo controlado incluido `blocked_task_reminder`. |
| `key` | `entity_source_id` | Para recordatorio administrativo; conservar. |
| `taskId`/`entityId` si aparecen | `entity_source_id` | Resolver tipo y FK opcional cuando exista. |
| `period` | `period` | Copiar/validar formato. |
| `sendDate` | `send_date` | `DATE`. |
| `sentAt` | `sent_at` | `DATETIME2(3)` UTC; estado inicial `sent`. |
| `daysAfter` si aparece | `metadata_json.daysAfter` | JSON validado; también puede alimentar reporting. |
| `recipients[]` | `notifications.email_notification_recipients(email_normalized,recipient_type='to')` | Trim/lower/dedupe; no JSON operativo. |
| documento completo | `migration.raw_documents.raw_json` | Restringido; no imprimir destinatarios. |

Nuevas notificaciones agregan `status`, intentos, claim con expiración, retry y provider ID. El índice unique de idempotencia se crea antes de reactivar timers.

## 12. `auditLogs` → `audit.audit_logs`

| Source container | Source field | Target table | Target column | Transform rule | Required | Default if missing | Validation | Sensitive |
|---|---|---|---|---|---|---|---|---|
| auditLogs | id | audit.audit_logs | source_id | copy | yes | fail | unique | no |
| auditLogs | entityType | audit.audit_logs | entity_type | copy | yes | unknown | preserve | no |
| auditLogs | entityId | audit.audit_logs | entity_id | copy | yes | unknown | preserve | no |
| auditLogs | clientId | audit.audit_logs | client_key | optional lookup clients.source_id; retain source value in raw | no | null | FK nullable | no |
| auditLogs | clientName | audit.audit_logs | client_name | copy | no | null | snapshot | no |
| auditLogs | domainId | audit.audit_logs | domain_key | optional lookup domains.source_id; retain source value in raw | no | null | FK nullable | no |
| auditLogs | domainName | audit.audit_logs | domain_name | copy | no | null | snapshot | no |
| auditLogs | companyName | audit.audit_logs | company_name | copy | no | null | snapshot | no |
| auditLogs | action | audit.audit_logs | action | copy | yes | unknown | preserve | no |
| auditLogs | performedBy | audit.audit_logs | performed_by | copy | yes | system/unknown | FK nullable | no |
| auditLogs | performedByEmail | audit.audit_logs | performed_by_email | copy | yes | empty/unknown | preserve | moderate |
| auditLogs | performedAt | audit.audit_logs | performed_at | datetime | yes | import time warning | valid | no |
| auditLogs | before | audit.audit_logs | before_json | json | no | null | should already be sanitized | maybe |
| auditLogs | after | audit.audit_logs | after_json | json | no | null | should already be sanitized | maybe |
| auditLogs | metadata | audit.audit_logs | metadata_json | json | no | null | should already be sanitized | maybe |
| auditLogs | full document | migration.raw_documents | raw_json | json | yes | fail | sha256 | may contain sanitized sensitive context |

Validation:

- Scan `before_json`, `after_json`, `metadata_json` for disallowed key names after migration.
- Todos los subcampos observados bajo `before.*`, `after.*` y `metadata.*` pertenecen a esos JSON sanitizados; no se proyectan dinámicamente a columnas.
- Do not delete audit records if related entity is deleted.

## 13. Cross-container validation matrix

| Validation | Source | SQL target | Severity |
|---|---|---|---|
| Count users | users count | security.users count | critical |
| Count clients all/status | clients by status | core.clients by status | critical |
| Count domains all/status | domains by status | core.domains by status | critical |
| Count databases all/status | databases by status | core.databases by status | critical |
| Count schedules active/inactive/origin | updateSchedules | scheduling.update_schedules | critical |
| Count tasks by status/type | updateTasks | workflow.update_tasks | critical |
| Count license modules | licenseModules | licensing.license_modules | critical |
| Count reconciled client license rows | clients licenseModuleIds + licenseAssignments | licensing.license_assignments target_type=client | high |
| Count audit logs | auditLogs | audit.audit_logs | high |
| Count email notifications | emailNotifications | notifications.email_notifications | high |
| Domain client exists | domains.clientId | core.clients.id | critical |
| Database domain exists | databases.domainId | core.domains.id | critical |
| Database client matches domain client | databases/domain | core.databases/core.domains | critical |
| Schedule targets exist | updateSchedules.targetIds | schedule_targets + core tables | high |
| Task target exists or historical placeholder | updateTasks target | workflow/core | high |
| No duplicate active client names | clients | core.clients unique | critical |
| No duplicate domain URLs | domains | core.domains unique | critical |
| No duplicate db fingerprints | databases | core.databases unique | critical |
| No secret values exported | all | SQL all | critical |

## 14. Business-output validation matrix

After loading SQL staging/final tables, compare these outputs against Cosmos behavior:

| Business output | Expected comparison |
|---|---|
| Clientes list | Same active/default records, same pagination/search results. |
| Dominios list | Same active/default records, recurrente/proxima equivalent. |
| Bases list | Same visible fields, no server/version columns in table. |
| Cliente tree | Same domains/databases grouped by client. |
| Domain associated databases | Same active databases and access metadata without password. |
| Master report | Same active clients/domains/databases/licenses and no secrets. |
| Special schedule manual preview/generation | Same scope resolution. |
| Special schedule licensing preview/generation | Same clients/domains/databases by license and environment. |
| Task refresh | Same created/skipped/deduplicated behavior. |
| Operational task view | Same overdue/today/upcoming/completed group counts. |
| Overdue alerts | Same recipients and task selection. |
| Blocked reminders | Same idempotency and due selection. |
| Administrative reminders | Same due dates, Friday/Monday rule and idempotency. |
| Audit page | Same filters and record counts. |

## 15. Required migration scripts after this matrix

Next phase should create:

```text
migration/sql/002_migration_history_and_schemas.sql
migration/sql/003_security_core.sql
migration/sql/004_licensing_scheduling_workflow.sql
migration/sql/005_settings_notifications_content_audit.sql
migration/sql/006_staging.sql
migration/sql/007_indexes_constraints_permissions.sql
migration/sql/008_stage_projection_procedure.sql
migration/tools/Import-CosmosSnapshot-RawStage.ps1
migration/tools/plan-operational-transform.js
migration/tools/validate-operational-transform-plan.js
api/scripts/import-cosmos-snapshot-to-sql.js (transformación final, pendiente)
api/scripts/validate-cosmos-sql-migration.js
```

Runtime switch (`DATA_PROVIDER=sql`) must wait until:

- Snapshot export exists.
- SQL schema exists.
- Import script exists.
- Validation script passes.
- Staging environment confirms business-output equivalence.

## 16. Estado de seguridad efimero excluido del traslado

- `securityRateLimits`: no se migra; los contadores empiezan vacios en el nuevo almacen distribuido.
- `authSessions`: no se migran sesiones activas ni hashes de refresh. El cutover revoca/cierra sesiones y exige un nuevo login.
- El destino debe recrear expiracion, revocacion por usuario, hash de refresh y actualizacion atomica antes de habilitar autenticacion SQL.

## 17. Precondicion de auditoria

Antes de exportar/importar `auditLogs`:

1. Ejecutar `npm run security:sanitize-audit` y revisar conteos.
2. Ejecutar `npm run security:sanitize-audit -- --apply` en una ventana controlada.
3. Repetir dry-run; debe informar `updated: 0` salvo registros creados por una version antigua.
4. El importador SQL debe volver a aplicar el DTO allowlist; nunca confiar ciegamente en JSON historico.

## 18. `roles` → autorización granular

| Campo Cosmos | Destino | Transformación / validación |
|---|---|---|
| `id` | `security.roles.role_id` | Aplicar solo aliases aprobados; rechazar colisión entre legacy y canónico. |
| `name` | `security.roles.name` | Trim; obligatorio. |
| `active` | `security.roles.active` | Default `true`. |
| `system`, `protected` | columnas homónimas | `super_admin` siempre true/true. |
| `taskVisibility.domain` | `domain_task_visibility` | `none|assigned|all`. |
| `taskVisibility.database` | `database_task_visibility` | `none|assigned|all`. |
| `permissions[]` | `security.role_permissions` | Cada clave debe existir en el catálogo sembrado desde `PERMISSION_CATALOG`; unknown = error crítico. |
| auditoría | `security.roles` | Parsear UTC; preservar actor snapshot. |

Los roles default que no tienen documento Cosmos se siembran desde código, pero una definición almacenada válida prevalece salvo las protecciones de `super_admin`. Antes de retirar `client_manager`, `viewer` o `public_downloads.admin`, validar usuarios, programaciones y tareas abiertas.

## 19. `authSessions` y `securityRateLimits`

No se cargan filas al target operativo. La migración valida solo conteos y ausencia de tokens en claro.

| Contenedor/campos fuente | Destino/regla de cutover |
|---|---|
| `authSessions.id`, `userId`, `refreshTokenHash`, `tokenVersion`, `createdAt`, `lastUsedAt`, `expiresAt`, `revokedAt`, `revokedReason`, `replacedBySessionId`, `ttl` | Raw restringido para diagnóstico; **no insertar filas**. El target vacío implementa las mismas columnas/semántica con PK interna, `source_id`, FK usuario y `ROWVERSION`. |
| `authSessions.mfaVerifiedAt` | Legado encontrado en 4/88 sesiones; raw-only, no columna operativa porque MFA fue retirado. |
| `securityRateLimits.id`, `scope`, `keyType`, `count`, `windowStartedAt`, `blockedUntil`, `updatedAt`, `ttl` | Raw restringido para conteo; **no insertar filas**. El target SQL vacío implementa `attempt_count`, ventanas/bloqueo, `expires_at` derivado para nuevas filas, `ROWVERSION` y purga. |

El cutover incrementa/revalida `token_version`, fuerza logout y no copia `_etag`/`ttl` como datos de negocio. `ttl` se transforma en `expires_at` solo para nuevas filas creadas después del corte.

## 20. `fuentesFormatos` y `formatosImpresion`

### Fuentes

| Campo | Destino | Regla |
|---|---|---|
| `id` | `content.print_format_sources.source_id` | Copiar; unique. |
| `nombre` | `name`, `name_normalized` | Trim/lower; unique entre no eliminados. |
| `descripcion` | exclusión aprobada | Campo legacy innecesario; conservar solo en raw restringido y no proyectar a la tabla operacional. |
| `activa`, `status` | `active`, `status` | Reconciliar; contradicción = warning que requiere regla aprobada. |
| timestamps/delete | columnas de auditoría | Parsear UTC. |

### Formatos y PDF

| Campo | Destino | Regla |
|---|---|---|
| `id` | `content.print_formats.source_id` | Copiar; unique. |
| `fuenteId` | `print_formats.print_format_source_key` | Fuente primaria de compatibilidad; lookup obligatorio. Para documentos con `fuenteIds[]`, debe coincidir con el primer elemento. |
| `fuenteIds[]` | `content.print_format_source_assignments` | Una fila ordenada y sin duplicados por fuente. Si el array no existe o está vacío, crear una fila desde `fuenteId`. Entre 1 y 50 fuentes; toda referencia debe existir. |
| `fuenteNombre`, `fuenteNombres[]` | raw + validación | Snapshots de compatibilidad; los nombres vigentes se derivan por join con `print_format_sources`. |
| `nombre`, `descripcion` | columnas homónimas | Nombre unique dentro de cada fuente asignada entre formatos no eliminados. |
| `tamanoFormato` | `format_size` | Enum; personalizado exige detalle. |
| `tamanoFormatoPersonalizado` | `custom_format_size` | Requerido solo si `format_size=personalizado`. |
| `requiereLicencia`, `licenciaModuloId` | licencia requerida/FK módulo | Si true, módulo debe existir. Nombres/códigos embebidos se comparan, no se duplican. |
| `licenciaModuloNombre`, `licenciaModuloCodigo` | raw + validación | Comparar con maestros; no duplicar como dato vigente. |
| `activo`, `status` | `active`, `status` | Reconciliar; contradicción = warning. |
| `codigoImportacion` | `legacy_import_code` | Preservar nullable; 37/37 históricos. No participa en identidad/filtros. |
| `estadoImportacion` | `legacy_import_status` | Preservar nullable; 37/37 históricos. No imponer catálogo sin evidencia funcional. |
| `variante` | `legacy_variant` | Preservar nullable; 37/37 históricos. No participa en unicidad. |
| `pdfBase64` | Azure Blob + `content.files` | Decodificar; firma `%PDF`; bytes 1..1.500.000; SHA-256. |
| `pdfNombreOriginal`, `pdfMimeType` | `content.files.original_name`, `mime_type` | MIME debe ser `application/pdf`. |
| `createdAt`, `createdBy`, `updatedAt`, `updatedBy`, `deletedAt`, `deletedBy` | auditoría/soft delete | Parsear UTC; preservar actor. |
| PDF actual | `content.print_format_files` | `version_no=1`, `is_current=1`. |

## 21. `publicDownloads`

El contenedor es polimórfico. El campo runtime `type` es obligatorio aunque no esté declarado en las interfaces TS actuales.

### `type=section`

Mapear `id`→`source_id`, `nombre`→`name/name_normalized`, `slug`→`slug/slug_normalized`, `descripcion`→`description`, `activa`→`active`, `status` y auditoría/soft delete a `content.public_download_sections`. Slug único entre no eliminadas.

### `type=document` (discriminator legacy de archivo)

| Campo | Destino | Regla |
|---|---|---|
| `id` | `content.public_download_documents.source_id` | Copiar; unique. El nombre físico se conserva por compatibilidad, aunque la entidad funcional es archivo público. |
| `sectionId` | `section_key` | Lookup section source_id; FK. `sectionName/sectionSlug` solo validan snapshot. |
| `titulo`, `slug`, `descripcion` | columnas del archivo | Slug global unique por endpoint legacy. |
| `archivoMimeType` | `asset_kind`, `content.files.mime_type` | `video/*` permitido solo para MP4/M4V/MOV/WebM y firma válida; demás extensiones aprobadas se clasifican `document`. |
| `archivoBase64` | Blob + `content.files` | Compatibilidad de cargas legacy: decodificar, validar extensión/MIME/firma y hash; documentos 1..8.000.000 bytes, videos 1..100.000.000. No llega a SQL operacional. |
| `archivoBlobContainer`, `archivoBlobName`, `archivoSha256` | `content.files` | Para cargas nuevas ya alojadas en Blob: verificar objeto/tamaño/hash y enlazar sin persistir SAS. |
| `archivoNombreOriginal`, `archivoMimeType`, `archivoBytes` | metadata `content.files` | Bytes deben coincidir con contenido real; discrepancia = error. |
| `activo`, `status` | columnas de documento | Reconciliar; `active|inactive|deleted`. |
| `sectionName`, `sectionSlug` | raw + validación | Comparar con sección; no duplicar como vigente. |
| `createdAt`, `createdBy`, `updatedAt`, `updatedBy`, `deletedAt`, `deletedBy` | auditoría/soft delete | Parsear UTC; preservar actor. |
| archivo actual | `content.public_download_files` | `version_no=1`, current. |

Registros con `type` ausente/unknown no se adivinan silenciosamente: inferencia por campos solo en staging, registrada como warning y sujeta a aprobación. Secciones siguen siendo categorías/segmentos de URL; los archivos son sus recursos descargables, por lo que no se fusionan.

## 22. Validación de round-trip de settings

La regla única está en la sección 10. El repositorio SQL debe reconstruir el mismo DTO sanitizado que `loadEmailAlertsSettings()` + `sanitizeForResponse()`:

- mismos defaults y valores efectivos;
- mismos roles/correos/días, sin duplicados ni cambios de orden observable donde la UI dependa de él;
- `smtpPasswordSecretName` nunca sale al frontend;
- `smtpPasswordConfigured` conserva semántica;
- los campos heredados se mantienen solo durante compatibilidad y se retiran mediante migración versionada.

## 23. Reconciliación de licencias duplicadas por representación

`clients.licenseModuleIds[]` y `licenseAssignments` pueden expresar la misma licencia de cliente.

1. Crear candidata por cada array de cliente con `target_type=client`.
2. Crear candidata por cada documento de asignación válido.
3. Unificar por `(module_key,target_type,client_key,domain_key,database_key,environment_id)`.
4. Si ambas existen, conservar el ID de `licenseAssignments`; registrar el array como fuente de reconciliación.
5. Si nombres/códigos snapshots no coinciden con maestro, manda el ID y se registra warning.
6. No cargar `client_license_modules` separada: la única fuente SQL será `licensing.license_assignments`.

## 24. Gestión de Implementaciones futura

No existe contenedor actual. Las tablas `implementation.*` se crean vacías o en una migración de schema posterior, según aprobación. No inventar datos desde documentos Step-by-step. La especificación es contrato futuro, no fuente productiva.

Antes de implementar el módulo se debe traducir su modelo de roles previo al catálogo granular y definir claves como `implementation.implementations.view/create/edit/...`, manteniendo separados permisos de opción y responsabilidad de etapa.

## 25. Validaciones funcionales agregadas en la revisión

| Salida | Comparación requerida |
|---|---|
| Editor de roles | Mismos permisos efectivos y visibilidad por usuario, incluido super admin. |
| Acceso a rutas/sidebar | Mismas opciones visibles por rol custom/default. |
| Acciones de tarea | Mismo resultado combinando permiso + visibilidad + asignación. |
| Sesiones | Login/refresh/logout/replay/revoke-all pasan tests sobre SQL; sesiones viejas no funcionan. |
| Formatos públicos | Mismos listados; cada PDF abre y tiene hash/nombre/MIME idénticos. |
| Descargas públicas | Mismas rutas nuevas y legacy; archivo idéntico por SHA-256. |
| Settings | Round-trip API produce DTO equivalente sin secreto. |
| Timers | No duplican correo tras migrar idempotency y reactivarse una vez. |
| Licencias | Alcance por licenciamiento idéntico después de consolidar representaciones. |
| Auditoría | Mismos conteos/filtros; ningún campo fuera de allowlist. |
