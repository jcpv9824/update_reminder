# Solicitud de base SQL Server para migración del Programador de Actualizaciones ERP

## 1. Objetivo

Solicitamos una base de datos SQL Server para migrar gradualmente la aplicación **Programador de Actualizaciones ERP** desde Azure Cosmos DB hacia un modelo relacional, conservando datos productivos, auditoría, tareas, programaciones, licenciamiento y configuraciones.

La migración se hará por fases. Cosmos DB seguirá siendo la fuente de verdad hasta completar exportación, carga, validación y aprobación de la base SQL.

## 2. Motor requerido

### Opción recomendada

- **Azure SQL Database** o **SQL Server 2022**.
- Nivel de compatibilidad recomendado: **160** si está disponible.

### Opción mínima aceptable

- **SQL Server 2016 o superior**.
- Nivel de compatibilidad mínimo: **130**.

Motivo del mínimo SQL Server 2016:

- Soporte de funciones JSON (`ISJSON`, `JSON_VALUE`, etc.) para staging y validación de documentos exportados desde Cosmos.
- Soporte de índices filtrados, `DATETIME2`, `NVARCHAR(MAX)`, `UNIQUEIDENTIFIER`, constraints e integridad referencial.

> Nota: si el proveedor puede entregar SQL Server 2019/2022 o Azure SQL, preferir esa opción sobre SQL Server 2016.

## 3. Nombre sugerido

Ambiente productivo:

```text
erp_update_scheduler_prod
```

Ambientes adicionales recomendados:

```text
erp_update_scheduler_dev
erp_update_scheduler_test
```

No mezclar esta base con otras aplicaciones, aunque compartan servidor o pool.

## 4. Collation y codificación

Requerimiento:

```text
Modern_Spanish_CI_AS
```

Alternativa aceptable:

```text
Latin1_General_100_CI_AI_SC
```

Notas:

- La aplicación guarda textos en español.
- Usar `NVARCHAR` para datos de texto.
- Comparaciones funcionales de duplicados se normalizan desde la aplicación; aun así se requieren columnas normalizadas e índices únicos filtrados.

## 5. Configuración recomendada de base

Solicitar al proveedor:

- `READ_COMMITTED_SNAPSHOT ON`.
- `ALLOW_SNAPSHOT_ISOLATION ON`.
- Recovery model: **FULL** si es SQL Server administrado por proveedor.
- Backups automáticos habilitados.
- Cifrado en reposo habilitado:
  - TDE si aplica.
  - En Azure SQL, Transparent Data Encryption activo.
- Conexiones cifradas por TLS.
- Zona horaria de aplicación: **America/Bogota**.
- Fechas de negocio como `DATE`.
- Timestamps técnicos como `DATETIME2(3)` o `DATETIME2(7)` en UTC.

## 6. Tamaño inicial y crecimiento

Estimación inicial razonable:

- Tamaño inicial de data: **10 GB**.
- Log inicial: **5 GB** si aplica.
- Crecimiento automático:
  - Data: incrementos de 512 MB o 1 GB.
  - Log: incrementos de 256 MB o 512 MB.

Si se usa Azure SQL:

- Iniciar con un tier equivalente a uso bajo/medio.
- Permitir escalar durante migración/importación.
- Activar métricas de CPU, DTU/vCore, storage y deadlocks.

## 7. Backups y retención

Requerimientos mínimos:

- Backups completos automáticos.
- Point-in-time restore.
- Retención mínima: **30 días**.
- Retención recomendada: **35 días o más**.
- Export/backup previo a cada cutover.
- Confirmar procedimiento de restore probado por el proveedor.

## 8. Seguridad y acceso

Crear usuarios/logins separados:

### Usuario runtime de la aplicación

Nombre sugerido:

```text
erp_scheduler_app
```

Permisos:

- `CONNECT`.
- `SELECT`, `INSERT`, `UPDATE`, `DELETE` sobre schemas de aplicación.
- Ejecución de stored procedures si se crean.
- No debe tener permisos de `db_owner`.
- No debe poder modificar schema en producción.

### Usuario de migración

Nombre sugerido:

```text
erp_scheduler_migration
```

Permisos durante migración:

- Crear/alterar tablas en schemas de staging/migration si el proveedor lo permite.
- `SELECT`, `INSERT`, `UPDATE`, `DELETE`.
- Bulk insert o método equivalente si se usará carga masiva.
- Permisos revocables después del cutover.

### Usuario lectura/reportes opcional

Nombre sugerido:

```text
erp_scheduler_readonly
```

Permisos:

- Solo `SELECT` sobre vistas/tablas autorizadas.

## 9. Firewall y conectividad

Permitir conexiones desde:

- Azure Functions de la aplicación `erpupdsch4645-api`.
- IPs salientes necesarias de Azure si aplica.
- Equipo/red autorizada para migración.
- Herramientas del proveedor durante ventana de migración.

Requerir:

- Conexión cifrada.
- No exponer SQL Server públicamente sin firewall.
- Si es posible, usar Private Endpoint, VPN o red privada.

## 10. Schemas requeridos

Crear o permitir crear estos schemas:

```text
security
core
licensing
scheduling
workflow
settings
notifications
audit
migration
```

Uso esperado:

- `security`: usuarios, roles y relación usuario-rol.
- `core`: clientes, dominios, bases de datos, ambientes.
- `licensing`: módulos y licencias de clientes.
- `scheduling`: programaciones normales, especiales, scopes y recordatorios.
- `workflow`: tareas, responsables, fuentes e historial de estados.
- `settings`: configuración de alertas/correos.
- `notifications`: idempotencia de correos y recordatorios enviados.
- `audit`: auditoría.
- `migration`: staging, raw JSON, runs y validaciones.

## 11. Catálogos iniciales

### Ambientes permitidos

La aplicación solo permite estos ambientes operativos:

```text
production  -> Producción
test        -> Pruebas
demo        -> Demo
```

El valor `all` puede existir únicamente para filtros/configuraciones, no para dominios ni bases.

### Roles funcionales

```text
admin
client_manager
domain_updater
database_updater
viewer
```

## 12. Contenedores Cosmos a migrar

Los contenedores actuales esperados son:

```text
users
clients
domains
databases
updateSchedules
updateTasks
auditLogs
appSettings
emailNotifications
licenseModules
licenseAssignments
```

Todos deben exportarse y preservarse. No migrar solo activos; también se deben preservar inactivos, eliminados lógicos e historial.

## 13. Reglas de datos críticas

### IDs

- Preservar IDs actuales de Cosmos como claves iniciales SQL.
- No reemplazar por identity integers en la primera migración.
- Clientes tienen además `externalId`, que es el ID de negocio:
  - Opcional por ahora.
  - Único si existe.
  - Puede volverse obligatorio en una fase futura.

### Soft delete

Preservar:

```text
status
deletedAt
deletedBy
updatedAt
updatedBy
```

No borrar auditoría ni historial.

### Secretos

SQL puede guardar nombres de secretos, pero nunca valores secretos.

Permitido:

```text
password_secret_name
smtp_password_secret_name
```

Prohibido:

```text
contraseñas reales
SMTP password
connection strings completas con contraseña
JWT secrets
tokens
valores de Key Vault
```

## 14. Reglas funcionales que SQL debe soportar

### Programaciones especiales

Modos vigentes:

```text
manual
licensing
```

No implementar modo “Todos los clientes activos”.

Manual:

- `manual_target_types`:
  - `domains_and_databases`
  - `domains_only`
  - `databases_only`
- El modo manual no tiene filtro de ambiente.

Licenciamiento:

- `license_match_mode`: `any` / `all`.
- Filtro de ambiente: `all`, `production`, `test`, `demo`.
- `target_types`: dominios, bases o ambos.
- Excepciones:
  - dominios excluidos.
  - bases excluidas.
- Excluir dominio no excluye automáticamente sus bases.
- Excluir base no excluye el dominio.

### Frecuencia única

- `frequency_type = once`.
- Usa `start_date` como **Fecha de actualización**.
- Puede generar tareas futuras dentro de la ventana operativa.
- Solo se marca inactiva/completada cuando `start_date <= hoy`.
- Al completarse:

```text
active = 0
completed_reason = 'one_time_schedule_executed'
```

### Tareas

- Dedupe principal:

```text
target_type + target_id + task_date
```

- `completed` bloquea duplicados.
- `cancelled` con `result = 'obsolete'` puede reactivarse a `pending` si una programación activa vuelve a requerirla.
- No ocultar silenciosamente tareas futuras requeridas por programaciones activas.

## 15. Tablas principales esperadas

El diseño final se documenta en:

```text
docs/RELATIONAL_MODEL_PROPOSAL.md
docs/COSMOS_TO_SQL_MIGRATION_MATRIX.md
```

Tablas principales esperadas:

```text
security.users
security.roles
security.user_roles

core.clients
core.environments
core.domains
core.domain_assignees
core.databases
core.database_assignees

licensing.license_modules
licensing.client_license_modules
licensing.license_assignments

scheduling.update_schedules
scheduling.schedule_targets
scheduling.schedule_weekdays
scheduling.schedule_assignees
scheduling.schedule_reminder_settings
scheduling.schedule_reminder_days
scheduling.special_schedule_scope_groups
scheduling.special_schedule_scope_domains
scheduling.special_schedule_scope_databases
scheduling.schedule_licensing_scope
scheduling.schedule_licensing_scope_modules
scheduling.schedule_licensing_excluded_domains
scheduling.schedule_licensing_excluded_databases

workflow.update_tasks
workflow.task_assignees
workflow.task_sources
workflow.task_status_history

settings.app_settings
notifications.email_notifications
audit.audit_logs

migration.migration_runs
migration.raw_documents
migration.validation_results
```

## 16. Índices y constraints mínimos

Solicitar soporte para:

- Primary keys.
- Foreign keys.
- Check constraints.
- Filtered unique indexes.
- Composite indexes.

Índices únicos requeridos/recomendados:

```text
core.clients.external_id where external_id is not null and status <> 'deleted'
core.clients.name_normalized where status <> 'deleted'
core.domains.domain_name_normalized where status <> 'deleted'
core.databases.connection_fingerprint where status <> 'deleted'
licensing.license_modules.code_normalized where code_normalized is not null and status <> 'deleted'
workflow.update_tasks.dedupe_key where dedupe_key is not null
workflow.update_tasks(target_type, target_id, task_date)
```

## 17. Funcionalidades SQL necesarias

Requerido:

- Transacciones ACID.
- Constraints relacionales.
- Índices filtrados.
- Funciones JSON disponibles para staging.
- `DATETIME2`.
- `NVARCHAR(MAX)`.
- `UNIQUEIDENTIFIER`.
- Vistas.
- Stored procedures opcionales.

No requerido inicialmente:

- SQL Server Agent, porque los timers actuales viven en Azure Functions.
- Full-text search.
- CLR.
- Replicación.

## 18. Entregables solicitados al proveedor

Solicitamos al proveedor entregar:

1. Nombre del servidor SQL.
2. Nombre de la base.
3. Versión exacta del motor.
4. Nivel de compatibilidad configurado.
5. Collation configurada.
6. Endpoint/host y puerto.
7. Confirmación de TLS/cifrado en tránsito.
8. Confirmación de cifrado en reposo.
9. Política de backups y retención.
10. Procedimiento de restore.
11. Usuarios creados y permisos asignados.
12. Rango/IPs permitidas en firewall.
13. Límite inicial de almacenamiento.
14. Métricas/monitoreo disponibles.
15. Ventanas de mantenimiento.

## 19. Información que NO debe enviarse por correo ni documento plano

No incluir en documentos:

- Contraseñas.
- Connection strings completas con password.
- JWT secrets.
- Tokens.
- App passwords SMTP.
- Valores de Key Vault.

Las credenciales deben entregarse por canal seguro definido por infraestructura.

## 20. Aprobación antes de migrar

Antes de usar SQL como fuente de verdad:

1. Exportar Cosmos.
2. Cargar staging SQL.
3. Validar conteos.
4. Validar relaciones.
5. Validar reportes y tareas.
6. Probar login y roles.
7. Probar Programaciones especiales manual/licenciamiento.
8. Probar dedupe y recuperación de tareas `cancelled/obsolete`.
9. Ejecutar pruebas backend/frontend.
10. Aprobar cutover con rollback documentado.
