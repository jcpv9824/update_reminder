# Plan agregado de transformación operacional — snapshot 2026-07-16

Estado: **listo para implementar y ensayar la carga final en no-producción**.

Este informe se genera a partir del snapshot restringido mediante `migration/tools/plan-operational-transform.js`. Contiene solo conteos y decisiones; no contiene IDs, nombres, correos, hashes de documentos, nombres de secretos ni valores productivos. La ejecución fue completamente local: no abrió conexiones SQL ni Blob y no modificó producción.

## Resultado

- 17 contenedores y 2.890 documentos fuente verificados.
- 0 condiciones críticas de transformación.
- 42 controles semánticos: 0 críticos y 462 warnings deterministas sujetos a aceptación antes de cargar no-producción.
- 370 documentos de tareas se consolidan en 338 tareas lógicas y 32 aliases.
- 39 archivos válidos, 968.128 bytes en total, se planifican para Blob privado.
- `authSessions` y `securityRateLimits` no producen filas operativas; el cutover comienza con ambos almacenes vacíos.
- Ningún valor de secreto se resuelve y ningún Base64 se almacena en tablas operativas.

## Conteos operativos esperados principales

| Área | Tabla / conjunto | Filas esperadas |
|---|---|---:|
| Seguridad | `security.users` | 7 |
| Seguridad | `security.roles` | 6 |
| Seguridad | `security.permissions` | 89 |
| Seguridad | `security.role_permissions` | 157 |
| Seguridad | `security.user_roles` | 8 |
| Core | `core.clients` | 40 |
| Core | `core.domains` | 45 |
| Core | `core.databases` | 55 |
| Core | `core.database_access_profiles` | 55 |
| Licencias | `licensing.license_modules` | 21 |
| Licencias | `licensing.license_assignments` | 55 |
| Programación | `scheduling.update_schedules` | 10 |
| Programación | targets / assignees / weekdays | 6 / 6 / 7 |
| Programación | reminder settings / days / emails | 6 / 12 / 0 |
| Programación | scope groups / domains / databases | 2 / 2 / 2 |
| Programación | licensing scope / modules / exclusions | 2 / 2 / 4 |
| Workflow | `workflow.update_tasks` | 338 |
| Workflow | `workflow.task_source_aliases` | 32 |
| Workflow | `workflow.task_sources` | 330 |
| Workflow | `workflow.task_assignees` | 61 |
| Workflow | `workflow.task_status_history` | 517 |
| Workflow | reminders / recipients | 262 / 262 |
| Workflow | `workflow.task_overdue_alerts` | 1.694 |
| Settings | email singleton / administrative reminders | 1 / 2 |
| Notificaciones | notifications / recipients | 6 / 6 |
| Contenido | sources / formats / format files | 13 / 37 / 37 |
| Contenido | public sections / documents / files | 2 / 2 / 2 |
| Contenido | `content.files` | 39 |
| Auditoría | `audit.audit_logs` | 2.182 |

## Decisiones deterministas

1. Las 32 colisiones de tarea son migrables: se conserva la fila no `cancelled/obsolete`; el ID supersedido queda en `task_source_aliases` y su estado se representa en history inferido.
2. Cuatro tareas lógicas históricas conservan snapshots y FKs nullable mediante `is_historical_orphan=1`; no existen huérfanas activas después de consolidar.
3. Las referencias de schedules históricos ausentes conservan el source ID sin crear schedules ficticios.
4. Las 55 licencias embebidas en clientes se convierten en la única representación `license_assignments`; el contenedor explícito está vacío en este snapshot.
5. Un usuario activo tiene cero roles. Se conserva con cero filas `user_roles`, manteniendo el comportamiento deny-all actual; no se inventa `viewer` ni otro rol implícito.
6. Los 39 archivos mantienen linaje uno-a-uno por registro y versión. Hay 34 payloads repetidos por contenido, pero no se deduplican durante la migración porque el volumen es pequeño y cada archivo conserva metadata/linaje propios.
7. Los weekdays se transformarán con numeración ISO: lunes=1 … domingo=7.

## Estado de implementación

1. Completado en `009`: control por fases, reconciliación y carga transaccional de roles/usuarios/core/licensing.
2. Completado en `010`: carga transaccional/reconciliada de schedules, 338 tareas lógicas, 32 aliases y sus tablas hijas/history.
3. Completado en `011`: carga transaccional/reconciliada de settings, contenido, idempotencia de notificaciones y auditoría; el enlace de archivos exige ledger Blob verificado.
4. Completado offline: preparación idempotente de 39 payloads con nombres opacos, byte count, SHA-256 y detección de manipulación; aún no se abrió conexión Blob.
5. Completado offline: ejecutor protegido no-productivo para registrar, cargar sin overwrite, descargar, verificar bytes/SHA-256 remoto y alimentar el ledger requerido por `011`; usa identidad Azure existente y no acepta secretos de Storage.
6. Siguiente paso: ejecutar el primer ensayo integral únicamente después de construir una base SQL Server 2019 desechable y disponer de Blob no-productivo privado, versionado y con TLS 1.2 o superior.
7. Repetir desde cero dos veces; comparar tablas, permisos, conteos, archivos y duración.

La generación del plan se repite con:

```powershell
node migration/tools/plan-operational-transform.js "migration/backups/<snapshot>" "migration/backups/<snapshot>/operational-transform-plan.json"
node migration/tools/validate-operational-transform-plan.js
```
