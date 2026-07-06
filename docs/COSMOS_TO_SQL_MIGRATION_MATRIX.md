# Cosmos To SQL Migration Matrix — Fase 3

Proyecto: **Programador de Actualizaciones ERP**  
Fecha: 2026-05-16  

Esta matriz define cómo transformar los documentos actuales de Cosmos DB hacia el modelo relacional propuesto. Debe aprobarse antes de crear scripts SQL de importación o cambiar runtime.

Reglas globales:

- Copiar IDs Cosmos como IDs SQL.
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

## 2. `users` → `security`

| Source container | Source field | Target table | Target column | Transform rule | Required | Default if missing | Validation | Sensitive |
|---|---|---|---|---|---|---|---|---|
| users | id | security.users | id | copy | yes | fail | unique, not empty | no |
| users | displayName | security.users | display_name | trim | yes | fail | not empty | no |
| users | email | security.users | email | trim | yes | fail | valid email | moderate |
| users | email | security.users | email_normalized | lower(trim(email)) | yes | fail | unique | moderate |
| users | active | security.users | active | boolean | yes | true | bit | no |
| users | passwordHash | security.users | password_hash | copy hash only | no | null | never plain password | yes |
| users | passwordUpdatedAt | security.users | password_updated_at | datetime | no | null | valid datetime | no |
| users | mustChangePassword | security.users | must_change_password | boolean | no | false | bit | no |
| users | passwordExpiresAt | security.users | password_expires_at | datetime | no | derive from passwordUpdatedAt + policy | valid datetime | no |
| users | tokenVersion | security.users | token_version | integer | no | 0 | >= 0 | no |
| users | mfaEnabled, mfaSecretName, mfaEnrolledAt, mfaLastTimeStep, mfaRecoveryCodeHashes | migration.migration_raw_documents | raw_json | preserve only inside encrypted migration snapshot; do not project into operational SQL | no | omit | verify absent from `security.users` and public exports | restricted legacy |
| users | lastLoginAt | security.users | last_login_at | datetime | no | null | valid datetime | no |
| users | passwordResetTokenHash | security.users | password_reset_token_hash | copy hash only | no | null | never plain token | yes |
| users | passwordResetExpiresAt | security.users | password_reset_expires_at | datetime | no | null | valid datetime | yes |
| users | passwordResetUsedAt | security.users | password_reset_used_at | datetime | no | null | valid datetime | yes |
| users | createdAt | security.users | created_at | datetime | yes | import time with warning | valid datetime | no |
| users | createdBy | security.users | created_by | copy | yes | system with warning | FK nullable | no |
| users | updatedAt | security.users | updated_at | datetime | yes | created_at | valid datetime | no |
| users | updatedBy | security.users | updated_by | copy | yes | created_by | FK nullable | no |
| users | roles[] | security.user_roles | role_id | split_array | yes | viewer? no, fail if empty for active users | role exists | no |
| users | id | security.user_roles | user_id | copy for each role | yes | fail | FK users | no |
| users | full document | migration.raw_documents | raw_json | json | yes | fail | sha256 | may contain sensitive hashes |

## 3. `clients` → `core.clients` and licensing

| Source container | Source field | Target table | Target column | Transform rule | Required | Default if missing | Validation | Sensitive |
|---|---|---|---|---|---|---|---|---|
| clients | id | core.clients | id | copy | yes | fail | unique | no |
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
| clients | licenseModuleIds[] | licensing.client_license_modules | module_id | split_array + dedupe | no | none | module exists or validation warning | no |
| clients | id | licensing.client_license_modules | client_id | copy for each license | no | none | FK client | no |
| clients | licenseModuleNames[] | migration.raw_documents | raw_json only | preserve in raw | no | none | use modules as source of truth | no |
| clients | full document | migration.raw_documents | raw_json | json | yes | fail | sha256 | no |

## 4. `domains` → `core.domains`

| Source container | Source field | Target table | Target column | Transform rule | Required | Default if missing | Validation | Sensitive |
|---|---|---|---|---|---|---|---|---|
| domains | id | core.domains | id | copy | yes | fail | unique | no |
| domains | clientId | core.domains | client_id | copy | yes | fail | FK clients | no |
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
| domains | assignedUpdaterIds[] | core.domain_assignees | user_id | split_array + dedupe | no | none | user exists warning if missing | no |
| domains | id | core.domain_assignees | domain_id | copy for each assignee | no | none | FK domain | no |
| domains | full document | migration.raw_documents | raw_json | json | yes | fail | sha256 | no |

## 5. `databases` → `core.databases`

| Source container | Source field | Target table | Target column | Transform rule | Required | Default if missing | Validation | Sensitive |
|---|---|---|---|---|---|---|---|---|
| databases | id | core.databases | id | copy | yes | fail | unique | no |
| databases | clientId | core.databases | client_id | copy | yes | fail | FK clients | no |
| databases | clientName | core.databases | client_name_snapshot | copy | no | lookup client.name | compare warning | no |
| databases | domainId | core.databases | domain_id | copy | yes | fail | FK domains | no |
| databases | domainName | core.databases | domain_name_snapshot | copy | no | lookup domain.name | compare warning | no |
| databases | companyName | core.databases | company_name | trim | yes | fail | not empty | no |
| databases | environment | core.databases | environment_id | normalize to closed catalog | yes | domain environment? warning | must be production/test/demo | no |
| databases | dbAccess.serverHostPort | core.databases | server_host_port | trim | yes | fail | not empty | sensitive technical |
| databases | dbAccess.initialCatalog | core.databases | initial_catalog | trim | yes | fail | not empty | no |
| databases | dbAccess.userId | core.databases | user_id_sql | trim | yes | fail | not empty | sensitive technical |
| databases | dbAccess.passwordSecretName | core.databases | password_secret_name | secret_ref_only | yes | fail | never resolve | yes |
| databases | dbAccess fields | core.databases | connection_fingerprint | normalize connection without password | yes | fail | unique where not deleted | yes derived |
| databases | currentDbVersion | core.databases | current_db_version | trim | no | null | preserve | no |
| databases | status | core.databases | status | copy | yes | active | active/inactive/deleted | no |
| databases | notes | core.databases | notes | trim | no | null | preserve | no |
| databases | lastUpdatedAt | core.databases | last_updated_at | datetime | no | null | valid | no |
| databases | lastUpdatedBy | core.databases | last_updated_by | copy | no | null | FK nullable | no |
| databases | timestamps/delete | core.databases | timestamps/delete columns | datetime/copy | mixed | defaults with warning | valid | no |
| databases | assignedUpdaterIds[] | core.database_assignees | user_id | split_array + dedupe | no | none | user exists warning if missing | no |
| databases | id | core.database_assignees | database_id | copy for each assignee | no | none | FK database | no |
| databases | full document | migration.raw_documents | raw_json | json | yes | fail | sha256 | may contain secret names |

Important validation:

- `databases.clientId` must equal `domains.clientId` for `databases.domainId`.
- Do not include server/user/secret fields in master report validation output.

## 6. `licenseModules` → `licensing.license_modules`

| Source container | Source field | Target table | Target column | Transform rule | Required | Default if missing | Validation | Sensitive |
|---|---|---|---|---|---|---|---|---|
| licenseModules | id | licensing.license_modules | id | copy | yes | fail | unique | no |
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
| licenseAssignments | id | licensing.license_assignments | id | copy | yes | fail | unique | no |
| licenseAssignments | moduleId | licensing.license_assignments | module_id | copy | yes | fail | FK module | no |
| licenseAssignments | moduleName | licensing.license_assignments | module_name_snapshot | copy | no | lookup module.name | warning if mismatch | no |
| licenseAssignments | moduleCode | licensing.license_assignments | module_code_snapshot | copy | no | lookup module.code | warning if mismatch | no |
| licenseAssignments | targetType | licensing.license_assignments | target_type | copy | no | infer from databaseId/domainId/clientId | client/domain/database | no |
| licenseAssignments | targetId | licensing.license_assignments | target_id | copy | no | infer from specific id | target exists warning | no |
| licenseAssignments | clientId | licensing.license_assignments | client_id | copy | no | derive from target | FK clients nullable | no |
| licenseAssignments | domainId | licensing.license_assignments | domain_id | copy | no | null | FK domains nullable | no |
| licenseAssignments | databaseId | licensing.license_assignments | database_id | copy | no | null | FK databases nullable | no |
| licenseAssignments | environment | licensing.license_assignments | environment_id | normalize to production/test/demo/all | no | all/null | FK nullable | no |
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
| updateSchedules | id | scheduling.update_schedules | id | copy | yes | fail | unique | no |
| updateSchedules | clientId | scheduling.update_schedules | client_id | copy | yes | fail | FK clients | no |
| updateSchedules | clientName | scheduling.update_schedules | client_name_snapshot | copy | no | lookup client.name | warning if mismatch | no |
| updateSchedules | domainId | scheduling.update_schedules | domain_id | copy | no | null | FK domains nullable | no |
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
| targetIds[] | scheduling.schedule_targets | schedule_id, target_type, target_id | split_array + dedupe | target exists based on target_type or historical warning |
| weekdays[] | scheduling.schedule_weekdays | schedule_id, weekday, kind=`weekdays` | split_array | valid weekday |
| preferredWeekdays[] | scheduling.schedule_weekdays | schedule_id, weekday, kind=`preferredWeekdays` | split_array | valid weekday |
| assignedUserIds[] | scheduling.schedule_assignees | schedule_id, user_id, assignment_kind=`general` | split_array | user exists warning if missing |
| databaseAssignedUserIds[] | scheduling.schedule_assignees | schedule_id, user_id, assignment_kind=`database` | split_array | user exists warning if missing |
| reminders.remindersEnabled | scheduling.schedule_reminder_settings | reminders_enabled | copy | boolean |
| reminders.reminderTime | scheduling.schedule_reminder_settings | reminder_time | copy | HH:mm |
| reminders.reminderRecipientsMode | scheduling.schedule_reminder_settings | reminder_recipients_mode | copy | allowed |
| reminders.reminderDaysBefore[] | scheduling.schedule_reminder_days | schedule_id, days_before | split_array | integer >=0 |
| reminders.customReminderEmails[] | scheduling.schedule_reminder_custom_emails | schedule_id, email | split_array + normalize | valid email |

### 8.3 `scopeGroups`

| Source path | Target table | Target columns | Transform rule | Validation |
|---|---|---|---|---|
| scopeGroups[i] | scheduling.special_schedule_scope_groups | id, schedule_id, client_id, include_all_domains | generate deterministic id `${scheduleId}:group:${i}` | client exists |
| scopeGroups[i].domains[j] | scheduling.special_schedule_scope_domains | id, scope_group_id, domain_id, include_all_databases | generate deterministic id `${groupId}:domain:${j}` | domain belongs to client |
| scopeGroups[i].domains[j].databaseIds[k] | scheduling.special_schedule_scope_databases | scope_domain_id, database_id | split_array | database belongs to domain |

### 8.4 `licensingScope`

| Source path | Target table | Target columns | Transform rule | Validation |
|---|---|---|---|---|
| licensingScope | scheduling.schedule_licensing_scope | schedule_id, license_match_mode, environment_id, target_types, active_only | one row | licenseMatchMode any/all, targetTypes allowed |
| licensingScope.licenseModuleIds[] | scheduling.schedule_licensing_scope_modules | schedule_id, module_id | split_array + dedupe | module exists and active if activeOnly |
| licensingScope.excludedDomainIds[] | scheduling.schedule_licensing_excluded_domains | schedule_id, domain_id | split_array + dedupe | domain belongs to resolved licensing scope; excludes only domain task |
| licensingScope.excludedDatabaseIds[] | scheduling.schedule_licensing_excluded_databases | schedule_id, database_id | split_array + dedupe | database belongs to resolved licensing scope; excludes only database task |

One-time schedule rule:

- `frequencyType = once` uses `startDate` as the run date / fecha de actualización.
- Refresh can create future tasks inside the operational window, but the schedule must remain active until `startDate <= today` in the app timezone.
- After its update date is reached and processed, `active` becomes false and `completedReason` should be `one_time_schedule_executed`.
- Migration must preserve executed one-time schedules as inactive history, not convert them to recurring schedules.

## 9. `updateTasks` → `workflow`

### 9.1 Main task fields

| Source container | Source field | Target table | Target column | Transform rule | Required | Default if missing | Validation | Sensitive |
|---|---|---|---|---|---|---|---|---|
| updateTasks | id | workflow.update_tasks | id | copy | yes | fail | unique | no |
| updateTasks | dedupeKey | workflow.update_tasks | dedupe_key | copy | no | derive from targetType/targetId/taskDate | unique if possible | no |
| updateTasks | taskDate | workflow.update_tasks | task_date | date | yes | fail | valid date | no |
| updateTasks | taskBucket | workflow.update_tasks | task_bucket | copy | yes | derive | preserve | no |
| updateTasks | clientId | workflow.update_tasks | client_id | copy | yes | fail | FK client or historical placeholder | no |
| updateTasks | clientName | workflow.update_tasks | client_name_snapshot | copy | yes | lookup client.name | preserve mismatch | no |
| updateTasks | domainId | workflow.update_tasks | domain_id | copy | yes | empty allowed? warning | FK domain or historical placeholder | no |
| updateTasks | domainName | workflow.update_tasks | domain_name_snapshot | copy | yes | lookup domain.name | preserve mismatch | no |
| updateTasks | targetType | workflow.update_tasks | target_type | copy | yes | fail | domain/database | no |
| updateTasks | targetId | workflow.update_tasks | target_id | copy | yes | fail | target exists or historical warning | no |
| updateTasks | targetName | workflow.update_tasks | target_name_snapshot | copy | yes | lookup target | preserve mismatch | no |
| updateTasks | scheduleId | workflow.update_tasks | schedule_id | copy | yes | null with warning only if missing schedule | FK nullable | no |
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
| assignedUserIds[] | workflow.task_assignees | task_id, user_id | split_array + dedupe | user exists warning if missing |
| sources[] | workflow.task_sources | task_id, schedule_id, schedule_type, reason, created_at | split_array | no duplicate source rows |
| remindersSent[] | workflow.task_reminders_sent | task_id, type, days_before, sent_at, recipients_json | split_array | valid email list warning |
| overdueAlertSentDates[] | workflow.task_overdue_alerts | task_id, sent_date | split_array | valid date |

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

## 10. `appSettings` → `settings.app_settings`

| Source container | Source field | Target table | Target column | Transform rule | Required | Default if missing | Validation | Sensitive |
|---|---|---|---|---|---|---|---|---|
| appSettings | id | settings.app_settings | id | copy | yes | email-alerts | unique | no |
| appSettings | full document sanitized | settings.app_settings | settings_json | json excluding real smtpPassword if present | yes | defaults JSON | valid JSON | may contain secret names |
| appSettings | smtpPasswordSecretName | settings.app_settings | smtp_password_secret_name | secret_ref_only | no | null | never resolve | yes |
| appSettings | smtpPasswordConfigured | settings.app_settings | smtp_password_configured | boolean | no | false | bit | no |
| appSettings | createdAt | settings.app_settings | created_at | datetime | no | import time | valid | no |
| appSettings | createdBy | settings.app_settings | created_by | copy | no | system | preserve | no |
| appSettings | updatedAt | settings.app_settings | updated_at | datetime | no | created_at | valid | no |
| appSettings | updatedBy | settings.app_settings | updated_by | copy | no | created_by | preserve | no |
| appSettings | full document | migration.raw_documents | raw_json | json | yes | fail | sha256 | may contain secret names |

Explicit rule:

- If any accidental `smtpPassword` field exists in source, do not migrate value to SQL; record validation error and omit from `settings_json`.

## 11. `emailNotifications` → `notifications.email_notifications`

| Source container | Source field | Target table | Target column | Transform rule | Required | Default if missing | Validation | Sensitive |
|---|---|---|---|---|---|---|---|---|
| emailNotifications | id | notifications.email_notifications | id | copy | yes | fail | unique | no |
| emailNotifications | type | notifications.email_notifications | type | copy | no | unknown | preserve | no |
| emailNotifications | taskId/key/entityId | notifications.email_notifications | entity_id | coalesce known fields | no | null | preserve | no |
| emailNotifications | period | notifications.email_notifications | period | copy | no | null | format warning | no |
| emailNotifications | sendDate | notifications.email_notifications | send_date | date | no | null | valid date | no |
| emailNotifications | recipients | notifications.email_notifications | recipients_json | json | no | [] | valid emails warning | moderate |
| emailNotifications | sentAt | notifications.email_notifications | sent_at | datetime | no | import time | valid | no |
| emailNotifications | remaining fields | notifications.email_notifications | metadata_json | json | no | {} | valid JSON | maybe moderate |
| emailNotifications | full document | migration.raw_documents | raw_json | json | yes | fail | sha256 | maybe moderate |

## 12. `auditLogs` → `audit.audit_logs`

| Source container | Source field | Target table | Target column | Transform rule | Required | Default if missing | Validation | Sensitive |
|---|---|---|---|---|---|---|---|---|
| auditLogs | id | audit.audit_logs | id | copy | yes | fail | unique | no |
| auditLogs | entityType | audit.audit_logs | entity_type | copy | yes | unknown | preserve | no |
| auditLogs | entityId | audit.audit_logs | entity_id | copy | yes | unknown | preserve | no |
| auditLogs | clientId | audit.audit_logs | client_id | copy | no | null | FK nullable | no |
| auditLogs | clientName | audit.audit_logs | client_name | copy | no | null | snapshot | no |
| auditLogs | domainId | audit.audit_logs | domain_id | copy | no | null | FK nullable | no |
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
| Count client license rows | clients licenseModuleIds | licensing.client_license_modules | high |
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
database/sql/001_create_schemas.sql
database/sql/002_create_tables.sql
database/sql/003_create_indexes_constraints.sql
database/sql/004_create_staging_tables.sql
api/scripts/import-cosmos-snapshot-to-sql.js
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
