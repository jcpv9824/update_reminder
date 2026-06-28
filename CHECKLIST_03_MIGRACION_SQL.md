# Checklist 03 - Preparacion para migracion a SQL Server

Fecha de revision: 2026-06-27  
Documentos revisados: `SOLICITUD_BASE_SQL_SERVER.md`, `docs/DATA_ARCHITECTURE_DISCOVERY.md`, `docs/RELATIONAL_MODEL_PROPOSAL.md`, `docs/COSMOS_TO_SQL_MIGRATION_MATRIX.md`, `migration/README.md`, modelos TypeScript y logica operativa actual.

## Veredicto

**Estado: NO-GO para iniciar cutover o construir runtime SQL definitivo.**

La propuesta conceptual es buena y cubre aproximadamente la mayor parte del dominio, pero no es implementable aun: no existen DDL, staging, importadores, comparadores ni validadores; hay inconsistencias entre propuesta y matriz; y varias reglas de negocio bloqueantes siguen sin decidirse. La migracion puede continuar a fase de diseno/POC, no a produccion.

## Fortalezas existentes

- [x] **SQL-001 - Preservar IDs Cosmos como claves iniciales.** Reduce ruptura de referencias y facilita rollback.
- [x] **SQL-002 - Preservar activos, inactivos y eliminados.** No se propone migrar solo datos visibles.
- [x] **SQL-003 - Mantener secretos reales en Key Vault.** SQL guarda referencias, no passwords.
- [x] **SQL-004 - Separacion por schemas.** `security`, `core`, `licensing`, `scheduling`, `workflow`, `settings`, `notifications`, `audit`, `migration`.
- [x] **SQL-005 - Staging + raw JSON + migration runs.** Patron correcto para trazabilidad y recuperacion de campos omitidos.
- [x] **SQL-006 - Normalizacion de roles, asignados, scopes, licencias, sources y recordatorios.**
- [x] **SQL-007 - Preservacion de snapshots historicos en tareas/auditoria.**
- [x] **SQL-008 - Dedupe de tarea por tipo+entidad+fecha considerado en el modelo.**
- [x] **SQL-009 - Idempotencia de notificaciones reconocida como dato critico.**
- [x] **SQL-010 - Cutover por fases con Cosmos como rollback conceptual.**

## Bloqueadores de plataforma

- [ ] **SQL-011 - P0 - Rechazar SQL Server 2016 como plataforma nueva.**
  - `SOLICITUD_BASE_SQL_SERVER.md` lo acepta como minimo.
  - Microsoft indica fin de soporte extendido el **2026-07-14**. ESU es temporal y de costo adicional.
  - Fuente oficial: https://learn.microsoft.com/en-us/lifecycle/products/sql-server-2016
  - Cierre: exigir Azure SQL Database o SQL Server 2022 (compatibilidad 160). SQL Server 2022 tiene soporte extendido hasta 2033: https://learn.microsoft.com/en-us/lifecycle/products/sql-server-2022

- [ ] **SQL-012 - P0 - Elegir producto y topologia exactos.**
  - Pendiente: Azure SQL Database vs Managed Instance vs SQL Server 2022 administrado.
  - Cierre: tier/vCores, HA, zona, red privada, autenticacion, mantenimiento, limites, RPO/RTO y costos aprobados.

- [ ] **SQL-013 - P0 - Definir autenticacion sin password de aplicacion cuando sea posible.**
  - Recomendado: Managed Identity de Function App + Microsoft Entra para Azure SQL; permisos por schema/procedimiento.
  - Alternativa: credencial en Key Vault con rotacion documentada, nunca connection string en repo/app settings plano.

- [ ] **SQL-014 - P1 - Actualizar la solicitud a infraestructura.**
  - Eliminar SQL 2016 como minimo aceptable.
  - Agregar Private Endpoint/VNet, Defender for SQL, auditing, vulnerability assessment, PITR/LTR, geo-restore segun RPO/RTO, CMK si cumplimiento lo exige.

## Artefactos inexistentes

- [ ] **SQL-015 - P0 - Crear DDL versionado.**
  - Falta `database/sql/001_initial_schema.sql`.
  - Debe incluir schemas, tablas, checks, FKs, indices, permisos y seeds.

- [ ] **SQL-016 - P0 - Herramienta de migraciones de schema.**
  - Elegir Flyway/DbUp/Prisma migrations u otra opcion compatible con Azure Functions/TypeScript.
  - No aplicar DDL manual sin version/tabla de historial.

- [ ] **SQL-017 - P0 - Importador Cosmos export -> staging.**
  - Falta script ejecutable, reanudable e idempotente.
  - Debe registrar `migration_run_id`, errores por fila, hashes y conteos.

- [ ] **SQL-018 - P0 - Transformador staging -> modelo final.**
  - Debe ejecutarse en transacciones por agregado/lote y poder reintentarse.

- [ ] **SQL-019 - P0 - Comparador Cosmos vs SQL.**
  - Falta `scripts/compare-cosmos-sql.ts`.
  - Comparar conteos, hashes normalizados, relaciones, estados, scopes, tareas, correos y reportes.

- [ ] **SQL-020 - P0 - Validador post-migracion.**
  - Falta `scripts/validate-sql-migration.ts` y reporte firmado/aprobable.

- [ ] **SQL-021 - P1 - Rollback ejecutable y ensayado.**
  - Documento conceptual no basta. Se necesita switch de proveedor, freeze de escrituras, reconciliacion de cambios y tiempo maximo de retorno.

- [ ] **SQL-022 - P1 - Snapshot productivo verificable.**
  - El repo solo contiene `migration/README.md`; los exports estan correctamente ignorados, pero no hay evidencia local verificable de conteos/hashes recientes.
  - Cierre: manifest seguro de snapshot de ensayo y resultado de validacion sin datos sensibles.

## Correcciones al modelo propuesto

- [ ] **SQL-023 - P0 - Eliminar columna duplicada `core.clients.name`.**
  - `RELATIONAL_MODEL_PROPOSAL.md` declara `name` dos veces, una nullable y otra not null.

- [ ] **SQL-024 - P0 - Agregar `scheduling.update_schedules.name`.**
  - Existe en `UpdateSchedule` y se muestra en tareas/UI; falta en tabla y matriz.

- [ ] **SQL-025 - P0 - Mapear explicitamente `updateTasks.rootScheduleId`.**
  - La propuesta tiene `root_schedule_id`, pero la matriz campo-a-campo no contiene fila de origen `rootScheduleId`.

- [ ] **SQL-026 - P0 - Resolver multiples fuentes antes de definir FKs.**
  - `scheduleId/rootScheduleId` son mutables al sincronizar dedupe, mientras `sources[]` conserva varias programaciones.
  - Recomendacion: tarea no debe depender de una sola FK operativa para elegibilidad; `task_sources` es la relacion autoritativa y puede tener `is_primary` solo para presentacion.

- [ ] **SQL-027 - P0 - Soft delete/tombstone de schedules.**
  - Hoy algunos schedules se borran fisicamente. Una FK desde tareas fallara o quedara null.
  - Antes de migrar: preservar schedule borrado como tombstone o crear tabla historica de definiciones.

- [ ] **SQL-028 - P1 - Alinear snapshots definidos en matriz y propuesta.**
  - La matriz usa `client_name_snapshot`/`domain_name_snapshot` en core, pero las tablas propuestas no siempre declaran esas columnas.

- [ ] **SQL-029 - P1 - Historial de estados derivado desde auditoria.**
  - Timestamps actuales no permiten reconstruir todas las transiciones.
  - Cierre: algoritmo que combine task actual + audit logs; marcar filas inferidas y conservar raw.

- [ ] **SQL-030 - P1 - Constraint cliente-dominio-base.**
  - Implementar unique `(domain_id, client_id)` y FK compuesta desde database, o trigger probado. No dejar solo validacion de aplicacion.

- [ ] **SQL-031 - P1 - Objetivos polimorficos.**
  - `target_type + target_id` no tiene FK real.
  - Preferencia: columnas `domain_target_id`/`database_target_id` con check exactamente una, o tablas de tareas por objetivo; evitar trigger opaco si es posible.

- [ ] **SQL-032 - P1 - Dedupe y estados cancelados.**
  - Unique `(target_type,target_id,task_date)` coincide con regla actual y debe incluir canceladas para permitir reactivacion del mismo registro, no insercion nueva.
  - Agregar prueba de `cancelled/obsolete -> pending`.

- [ ] **SQL-033 - P1 - Huella de conexion.**
  - Regla actual compara servidor+catalogo+usuario, sin password.
  - Usar `BINARY(32)` SHA-256/HMAC de representacion canonica, no `NVARCHAR(500)`; definir normalizacion identica a `duplicateValidation.ts`.

- [ ] **SQL-034 - P1 - Collation y normalizacion.**
  - `Modern_Spanish_CI_AS` es accent-sensitive; algunas reglas funcionales eliminan tildes y otras no.
  - Cierre: escoger collation y columnas normalizadas persistidas de forma coherente; probar `Facturacion/Facturación`, mayusculas y espacios.

- [ ] **SQL-035 - P1 - `rowversion`/concurrencia optimista.**
  - Agregar a maestros, schedules, tasks y settings; API debe usarlo para evitar lost updates.

- [ ] **SQL-036 - P1 - Checks completos.**
  - Estados, frecuencia, target types, dias, horas, ambiente, email y coherencia de campos condicionales (`once`, weekly, monthly).

- [ ] **SQL-037 - P1 - Indices de consultas reales.**
  - Minimos:
    - tasks `(status, task_date, target_type)` include IDs/asignacion;
    - task_sources `(schedule_id, task_id)`;
    - schedules `(active, frequency_type, start_date, end_date)`;
    - domains/databases por client/status/environment;
    - notifications por unique idempotency key/status/next_attempt;
    - audit por fecha/entidad/cliente/actor.

- [ ] **SQL-038 - P1 - Idempotencia transaccional de correos.**
  - Modelar `notification_attempts` o ampliar `email_notifications` con recipient, state, claimed_at, sent_at, attempts, next_attempt_at, provider_id y unique key.

- [ ] **SQL-039 - P2 - Settings JSON con schema version.**
  - Agregar `schema_version`, `CHECK ISJSON`, migradores y columnas indexables para timers; no dejar JSON indefinido permanentemente.

- [ ] **SQL-040 - P2 - Auditoria append-only.**
  - Permisos sin UPDATE/DELETE para runtime; procedimiento de insercion; hash encadenado o export WORM si cumplimiento lo requiere.

## Runtime y arquitectura de aplicacion

- [ ] **SQL-041 - P0 - Repository/data access layer.**
  - Hoy Functions llaman Cosmos directamente. No existe `DATA_PROVIDER=cosmos|sql` ni repositorios intercambiables.
  - Cierre: contratos por agregado y pruebas de conformidad Cosmos/SQL.

- [ ] **SQL-042 - P0 - Driver y pool SQL.**
  - No hay dependencia `mssql`/Tedious ni configuracion de pool para Azure Functions.
  - Cierre: singleton por worker, limites, timeouts, cancelacion y telemetria.

- [ ] **SQL-043 - P1 - Resiliencia transitoria.**
  - Retry con backoff para errores transitorios/deadlocks, no para errores de negocio; idempotencia en escrituras.

- [ ] **SQL-044 - P1 - Frontera transaccional.**
  - Crear/editar/eliminar schedule + scope + targets + tareas/auditoria debe tener una unidad de trabajo clara.
  - Key Vault sigue externo: usar saga/compensacion y registro de operacion.

- [ ] **SQL-045 - P1 - Estrategia de cutover.**
  - Recomendado para volumen actual: ventana de mantenimiento, freeze de escrituras, snapshot final, carga/validacion, switch, smoke tests, rollback.
  - Dual-write solo si se diseña outbox y reconciliacion; no implementarlo improvisadamente.

- [ ] **SQL-046 - P1 - Timers singleton/locks.**
  - SQL permite `sp_getapplock` o claims atomicos para evitar dos generadores/reminders simultaneos.

- [ ] **SQL-047 - P1 - Outbox para efectos externos.**
  - Transaccion de negocio escribe outbox; worker envia email y actualiza intento. Evita “DB guardo pero correo no” y viceversa.

## Seguridad SQL

- [ ] **SQL-048 - P0 - Minimo privilegio por identidad.**
  - Runtime sin `db_owner`, sin DDL, sin acceso directo a `migration` y con lectura de `audit` limitada.

- [ ] **SQL-049 - P1 - Red privada y firewall.**
  - Private Endpoint preferido; negar acceso publico o restringir estrictamente; TLS obligatorio.

- [ ] **SQL-050 - P1 - TDE, backups y claves.**
  - Confirmar TDE, PITR, LTR, geo-redundancia segun RPO/RTO y restore probado.

- [ ] **SQL-051 - P1 - Clasificacion/mascarado.**
  - Clasificar email, servidor, usuario SQL, secret name, audit metadata. Dynamic Data Masking no sustituye permisos.

- [ ] **SQL-052 - P1 - Row-Level Security si se introduce scope por cliente.**
  - No activar sin diseno, pero el modelo debe soportar asignacion usuario-cliente y politicas testeables.

- [ ] **SQL-053 - P2 - Defender/auditing/alertas.**
  - Logins anormales, cambios de schema/roles, export masivo, consultas de datos sensibles.

## Validacion de migracion

- [ ] **SQL-054 - Conteos por entidad y estado.** Total, active/inactive/deleted, tareas por estado/fecha/tipo.
- [ ] **SQL-055 - Integridad relacional.** Cliente-dominio-base, scopes, licencias, tasks/sources, usuarios asignados.
- [ ] **SQL-056 - Equivalencia funcional.** Mismos resultados en listas, arboles, preview de licencia, generador, dedupe, tareas, alertas y reporte maestro.
- [ ] **SQL-057 - Equivalencia de seguridad.** Mismos o menores datos por rol; secretos nunca aparecen; pruebas BOLA.
- [ ] **SQL-058 - Equivalencia temporal.** Zona Bogota, once, recurrentes, vencidas, recordatorios, fin de mes y reprogramacion.
- [ ] **SQL-059 - Pruebas de volumen/rendimiento.** P95/P99, timers, reporte, auditoria, locks y crecimiento.
- [ ] **SQL-060 - Ensayo de rollback.** Cronometrado, documentado y aprobado.
- [ ] **SQL-061 - Dos migraciones de ensayo consecutivas idempotentes.** Mismo snapshot produce mismos resultados sin duplicados.
- [ ] **SQL-062 - Aprobacion formal.** Producto, desarrollo, infraestructura, seguridad y dueño de datos.

## Secuencia recomendada

1. Cerrar decisiones BUS-001 a BUS-005.
2. Corregir `SOLICITUD_BASE_SQL_SERVER.md` y pedir Azure SQL/SQL Server 2022.
3. Corregir propuesta/matriz (SQL-023 a SQL-040).
4. Crear DDL versionado y pruebas de schema.
5. Crear export, staging, import y validadores.
6. Introducir repositorios y pruebas de conformidad.
7. Ensayar en dev/test con copia sanitizada.
8. Medir, corregir, repetir snapshot.
9. Ejecutar ensayo de cutover/rollback.
10. Aprobar y programar produccion.

## Criterio de go/no-go

No avanzar a cutover hasta cerrar SQL-011 a SQL-027, disponer de DDL/importador/comparador/validador ejecutables, completar seguridad P0/P1 y demostrar dos migraciones de ensayo idempotentes con rollback exitoso.
