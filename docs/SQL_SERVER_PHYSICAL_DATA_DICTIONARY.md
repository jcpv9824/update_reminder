# Diccionario físico SQL Server 2019 — Portal SAG Web

Revisión: **2026-07-16**
Motor: **SQL Server 2019 Standard, compatibility 150**
Estado: **listo para generar DDL no productivo; no autoriza ejecución en producción**

Este documento convierte el modelo lógico y el mapeo canónico en un contrato físico. `docs/COSMOS_TO_SQL_MIGRATION_MATRIX.md` define la transformación fuente; este documento define tablas, claves, tipos, concurrencia e índices.

## 1. Patrones obligatorios

### Entidad migrada mutable

| Columna | Tipo/regla |
|---|---|
| `<entity>_key` | `BIGINT IDENTITY(1,1)` PK clustered. |
| `source_id` | `NVARCHAR(150) NOT NULL`, AK unique; conserva Cosmos y es el `id` de API. |
| `created_at`, `updated_at` | `DATETIME2(3)` UTC. |
| `created_by`, `updated_by` | `NVARCHAR(150)` snapshot; admite `system`. |
| `row_version` | `ROWVERSION`; obligatorio para updates optimistas. |
| soft delete | `status`, `deleted_at`, `deleted_by` cuando aplique. |

Las FK usan claves `BIGINT`, nunca `source_id`. Roles, permisos y ambientes son catálogos pequeños con PK textual estable. JSON permitido usa `NVARCHAR(MAX)` + `ISJSON`; no existe tipo JSON nativo en SQL Server 2019.

### Convenciones

- Instantes: `DATETIME2(3)` UTC; fechas de negocio: `DATE`; horas locales: `TIME(0)` + timezone `NVARCHAR(100)`.
- Emails: valor `NVARCHAR(254)` y normalizado `NVARCHAR(254)`.
- URLs/hosts: `NVARCHAR(500)`; notas: `NVARCHAR(MAX)` solo donde sea necesario.
- Hash SHA-256: `BINARY(32)`; nunca texto hexadecimal en índices.
- Estados/enums: `VARCHAR`/`NVARCHAR` corto con `CHECK`.
- Montos/decimales futuros: precisión explícita; nunca `FLOAT` para negocio.
- Todas las FK: `NO ACTION`; cascadas mediante servicios transaccionales auditados.

## 2. `security`

| Tabla | Columnas específicas y reglas |
|---|---|
| `users` | Patrón entidad; `display_name NVARCHAR(160)`, email/normalizado, `active BIT`, hashes `NVARCHAR(500)`, fechas de password/reset/login, `must_change_password BIT`, `token_version INT CHECK >=0`. Unique email normalizado. MFA legado raw-only. |
| `roles` | `role_id NVARCHAR(80)` PK; nombre, `active`, `system_role`, `protected_role`, visibilidad domain/database con checks `none|assigned|all`, auditoría, rowversion. |
| `permissions` | `permission_key NVARCHAR(160)` PK; module/option/action y labels; seed desde catálogo de código. |
| `role_permissions` | PK `(role_id,permission_key)`; ambas FK. |
| `user_roles` | PK `(user_key,role_id)`; assigned_at/by. |
| `auth_sessions` | Patrón entidad; `user_key`, refresh hash, token version, created/last-used/expires/revoked, reason, `replaced_by_session_key`, rowversion. Comienza vacía. |
| `rate_limits` | PK interna + `source_id`; scope/key_type/count/window/block/expires/update, rowversion. Comienza vacía; job de purga. |

`super_admin` se protege en servicio y procedimiento administrativo; runtime no puede reducir permisos/visibilidad ni desactivarlo.

El build siembra 89 permisos verificados contra `PERMISSION_CATALOG` y los cuatro roles de sistema actuales. Cualquier cambio del catálogo debe fallar `migration/tools/validate-permission-seed.js` hasta regenerar y revisar el seed SQL.

## 3. `core`

| Tabla | Columnas específicas y reglas |
|---|---|
| `environments` | `environment_id VARCHAR(20)` PK: `production|test|demo`. |
| `clients` | Patrón entidad; external ID, nombre/normalizado, estado, notas. Unique filtrado external ID no nulo y nombre no eliminado. |
| `domains` | Patrón entidad; `client_key`, dominio/normalizado, environment, versión web, estado/notas, last-updated snapshot. Unique dominio normalizado no eliminado. AK `(domain_key,client_key)` para coherencia jerárquica. |
| `domain_assignees` | PK `(domain_key,user_key)`; fecha/actor. |
| `database_access_profiles` | PK interna; `public_id UNIQUEIDENTIFIER`; host/puerto, catálogo, usuario SQL, nombre de secreto, fingerprint `BINARY(32)`, active, auditoría/rowversion. Vista general no expone estas columnas. |
| `databases` | Patrón entidad; `client_key`, `domain_key`, `access_profile_key`, company/normalizado, environment, versión, estado/notas, last-updated snapshot. FK compuesta valida cliente del dominio. |
| `database_assignees` | PK `(database_key,user_key)`; fecha/actor. |

La huella de conexión usa la misma normalización del runtime actual y excluye password. La unicidad aplica solo a perfiles activos: un perfil histórico de una base eliminada se conserva inactivo con su propia referencia de secreto. En el snapshot certificado esto produce 55 perfiles (50 activos y 5 históricos inactivos) sin fingerprints activos duplicados. Revelar/copiar password sigue resolviendo Key Vault y escribiendo auditoría sin valor secreto.

## 4. `licensing`

| Tabla | Columnas específicas y reglas |
|---|---|
| `license_modules` | Patrón entidad; name/code normalizados, description, status/notes. Unique filtrado name/code no eliminado. |
| `license_assignments` | Patrón entidad; `module_key`, `target_type`, client/domain/database keys nullable, environment nullable, status. CHECK exige exactamente el destino correcto. Unique filtrado por módulo/destino/ambiente. |

`clients.licenseModuleIds[]` y documentos de asignación convergen aquí. No existe una segunda tabla de licencias de cliente.

## 5. `scheduling`

| Tabla | Columnas específicas y reglas |
|---|---|
| `update_schedules` | Patrón entidad; client/domain keys, name, target/frequency, parámetros de recurrencia, fechas/timezone, roles general/domain/database, modes, origin, active/completion, notes, snapshots y soft-delete tombstone. |
| `schedule_weekdays` | PK `(schedule_key,kind,weekday)`; kind `weekly|preferred`. |
| `schedule_targets` | PK interna; unique `(schedule_key,target_type,domain_key,database_key)`; incluye `client_key`; CHECK exige una FK de destino y FKs compuestas validan que schedule/destino compartan cliente. |
| `schedule_assignees` | PK `(schedule_key,assignment_kind,user_key)`; kind `general|domain|database`. |
| `schedule_reminder_settings` | PK/FK schedule; enabled, time, recipient mode. |
| `schedule_reminder_days` | PK `(schedule_key,days_before)`, CHECK >=0. |
| `schedule_reminder_emails` | PK `(schedule_key,email_normalized)`. |
| `scope_groups` | PK interna; schedule/client, include-all-domains, unique por schedule/ordinal. |
| `scope_domains` | PK interna; group/client/domain, include-all-databases; FKs compuestas validan jerarquía. |
| `scope_databases` | PK `(scope_domain_key,database_key)` con domain/client redundantes controlados por FKs compuestas. |
| `licensing_scope` | PK/FK schedule; match mode, environment filter, target types, active-only. |
| `licensing_scope_modules` | PK `(schedule_key,module_key)`. |
| `licensing_excluded_domains` | PK `(schedule_key,domain_key)`. |
| `licensing_excluded_databases` | PK `(schedule_key,database_key)`. |

Checks de frecuencia aseguran que solo los parámetros aplicables estén presentes. Schedules referenciados se convierten en tombstone; nunca se borran físicamente.

## 6. `workflow`

| Tabla | Columnas específicas y reglas |
|---|---|
| `update_tasks` | Patrón entidad; dedupe, task date/bucket, client/domain/database keys nullable solo para histórico, source-ID snapshots, `is_historical_orphan`, target type, primary schedule source/FK nullable, assigned role, status/result/notas, completion/block/resolution/reopen y snapshots. FKs compuestas impiden combinar cliente, dominio, base o schedule incorrectos. |
| `task_assignees` | PK `(task_key,user_key)`. |
| `task_sources` | PK interna; task, `schedule_source_id NVARCHAR(150)`, schedule FK nullable, type, reason, created_at, is_primary. Unique por task/source/type. Relación autoritativa; admite schedule histórico ausente. |
| `task_source_aliases` | `alias_source_id NVARCHAR(150)` PK, task FK, original status/result/timestamps sanitizados; preserva IDs consolidados. |
| `task_status_history` | PK `BIGINT IDENTITY`; task, previous/new status, action, comment, actor snapshots, performed_at, `is_inferred`, metadata JSON. Append-only. |
| `task_reminders` | PK interna; task, type, days_before, sent_at; unique idempotente. |
| `task_reminder_recipients` | PK `(task_reminder_key,email_normalized)`. |
| `task_overdue_alerts` | PK `(task_key,sent_date)`. |

Unique de dedupe usa destino físico + fecha y conserva la misma fila para reactivar `cancelled/obsolete`. Los 32 grupos históricos se consolidan mediante aliases/history. FK ausente solo se admite para importación terminal marcada `is_historical_orphan`; runtime normal nunca puede crearla. Transición, history, maestro, audit y outbox comparten transacción.

## 7. `settings`

| Tabla | Columnas específicas y reglas |
|---|---|
| `email_settings` | Singleton con provider/from/frontend, SMTP no secreto, referencia Key Vault/flag, defaults, overdue, blocked, password-notification, auditoría/rowversion. |
| `default_reminder_days` | PK days_before. |
| `alert_recipient_roles` | PK `(alert_kind,role_id)`. |
| `alert_recipient_emails` | PK `(alert_kind,email_normalized,source_kind)`. |
| `overdue_alert_weekdays` | PK weekday. |
| `blocked_reminder_days` | PK days_after. |
| `administrative_reminders` | PK `reminder_kind`; enabled/rule/day/time/timezone/subject, rowversion. |
| `administrative_reminder_recipients` | PK `(reminder_kind,email_normalized)`. |

Updates reemplazan el agregado completo en una transacción con rowversion; el repositorio reconstruye el DTO actual.

## 8. `content`

| Tabla | Columnas específicas y reglas |
|---|---|
| `files` | `file_key BIGINT IDENTITY`, `public_id UNIQUEIDENTIFIER`, provider/container/blob, original name, MIME, bytes, SHA-256, created at/by. Inmutable; no Base64/SAS. |
| `print_format_sources` | Patrón entidad; name/normalizado y active/status. La descripción fue retirada en `016`. |
| `print_formats` | Patrón entidad; fuente primaria de compatibilidad, name/normalizado, description, size/custom size, license flag/module FK, tres `legacy_*` nullable, active/status. |
| `print_format_source_assignments` | PK `(print_format_key,print_format_source_key)`; orden único por formato; FK a formato/fuente; 1–50 fuentes y la primaria siempre incluida. Índice inverso por fuente para catálogo público. |
| `print_format_files` | PK `(print_format_key,version_no)`; file FK, is_current, created at/by; unique filtrado current. |
| `public_download_sections` | Evidencia histórica de la migración; fuera del runtime desde 025. |
| `public_download_documents` | Nombre físico legacy; representa descargas forzadas. `section_key` nullable/legacy, `asset_kind document|video`, title, slug normalizado, description, active/status. |
| `public_download_files` | PK `(document_key,version_no)`; file FK, is_current, created at/by. |
| `public_files` | Archivos visualizables inline; `asset_kind image|video|pdf`, title, slug normalizado, description, active/status, `row_version`. |
| `public_file_versions` | PK `(public_file_key,version_no)`; file FK, is_current, created at/by. |

`content.v_public_download_assets` expone descargas forzadas; `content.v_public_files` expone archivos inline. Ninguna vista persiste Base64 ni URLs firmadas.

Blob se escribe primero con clave temporal; la transacción SQL publica metadata/versión; una compensación elimina blobs huérfanos. URLs SAS nunca se persisten.

## 9. `notifications`

| Tabla | Columnas específicas y reglas |
|---|---|
| `email_notifications` | Patrón entidad; type, entity type/source ID/FK opcional, idempotency unique, period/date/subject, status, attempts, claim/expiry/next retry, attempted/sent, provider ID, error sanitizado, metadata JSON, rowversion. |
| `email_notification_recipients` | PK interna; notification, email/normalizado, to/cc/bcc, name, state/error; unique `(notification_key,type,email_normalized)`. |
| `email_notification_attempts` | PK identity; notification, attempt no, started/completed, state, provider ID/error. Append-only. |

Worker reclama filas mediante update atómico y lease. Negocio solo crea outbox; no envía correo dentro de la transacción HTTP.

## 10. `audit`

`audit_logs`: `audit_log_key BIGINT IDENTITY`, `source_id` unique, entity type/source ID, client/domain FK opcional, snapshots, action, actor/source/email, performed_at, before/after/metadata JSON, schema version y clasificación. Runtime solo `INSERT` mediante procedimiento y `SELECT` autorizado; no `UPDATE/DELETE`.

## 11. `implementation`

Se reserva el esquema, pero su DDL se versiona después del core si producto aún no activa el módulo:

- `implementations`, `implementation_assignees`, `implementation_companies`;
- `implementation_modules`, `implementation_module_users`, `implementation_decisions`;
- `implementation_steps`, `implementation_events`, `module_test_catalog`.

Todas usan clave interna + public ID; steps unique por implementación/key; events append-only. Las responsabilidades de etapa no sustituyen permisos granulares.

## 12. `migration`

| Tabla | Propósito |
|---|---|
| `schema_migrations` | versión, checksum, actor, fecha, duración y éxito. |
| `migration_runs` | snapshot/app/schema, estado, timestamps y conteos. |
| `raw_documents` | PK `(run_key,source_container,source_id)`; JSON original, SHA-256, estado/error. Acceso restringido; cifrado en reposo obligatorio. |
| `stage_*` | Una tabla por contenedor; conserva campos fuente tipados y raw hash. |
| `validation_results` | regla, severidad, esperado/real sanitizado, resolución/aprobación. |
| `reconciliation_counts` | conteos/hashes por corrida, origen y destino. |

## 13. Índices iniciales

| Caso | Índice |
|---|---|
| Login | users email_normalized unique. |
| Jerarquía | domains `(client_key,status,domain_key)`; databases `(domain_key,status,database_key)` y `(client_key,status)`. |
| Tareas | `(status,task_date,target_type,task_key)` INCLUDE claves/snapshots; assignees `(user_key,task_key)`; sources `(schedule_key,task_key)`. |
| Schedules/timers | `(active,frequency_type,start_date,end_date,schedule_key)`. |
| Outbox | `(status,next_attempt_at,notification_key)` INCLUDE claim/attempts. |
| Auditoría | `(performed_at DESC,audit_log_key DESC)`; `(entity_type,entity_source_id,performed_at DESC)`; cliente/actor/acción. |
| Contenido público | slug unique filtrado; source/active; formato/licencia. |

Revisar planes con Query Store después de cada ensayo. No agregar índices para columnas no consultadas; cada índice de escritura debe justificar una consulta real.

## 14. Crecimiento, retención y partición

- Volumen actual: 370 tareas, 2.182 auditorías y 2.890 documentos totales; no se particiona inicialmente.
- Revisar partición mensual de audit/history/attempts cuando una tabla supere 5 millones de filas, 50 GB o la ventana de mantenimiento/consulta acordada, lo que ocurra primero.
- Diseñar desde el inicio índices y claves de archivo por fecha para permitir partición futura sin cambiar contratos.
- Sesiones y rate limits se purgan por expiración. Outbox/attempts se archivan por política aprobada. Auditoría no se elimina hasta definir retención legal/operativa.
- Archivos usan lifecycle/versioning de Blob; SQL conserva metadata según la misma retención.
- Tamaño inicial recomendado para revisión del proveedor: data 512 MB, log 256 MB, autogrowth fijo 128 MB; ajustar con ensayos. Con FULL se exigen log backups y restore probado.

## 15. Aislamiento, locks y transacciones

- Habilitar `READ_COMMITTED_SNAPSHOT`; usar SNAPSHOT explícito solo en unidades que lo requieran.
- Usar rowversion en ediciones y claims; respuesta conflict ante versión obsoleta.
- Generación/timers usan `sp_getapplock` por job/ventana y constraints idempotentes.
- Lotes de importación usan `XACT_ABORT ON`, checkpoints de corrida y transacciones acotadas.
- Key Vault/Blob/email son efectos externos: outbox o saga/compensación, nunca transacción distribuida improvisada.

## 16. Principals mínimos

- `portal_migrator`: DDL/DML temporal, revocable, acceso a migration.
- `portal_runtime`: EXECUTE/DML solo en objetos autorizados; sin DDL, db_owner, raw ni UPDATE/DELETE de audit/events.
- `portal_reporting`: SELECT sobre vistas sanitizadas; sin secretos, hashes ni raw.
- `portal_dba_provider`: operación/backup/restore; no se reutiliza en runtime.

Gate C requiere generar DDL desde este contrato, construir dos bases limpias idénticas y validar permisos antes de tocar producción.
