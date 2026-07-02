# Data Architecture Discovery — Fase 1

Proyecto: **Programador de Actualizaciones ERP**  
Fecha de descubrimiento: 2026-05-16  
Objetivo: documentar el modelo actual Cosmos/TypeScript/API/UI antes de proponer o implementar una migración a base de datos relacional.  

> Regla de esta fase: **no cambiar runtime ni comportamiento de la app**. Cosmos DB sigue siendo la fuente de verdad hasta que existan propuesta relacional, matriz de migración, scripts, validaciones y plan de cutover aprobados.

## 1. Alcance inspeccionado

Archivos backend revisados:

- `api/src/types/models.ts`
- `api/src/lib/cosmos.ts`
- `api/src/lib/permissions.ts`
- `api/src/lib/audit.ts`
- `api/src/lib/keyVault.ts`
- `api/src/lib/settingsService.ts`
- `api/src/lib/emailTemplates.ts`
- `api/src/lib/emailRecipients.ts`
- `api/src/functions/reports.ts`
- `api/src/lib/taskGenerator.ts`
- `api/src/functions/*.ts`

Archivos frontend revisados:

- `frontend/src/types.ts`
- `frontend/src/api/client.ts`
- `frontend/src/pages/ClientesPage.tsx`
- `frontend/src/pages/DominiosPage.tsx`
- `frontend/src/pages/BasesDeDatosPage.tsx`
- `frontend/src/pages/FrecuenciasPage.tsx`
- `frontend/src/pages/TareasPage.tsx`
- `frontend/src/pages/AlertasCorreosPage.tsx`
- También se identificaron usos relevantes en `AuditoriaPage.tsx`, `UsuariosPage.tsx`, `LicenciamientoPage.tsx` y `DashboardPage.tsx`.

## 2. Principios de migración derivados del descubrimiento

- Preservar IDs actuales de Cosmos como claves iniciales en SQL.
- Migrar registros activos, inactivos y eliminados lógicos; no migrar solo activos.
- Preservar `status`, `deletedAt`, `deletedBy`, `createdAt`, `createdBy`, `updatedAt`, `updatedBy`.
- Preservar auditoría, tareas, cambios de estado, recordatorios enviados e idempotencia de correos.
- No migrar valores secretos. Solo migrar referencias a Key Vault (`passwordSecretName`, `smtpPasswordSecretName`).
- No resolver ni exportar contraseñas durante la migración.
- No romper `taskBucket`; hoy es partición/lógica de acceso importante para `updateTasks`.
- No convertir `scopeGroups`, `licensingScope`, `reminders` o settings complejos a texto opaco sin diseñar tablas hijas o JSON controlado.
- Separar claramente datos operativos core, seguridad, scheduling, workflow/tareas, licensing, settings, notifications, audit y migration.

## 3. Contenedores Cosmos actuales

Definidos en `api/src/lib/cosmos.ts`.

| Contenedor | Modelo principal | Partición/lectura observada | Uso principal | SQL schema propuesto | Comentarios de migración |
|---|---|---|---|---|---|
| `users` | `UserRecord` | `.item(id, id)` y queries por roles/email | Autenticación, roles, destinatarios por rol, auditoría | `security.users`, `security.user_roles` | No exponer `passwordHash` ni reset token hashes. |
| `clients` | `ClientRecord` | `.item(id, id)` | Maestro clientes, licencias por cliente, cascada | `core.clients`, `licensing.client_license_modules` | Mantener `licenseModuleIds` al inicio; normalizar luego. |
| `domains` | `DomainRecord` | `.item(id, clientId)` en escrituras; queries por `id/clientId` | Maestro dominios, tareas, reporte | `core.domains` | FK a clients. Validar URL `https://`. |
| `databases` | `DatabaseRecord` | `.item(id, clientId)` en escrituras; queries por `id/clientId/domainId` | Maestro empresas/bases, acceso SQL, tareas base | `core.databases`, `security.database_secrets` opcional | No guardar contraseña real, solo `password_secret_name`. |
| `updateSchedules` | `UpdateSchedule` | `.item(id, clientId)` | Frecuencias dominio/default, especiales, licenciamiento | `scheduling.update_schedules` + tablas scope | Normalizar `scopeGroups` y `licensingScope`. |
| `updateTasks` | `UpdateTask` | `.item(id, taskBucket)` | Tareas operativas, estados, alertas, recordatorios | `workflow.update_tasks`, `workflow.task_status_history`, `workflow.task_sources` | Preservar `taskBucket`, `dedupeKey`, `sources`, estados. |
| `licenseModules` | `LicenseModuleRecord` | `.item(id, id)` | Maestro de módulos/licencias | `licensing.license_modules` | Código opcional/autogenerado; unique por code normalizado. |
| `licenseAssignments` | `LicenseAssignmentRecord` | `.item(id, clientId)` | Asignaciones avanzadas ocultas | `licensing.license_assignments` | Reservado; UI normal usa licencias por cliente. Migrar si existe. |
| `auditLogs` | `AuditLog` | append/query paginada | Auditoría | `audit.audit_logs` o conservar temporalmente en Cosmos | Allowlist por entidad/accion. Ejecutar saneamiento historico antes de exportar o migrar. |
| `appSettings` | `EmailAlertsSettings` | `.item("email-alerts", "email-alerts")` | Configuración correo/alertas | `settings.app_settings`, tablas específicas opcionales | Puede conservar JSON controlado al inicio. |
| `emailNotifications` | docs idempotencia | `.item(id, id)` | Idempotencia recordatorios admin/bloqueos | `notifications.email_notifications` | Migrar para no duplicar correos tras cutover. |
| `securityRateLimits` | docs tecnicos con TTL | `.item(id, id)` y reemplazo por `_etag` | Rate limiting y lockout distribuido | Redis o tabla tecnica temporal | No exportar ni migrar como dato de negocio; iniciar vacio en cutover. |
| `authSessions` | `AuthSessionRecord` con TTL | `.item(id, id)`, query por `userId`, reemplazo `_etag` | Refresh rotatorio, revocacion y replay | Redis o `security.auth_sessions` | No migrar sesiones activas; cerrar sesion en cutover. Nunca contiene refresh en claro. |

## 4. Modelos y campos

### 4.1 `UserRecord` → `security.users` + `security.user_roles`

| Campo Cosmos | Tipo TS | Requerido | Uso backend | Uso frontend/API | Sensible | SQL propuesto | Notas |
|---|---:|---|---|---|---|---|---|
| `id` | string | sí | login, auditoría, asignaciones, roles | usuarios, responsables | no | `security.users.id` | Preservar ID. |
| `displayName` | string | sí | emails, auditoría | usuarios, responsables | no | `display_name` | Trim. |
| `email` | string | sí | login, recipients, auditoría | login, usuarios | moderado | `email` | Unique normalizado recomendado. |
| `roles` | string[] | sí | permisos y destinatarios por rol | UI permisos/menú | no | `security.user_roles` | Normalizar a tabla puente. |
| `active` | boolean | sí | login/listado/destinatarios | usuarios | no | `active` | No equivalente directo a `status`. |
| `createdAt`, `createdBy` | string | sí | auditoría | usuarios | no | `created_at`, `created_by` | Convertir a DATETIME2. |
| `updatedAt`, `updatedBy` | string | sí | auditoría | usuarios | no | `updated_at`, `updated_by` | Convertir a DATETIME2. |
| `lastLoginAt` | string/null | no | login | no principal | no | `last_login_at` | Preservar. |
| `passwordHash` | string | no | login | nunca | sí | `password_hash` | Migrar hash, no contraseña. |
| `passwordUpdatedAt` | string/null | no | seguridad | no | no | `password_updated_at` | Preservar. |
| `mustChangePassword` | boolean | no | auth/user flows | posible | no | `must_change_password` | Preservar. |
| `passwordExpiresAt` | string/null | no | expiración de credenciales | posible | no | `password_expires_at` | Preservar/derivar por política. |
| `tokenVersion` | number | no | revocación de sesiones | nunca | restringido | `token_version` | Preservar. |
| `mfaEnabled`, `mfaEnrolledAt` | boolean/string | no | MFA TOTP | estado en usuarios | no | `mfa_enabled`, `mfa_enrolled_at` | Preservar. |
| `mfaSecretName` | string/null | no | lookup en Key Vault | nunca | restringido | `mfa_secret_name` | Solo referencia; el secreto permanece en Key Vault. |
| `mfaLastTimeStep` | number/null | no | anti-replay TOTP | nunca | restringido | `mfa_last_time_step` | Preservar. |
| `mfaRecoveryCodeHashes` | string[] | no | recuperación MFA | nunca | sí | `security.user_mfa_recovery_codes` | Un hash por fila; nunca código plano. |
| `passwordResetTokenHash` | string/null | no | forgot/reset | nunca | sí | `password_reset_token_hash` | Hash solamente. |
| `passwordResetExpiresAt` | string/null | no | forgot/reset | nunca | sí | `password_reset_expires_at` | Preservar. |
| `passwordResetUsedAt` | string/null | no | forgot/reset | nunca | sí | `password_reset_used_at` | Preservar. |

Endpoints:

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `GET /api/me`
- `GET/POST/PUT /api/users`
- `POST /api/users/{id}/reset-password`
- `POST /api/users/{id}/deactivate`
- `POST /api/users/{id}/reactivate`
- `POST /api/setup/first-admin`
- `POST /api/setup/set-admin-password`

Dependencias:

- `permissions.ts` evalúa roles.
- `emailRecipients.ts` busca usuarios activos por roles.
- `audit.ts` usa `performedBy` y `performedByEmail`.
- `users.ts`, `auth.ts`, `setup.ts` escriben auditoría.

### 4.2 `ClientRecord` → `core.clients` + `licensing.client_license_modules`

| Campo Cosmos | Tipo TS | Requerido | Uso backend | Uso frontend/API | Sensible | SQL propuesto | Notas |
|---|---:|---|---|---|---|---|---|
| `id` | string | sí | FK lógica dominios/bases/schedules/tasks | tablas/modales | no | `core.clients.id` | Preservar. |
| `name` | string | sí | reportes, tareas, búsqueda, duplicados | tabla/formulario | no | `name` | Unique normalizado para activos/existentes. |
| `status` | active/inactive/deleted | sí | listados, cascada, reportes | UI estado | no | `status` | Mantener soft delete. |
| `notes` | string | no | auditoría/listado | formulario | no | `notes` | Trim. |
| `licenseModuleIds` | string[] | no | reportes, licensing scope | checkboxes cliente | no | `licensing.client_license_modules.module_id` | Normalizar. |
| `licenseModuleNames` | string[] | no | snapshot visual | ver dominios/bases | no | opcional snapshot | Recalcular desde módulos mejor. |
| `createdAt`, `createdBy` | string | sí | reporte/audit | UI | no | `created_at`, `created_by` | Preservar. |
| `updatedAt`, `updatedBy` | string | sí | auditoría | UI | no | `updated_at`, `updated_by` | Preservar. |
| `deletedAt`, `deletedBy` | string/null | no | soft delete | oculto | no | `deleted_at`, `deleted_by` | Migrar también deleted. |

Endpoints:

- `GET /api/clients?page&pageSize&search&status`
- `POST /api/clients`
- `GET /api/clients/{id}`
- `GET /api/clients/{id}/tree`
- `PUT /api/clients/{id}`
- `POST /api/clients/{id}/deactivate`
- `POST /api/clients/{id}/reactivate`
- `DELETE /api/clients/{id}?cascade=true`

Dependencias:

- Cascada toca `domains`, `databases`, `updateSchedules`, `updateTasks`.
- `reports.ts` carga clientes activos para reporte maestro.
- `taskGenerator.ts` filtra schedules por clientes activos.
- `licensingScope.ts` usa `licenseModuleIds` en programación por licenciamiento.
- Frontend `ClientesPage` muestra licencias, tree y acciones rápidas.

### 4.3 `DomainRecord` → `core.domains`

| Campo Cosmos | Tipo TS | Requerido | Uso backend | Uso frontend/API | Sensible | SQL propuesto | Notas |
|---|---:|---|---|---|---|---|---|
| `id` | string | sí | schedules/tasks/databases | UI navegación | no | `core.domains.id` | Preservar. |
| `clientId` | string | sí | FK lógica | filtros/formularios | no | `client_id` | FK `clients.id`. |
| `clientName` | string | sí | snapshot reportes/tareas | tabla | no | snapshot opcional | Puede recalcularse en SQL con join. |
| `domainName` | string | sí | duplicado, publish format, tareas | tabla/formulario | no | `domain_name` | Unique normalizado. Debe iniciar `https://`. |
| `environment` | string | sí | filtros/reportes/licensing preview | UI | no | `environment_id` o `environment` | Normalizar catálogo. |
| `currentWebVersion` | string | no | legado | UI mínima | no | `current_web_version` | Columna visible ya removida. |
| `assignedUpdaterIds` | string[] | sí | permisos limitados | formulario | no | `core.domain_assignees` | Normalizar tabla puente. |
| `status` | EntityStatus | sí | listados/reportes/generación | UI estado | no | `status` | Soft delete. |
| `notes` | string | no | auditoría | formulario | no | `notes` | Trim. |
| `createdAt`, `createdBy` | string | sí | auditoría | UI | no | `created_at`, `created_by` | Preservar. |
| `updatedAt`, `updatedBy` | string | sí | auditoría | UI | no | `updated_at`, `updated_by` | Preservar. |
| `deletedAt`, `deletedBy` | string/null | no | soft delete | oculto | no | `deleted_at`, `deleted_by` | Preservar. |
| `lastUpdatedAt`, `lastUpdatedBy` | string/null | no | tareas completadas actualizan dominio | tabla | no | `last_updated_at`, `last_updated_by` | Preservar. |

Endpoints:

- `GET /api/domains?page&pageSize&clientId&status&environment&search`
- `POST /api/domains`
- `GET /api/domains/{id}`
- `GET /api/domains/{id}/databases`
- `PUT /api/domains/{id}`
- `POST /api/domains/{id}/deactivate`
- `POST /api/domains/{id}/reactivate`
- `DELETE /api/domains/{id}?cascade=true`

Dependencias:

- Nuevas actualizaciones se configuran desde `updateSchedules` con `origin="special"` y alcance explícito.
- Bases cuelgan de `domainId`.
- Tareas de dominio usan `domainId`, `domainName`, `targetId`.
- Tareas de base también usan `domainId` y `domainName`.
- Frontend `DominiosPage` ya no calcula Recurrente/Próxima actualización ni crea frecuencia embebida.

### 4.4 `DatabaseRecord` → `core.databases`

| Campo Cosmos | Tipo TS | Requerido | Uso backend | Uso frontend/API | Sensible | SQL propuesto | Notas |
|---|---:|---|---|---|---|---|---|
| `id` | string | sí | tasks/schedules/access | UI | no | `core.databases.id` | Preservar. |
| `clientId` | string | sí | FK lógica | filtros/formularios | no | `client_id` | FK clients. |
| `clientName` | string | sí | snapshot | tabla/reportes | no | snapshot opcional | Recalcular con join. |
| `domainId` | string | sí | FK lógica | filtros/formularios | no | `domain_id` | FK domains. Validar client consistente. |
| `domainName` | string | sí | snapshot emails/reportes | UI | no | snapshot opcional | Recalcular. |
| `companyName` | string | sí | reportes, tarea target | UI | no | `company_name` | Trim. |
| `environment` | string | sí | filtros/licensing preview/reportes | UI | no | `environment_id` o `environment` | Normalizar catálogo. |
| `dbAccess.serverHostPort` | string | sí | access-info, correos error | modal/ver acceso | sensible técnico | `server_host_port` | No en reporte maestro. |
| `dbAccess.initialCatalog` | string | sí | tarea/reportes | visible | no | `initial_catalog` | Parte de duplicado conexión. |
| `dbAccess.userId` | string | sí | access-info, correos error | modal/ver acceso | sensible técnico | `user_id` | No en reporte maestro. |
| `dbAccess.passwordSecretName` | string | sí | Key Vault lookup | nunca listado general | sí | `password_secret_name` | No resolver secreto en migración. |
| `currentDbVersion` | string | no | legado | no visible principal | no | `current_db_version` | Preservar. |
| `assignedUpdaterIds` | string[] | sí | permisos/reveal password | formulario | no | `core.database_assignees` | Normalizar. |
| `status` | EntityStatus | sí | listados/generación/reportes | UI estado | no | `status` | Soft delete. |
| `notes` | string | no | auditoría | formulario | no | `notes` | Trim. |
| timestamps/delete/lastUpdated | string/null | sí/no | auditoría/tareas | UI | no | columnas datetime | Preservar. |

Endpoints:

- `GET /api/databases?page&pageSize&clientId&domainId&status&environment&search`
- `POST /api/databases`
- `GET /api/databases/{id}`
- `PUT /api/databases/{id}`
- `GET /api/databases/{id}/access-info`
- `POST /api/databases/{id}/copy-access-part`
- `POST /api/databases/{id}/reveal-password`
- `POST /api/databases/{id}/deactivate`
- `POST /api/databases/{id}/reactivate`
- `DELETE /api/databases/{id}?cascade=true`

Dependencias:

- `databaseService.ts` parsea `rawDbAccess`, crea `passwordSecretName` y guarda contraseña en Key Vault.
- `dbAccessParser.ts` extrae `serverHostPort`, `initialCatalog`, `userId`, `password`.
- `duplicateValidation.ts` bloquea conexión duplicada normalizada.
- `databaseAccessInfo.ts` devuelve acceso sin password.
- `TareasPage` usa `access-info` y `reveal-password` por `taskId`.
- `reportsService` no incluye server/user/password.

### 4.5 `LicenseModuleRecord` → `licensing.license_modules`

| Campo Cosmos | Tipo TS | Requerido | Uso backend | Uso frontend/API | Sensible | SQL propuesto | Notas |
|---|---:|---|---|---|---|---|---|
| `id` | string | sí | client licenses/schedules/reportes | UI | no | `license_modules.id` | Preservar. |
| `name` | string | sí | reportes, preview | UI | no | `name` | Unique recomendado por nombre normalizado. |
| `code` | string | no | duplicate/manual/autogen | UI | no | `code` | Unique cuando no null. |
| `description` | string | no | UI | UI | no | `description` | Trim. |
| `status` | EntityStatus | no | activos/reportes | UI | no | `status` | Usar status principal. |
| `active` | boolean | no | compatibilidad | UI | no | `active` o derivado | Decidir unificar con status. |
| `notes` | string | no | no principal | no | no | `notes` | Preservar. |
| timestamps/delete | string/null | no | auditoría | UI parcial | no | columnas datetime | Preservar. |

Endpoints:

- `GET /api/license-modules?page&pageSize&search&status`
- `POST /api/license-modules`
- `PUT /api/license-modules/{id}`
- `DELETE /api/license-modules/{id}`

Dependencias:

- `clients.ts` valida `licenseModuleIds`.
- `reportsService` resuelve licencias por cliente.
- `schedules.ts` valida `licensingScope.licenseModuleIds`.
- `taskGenerator.ts` expande schedules por licenciamiento.
- `LicenciamientoPage` solo muestra maestro de módulos por defecto.

### 4.6 `LicenseAssignmentRecord` → `licensing.license_assignments`

Este modelo existe y tiene endpoints, pero la decisión de producto actual es **no usar asignaciones avanzadas en la UI normal**. Las licencias principales se asignan al cliente.

| Campo Cosmos | Tipo TS | Requerido | Uso backend | Uso frontend/API | Sensible | SQL propuesto | Notas |
|---|---:|---|---|---|---|---|---|
| `id` | string | sí | CRUD oculto | tab oculta | no | `license_assignments.id` | Migrar si existe data. |
| `moduleId` | string | sí | FK módulo | UI avanzada | no | `module_id` | FK `license_modules`. |
| `clientId`, `domainId`, `databaseId` | string | depende | validaciones | UI avanzada | no | FK nullable | Reservado. |
| `targetType`, `targetId` | string | depende | compatibilidad | UI avanzada | no | `target_type`, `target_id` | Resolver a FK según tipo. |
| `environment` | string | no | filtro futuro | UI avanzada | no | `environment` | Preservar. |
| `status`, `active`, timestamps/delete | varios | no | CRUD/reportes con flag | UI avanzada | no | columnas | Preservar. |

Nota: `reportsService` solo usa asignaciones avanzadas si `ENABLE_ADVANCED_LICENSE_ASSIGNMENTS=true`.

### 4.7 `UpdateSchedule` → `scheduling.update_schedules` + tablas hijas

| Campo Cosmos | Tipo TS | Requerido | Uso backend | Uso frontend/API | Sensible | SQL propuesto | Notas |
|---|---:|---|---|---|---|---|---|
| `id` | string | sí | task generation/tasks source | UI | no | `update_schedules.id` | Preservar. |
| `clientId`, `clientName` | string | sí | filtros/generación | UI | no | `client_id`, snapshot opcional | FK client. |
| `domainId`, `domainName` | string | no | alcance explícito/tareas | UI | no | `domain_id`, snapshot opcional | FK domain nullable. |
| `targetType` | domain/database | sí | generator/preview | UI | no | `target_type` | Enum. |
| `targetIds` | string[] | sí | generator | no directo | no | `schedule_targets` | Normalizar. |
| `frequencyType` | weekly/interval/monthly/manual | sí | scheduleEngine | UI | no | `frequency_type` | Enum. |
| `everyNWeeks`, `weekdays`, `intervalDays`, `preferredWeekdays`, `dayOfMonth` | varios | según tipo | scheduleEngine | UI | no | columnas + child weekdays | Validar por tipo. |
| `startDate`, `endDate`, `timezone` | string | sí/parcial | scheduleEngine/timers | UI | no | `start_date`, `end_date`, `timezone` | Date/timezone. |
| `assignedRole`, `assignedUserIds` | string/string[] | sí | task assignment | UI responsables | no | `assigned_role`, `schedule_assignees` | Normalizar user IDs. |
| `databaseAssignedUserIds`, `databaseReminderRecipientsMode` | string[]/enum | no | herencia bases | UI | no | child table/columns | Preservar. |
| `scopeGroups` | array jerárquico | no | especiales manuales | constructor UI | no | `special_schedule_scope_groups/domains/databases` | No dejar solo JSON en SQL final. |
| `selectionMode` | manual/licensing | no | especiales | UI | no | `selection_mode` | Enum. |
| `manualTargetTypes` | domains_and_databases/domains_only/databases_only | no | especiales manuales | UI objetivo manual | no | `manual_target_types` | Define si se generan tareas de dominio, base o ambas. |
| `licensingScope` | object | no | preview/generator licencias | UI | no | `schedule_licensing_scope` | Normalizar license ids. |
| `assignmentMode`, `domainAssignedRole`, `databaseAssignedRole` | varios | no | especiales | UI | no | columns | Preservar. |
| `origin` | special/domain_default/database_inherited/licensing | no | generator/filter/report | UI | no | `origin` | `special` es el patrón nuevo; otros valores se preservan por historia/compatibilidad. |
| `active` | boolean | sí | generator/listados | UI | no | `active` | No confundir con status. |
| `reminders` | object | no | sendScheduledReminders | UI | emails | `schedule_reminder_settings` | Contiene custom emails, no secretos. |
| `notes`, timestamps | varios | no/sí | auditoría/UI | UI | no | columns | Preservar. |

Endpoints:

- `GET /api/schedules?origin&clientId&page&pageSize&search`
- `POST /api/schedules`
- `GET /api/schedules/{id}`
- `PUT /api/schedules/{id}`
- `POST /api/schedules/{id}/deactivate`
- `POST /api/schedules/{id}/reactivate`
- `DELETE /api/schedules/{id}`
- `POST /api/special-schedules/preview-licensing-scope`

Dependencias:

- `scheduleEngine.ts` calcula fechas.
- `taskGenerator.ts` expande:
  - schedules directos.
  - alcance manual explícito `scopeGroups`.
  - alcance por licenciamiento `licensingScope`.
- `sendScheduledReminders.ts` usa `reminders` de schedule o global.
- `reportsService` describe frecuencia activa por dominio.
- `TareasPage` usa `rootScheduleId` para mostrar el nombre de la actualización programada de origen.

### 4.8 `UpdateTask` → `workflow.update_tasks` + history/sources

| Campo Cosmos | Tipo TS | Requerido | Uso backend | Uso frontend/API | Sensible | SQL propuesto | Notas |
|---|---:|---|---|---|---|---|---|
| `id` | string | sí | get/update/audit | UI | no | `update_tasks.id` | Preservar. |
| `dedupeKey` | string | no | idempotencia | no | no | `dedupe_key` unique | Formato `domain:{id}:{date}`. |
| `sources` | array | no | dedupe/multiple schedules | no | no | `task_sources` | Normalizar. |
| `taskDate` | YYYY-MM-DD | sí | ventanas/timers | UI grupos | no | `task_date` | Índice crítico. |
| `taskBucket` | string | sí | partición Cosmos | no directo | no | `task_bucket` | Preservar durante transición. |
| `clientId`, `domainId`, `targetId` | string | sí | queries/permisos | UI | no | FK columns | target FK polimórfico. |
| `clientName`, `domainName`, `targetName` | string | sí | snapshots UI/emails | UI | no | snapshot columns | Preservar para historia. |
| `targetType` | domain/database | sí | permisos/UI/emails | UI | no | `target_type` | Enum. |
| `scheduleId` | string | sí | source/audit | no directo | no | `schedule_id` | FK schedule nullable si borrado. |
| `rootScheduleId` | string | no | vínculo estable a actualización programada | UI nombre de origen | no | `root_schedule_id` | Requerido para migración SQL; fallback desde `scheduleId` legado. |
| `assignedRole`, `assignedUserIds` | string/string[] | sí | permisos/destinatarios | UI | no | `assigned_role`, `task_assignees` | Normalizar users. |
| `status` | TaskStatus | sí | todo flujo | UI | no | `status` | Enum. |
| `result`, `notes` | string/null | sí | cambios estado | UI | no | columns | Trim/limitar. |
| `completedAt`, `completedBy` | string/null | sí | estado/reportes | UI | no | columns | Preserve. |
| `completedWithProblems`, `problemNote`, `completionNote` | varios | no | correos error | UI | posible sensible operativo | columns | No secretos. |
| `blockedAt`, `blockedBy`, `blockReason` | varios | no | bloqueos/reminders | UI/correos | posible sensible operativo | columns | No contraseña. |
| `resolvedAt`, `resolvedBy`, `resolutionComment` | varios | no | resolución bloqueo | UI | no | columns/history | Preserve. |
| `reopenedAt`, `reopenedBy`, `reopenReason` | varios | no | reapertura | UI | no | columns/history | Preserve. |
| `remindersSent` | array | no | idempotencia recordatorios | no | emails | `task_reminders_sent` | Normalizar. |
| `overdueAlertSentDates` | string[] | no | idempotencia vencidos | no | no | `task_overdue_alerts` | Normalizar. |

Endpoints:

- `GET /api/tasks?targetType&dateTo&range...`
- `GET /api/tasks/{id}`
- `POST /api/tasks/{id}/start` (compat backend, UI no lo usa)
- `POST /api/tasks/{id}/complete`
- `POST /api/tasks/{id}/fail`
- `POST /api/tasks/{id}/block`
- `POST /api/tasks/{id}/reopen`
- `POST /api/tasks/{id}/cancel`
- `POST /api/tasks/{id}/resolve-block`
- `POST /api/tasks/generate`
- `POST /api/tasks/refresh` existe por compatibilidad operativa/API, pero no es el flujo principal de la UI.

Dependencias críticas:

- Vencidas: `taskDate < hoy` y status abierto.
- Próximas: ventana de 4 días en frontend.
- Completadas: recientes.
- Bloqueadas: alertas inmediatas y recordatorios por `blockedAt`.
- `complete` actualiza `lastUpdatedAt/lastUpdatedBy` en dominio/base.
- `block` exige motivo para bloquear.
- `reopen` y `resolve-block` guardan metadatos de transición.
- `taskGenerator.ts` no debe crear duplicados por `targetType + targetId + taskDate`.

### 4.9 `EmailAlertsSettings` → `settings.email_alerts`

Documento único en `appSettings` con `id="email-alerts"`.

Grupos de campos:

- Proveedor/remitente: `emailProvider`, `emailFrom`, `emailFromName`, `frontendBaseUrl`.
- SMTP: `smtpHost`, `smtpPort`, `smtpSecure`, `smtpUser`, `smtpPasswordSecretName`, `smtpPasswordConfigured`.
- Recordatorios update: `remindersEnabled`, `defaultReminderDaysBefore`, `defaultReminderTime`, `defaultTimezone`.
- Vencidos: `overdueAlertsEnabled`, roles/emails, frecuencia, hora, timezone, `overdueAlertLastSentPeriod`.
- Bloqueos: `blockedAlertsEnabled`, roles/emails, recordatorios no resueltos.
- Administrativos: `administrativeReminders.sagWebVersionReminder`, `administrativeReminders.whatsNewReminder`.
- Password notifications: `passwordNotificationEnabled`, `sendTemporaryPasswordByEmail`.
- Timestamps.

SQL recomendado:

- Fase inicial: `settings.app_settings(id, settings_json, created_at, updated_at)` preservando JSON y `smtp_password_secret_name` separado.
- Fase posterior: normalizar `email_settings`, `overdue_alert_settings`, `blocked_alert_settings`, `administrative_reminder_settings`.

Seguridad:

- `smtpPasswordSecretName` no se devuelve al frontend.
- `smtpPassword` entrante se guarda en Key Vault.
- No migrar password SMTP real.

### 4.10 `AuditLog` → `audit.audit_logs`

| Campo | Uso | SQL recomendado | Notas |
|---|---|---|---|
| `id` | PK | `id` | Preservar. |
| `entityType`, `entityId` | entidad auditada | columns | Índices por entidad. |
| `clientId`, `domainId`, `companyName` | contexto | nullable columns | Facilita filtros. |
| `action` | tipo acción | column | Valores libres hoy. |
| `performedBy`, `performedByEmail` | actor | columns | FK nullable a users. |
| `performedAt` | fecha | datetime2 | Índice. |
| `before`, `after`, `metadata` | snapshots | JSON columns | Sanitizado actual omite claves sensibles. |

Importante:

- `audit.ts` elimina claves que contengan `password`, `passwordhash`, `rawDbAccess`, `secret`, `passwordPlain`, `token`, `jwt`.
- No borrar auditoría en cascadas.
- Puede mantenerse temporalmente en Cosmos por ser append-heavy, pero si se corta a SQL debe migrarse completa.

### 4.11 `emailNotifications` → `notifications.email_notifications`

Estructura observada por funciones:

- IDs como `blockedReminder:{taskId}:{daysAfter}`.
- IDs como `adminReminder:{type}:{period}:{sendDate}`.
- Campos: `id`, `type`, `taskId` o `key`, `period`, `sendDate`, `recipients`, `sentAt`, otros metadatos.

Uso:

- Idempotencia de recordatorios administrativos.
- Idempotencia de recordatorios de bloqueos no resueltos.

Migración:

- Debe migrarse antes del cutover si los timers pasan a SQL; de lo contrario se pueden duplicar correos.

## 5. Endpoints API y entidades tocadas

| Área | Endpoints | Contenedores principales | Frontend |
|---|---|---|---|
| Auth/setup | `/auth/*`, `/setup/*`, `/me` | `users`, `auditLogs` | Login/Forgot/Reset/AuthContext |
| Usuarios | `/users`, `/users/{id}`, reset/deactivate/reactivate | `users`, `auditLogs` | `UsuariosPage` |
| Clientes | `/clients`, `/clients/{id}`, `/clients/{id}/tree` | `clients`, `domains`, `databases`, `updateSchedules`, `updateTasks`, `licenseModules` | `ClientesPage` |
| Dominios | `/domains`, `/domains/{id}`, `/domains/{id}/databases` | `domains`, `databases`, `updateSchedules`, `updateTasks` | `DominiosPage` |
| Bases | `/databases`, access/copy/reveal | `databases`, `updateTasks`, Key Vault, `auditLogs` | `BasesDeDatosPage`, `TareasPage` |
| Schedules | `/schedules`, preview licensing | `updateSchedules`, `clients`, `domains`, `databases`, `licenseModules` | `FrecuenciasPage` |
| Tareas | `/tasks`, status endpoints, refresh/generate compatibilidad | `updateTasks`, `updateSchedules`, `domains`, `databases`, `clients` | `TareasPage`, `DashboardPage` |
| Licencias | `/license-modules`, `/license-assignments` | `licenseModules`, `licenseAssignments`, `clients/domains/databases` | `LicenciamientoPage`, `ClientesPage`, `FrecuenciasPage` |
| Settings/correos | `/settings/email-alerts`, test, admin reminders test | `appSettings`, Key Vault, `auditLogs` | `AlertasCorreosPage` |
| Reportes | `/reports/masters/send-email` | `clients`, `domains`, `databases`, `updateSchedules`, `licenseModules`, `licenseAssignments` | `AlertasCorreosPage` |
| Auditoría | `/audit-logs` | `auditLogs` | `AuditoriaPage` |
| Timers | task generation, scheduled reminders, overdue, blocked, administrative | varios + `emailNotifications` | no UI directa |

## 6. Reglas de negocio que la migración debe conservar

### 6.1 Integridad core

- Cliente → dominios → bases.
- Base pertenece a cliente y dominio.
- El `clientId` de base debe coincidir con el `clientId` del dominio.
- Eliminaciones de maestros son soft delete salvo algunas programaciones que pueden borrarse físicamente por patrón actual.
- Listados normales excluyen `deleted`.
- Reporte maestro solo incluye activos.

### 6.2 Duplicados y normalización

- Cliente duplicado por nombre normalizado: prohibido.
- ID de cliente de negocio (`externalId`) es opcional, pero si existe debe ser único entre clientes no eliminados.
- Dominio duplicado por URL normalizada: prohibido.
- Base duplicada por cadena de conexión normalizada: prohibido.
- URL dominio debe iniciar con `https://`.
- Ambientes permitidos para dominios/bases: `production`, `test`, `demo`.
- Emails separados por `;` deben parsearse y validarse individualmente.

### 6.3 Frecuencia y generación de tareas

- Nuevas actualizaciones se crean como `origin="special"` y usan alcance explícito.
- Una programación plana de dominio no hereda bases automáticamente.
- Actualizaciones manuales usan `scopeGroups` y `manualTargetTypes` para generar dominio/base/ambas.
- Para bases de un dominio se marca `includeAllDatabases` o se enumeran `databaseIds`.
- Programaciones por licenciamiento usan `licensingScope` y clientes activos con `licenseModuleIds`.
- `licensingScope` soporta excepciones por ID: `excludedDomainIds` y `excludedDatabaseIds`.
- Excluir dominio evita solo tarea de dominio; no excluye automáticamente bases.
- Excluir base evita solo tarea de base; no excluye dominio.
- La frecuencia especial `once` usa `startDate` como fecha de actualización. Puede generar tareas futuras dentro de la ventana operativa, pero solo se desactiva cuando `startDate <= hoy`.
- Tareas `cancelled` con `result = "obsolete"` pueden reactivarse si una programación activa las vuelve a requerir; no deben bloquear silenciosamente la visibilidad de tareas futuras.
- Actualizaciones programadas usan configuración global de recordatorios si `reminders` no está definido; si hay override, `reminderDaysBefore` viene de una lista separada por coma en UI y `reminderTime` en `HH:mm`.
- Máximo una tarea por `targetType + targetId + taskDate`.
- `sources` puede registrar múltiples orígenes.
- La vista Tareas no usa botón Refrescar como flujo operativo; la generación ocurre al guardar/reactivar actualizaciones y por timer.
- Refresh no debe cancelar vencidas abiertas antiguas.

### 6.4 Vista operativa de tareas

- Vencidas abiertas nunca desaparecen por antigüedad.
- Hoy: tareas de hoy abiertas.
- Próximas: siguientes 4 días.
- Completadas: recientes últimos 4 días.
- No acción “Iniciar” en UI.
- Bloqueada: Completar/Resolver bloqueo.
- Completada: Reabrir.

### 6.5 Licenciamiento

- Modelo principal actual: licencias asignadas al cliente completo (`clients.licenseModuleIds`).
- `licenseAssignments` queda reservado/oculto.
- Programación por licenciamiento resuelve dinámicamente clientes activos con licencias activas.
- Reporte maestro muestra licencias por cliente.

### 6.6 Secretos

- Contraseña de base se guarda en Key Vault, nunca en Cosmos/SQL.
- SQL puede almacenar `password_secret_name`, no el valor.
- SMTP password se guarda en Key Vault, no en Cosmos/SQL.
- Auditoría/reportes/correos no deben incluir passwords, tokens, JWT, raw connection strings ni secret values.

## 7. Uso frontend por entidad

| Página | Entidades leídas | Entidades escritas | Observaciones |
|---|---|---|---|
| `ClientesPage` | clients, licenseModules, client tree | clients | Licencias por cliente, cascade delete, tree dominios/bases. |
| `DominiosPage` | clients, domains paginados, domain databases | domains, database password copy endpoint | Sin frecuencia embebida; enlaza a bases y a Actualizaciones programadas. |
| `BasesDeDatosPage` | clients, domains, databases paginadas | databases | Raw connection string en formulario; no mostrar password real; sin frecuencia embebida. |
| `FrecuenciasPage` | clients, domains, databases, users, licenseModules, schedules | schedules, preview licensing | Actualizaciones programadas manuales y por licenciamiento. |
| `TareasPage` | tasks, users, schedules, database access-info | task status endpoints, reveal-password | Vista operativa, nombre de actualización por `rootScheduleId`, acceso DB con permisos. |
| `AlertasCorreosPage` | settings/email-alerts | settings, test email, master report, admin reminder test | SMTP password siempre vacío al cargar. |
| `AuditoriaPage` | auditLogs paginados, clients | ninguno | Filtros; append-only. |
| `UsuariosPage` | users paginados | users | Roles, reset password, active/inactive. |
| `LicenciamientoPage` | licenseModules, hidden assignments support | licenseModules; assignments si flag | UI normal solo módulos. |
| `DashboardPage` | tasks, clients, domains, databases | ninguno | Métricas rápidas. |

## 8. Mapa SQL inicial propuesto por entidad

| Cosmos/modelo | SQL tabla principal | Tablas hijas recomendadas | Prioridad migración | Riesgo |
|---|---|---|---|---|
| `users` | `security.users` | `security.user_roles`, `security.password_reset_tokens` opcional | media | Auth/JWT sensible. |
| `clients` | `core.clients` | `licensing.client_license_modules` | alta | Base de todo el dominio. |
| `domains` | `core.domains` | `core.domain_assignees` | alta | Frecuencias y tareas dependen. |
| `databases` | `core.databases` | `core.database_assignees` | alta | Secretos y acceso técnico. |
| `licenseModules` | `licensing.license_modules` | - | alta | Programación por licencia/reportes. |
| `licenseAssignments` | `licensing.license_assignments` | - | baja/media | Oculto, migrar si hay datos. |
| `updateSchedules` | `scheduling.update_schedules` | `schedule_targets`, `special_schedule_scope_*`, `schedule_licensing_scope`, `schedule_assignees`, `schedule_reminder_settings` | alta | Generador de tareas. |
| `updateTasks` | `workflow.update_tasks` | `task_sources`, `task_assignees`, `task_status_history`, `task_reminders_sent`, `task_overdue_alerts` | alta | Operación diaria. |
| `appSettings` | `settings.app_settings` | settings normalizadas fase 2 | media | Puede conservar JSON controlado. |
| `emailNotifications` | `notifications.email_notifications` | - | media | Idempotencia correos. |
| `auditLogs` | `audit.audit_logs` | - | media/baja | Puede quedarse temporalmente en Cosmos. |

## 9. Riesgos de migración identificados

1. **IDs/particiones**: varias escrituras usan particiones actuales (`clientId`, `taskBucket`, `id`). Al pasar a SQL, el repositorio debe conservar búsquedas por ID y comportamiento equivalente.
2. **Snapshots vs joins**: muchos documentos guardan `clientName`, `domainName`, `targetName`. SQL puede recalcular, pero para historia conviene preservar snapshots en tareas/auditoría.
3. **Arrays embebidos**: `roles`, `assignedUpdaterIds`, `assignedUserIds`, `targetIds`, `licenseModuleIds`, `remindersSent`, `overdueAlertSentDates` deben normalizarse o conservarse como JSON temporalmente con plan claro.
4. **Objetivos polimórficos**: `targetType` + `targetId` puede apuntar a dominio o base. SQL debe modelar esto con constraints, tablas separadas o validación de servicio.
5. **Actualizaciones programadas**: `scopeGroups` es jerárquico; si se deja en JSON se pierde integridad.
6. **Licenciamiento**: `licenseAssignments` existe pero está oculto. No dejar que su presencia cambie el modelo principal sin feature flag.
7. **Secretos**: `passwordSecretName` contiene referencia sensible; no debe aparecer en reportes ni auditoría. No resolver secretos durante export/migración.
8. **Idempotencia de correos**: `emailNotifications`, `remindersSent`, `overdueAlertSentDates`, `overdueAlertLastSentPeriod` evitan duplicados. Si se pierden, se puede enviar spam.
9. **Tareas vencidas antiguas**: no deben cancelarse ni excluirse por ventana de próximas.
10. **Auditoría sanitizada**: migrar `before/after/metadata` tal como existen, sin intentar rehidratar secretos.

## 10. Recomendaciones para Fase 2

Crear export/snapshot antes de diseñar scripts finales:

```text
migration/backups/cosmos-export-YYYYMMDD-HHMM/
  users.json
  clients.json
  domains.json
  databases.json
  updateSchedules.json
  updateTasks.json
  licenseModules.json
  licenseAssignments.json
  auditLogs.json
  appSettings.json
  emailNotifications.json
  manifest.json
```

El `manifest.json` debe incluir:

- Fecha/hora exportación.
- Cosmos account/database.
- Nombre de contenedor.
- Conteo.
- SHA256 por archivo.
- Script/versión usado.

No exportar valores desde Key Vault. No imprimir secretos.

## 11. Recomendaciones para Fase 3

Crear:

- `docs/RELATIONAL_MODEL_PROPOSAL.md`
- `docs/COSMOS_TO_SQL_MIGRATION_MATRIX.md`

La matriz debe ser campo por campo e incluir:

- contenedor origen
- campo origen
- tipo actual
- obligatoriedad
- transformación
- tabla SQL destino
- columna SQL destino
- FK/índice/unique
- valor por defecto si falta
- sensibilidad
- validación post-migración

## 12. Validaciones mínimas post-migración

Conteos:

- Total por contenedor/tabla.
- Activos/inactivos/deleted por entidad.
- Tareas por estado.
- Schedules activos/inactivos por origen.
- Licencias activas/inactivas.
- Audit logs total.
- Email notifications total.

Relaciones:

- Todo dominio tiene cliente.
- Toda base tiene cliente y dominio.
- Base y dominio comparten cliente.
- Toda tarea referencia cliente y target válido o conserva snapshot de histórico eliminado.
- Todo schedule target existe o está documentado como histórico.
- Todo client license module existe o queda marcado como huérfano histórico.

Business equivalence:

- Listado clientes.
- Listado dominios.
- Listado bases.
- Ver dominios y bases.
- Ver bases asociadas.
- Actualizaciones programadas manual/licensing.
- Preview por licenciamiento.
- Refresh tareas.
- Vista operativa tareas.
- Alertas vencidas.
- Alertas bloqueadas.
- Recordatorios admin.
- Reporte maestro.
- Auditoría.

## 13. Decisión pendiente para arquitectura de acceso a datos

Antes de implementar SQL runtime, agregar capa de repositorios:

```text
api/src/data/
  clientsRepository.ts
  domainsRepository.ts
  databasesRepository.ts
  schedulesRepository.ts
  tasksRepository.ts
  usersRepository.ts
  settingsRepository.ts
  auditRepository.ts

api/src/data/cosmos/
api/src/data/sql/
```

Variable recomendada:

```text
DATA_PROVIDER=cosmos
DATA_PROVIDER=sql
```

La app debe arrancar con `DATA_PROVIDER=cosmos` hasta terminar validación en staging.

## 14. Resultado de Fase 1

Este documento completa el descubrimiento inicial. La conclusión técnica es:

- El dominio actual ya es relacional.
- La migración debe conservar IDs Cosmos y soft deletes.
- Las entidades críticas para migración temprana son `clients`, `domains`, `databases`, `licenseModules`, `updateSchedules` y `updateTasks`.
- `auditLogs`, `emailNotifications` y `appSettings` pueden migrarse después o mantenerse temporalmente en Cosmos, pero deben incluirse en snapshot/validación.
- La siguiente fase no debe cambiar runtime: debe exportar datos y producir matriz detallada antes de escribir SQL de producción.
