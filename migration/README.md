# Migration Workspace

Carpeta para herramientas y documentación de migración Cosmos DB → base relacional.

Los backups reales se generan en:

```text
migration/backups/
```

Esa carpeta está ignorada por git porque puede contener datos productivos, PII, hashes y nombres de secretos. No subir exports reales al repositorio.

Ver instrucciones:

```text
docs/COSMOS_EXPORT_SNAPSHOT.md
```

Evidencia estructural sanitizada del snapshot productivo del 2026-07-16:

- `migration/intake/COSMOS_SNAPSHOT_PROFILE_2026-07-16.md`

El export completó 17/17 contenedores y 2.890 documentos sin errores de hash, conteo o ID. Todos los campos observados ya tienen regla canónica y el validador estructural informa cero gaps. La validación semántica ejecutó 42 controles: 0 errores críticos y 462 warnings con transformación determinista documentada. Gate B está aprobado para construcción no productiva.

Validar que cada campo observado esté nombrado en la matriz canónica:

```powershell
node migration/tools/validate-mapping-coverage.js migration/backups/<snapshot>/profile.json
```

Este validador no lee ni imprime valores: usa únicamente el perfil estructural.

Validar semántica e integridad del snapshot sin emitir valores:

```powershell
node migration/tools/validate-cosmos-business-data.js migration/backups/<snapshot>
```

El reporte detallado queda dentro del backup restringido como `business-validation.json`; la consola muestra solo conteos agregados.

Diseño y cobertura vigentes (revisión 2026-07-16):

- `docs/RELATIONAL_MODEL_PROPOSAL.md`
- `docs/PORTAL_DATA_COVERAGE_MATRIX.md`
- `docs/COSMOS_TO_SQL_MIGRATION_MATRIX.md`
- `SOLICITUD_BASE_SQL_SERVER.md`
- `docs/SQL_SERVER_MIGRATION_RUNBOOK.md`
- `docs/SQL_SERVER_PHYSICAL_DATA_DICTIONARY.md`

La propuesta relacional de mayo fue reemplazada por el diseño integral de Portal SAG Web. No generar DDL usando una copia anterior que omita roles, sesiones, contenido, archivos o implementaciones.

DDL local de Gate C:

```text
migration/sql/002_migration_history_and_schemas.sql
migration/sql/003_security_core.sql
migration/sql/004_licensing_scheduling_workflow.sql
migration/sql/005_settings_notifications_content_audit.sql
migration/sql/006_staging.sql
migration/sql/007_indexes_constraints_permissions.sql
migration/sql/008_stage_projection_procedure.sql
migration/sql/009_operational_load_control_and_core.sql
migration/sql/010_operational_load_scheduling_workflow.sql
migration/sql/011_operational_load_settings_content_notifications_audit.sql
migration/sql/012_expand_task_source_identifiers.sql
migration/sql/013_expand_entity_source_identifiers.sql
migration/sql/014_correct_historical_task_orphan_projection.sql
migration/sql/015_print_format_multiple_sources.sql
migration/sql/016_public_download_video_assets_and_source_cleanup.sql
migration/sql/017_normalize_domain_url_identity.sql
migration/sql/018_expand_license_module_description.sql
migration/sql/019_expand_notification_outbox_types.sql
migration/sql/020_allow_outbox_attempt_completion.sql
```

Validar su sintaxis con la gramática SQL Server 2019 instalada con SSMS:

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File migration/tools/Validate-SqlServer2019Scripts.ps1
node migration/tools/validate-permission-seed.js
node migration/tools/validate-operational-core-loader.js
node migration/tools/validate-operational-scheduling-workflow-loader.js
node migration/tools/validate-operational-settings-content-audit-loader.js
```

El parseo no sustituye la construcción en una base desechable. Gate C termina solo después de dos builds limpios equivalentes y pruebas de los roles `portal_migrator`, `portal_runtime` y `portal_reporting`.

El destino `data14.sagerp.co,54103` / `PortalSAGWeb` está reservado como producción y está bloqueado en todas las herramientas `nonproduction`. Los dos ensayos limpios deben ejecutarse en un servidor/base de rehearsal separado. La designación productiva no cambia todavía el backend de la aplicación: Cosmos sigue siendo la fuente de verdad hasta el cutover aprobado.

Cuando exista una instancia **no productiva** con una base vacía llamada `PortalSAGWeb`, ejecutar el build protegido (solicita la contraseña sin guardarla):

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File migration/tools/Build-PortalSAGWeb-NonProduction.ps1 -ServerName "<servidor-no-productivo>,<puerto>" -EnvironmentTag nonproduction
```

El operador debe escribir `BUILD NONPRODUCTION`; el script valida motor 15, compatibility 150, collation, base vacía y checksums, aplica primero `001_prepare_production_mvp_database.sql` y después las migraciones versionadas `002..020`. No crea la base ni debe apuntarse a producción.

Validar el snapshot y el plan raw/stage sin abrir SQL:

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File migration/tools/Import-CosmosSnapshot-RawStage.ps1 -SnapshotDirectory "migration/backups/<snapshot>"
```

Después de construir una base no productiva, cargar únicamente raw/staging con conexión cifrada y contraseña solicitada en memoria:

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File migration/tools/Import-CosmosSnapshot-RawStage.ps1 -SnapshotDirectory "migration/backups/<snapshot>" -Apply -TargetEnvironment nonproduction -ServerName "<servidor-no-productivo>,<puerto>" -AcceptKnownWarnings
```

La segunda forma exige escribir `IMPORT RAW STAGE NONPRODUCTION`, verifica hashes/conteos/0 críticos, crea una corrida reanudable y ejecuta 17 reconciliaciones. No carga tablas operativas ni Blob Storage. `-AcceptKnownWarnings` solo se usa después de revisar las transformaciones documentadas.

### Ensayo completo del snapshot vigente con una sola credencial

El launcher `migration/tools/Run-Current-Snapshot-SQL-Rehearsal.cmd` encadena build (solo si la base no tiene tablas), raw/stage, core, scheduling/workflow, verificación Blob y carga final. Solicita una sola vez la credencial SQL del migrador y una sola frase exacta de autorización; la contraseña permanece únicamente en la memoria de ese proceso.

El preflight rechaza `SAGWebDev`, exige `CONTROL`/`db_owner` para la identidad separada del proveedor y se detiene si encuentra filas operativas o corridas anteriores. No limpia ni reemplaza evidencia silenciosamente. Para reutilizar `PortalSAGWeb`, el proveedor debe confirmar antes un backup/restore point y entregar el target limpio. Cosmos continúa como fuente de respuestas y escrituras; este launcher no habilita `DATA_BACKEND=sql`.

Calcular el contrato agregado de la transformación final, sin abrir SQL ni Blob y sin emitir valores productivos:

```powershell
node migration/tools/validate-operational-transform-plan.js
node migration/tools/plan-operational-transform.js "migration/backups/<snapshot>" "migration/backups/<snapshot>/operational-transform-plan.json"
```

El snapshot certificado produce 338 tareas lógicas, 32 aliases, 39 archivos y cero condiciones críticas de transformación. El informe agregado versionable está en `migration/intake/OPERATIONAL_TRANSFORM_PLAN_2026-07-16.md`; el JSON generado permanece junto al snapshot restringido e ignorado por Git.

La migración `009` agrega checkpoints operacionales, un ledger inmutable de transferencias de archivos y la primera fase transaccional: roles, usuarios, clientes, dominios, bases y licenciamiento. Fuerza el límite de autenticación incrementando `token_version` y no copia las 88 sesiones ni las 9 ventanas de rate limit heredadas. Solo después de validar raw/stage en una base no productiva se ejecuta con doble clic en:

```text
migration/tools/Run-Operational-Core-NonProduction.cmd
```

O desde PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File migration/tools/Load-PortalSAGWeb-OperationalCore.ps1 -ServerName "<servidor-no-productivo>,<puerto>" -RunKey <run-key>
```

Exige escribir `LOAD OPERATIONAL CORE NONPRODUCTION`, usa TLS estricto, solicita la contraseña como `SecureString`, verifica que `009` esté registrada y carga todo el core dentro de una sola transacción. Aún no carga schedules, tareas, settings, contenido, notificaciones ni auditoría.

La migración `010` crea la segunda fase transaccional y reconciliada: 10 schedules, 338 tareas lógicas, 32 aliases y todas las tablas hijas de programación/workflow para el snapshot certificado. Tras completar y reconciliar `009` en una base no productiva, se ejecuta con doble clic en:

```text
migration/tools/Run-Operational-SchedulingWorkflow-NonProduction.cmd
```

O desde PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File migration/tools/Load-PortalSAGWeb-OperationalSchedulingWorkflow.ps1 -ServerName "<servidor-no-productivo>,<puerto>" -RunKey <run-key>
```

Exige escribir `LOAD SCHEDULING WORKFLOW NONPRODUCTION`, usa TLS estricto, verifica que `010` esté registrada y que `009` haya terminado para la misma corrida. Settings, contenido, notificaciones, auditoría y payloads Blob siguen fuera de esta fase.

La migración `011` crea la fase operacional final, `015` la envuelve para normalizar las asignaciones muchos-a-muchos de formatos/fuentes y `016` clasifica archivos públicos como documento/video y elimina la descripción de fuentes. La transacción carga settings normalizados, seis registros de idempotencia de correo, metadata/versiones para 39 archivos, fuentes/formatos, descargas públicas y 2.182 filas append-only de auditoría. La fase rechaza secretos en claro, relaciones inválidas, discriminadores desconocidos, archivos sin hash y cualquier ledger Blob incompleto. Solo después de cargar y verificar los objetos en Blob no-productivo se ejecuta con doble clic en:

La migración `017` corrige la identidad normalizada de dominios para que `https://ejemplo/` y `https://ejemplo` sean la misma URL, sin cambiar el valor visible. También actualiza el loader operacional y aborta si datos activos existentes colisionarían después de retirar los slash finales.

La migración `018` amplía de forma aditiva `licensing.license_modules.description` a `NVARCHAR(2000)` para mantener el contrato vigente de la API sin truncar contenido. El DDL base ya incluye el mismo tamaño para que las construcciones desde cero y las actualizaciones converjan.

La migración `019` habilita los tipos durables `task_status_notification` y `test_email`. La `020` conserva los intentos de entrega como evidencia inmutable, permitiendo solamente su única transición de cierre `processing → sent/failed`; deletes, reaperturas y modificaciones posteriores siguen bloqueados.

Para aplicar `017..020` mediante una sesión efímera ya autorizada y registrar los checksums:

```powershell
pwsh -NoProfile -ExecutionPolicy RemoteSigned -File migration/tools/Apply-PortalSAGWeb-PendingMigrationsThroughSession.ps1 -Environment qa
```

El smoke `migration/sql/qa_operational_writers_rollback_smoke.sql` está restringido a `PortalSAGWeb-TEST`, ejecuta writers representativos y exige cero filas sintéticas después del rollback.

```text
migration/tools/Run-Final-Operational-NonProduction.cmd
```

O desde PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File migration/tools/Load-PortalSAGWeb-FinalOperational.ps1 -ServerName "<servidor-no-productivo>,<puerto>" -RunKey <run-key>
```

Exige escribir `LOAD FINAL OPERATIONAL NONPRODUCTION`, verifica que `011` esté registrada, que `010` haya terminado para la misma corrida y que los 39 objetos estén `verified`. Al completar, enlaza los archivos, ejecuta 20 reconciliaciones y marca la corrida `completed` dentro de la misma transacción.

Estado real de la corrida certificada 1 al 2026-07-21: completada; 17 contenedores/2.890 documentos preservados en raw, 15 contenedores de negocio proyectados, 39 archivos/968.128 bytes verificados y enlazados, y 65/65 controles finales aprobados. `authSessions` (88) y `securityRateLimits` (9) quedaron deliberadamente fuera del modelo operacional. El siguiente gate es la equivalencia del runtime y el login restringido `portal_sag_runtime`; esta carga completa no significa que la aplicación desplegada ya use SQL.

Validar los archivos para Blob privado sin escribir payload ni abrir conexiones:

```powershell
node migration/tools/validate-blob-transfer-package.js
node migration/tools/prepare-blob-transfer-package.js "migration/backups/<snapshot>"
```

La segunda orden debe informar 39 archivos y 968.128 bytes para el snapshot certificado. `--prepare` crea el payload restringido e idempotente bajo `migration/work/`, ignorado por Git; no debe usarse hasta disponer de Blob no-productivo y del run key staged correspondiente.

Transferir y verificar los archivos únicamente en el ambiente no-productivo, después de completar `010`, con doble clic en:

```text
migration/tools/Run-Blob-Transfer-NonProduction.cmd
```

O desde PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File migration/tools/Transfer-PortalSAGWeb-Blobs.ps1 -ServerName "<servidor-no-productivo>,<puerto>" -RunKey <run-key> -SnapshotDirectory "migration/backups/<snapshot>" -StorageAccountName "<cuenta>" -ResourceGroupName "<grupo>" -BlobContainerName "<container-privado>"
```

Prerequisitos: Azure CLI ya autenticado con identidad (el ejecutor no ejecuta `az login`), lectura del recurso Storage, rol `Storage Blob Data Contributor` sobre el container, HTTPS obligatorio, TLS 1.2 o superior, acceso público deshabilitado, versionado Blob habilitado y container privado existente. El operador debe escribir `TRANSFER BLOBS NONPRODUCTION`. El ejecutor no acepta keys, SAS ni connection strings de Storage; registra el plan SQL, carga sin sobrescribir, vuelve a descargar cada objeto, compara bytes/SHA-256 y solo deja el ledger en `verified` cuando los 39 archivos y 968.128 bytes coinciden. No imprime IDs, nombres, hashes ni contenido restringido.

Validar offline el contrato del ejecutor:

```powershell
node migration/tools/validate-protected-blob-transfer-executor.js
```

Primer paso al recibir SQL Server:

- abrir `migration/connect-sql-server/Open-PortalSAGWeb-Connection.cmd` y proporcionar las credenciales en el prompt protegido;
- ejecutar `migration/sql/000_database_intake_readonly.sql` con una cuenta de lectura;
- completar `migration/templates/SQL_DATABASE_INTAKE_TEMPLATE.md` sin credenciales;
- aprobar Gate A de `docs/SQL_SERVER_MIGRATION_RUNBOOK.md` antes de crear objetos.

Antes de diseñar Fase 4, considerar:

- V14/V16 de `updateSchedules`: frecuencia única (`once`), `completedAt`, `completedReason`, `manualTargetTypes` y excepciones por licenciamiento (`excludedDomainIds`, `excludedDatabaseIds`).
- V15 de clientes: `externalId` opcional, único si existe, y futuro candidato a obligatorio.
- Catálogo cerrado de ambientes operativos: `production`, `test`, `demo`.
- Regla crítica de tareas: `cancelled` + `result = "obsolete"` puede ser reactivada por una programación activa; `completed` sí bloquea duplicados.
