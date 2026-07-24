# Matriz de cobertura de datos de Portal SAG Web

Revisión: **2026-07-22**
Propósito: demostrar que cada opción, ruta y proceso del portal tiene persistencia definida en el modelo SQL objetivo.

## 1. Cobertura de opciones visibles actuales

| Módulo / opción | Ruta UI | Permiso de entrada | Datos actuales | Destino SQL | Estado |
|---|---|---|---|---|---|
| Clientes / Clientes | `/clientes` | `clients.clients.view` | `clients`, licencias embebidas | `core.clients`, `licensing.license_assignments` | Cubierto |
| Clientes / Dominios | `/dominios` | `clients.domains.view` | `domains`, responsables | `core.domains`, `core.domain_assignees` | Cubierto |
| Clientes / Bases de Datos | `/bases-de-datos` | `clients.databases.view` | `databases`, Key Vault | `core.databases`, `core.database_access_profiles`, assignees | Cubierto |
| Clientes / Licenciamiento | `/licenciamiento` | `clients.licensing.view` | `licenseModules`, `licenseAssignments`, arrays en cliente | `licensing.license_modules`, `license_assignments` reconciliada | Cubierto |
| Actualizaciones / Tareas | `/tareas` | `updates.tasks.view` + visibilidad | `updateTasks`, maestros, schedules | `workflow.*` + FK core/scheduling/security | Cubierto |
| Actualizaciones / Programar Actualizaciones | `/frecuencias` | `updates.schedules.view` | `updateSchedules` y scopes embebidos | `scheduling.*` | Cubierto |
| Implementación / Descargas Públicas | `/admin/descargas-publicas` | `implementation.public_downloads.view` | archivos document/video legacy; secciones solo históricas | `content.public_download_documents/files`; respuesta `attachment` | Cubierto |
| Implementación / Archivos Públicos | `/admin/archivos-publicos` | `implementation.public_files.view` | módulo nuevo sin origen Cosmos | `content.public_files/public_file_versions`; respuesta `inline` | Preparado en migración 025 |
| Configuración / Alertas y Correos | `/alertas-correos` | `configuration.alerts.view` | `appSettings`, `emailNotifications`, timers | `settings.*`, `notifications.*`, workflow alerts | Cubierto |
| Configuración / Usuarios y Roles | `/usuarios` | users/roles view | `users`, `roles`, sessions, Key Vault | `security.users/roles/permissions/user_roles/auth_sessions` | Cubierto |
| Configuración / Formatos de Impresión | `/admin/formatos-impresion` | `configuration.print_formats.view` | `fuentesFormatos`, `formatosImpresion` + Base64 | `content.print_format_*`, `content.files` + objeto privado | Cubierto |
| Auditoría y Visibilidad / Auditoría | `/auditoria` | `visibility.audit.view` | `auditLogs` | `audit.audit_logs` | Cubierto |
| Auditoría y Visibilidad / Tablero | `/tablero` | `visibility.dashboard.view` | agregaciones de maestros/schedules | índices y vistas sobre core/scheduling/workflow | Cubierto |
| Público / Formatos de Impresión | `/formatos-impresion` | público | fuentes/formatos activos | vistas/queries de `content` sin metadata privada | Cubierto |
| Público / Descargas | `/public/downloads/{slug}` y aliases legacy | público | archivos activos document/video | metadata SQL + objeto privado; `attachment` obligatorio | Cubierto |
| Público / Archivos | `/public/files/{slug}` | público | imágenes/PDF/videos activos | `content.v_public_files` + objeto privado; `inline` | Preparado en migración 025 |

## 2. Cobertura transversal no visible en sidebar

| Capacidad | Código/contenedor | Destino SQL | Regla crítica |
|---|---|---|---|
| Login, refresh, logout | `users`, `authSessions` | `security.users`, `auth_sessions` | Forzar login en cutover; rotación atómica. |
| Recuperación de contraseña | campos en `users` | `security.users` | Solo hashes; expiración y uso único. |
| Rate limit/lockout | `securityRateLimits` | `security.rate_limits` o Redis | No migrar estado; iniciar vacío. |
| Setup/migración de roles | `users`, `roles`, settings, schedules, tasks | tablas security + FKs | Bloquear IDs retirados aún referenciados. |
| Generación diaria/manual | schedules/core/licensing/tasks | scheduling/workflow | Dedupe, ventana, `once`, licencias, tareas obsoletas. |
| Recordatorios programados | tasks/schedules/settings/users | workflow/settings/notifications | Idempotencia por tarea/día/destinatario. |
| Alertas vencidas | tasks/schedules/settings | workflow/settings/notifications | Ignorar huérfanas y schedules inactivos. |
| Alertas/recordatorios de bloqueo | tasks/settings/emailNotifications | workflow/settings/notifications | Días posteriores e idempotencia. |
| Recordatorios administrativos | settings/emailNotifications | settings/notifications | Unique por clave/período/fecha. |
| Reporte de maestros | clients/domains/databases/schedules | vistas autorizadas | Excluir credenciales y nombres de secretos. |
| Auditoría de secretos | auditLogs | audit | Nunca almacenar valor revelado/copied. |

## 2.1 Cobertura de writers SQL

| Área | Escritura SQL | Unidad transaccional / recuperación |
|---|---|---|
| Programaciones y vista previa | CRUD, estado, targets, weekdays, responsables, recordatorios, alcance manual y licenciamiento | Hijos normalizados y auditoría en la misma transacción; reprogramación cancela tareas abiertas. |
| Generación automática/manual | Alta idempotente, sincronización de asignación, obsolescencia y cierre de `once` | Unique lógico por objetivo/fecha, historial y auditoría; reintentos no duplican. |
| Seguridad | Usuarios, roles, permisos, sesiones, login, cambio/reset y setup | Revocación de sesiones y auditoría atómicas; reset por outbox y token generado al reclamar. |
| Notificaciones | Configuración, alertas, recordatorios, pruebas y outbox | Dedupe, lease, backoff, cinco intentos y recuperación de lease vencido. |
| Descargas y archivos públicos | Agregados separados, archivos/versiones y storage privado | SQL guarda metadata/hash; `attachment` e `inline` nunca comparten endpoint. |
| Formatos de impresión | Fuentes, formatos, relación N:M, PDF/versiones y objeto privado | Cambio de fuente primaria compatible con trigger; compensación provider-aware de objeto no referenciado. |
| Cascadas core | Cliente, dominio y base, schedules, tareas y licencias dependientes | Soft-delete y cancelación de tareas de dominio/base en una sola transacción auditable. |

La implementación está local y no cambia por sí sola la fuente productiva. La migración `019` debe aplicarse antes del ensayo porque amplía el constraint del outbox para `task_status_notification` y `test_email`.

## 3. Cobertura de los 17 contenedores declarados

| Contenedor Cosmos | Persistencia objetivo | Tratamiento de cutover |
|---|---|---|
| `users` | `security.users`, `user_roles` | Migrar todo; retirar campos MFA operativos. |
| `clients` | `core.clients`, asignaciones client-level | Migrar activos/inactivos/deleted. |
| `domains` | `core.domains`, assignees | Migrar y validar cliente/ambiente/URL. |
| `databases` | `core.databases`, access profiles, assignees | Solo referencia Key Vault. |
| `updateSchedules` | `scheduling.*` | Expandir todos los objetos/arrays. |
| `updateTasks` | `workflow.*` | Preservar estados, fuentes, recordatorios y snapshots. |
| `licenseModules` | `licensing.license_modules` | Reconciliar status/active. |
| `licenseAssignments` | `licensing.license_assignments` | Reconciliar con arrays de cliente. |
| `auditLogs` | `audit.audit_logs` | Sanear antes de exportar; append-only. |
| `appSettings` | `settings.*` | Normalizar documento `email-alerts`. |
| `emailNotifications` | `notifications.*` | Migrar antes de reactivar timers. |
| `securityRateLimits` | `security.rate_limits`/Redis | No cargar registros activos; iniciar vacío. |
| `authSessions` | `security.auth_sessions` | No cargar; forzar logout. |
| `roles` | roles/permissions/task visibility | Migrar definiciones y aliases aprobados. |
| `fuentesFormatos` | `content.print_format_sources` | Migrar identidad/nombre/estado; `descripcion` legacy se excluye explícitamente. |
| `formatosImpresion` | formatos, archivos/versiones | Extraer Base64 a Blob y verificar PDF/hash. |
| `publicDownloads` | descargas document/video y versiones; secciones históricas | `type=document` se conserva como discriminator legacy; derivar `asset_kind`; Base64 legacy a storage privado. |

## 4. Capacidades especificadas pero aún no implementadas

La documentación `docs/implementaciones/*` describe una opción futura de gestión de implementaciones que todavía no aparece en `App.tsx`, `AppLayout.tsx`, `cosmos.ts` ni endpoints. Se incluye en el target para no diseñar una base obsoleta desde su nacimiento.

| Requisito futuro | Tablas reservadas |
|---|---|
| Tres casos y ciclo de vida | `implementation.implementations` |
| Responsables Ventas/Soporte/Líder | `implementation_assignees` |
| Entregables por compañía | `implementation_companies`, access profiles |
| Módulos/licencias y usuarios de módulo | `implementation_modules`, `implementation_module_users` |
| Decisiones del flujo | `implementation_decisions` |
| Checklist instanciado/versionado | `implementation_steps` |
| Timeline inmutable | `implementation_events` |
| Catálogo requiere pruebas | `module_test_catalog` |
| Correos y escalamiento | `notifications.*` + outbox/eventos |
| Siembra de maestros al cerrar | transacción hacia `core`/`licensing`/`scheduling` |

## 5. Hallazgos que la migración debe corregir, no copiar ciegamente

1. La propuesta anterior no incluía roles granulares, permisos, sesiones, rate limits, contenido público ni formatos.
2. `publicDownloads` usa un discriminator `type` en runtime que no aparece en sus tipos TypeScript; la migración debe exigir `section|document` y separar tablas.
3. Los nombres denormalizados (`clientName`, `domainName`, `sectionName`, `fuenteNombre`, módulo) son conveniencia Cosmos. SQL usa FK/joins y deja snapshots solo donde hay historia.
4. Licencias de cliente existen tanto en arrays de `clients` como en `licenseAssignments`; se requiere reconciliación y una única tabla destino.
5. Roles del backend/frontend contienen IDs heredados mientras el nuevo catálogo usa `super_admin` y `print_formats_admin`; la migración no puede insertar ambos como equivalentes sin política.
6. `rootScheduleId` es la referencia estable; IDs sintéticos de expansión no deben convertirse en FK.
7. Los Base64 de archivos no deben quedar en SQL productivo.
8. Borrados actuales mezclan soft-delete y hard-delete de schedules/roles/asignaciones. El target usa FK restrictivas y servicios transaccionales; el comportamiento exacto debe probarse antes del cutover.
9. `task_status_history` no existe como contenedor actual; se siembra desde timestamps/auditoría y desde el cutover se vuelve la fuente completa de transiciones.
10. Las especificaciones de Gestión de Implementaciones usan un modelo de roles previo. Antes de implementarlas deberán traducirse al catálogo granular `<module>.<option>.<action>`.

## 6. Evidencia revisada

- `api/src/types/models.ts`, `api/src/lib/cosmos.ts` y todas las llamadas `getContainer`.
- Funciones HTTP/timer en `api/src/functions` y lógica en `api/src/lib`.
- `frontend/src/App.tsx`, `AppLayout.tsx`, tipos, páginas y permisos.
- Tests de seguridad, permisos, tareas, scheduling, licenciamiento, formatos y recordatorios.
- `docs/PERMISSIONS_AND_TASK_VISIBILITY_DESIGN.md`.
- `docs/implementaciones/00..08` y `docs/DISENO_MODULO_IMPLEMENTACIONES.md`.
- Propuesta/matriz/solicitud SQL anteriores.

La cobertura se considera completa para el código y especificaciones presentes al 2026-07-14. Cualquier opción nueva debe agregar una fila aquí y su tabla/mapeo antes de desarrollarse.
