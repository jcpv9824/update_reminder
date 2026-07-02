# Relational Model Proposal — Fase 3

Proyecto: **Programador de Actualizaciones ERP**  
Fecha: 2026-05-16  
Destino recomendado: **Azure SQL Database**  

Este documento propone el modelo relacional objetivo para migrar desde Cosmos DB sin perder datos ni romper comportamiento actual. No es un script SQL final; es la base de diseño para crear scripts en la siguiente fase.

## 1. Decisiones arquitectónicas

### 1.1 Mantener IDs actuales

Durante la primera migración, las claves principales deben conservar los IDs actuales de Cosmos:

```text
id NVARCHAR(100) NOT NULL PRIMARY KEY
```

Razones:

- El frontend, backend, auditoría, tareas y programaciones ya referencian esos IDs.
- Reduce riesgo de romper relaciones históricas.
- Facilita rollback a Cosmos.
- Permite comparar Cosmos vs SQL por ID.

No introducir IDs enteros autoincrementales en la primera migración. Si se desean surrogate keys en el futuro, agregarlas después de estabilizar SQL.

### 1.2 Preservar soft delete

Las tablas maestras deben conservar:

```text
status NVARCHAR(30) NOT NULL
created_at DATETIME2 NULL
created_by NVARCHAR(100) NULL
updated_at DATETIME2 NULL
updated_by NVARCHAR(100) NULL
deleted_at DATETIME2 NULL
deleted_by NVARCHAR(100) NULL
```

No migrar solo activos. Los inactivos y eliminados son importantes para auditoría, tareas históricas y reportes de trazabilidad.

### 1.3 Separar schemas por dominio

Schemas recomendados:

| Schema | Propósito |
|---|---|
| `security` | Usuarios, roles, credenciales/hash y permisos. |
| `core` | Clientes, dominios, bases de datos, ambientes. |
| `licensing` | Módulos/licencias y asignación principal a clientes. |
| `scheduling` | Programaciones recurrentes/especiales y scopes. |
| `workflow` | Tareas generadas, estados, fuentes y recordatorios por tarea. |
| `settings` | Configuración global de correos/alertas. |
| `notifications` | Idempotencia y registro de notificaciones/correos. |
| `audit` | Auditoría append-only. |
| `migration` | Staging, raw documents, resultados y control de corridas. |

### 1.4 Mantener Key Vault como fuente de secretos

SQL puede guardar nombres de secretos:

- `password_secret_name`
- `smtp_password_secret_name`

SQL no debe guardar:

- Contraseña de base de datos.
- Contraseña SMTP real.
- JWT secrets.
- Tokens reales.
- Valores reales de Key Vault.

### 1.5 Usar JSON solo como transición controlada

Campos como `before`, `after`, `metadata`, settings complejos y raw Cosmos deben poder guardarse en JSON. Pero para entidades operativas clave se recomienda normalizar arrays y scopes:

- Roles de usuario.
- Asignados a dominio/base.
- `targetIds`.
- `scopeGroups`.
- `licensingScope`.
- `sources`.
- `remindersSent`.

## 2. Diagrama lógico

```text
security.users
  -> security.user_roles

core.clients
  -> core.domains
      -> core.databases

licensing.license_modules
  -> licensing.client_license_modules
  -> licensing.license_assignments (reservado avanzado)

scheduling.update_schedules
  -> scheduling.schedule_targets
  -> scheduling.special_schedule_scope_groups
      -> scheduling.special_schedule_scope_domains
          -> scheduling.special_schedule_scope_databases
  -> scheduling.schedule_licensing_scope
      -> scheduling.schedule_licensing_scope_modules
      -> scheduling.schedule_licensing_excluded_domains
      -> scheduling.schedule_licensing_excluded_databases

workflow.update_tasks
  -> workflow.task_sources
  -> workflow.task_assignees
  -> workflow.task_status_history
  -> workflow.task_reminders_sent
  -> workflow.task_overdue_alerts

settings.app_settings
notifications.email_notifications
audit.audit_logs
migration.*
```

## 3. Security schema

### 3.1 `security.users`

| Columna | Tipo recomendado | Null | Notas |
|---|---:|---|---|
| `id` | NVARCHAR(100) | no | ID Cosmos. |
| `display_name` | NVARCHAR(200) | no | `displayName`. |
| `email` | NVARCHAR(254) | no | Unique normalizado. |
| `email_normalized` | NVARCHAR(254) | no | Lower/trim. |
| `active` | BIT | no | Estado usuario. |
| `password_hash` | NVARCHAR(500) | sí | Hash actual, nunca password real. |
| `password_updated_at` | DATETIME2 | sí |  |
| `password_expires_at` | DATETIME2 | sí | Expiracion de la credencial definitiva. |
| `must_change_password` | BIT | no | Default 0. |
| `token_version` | INT | no | Revocacion global de sesiones. |
| `mfa_enabled` | BIT | no | MFA TOTP confirmado. |
| `mfa_secret_name` | NVARCHAR(200) | sí | Referencia a Key Vault; nunca el secreto. |
| `mfa_enrolled_at` | DATETIME2 | sí | Fecha de enrolamiento. |
| `mfa_last_time_step` | BIGINT | sí | Anti-replay TOTP. |
| `mfa_recovery_code_hashes_json` | NVARCHAR(MAX) | sí | Compatibilidad inicial; preferir tabla hija normalizada. |
| `last_login_at` | DATETIME2 | sí |  |
| `password_reset_token_hash` | NVARCHAR(500) | sí | Hash solamente. |
| `password_reset_expires_at` | DATETIME2 | sí |  |
| `password_reset_used_at` | DATETIME2 | sí |  |
| `created_at`, `created_by`, `updated_at`, `updated_by` | varios | sí | Preservar. |
| `legacy_cosmos_json` | NVARCHAR(MAX) | sí | Opcional temporal. |

Constraints:

- `PK_security_users(id)`
- `UQ_security_users_email_normalized(email_normalized)`
- `CK_security_users_email_not_empty`

Los codigos de recuperacion deben migrarse preferiblemente a `security.user_mfa_recovery_codes(user_id, code_hash, consumed_at, created_at)`. El secreto TOTP permanece en Key Vault y SQL conserva solo `mfa_secret_name`.

### 3.2 `security.roles`

Tabla catálogo.

| Columna | Tipo | Notas |
|---|---:|---|
| `id` | NVARCHAR(50) PK | `admin`, `client_manager`, `domain_updater`, `database_updater`, `viewer`. |
| `name_es` | NVARCHAR(100) | Etiqueta española. |
| `active` | BIT | Permite ocultar roles futuros. |

### 3.3 `security.user_roles`

| Columna | Tipo | Notas |
|---|---:|---|
| `user_id` | NVARCHAR(100) | FK users. |
| `role_id` | NVARCHAR(50) | FK roles. |
| `created_at` | DATETIME2 | Opcional. |

PK compuesta:

```text
(user_id, role_id)
```

## 4. Core schema

### 4.1 `core.environments`

Catálogo cerrado para normalizar ambiente. Desde V15 la aplicación solo permite tres ambientes operativos: `production`, `test` y `demo`. El valor `all` puede existir únicamente para filtros/configuración, no para dominios ni bases de datos.

| Columna | Tipo | Notas |
|---|---:|---|
| `id` | NVARCHAR(50) PK | `production`, `test`, `demo`; opcionalmente `all` solo para filtros/configuración. |
| `name_es` | NVARCHAR(100) | Producción, Pruebas, Demo. |
| `sort_order` | INT |  |
| `active` | BIT |  |

Si aparecen ambientes no catalogados en Cosmos durante el export, no crear nuevos ambientes operativos automáticamente. Registrarlos como anomalía de migración para revisión manual y mapearlos explícitamente a `production`, `test` o `demo` antes del cutover.

### 4.2 `core.clients`

| Columna | Tipo | Null | Notas |
|---|---:|---|---|
| `id` | NVARCHAR(100) | no | ID Cosmos. |
| `name` | NVARCHAR(200) | sí | Nombre visible; puede ser autogenerado. |
| `external_id` | NVARCHAR(100) | sí | ID de negocio del cliente. Opcional ahora; será obligatorio en una fase futura. |
| `name` | NVARCHAR(200) | no |  |
| `name_normalized` | NVARCHAR(200) | no | Para duplicados. |
| `status` | NVARCHAR(30) | no | `active`, `inactive`, `deleted`. |
| `notes` | NVARCHAR(MAX) | sí |  |
| `created_at`, `created_by`, `updated_at`, `updated_by` | varios | sí |  |
| `deleted_at`, `deleted_by` | varios | sí |  |

Constraints:

- `PK_core_clients(id)`
- `CK_core_clients_status`
- Unique filtrado recomendado: `name_normalized` donde `status <> 'deleted'`.
- Unique filtrado requerido: `external_id` donde `external_id IS NOT NULL AND status <> 'deleted'`.

### 4.3 `core.domains`

| Columna | Tipo | Null | Notas |
|---|---:|---|---|
| `id` | NVARCHAR(100) | no | ID Cosmos. |
| `client_id` | NVARCHAR(100) | no | FK clients. |
| `domain_name` | NVARCHAR(500) | no | URL completa registrada. |
| `domain_name_normalized` | NVARCHAR(500) | no | Sin slash final, lower, trim. |
| `publishable_domain` | NVARCHAR(500) | sí | Puede calcularse, opcional snapshot. |
| `environment_id` | NVARCHAR(50) | no | FK environments. |
| `current_web_version` | NVARCHAR(100) | sí | Preservar aunque no sea columna visible. |
| `status` | NVARCHAR(30) | no |  |
| `notes` | NVARCHAR(MAX) | sí |  |
| `last_updated_at`, `last_updated_by` | varios | sí | Última actualización operativa. |
| timestamps/delete | varios | sí |  |

Constraints:

- FK `client_id -> core.clients(id)`.
- FK `environment_id -> core.environments(id)`.
- Unique filtrado recomendado: `domain_name_normalized` donde `status <> 'deleted'`.
- Check: `domain_name LIKE 'https://%'`.

### 4.4 `core.domain_assignees`

| Columna | Tipo | Notas |
|---|---:|---|
| `domain_id` | NVARCHAR(100) | FK domains. |
| `user_id` | NVARCHAR(100) | FK users. |

PK: `(domain_id, user_id)`.

### 4.5 `core.databases`

| Columna | Tipo | Null | Notas |
|---|---:|---|---|
| `id` | NVARCHAR(100) | no | ID Cosmos. |
| `client_id` | NVARCHAR(100) | no | FK clients. |
| `domain_id` | NVARCHAR(100) | no | FK domains. |
| `company_name` | NVARCHAR(250) | no | Empresa. |
| `environment_id` | NVARCHAR(50) | no | FK environments. |
| `server_host_port` | NVARCHAR(500) | no | Sensible técnico, no reporte maestro. |
| `initial_catalog` | NVARCHAR(250) | no | Base de datos. |
| `user_id_sql` | NVARCHAR(250) | no | Usuario SQL, no reporte maestro. |
| `password_secret_name` | NVARCHAR(250) | no | Nombre secreto Key Vault, no valor. |
| `connection_fingerprint` | NVARCHAR(500) | no | Hash/normalización para duplicados sin password. |
| `current_db_version` | NVARCHAR(100) | sí | Preservar. |
| `status` | NVARCHAR(30) | no |  |
| `notes` | NVARCHAR(MAX) | sí |  |
| `last_updated_at`, `last_updated_by` | varios | sí |  |
| timestamps/delete | varios | sí |  |

Constraints:

- FK `client_id -> core.clients(id)`.
- FK `domain_id -> core.domains(id)`.
- FK `environment_id -> core.environments(id)`.
- Unique filtrado recomendado: `connection_fingerprint` donde `status <> 'deleted'`.

Validación extra:

- `core.databases.client_id` debe coincidir con `core.domains.client_id`. En Azure SQL se puede lograr con:
  - trigger,
  - composite FK si `domains` expone unique `(id, client_id)`,
  - o validación fuerte en repositorio.

### 4.6 `core.database_assignees`

| Columna | Tipo | Notas |
|---|---:|---|
| `database_id` | NVARCHAR(100) | FK databases. |
| `user_id` | NVARCHAR(100) | FK users. |

PK: `(database_id, user_id)`.

## 5. Licensing schema

### 5.1 `licensing.license_modules`

| Columna | Tipo | Null | Notas |
|---|---:|---|---|
| `id` | NVARCHAR(100) | no | ID Cosmos. |
| `name` | NVARCHAR(200) | no |  |
| `name_normalized` | NVARCHAR(200) | no | Para duplicados. |
| `code` | NVARCHAR(100) | sí | Opcional. |
| `code_normalized` | NVARCHAR(100) | sí | Unique cuando no null. |
| `description` | NVARCHAR(MAX) | sí |  |
| `status` | NVARCHAR(30) | no | Derivar de `status` o `active`. |
| `active_legacy` | BIT | sí | Si existe `active` en Cosmos. |
| `notes` | NVARCHAR(MAX) | sí |  |
| timestamps/delete | varios | sí |  |

Constraints:

- Unique `code_normalized` donde no null y `status <> 'deleted'`.
- Unique recomendado `name_normalized` donde `status <> 'deleted'`.

### 5.2 `licensing.client_license_modules`

Tabla principal actual para licencias compradas por cliente.

| Columna | Tipo | Notas |
|---|---:|---|
| `client_id` | NVARCHAR(100) | FK clients. |
| `module_id` | NVARCHAR(100) | FK license_modules. |
| `created_at` | DATETIME2 | Opcional si no existe en Cosmos. |
| `created_by` | NVARCHAR(100) | Opcional. |
| `source` | NVARCHAR(50) | `client.licenseModuleIds`. |

PK: `(client_id, module_id)`.

### 5.3 `licensing.license_assignments`

Reservado para asignaciones avanzadas actualmente ocultas.

| Columna | Tipo | Notas |
|---|---:|---|
| `id` | NVARCHAR(100) PK | ID Cosmos. |
| `module_id` | NVARCHAR(100) | FK license_modules. |
| `target_type` | NVARCHAR(30) | `client`, `domain`, `database`. |
| `target_id` | NVARCHAR(100) | FK lógica según tipo. |
| `client_id` | NVARCHAR(100) | FK clients nullable pero recomendado. |
| `domain_id` | NVARCHAR(100) | FK domains nullable. |
| `database_id` | NVARCHAR(100) | FK databases nullable. |
| `environment_id` | NVARCHAR(50) | Nullable. |
| `status` | NVARCHAR(30) |  |
| `active_legacy` | BIT |  |
| timestamps/delete | varios |  |

Nota: No usar esta tabla en la lógica principal hasta que se reactive explícitamente la feature avanzada.

## 6. Scheduling schema

### 6.1 `scheduling.update_schedules`

| Columna | Tipo | Null | Notas |
|---|---:|---|---|
| `id` | NVARCHAR(100) | no | ID Cosmos. |
| `client_id` | NVARCHAR(100) | no | FK clients. |
| `domain_id` | NVARCHAR(100) | sí | FK domains. |
| `target_type` | NVARCHAR(30) | no | `domain`, `database`. |
| `frequency_type` | NVARCHAR(30) | no | `once`, `weekly`, `interval`, `monthly`, `manual`. |
| `every_n_weeks` | INT | sí | Para weekly. |
| `interval_days` | INT | sí | Para interval. |
| `day_of_month` | INT | sí | Para monthly. |
| `start_date` | DATE | no |  |
| `end_date` | DATE | sí |  |
| `timezone` | NVARCHAR(100) | no | Default `America/Bogota`. |
| `assigned_role` | NVARCHAR(50) | no |  |
| `database_reminder_recipients_mode` | NVARCHAR(30) | sí |  |
| `selection_mode` | NVARCHAR(30) | sí | `manual`, `licensing`. |
| `manual_target_types` | NVARCHAR(40) | sí | `domains_and_databases`, `domains_only`, `databases_only`; default `domains_and_databases`. |
| `assignment_mode` | NVARCHAR(30) | sí | `role`, `users`. |
| `domain_assigned_role` | NVARCHAR(50) | sí |  |
| `database_assigned_role` | NVARCHAR(50) | sí |  |
| `origin` | NVARCHAR(50) | sí | `special` como patrón nuevo; preservar `domain_default`, `database_inherited` y `licensing` por historia/compatibilidad. |
| `active` | BIT | no |  |
| `completed_at` | DATETIME2 | sí | Para programaciones únicas ejecutadas. |
| `completed_reason` | NVARCHAR(100) | sí | Ej. `one_time_schedule_executed`. |
| `notes` | NVARCHAR(MAX) | sí |  |
| `client_name_snapshot` | NVARCHAR(200) | sí | Historia. |
| `domain_name_snapshot` | NVARCHAR(500) | sí | Historia. |
| timestamps | varios | sí/no |  |

Nota: la frecuencia embebida de dominios/bases fue retirada de la UI. Las nuevas actualizaciones operativas se modelan como `origin = 'special'` con alcance explícito manual o por licenciamiento.

### 6.2 `scheduling.schedule_weekdays`

| Columna | Tipo | Notas |
|---|---:|---|
| `schedule_id` | NVARCHAR(100) | FK schedules. |
| `weekday` | NVARCHAR(20) | MONDAY...SUNDAY. |
| `kind` | NVARCHAR(30) | `weekdays` o `preferredWeekdays`. |

PK: `(schedule_id, weekday, kind)`.

### 6.3 `scheduling.schedule_targets`

Normaliza `targetIds`.

| Columna | Tipo | Notas |
|---|---:|---|
| `schedule_id` | NVARCHAR(100) | FK schedules. |
| `target_type` | NVARCHAR(30) | Copia de schedule. |
| `target_id` | NVARCHAR(100) | Dominio o base. |

PK: `(schedule_id, target_type, target_id)`.

### 6.4 `scheduling.schedule_assignees`

Normaliza `assignedUserIds` y `databaseAssignedUserIds`.

| Columna | Tipo | Notas |
|---|---:|---|
| `schedule_id` | NVARCHAR(100) | FK schedules. |
| `user_id` | NVARCHAR(100) | FK users. |
| `assignment_kind` | NVARCHAR(30) | `domain`, `database`, `general`. |

PK: `(schedule_id, user_id, assignment_kind)`.

### 6.5 `scheduling.schedule_reminder_settings`

Normaliza `reminders`.

| Columna | Tipo | Notas |
|---|---:|---|
| `schedule_id` | NVARCHAR(100) PK | FK schedules. |
| `reminders_enabled` | BIT |  |
| `reminder_time` | CHAR(5) | HH:mm. |
| `reminder_recipients_mode` | NVARCHAR(30) |  |

### 6.6 `scheduling.schedule_reminder_days`

| Columna | Tipo | Notas |
|---|---:|---|
| `schedule_id` | NVARCHAR(100) | FK. |
| `days_before` | INT | 0 = mismo día. |

PK: `(schedule_id, days_before)`.

### 6.7 `scheduling.schedule_reminder_custom_emails`

| Columna | Tipo | Notas |
|---|---:|---|
| `schedule_id` | NVARCHAR(100) | FK. |
| `email` | NVARCHAR(254) | Normalizado. |

PK: `(schedule_id, email)`.

### 6.8 Special schedule scope tables

Normalizan `scopeGroups`.

`scheduling.special_schedule_scope_groups`

| Columna | Tipo | Notas |
|---|---:|---|
| `id` | NVARCHAR(100) PK | Generar durante migración. |
| `schedule_id` | NVARCHAR(100) | FK schedules. |
| `client_id` | NVARCHAR(100) | FK clients. |
| `include_all_domains` | BIT |  |

`scheduling.special_schedule_scope_domains`

| Columna | Tipo | Notas |
|---|---:|---|
| `id` | NVARCHAR(100) PK | Generar durante migración. |
| `scope_group_id` | NVARCHAR(100) | FK scope_groups. |
| `domain_id` | NVARCHAR(100) | FK domains. |
| `include_all_databases` | BIT |  |

`scheduling.special_schedule_scope_databases`

| Columna | Tipo | Notas |
|---|---:|---|
| `scope_domain_id` | NVARCHAR(100) | FK scope_domains. |
| `database_id` | NVARCHAR(100) | FK databases. |

PK: `(scope_domain_id, database_id)`.

### 6.9 Licensing schedule scope

`scheduling.schedule_licensing_scope`

| Columna | Tipo | Notas |
|---|---:|---|
| `schedule_id` | NVARCHAR(100) PK | FK schedules. |
| `license_match_mode` | NVARCHAR(20) | `any`, `all`. |
| `environment_id` | NVARCHAR(50) | `all` o ambiente. |
| `target_types` | NVARCHAR(40) | `domains_and_databases`, etc. |
| `active_only` | BIT | Debe ser true por defecto. |

`scheduling.schedule_licensing_scope_modules`

| Columna | Tipo | Notas |
|---|---:|---|
| `schedule_id` | NVARCHAR(100) | FK. |
| `module_id` | NVARCHAR(100) | FK license_modules. |

PK: `(schedule_id, module_id)`.

`scheduling.schedule_licensing_excluded_domains`

| Columna | Tipo | Notas |
|---|---:|---|
| `schedule_id` | NVARCHAR(100) | FK. |
| `domain_id` | NVARCHAR(100) | FK domains. Excluye solo la tarea de dominio. |

PK: `(schedule_id, domain_id)`.

`scheduling.schedule_licensing_excluded_databases`

| Columna | Tipo | Notas |
|---|---:|---|
| `schedule_id` | NVARCHAR(100) | FK. |
| `database_id` | NVARCHAR(100) | FK databases. Excluye solo la tarea de base. |

PK: `(schedule_id, database_id)`.

Reglas importantes:

- Excluir un dominio no excluye automáticamente sus bases.
- Excluir una base no excluye el dominio.
- Las excepciones se revalidan contra el preview vigente antes de guardar.
- El modo manual no incorpora filtro de ambiente.
- El modo manual sí incorpora `manual_target_types`: puede generar dominios y bases, solo dominios o solo bases. En `databases_only` las bases se seleccionan directamente desde el cliente, pero se almacenan agrupadas por dominio para preservar integridad.
- El modo **Todos los clientes activos** está cancelado y no debe modelarse por ahora.

## 7. Workflow schema

### 7.1 `workflow.update_tasks`

| Columna | Tipo | Null | Notas |
|---|---:|---|---|
| `id` | NVARCHAR(150) | no | ID Cosmos. |
| `dedupe_key` | NVARCHAR(250) | sí | Unique recomendado. |
| `task_date` | DATE | no |  |
| `task_bucket` | NVARCHAR(80) | no | Preservar compatibilidad. |
| `client_id` | NVARCHAR(100) | no | FK nullable en caso histórico no encontrado? recomendado FK con staging limpio. |
| `domain_id` | NVARCHAR(100) | no | FK nullable si histórico eliminado no migrado, pero debe migrarse. |
| `target_type` | NVARCHAR(30) | no | domain/database. |
| `target_id` | NVARCHAR(100) | no | FK lógica según target. |
| `schedule_id` | NVARCHAR(100) | no | FK schedules, nullable si schedule fue hard-deleted; preferir migrar raw. |
| `root_schedule_id` | NVARCHAR(100) | sí | FK a la actualización programada original. Si falta en Cosmos legado, derivar desde `schedule_id`. |
| `assigned_role` | NVARCHAR(50) | no |  |
| `status` | NVARCHAR(30) | no | pending/in_progress/completed/failed/blocked/cancelled/reopened. |
| `result` | NVARCHAR(200) | sí |  |
| `notes` | NVARCHAR(MAX) | sí |  |
| `completed_at`, `completed_by` | varios | sí |  |
| `completed_with_problems` | BIT | no | Default 0. |
| `problem_note`, `completion_note` | NVARCHAR(MAX) | sí |  |
| `blocked_at`, `blocked_by`, `block_reason` | varios | sí |  |
| `resolved_at`, `resolved_by`, `resolution_comment` | varios | sí |  |
| `reopened_at`, `reopened_by`, `reopen_reason` | varios | sí |  |
| `client_name_snapshot`, `domain_name_snapshot`, `target_name_snapshot` | NVARCHAR | sí/no | Preservar historia. |
| timestamps | varios | sí/no |  |

Índices recomendados:

- `(task_date, target_type, status)`
- `(target_type, target_id, task_date)` unique filtrado o full unique según regla.
- `(assigned_role, status, task_date)`
- `(client_id, task_date)`
- `(domain_id, task_date)`
- `dedupe_key` unique donde no null.

Reglas operativas críticas:

- La deduplicación principal es `target_type + target_id + task_date`.
- Una tarea `completed` para la misma entidad y fecha bloquea duplicados.
- Una tarea `cancelled` con `result = 'obsolete'` no debe bloquear la recuperación si una programación activa vuelve a requerirla; el generador actual la reactiva como `pending`.
- Una programación `once` puede generar tareas futuras dentro de la ventana operativa, pero solo se marca inactiva/completada cuando `start_date <= hoy` en la zona de la aplicación.

### 7.2 `workflow.task_assignees`

| Columna | Tipo | Notas |
|---|---:|---|
| `task_id` | NVARCHAR(150) | FK tasks. |
| `user_id` | NVARCHAR(100) | FK users. |

PK: `(task_id, user_id)`.

### 7.3 `workflow.task_sources`

Normaliza `sources`.

| Columna | Tipo | Notas |
|---|---:|---|
| `task_id` | NVARCHAR(150) | FK tasks. |
| `schedule_id` | NVARCHAR(100) | FK schedules, nullable si histórico. |
| `schedule_type` | NVARCHAR(30) | normal/special/licensing/manual. |
| `reason` | NVARCHAR(500) | nullable. |
| `created_at` | DATETIME2 |  |

PK recomendado: `(task_id, schedule_id, schedule_type)`.

### 7.4 `workflow.task_status_history`

Tabla recomendada para estado transaccional futuro. La migración inicial puede crear una fila de estado inicial por tarea y filas derivadas si existen timestamps.

| Columna | Tipo | Notas |
|---|---:|---|
| `id` | NVARCHAR(150) PK | Generar. |
| `task_id` | NVARCHAR(150) | FK tasks. |
| `previous_status` | NVARCHAR(30) | nullable. |
| `new_status` | NVARCHAR(30) |  |
| `action` | NVARCHAR(100) | task_completed, task_blocked, etc. |
| `comment` | NVARCHAR(MAX) | Nota/motivo. |
| `performed_by` | NVARCHAR(100) | FK users nullable. |
| `performed_at` | DATETIME2 |  |
| `metadata_json` | NVARCHAR(MAX) | Opcional. |

### 7.5 Reminder/idempotency task tables

`workflow.task_reminders_sent`

| Columna | Tipo |
|---|---:|
| `task_id` | NVARCHAR(150) |
| `type` | NVARCHAR(30) |
| `days_before` | INT |
| `sent_at` | DATETIME2 |
| `recipients_json` | NVARCHAR(MAX) |

`workflow.task_overdue_alerts`

| Columna | Tipo |
|---|---:|
| `task_id` | NVARCHAR(150) |
| `sent_date` | DATE |

## 8. Settings schema

### 8.1 Fase inicial recomendada: `settings.app_settings`

| Columna | Tipo | Notas |
|---|---:|---|
| `id` | NVARCHAR(100) PK | `email-alerts`. |
| `settings_json` | NVARCHAR(MAX) | Documento completo sanitizado. |
| `smtp_password_secret_name` | NVARCHAR(250) | Si existe. |
| `smtp_password_configured` | BIT |  |
| `created_at`, `created_by`, `updated_at`, `updated_by` | varios |  |

Razón: settings cambia más rápido que el core y es documento complejo. Puede normalizarse después.

### 8.2 Fase posterior

Normalizar:

- `settings.email_provider_settings`
- `settings.overdue_alert_settings`
- `settings.blocked_alert_settings`
- `settings.administrative_reminder_settings`
- `settings.update_reminder_defaults`

## 9. Notifications schema

### 9.1 `notifications.email_notifications`

| Columna | Tipo | Notas |
|---|---:|---|
| `id` | NVARCHAR(250) PK | Ej: `blockedReminder:{taskId}:{daysAfter}`. |
| `type` | NVARCHAR(100) | administrative_reminder, blocked_task_reminder, etc. |
| `entity_type` | NVARCHAR(100) | nullable. |
| `entity_id` | NVARCHAR(150) | nullable. |
| `period` | NVARCHAR(20) | nullable. |
| `send_date` | DATE | nullable. |
| `recipients_json` | NVARCHAR(MAX) | emails enviados. |
| `metadata_json` | NVARCHAR(MAX) | resto del documento. |
| `sent_at` | DATETIME2 |  |

Índices:

- `(type, period, send_date)`
- `(entity_id, type)`

## 10. Audit schema

### 10.1 `audit.audit_logs`

| Columna | Tipo | Notas |
|---|---:|---|
| `id` | NVARCHAR(150) PK | ID Cosmos. |
| `entity_type` | NVARCHAR(100) |  |
| `entity_id` | NVARCHAR(150) |  |
| `client_id` | NVARCHAR(100) | nullable. |
| `client_name` | NVARCHAR(200) | snapshot. |
| `domain_id` | NVARCHAR(100) | nullable. |
| `domain_name` | NVARCHAR(500) | snapshot. |
| `company_name` | NVARCHAR(250) | nullable. |
| `action` | NVARCHAR(150) |  |
| `performed_by` | NVARCHAR(100) | FK users nullable. |
| `performed_by_email` | NVARCHAR(254) | snapshot. |
| `performed_at` | DATETIME2 |  |
| `before_json` | NVARCHAR(MAX) | Sanitizado actual. |
| `after_json` | NVARCHAR(MAX) | Sanitizado actual. |
| `metadata_json` | NVARCHAR(MAX) | Sanitizado actual. |

Índices:

- `(performed_at DESC)`
- `(entity_type, entity_id, performed_at DESC)`
- `(client_id, performed_at DESC)`
- `(action, performed_at DESC)`

## 11. Migration schema

### 11.1 `migration.migration_runs`

| Columna | Tipo |
|---|---:|
| `id` | UNIQUEIDENTIFIER PK |
| `started_at` | DATETIME2 |
| `completed_at` | DATETIME2 NULL |
| `source_cosmos_account` | NVARCHAR(200) |
| `source_cosmos_database` | NVARCHAR(200) |
| `source_export_path` | NVARCHAR(1000) |
| `target_sql_database` | NVARCHAR(200) |
| `status` | NVARCHAR(50) |
| `notes` | NVARCHAR(MAX) |

### 11.2 `migration.raw_documents`

| Columna | Tipo |
|---|---:|
| `migration_run_id` | UNIQUEIDENTIFIER |
| `source_container` | NVARCHAR(100) |
| `source_id` | NVARCHAR(150) |
| `raw_json` | NVARCHAR(MAX) |
| `sha256` | CHAR(64) |
| `migrated_at` | DATETIME2 |
| `migration_status` | NVARCHAR(50) |
| `error_message` | NVARCHAR(MAX) NULL |

PK: `(migration_run_id, source_container, source_id)`.

### 11.3 Staging tables

Crear staging con columnas cercanas a Cosmos antes de normalizar:

- `migration.stage_users`
- `migration.stage_clients`
- `migration.stage_domains`
- `migration.stage_databases`
- `migration.stage_license_modules`
- `migration.stage_license_assignments`
- `migration.stage_update_schedules`
- `migration.stage_update_tasks`
- `migration.stage_app_settings`
- `migration.stage_email_notifications`
- `migration.stage_audit_logs`

### 11.4 Validation results

`migration.validation_results`

| Columna | Tipo |
|---|---:|
| `id` | UNIQUEIDENTIFIER PK |
| `migration_run_id` | UNIQUEIDENTIFIER |
| `validation_name` | NVARCHAR(200) |
| `severity` | NVARCHAR(30) |
| `status` | NVARCHAR(30) |
| `expected_value` | NVARCHAR(MAX) |
| `actual_value` | NVARCHAR(MAX) |
| `details_json` | NVARCHAR(MAX) |
| `created_at` | DATETIME2 |

## 12. Reglas de constraints importantes

### 12.1 Estados permitidos

`status` de maestros:

```text
active, inactive, deleted
```

`workflow.update_tasks.status`:

```text
pending, in_progress, completed, failed, blocked, cancelled, reopened
```

### 12.2 Dedupe de tareas

Regla:

```text
target_type + target_id + task_date = único
```

Recomendación:

- Unique index completo para todos los estados en primera migración, si los datos actuales cumplen.
- Si hay históricos duplicados, documentar y resolver en staging antes de crear unique.

### 12.3 No romper históricos

Para tareas/auditoría históricas que referencien maestros eliminados:

- Migrar los maestros eliminados.
- Mantener FK si es posible.
- Si falta un maestro por corrupción histórica, registrar en `migration.validation_results` y decidir si crear placeholder con `status='deleted'`.

## 13. Orden de implementación recomendado

1. Crear schemas y catálogos: `security.roles`, `core.environments`.
2. Crear tablas core sin FKs estrictas temporales o con FKs después del staging.
3. Cargar staging desde JSON.
4. Cargar `security.users` y roles.
5. Cargar `core.clients`, `core.domains`, `core.databases`.
6. Cargar `licensing.license_modules`, `client_license_modules`, `license_assignments`.
7. Cargar `scheduling.update_schedules` y tablas hijas.
8. Cargar `workflow.update_tasks` y tablas hijas.
9. Cargar `settings`, `notifications`, `audit`.
10. Ejecutar validaciones.
11. Agregar/validar FKs e índices unique.
12. Repetir con snapshot nuevo hasta cero errores críticos.

## 14. Decisiones pendientes antes de SQL scripts

| Decisión | Opción recomendada | Motivo |
|---|---|---|
| ¿Usar Azure SQL o PostgreSQL? | Azure SQL | Integración Azure y operación actual. |
| ¿IDs string o integer? | String IDs Cosmos | Menor riesgo. |
| ¿Settings JSON o normalizado? | JSON en fase inicial | Reduce riesgo y cambio de forma. |
| ¿Auditoría en SQL desde día 1? | Migrar si se corta todo; puede quedar temporal en Cosmos | Append-heavy, bajo acoplamiento operativo. |
| ¿emailNotifications en SQL? | Sí antes de activar timers SQL | Evita correos duplicados. |
| ¿securityRateLimits en SQL? | No como dato migrado | Es estado efimero; recrear el control con Redis o tabla tecnica con expiracion y operaciones atomicas. |
| ¿authSessions en SQL? | Recrear, no migrar sesiones activas | Tabla tecnica/Redis con indice por usuario, expiracion, hash y rotacion atomica. Forzar login tras cutover. |
| ¿auditLogs se copian sin transformar? | No | Ejecutar allowlist SEC-009 antes del snapshot/import; SQL debe aceptar solo DTO de auditoria clasificado, nunca cuerpos arbitrarios. |
| ¿licenseAssignments se usa? | No en lógica principal | Feature avanzada oculta. |
| ¿FK estrictas desde el inicio? | Después de staging/validación | Evita bloquear por datos históricos hasta diagnosticar. |

## 15. Entregable siguiente

Crear `database/sql/001_initial_schema.sql` basado en este documento, más scripts de staging/import. Antes de eso, completar y aprobar `COSMOS_TO_SQL_MIGRATION_MATRIX.md`.
