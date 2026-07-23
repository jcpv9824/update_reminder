# Runbook de migración de Portal SAG Web a SQL Server

Versión: **2026-07-23**

Base recibida: **2026-07-16** (`PortalSAGWeb`; production MVP; intake técnico completado)

Modalidad aprobada por producto: **production MVP**. Esto permite una sola base y un despliegue incremental, pero mantiene los controles mínimos de backup, integridad, autorización, secretos y rollback.

Estado: **cutover productivo a SQL completado y verificado el 2026-07-23**

## Estado productivo certificado — 2026-07-23

- La Function App productiva opera con `DATA_BACKEND=sql`, conexión SQL activa, autorización SQL habilitada, mantenimiento desactivado y los seis timers habilitados.
- La corrida certificada `2` está `completed`: 2.987 documentos raw/stage, 66 reconciliaciones sin fallos y 0 validaciones críticas abiertas.
- La carga operacional contiene 7 usuarios, 40 clientes, 45 dominios, 55 bases, 11 programaciones, 341 tareas, 2.251 auditorías, 2 activos públicos y 39 archivos.
- La base tiene 0 FK inválidas/no confiables, 0 checks inválidos/no confiables y 0 triggers de tabla deshabilitados.
- Los 39 objetos privados (968.128 bytes) permanecen en Azure Blob Storage; SQL conserva metadata, hashes, versiones y referencias, no los bytes.
- El probe productivo verificó catálogos públicos, un archivo Blob privado mediante SAS de delegación, frontera no autenticada `401`, bloqueo de mutaciones durante mantenimiento y reapertura posterior.
- La identidad administrada conserva acceso de datos limitado al container y recibió `Storage Blob Delegator` al nivel de la cuenta, requisito para generar SAS de delegación sin claves de cuenta.
- `SAGWebDev` conserva `db_owner` y `CONTROL` conforme a la excepción explícita del propietario; ningún script de cutover redujo sus permisos.
- Application Insights mostró 0 requests fallidas `5xx`, excepciones o trazas de error desde el corte hasta `2026-07-23T21:01:53Z`.
- Cosmos dejó de ser el backend de lectura/escritura de la aplicación. Debe conservarse sin eliminación durante el período de retención acordado; cualquier rollback posterior a nuevas escrituras SQL requiere reconciliación controlada.

### Retiro de Cosmos iniciado — 2026-07-23

- El runtime ahora falla si `DATA_BACKEND` no está configurado explícitamente; ya no existe un fallback silencioso a Cosmos.
- Cuando `DATA_BACKEND=sql`, cualquier llamada accidental a `getContainer` falla de forma explícita antes de abrir el cliente Cosmos.
- La creación de programaciones obtiene el cliente desde SQL; los recordatorios programados resuelven usuarios por SQL sin inicializar Cosmos.
- Usuarios, roles y setup dejaron de inicializar contenedores Cosmos antes de seleccionar sus writers SQL.
- Se añadieron pruebas SQL-only sin `COSMOS_CONNECTION_STRING` para creación de programaciones y recordatorios.
- El commit `32cc033` se desplegó como canary productivo `b5d4f55f087c4c90bedc4add13bdaef8` a las `2026-07-23T22:26:43Z`, conservando temporalmente la cadena Cosmos.
- Los probes iniciales confirmaron SQL saludable, seis timers habilitados, rutas públicas y Blob `200`, frontera protegida `401`, cero errores del guard y cero solicitudes Cosmos posteriores al despliegue.
- La cadena y la cuenta no se eliminan hasta completar siete días continuos sin actividad, snapshot final cifrado e inmutable y restore SQL probado.

## 1. Objetivo y resultado esperado

Migrar Portal SAG Web de Cosmos DB a SQL Server sin perder datos, romper permisos, duplicar tareas/correos ni exponer secretos. El resultado final debe conservar los contratos de la API y el comportamiento de todos los módulos actuales:

- Clientes, Dominios, Bases de Datos y Licenciamiento.
- Tareas y Programar Actualizaciones.
- Descargas Públicas.
- Alertas y Correos, Usuarios y Roles, Formatos de Impresión.
- Auditoría y Tablero.
- Login, sesiones, reset de contraseña, rate limits y timers.
- Preparación estructural para el futuro flujo de Gestión de Implementaciones.

La migración termina únicamente cuando SQL sea la fuente de verdad aprobada, Cosmos quede read-only durante la retención acordada, los resultados funcionales sean equivalentes y exista rollback probado.

## 2. Principios no negociables

1. No ejecutar DDL ni importar datos hasta inventariar la base recibida.
2. No probar por primera vez en producción; usar una base no productiva o copia restaurable.
3. No pegar credenciales, connection strings ni valores de Key Vault en chats, documentos o commits.
4. No resolver secretos de Key Vault durante la migración; solo copiar sus nombres.
5. No cambiar la aplicación a SQL antes de completar dos ensayos reproducibles.
6. No usar dual-write Cosmos/SQL como estrategia normal: genera divergencias. Usar Cosmos-write + shadow-read SQL hasta el corte.
7. No reactivar timers hasta migrar idempotencia y verificar que existe una sola instancia lógica activa.
8. No eliminar Cosmos después del corte. Mantenerlo read-only 30–90 días o el período aprobado.
9. Cada script debe ser versionado, repetible, transaccional cuando aplique y registrar una `migration_run`.
10. Toda anomalía queda en `migration.validation_results`; no se corrige silenciosamente.

## 3. Roles de ejecución

| Rol | Responsabilidad |
|---|---|
| Dueño del portal | Aprobar decisiones de negocio, ventanas, go/no-go y resolución de anomalías. |
| Arquitecto de datos/solución | Diseñar y revisar DDL, mapeos, orden de carga, validación, cutover y rollback. |
| DBA/proveedor | Entregar motor, acceso, backup/PITR, red, capacidad, monitoreo y restore probado. |
| Responsable Azure | Conectividad de Function App, identidad administrada, Key Vault y Blob Storage. |
| Equipo de pruebas | Validar equivalencia funcional y permisos con usuarios representativos. |

Codex puede preparar, ejecutar y verificar comandos dentro del workspace cuando el usuario entregue el acceso y autorice cada acción con impacto. El proveedor conserva las acciones que solo pueda realizar en su infraestructura.

## 4. Mañana: secuencia de las primeras dos horas

### Paso 1 — recibir información sin exponer secretos

Solicitar por canal seguro:

- Host/servidor y puerto.
- Nombre de base y ambiente.
- Azure SQL vs SQL Server; versión/edition y compatibility level.
- Método de autenticación: identidad administrada/Entra ID recomendado, o credencial SQL temporal.
- Usuario runtime, usuario migrador y usuario read-only, o autorización para crearlos.
- Firewall/private endpoint/VPN y origen autorizado.
- Collation, tamaño/tier, límites, backup/PITR, retención, RPO y RTO.
- Confirmación de TLS y cifrado en reposo.
- Si la base está vacía o contiene objetos/datos que deban respetarse.
- Cuenta/container de Blob Storage o autorización para crearlos.

Guardar secretos directamente en Key Vault o variables de sesión. En el workspace solo se documentan nombres de variables y nombres de secretos.

### Paso 2 — probar conectividad de forma read-only

Antes de cualquier cambio:

```sql
SELECT @@VERSION AS engine_version;
SELECT DB_NAME() AS database_name;
SELECT compatibility_level, collation_name, is_read_committed_snapshot_on,
       snapshot_isolation_state_desc
FROM sys.databases
WHERE name = DB_NAME();

SELECT SUSER_SNAME() AS login_name, USER_NAME() AS database_user;

SELECT s.name AS schema_name, COUNT(t.object_id) AS table_count
FROM sys.schemas s
LEFT JOIN sys.tables t ON t.schema_id = s.schema_id
GROUP BY s.name
ORDER BY s.name;
```

No seleccionar datos existentes todavía. Registrar resultados sin credenciales en un informe de intake.

### Paso 3 — inventariar base existente

Si no está vacía, exportar metadata únicamente:

- schemas, tablas, columnas, PK, FK, índices, checks, defaults, vistas, procedures y triggers;
- principals, roles y grants relevantes;
- tamaños por tabla y propiedades de la base;
- historial/baseline de herramienta de migraciones si existe.

Clasificar cada objeto como `portal`, `compartido`, `ajeno` o `desconocido`. No modificar nada hasta que no queden objetos desconocidos que puedan colisionar.

### Gate A — aceptar o rechazar la base

La base se acepta para construcción cuando:

- motor/compatibilidad soportan JSON, índices filtrados, `ROWVERSION`, `DATETIME2` y snapshot isolation;
- collation y `NVARCHAR` preservan español;
- backup/PITR y restore están confirmados;
- red desde estación de migración y Azure Functions es viable;
- existen permisos separados o un plan para crearlos;
- objetos existentes están inventariados y no habrá colisiones;
- capacidad inicial y crecimiento son suficientes;
- existe estrategia de archivos en Blob Storage.

Si falla un punto, se documenta y se corrige antes de DDL.

## 5. Fases completas

```text
Recepción e inventario
  -> infraestructura no productiva
  -> DDL versionado
  -> snapshot Cosmos
  -> raw + staging
  -> transformación/carga
  -> adaptador SQL
  -> shadow read
  -> ensayos
  -> cutover controlado
  -> estabilización
  -> retiro posterior de Cosmos
```

### Fase 0 — decisiones y baseline

Cerrar y registrar:

- Azure SQL/SQL Server y ambiente que se usará para pruebas.
- Collation final.
- Blob Storage privado para archivos Base64.
- SQL o Redis para rate limits.
- Crear ahora o después las tablas vacías de `implementation`.
- RPO/RTO, ventana máxima y período read-only de Cosmos.
- Herramienta de migraciones del schema. Recomendación: scripts SQL numerados con tabla de historial; evaluar DACPAC/Flyway solo si el equipo los operará.
- Criterio de anonimización si se usa copia productiva en pruebas.

Entregable: `migration/intake/SQL_DATABASE_INTAKE.md` sin secretos.

### Fase 1 — seguridad e infraestructura

Crear/probar en no-producción:

- identidad/login de migración con DDL y carga, revocable;
- identidad runtime con DML solo en schemas autorizados;
- identidad read-only/reporting con vistas sanitizadas;
- permisos append-only para `audit` e `implementation_events`;
- Blob Storage privado con versionado/lifecycle y acceso por identidad administrada;
- secreto de conexión o configuración Entra ID en Key Vault;
- métricas de conexiones, CPU, storage, deadlocks, errores y queries lentas.

La cuenta runtime no es `db_owner`, no puede alterar schema y no puede actualizar/borrar auditoría.

### Fase 2 — DDL versionado

Crear en este orden:

```text
migration/sql/
  001_prepare_production_mvp_database.sql
  002_migration_history_and_schemas.sql
  003_security_core.sql
  004_licensing_scheduling_workflow.sql
  005_settings_notifications_content_audit.sql
  006_staging.sql
  007_indexes_constraints_permissions.sql
  008_stage_projection_procedure.sql
  009_operational_load_control_and_core.sql
  010_operational_load_scheduling_workflow.sql
  011_operational_load_settings_content_notifications_audit.sql
  012_expand_task_source_identifiers.sql
  013_expand_entity_source_identifiers.sql
  014_correct_historical_task_orphan_projection.sql
  015_print_format_multiple_sources.sql
  016_public_download_video_assets_and_source_cleanup.sql
  017_normalize_domain_url_identity.sql
  018_expand_license_module_description.sql
  019_expand_notification_outbox_types.sql
  020_allow_outbox_attempt_completion.sql
```

`001` se ejecuta por el build protegido antes del historial. `002..020` están en el manifiesto SHA-256 y pasan la gramática T-SQL 150. `009`, `010`, `011`, `015` y `016` crean objetos/checkpoints o procedimientos, pero no ejecutan una corrida por sí solas. `015` agrega la relación muchos-a-muchos de formatos/fuentes; `016` agrega clasificación document/video, la vista de assets y retira la descripción innecesaria del maestro de fuentes. `017` normaliza la identidad de dominios, `018` amplía descripciones de módulos, `019` habilita los tipos nuevos del outbox y `020` permite únicamente la transición terminal e inmutable de cada intento de entrega.

Cada script:

- usa `SET XACT_ABORT ON`;
- es seguro frente a ejecución repetida o se controla por tabla de historial;
- falla ante versión inesperada;
- no contiene secretos;
- registra versión, checksum, fecha y actor;
- se prueba creando la base desde cero.

Gate C: schema vacío creado dos veces desde cero y validado sin diferencias inesperadas.

### Fase 3 — snapshot fuente

1. Ejecutar saneamiento de auditoría en dry-run.
2. Revisar conteos; aplicar el saneamiento solo con aprobación y backup.
3. Configurar `COSMOS_CONNECTION_STRING` en variable de sesión sin imprimirla.
4. Ejecutar `npm run export:cosmos`.
5. Verificar que manifest incluya los 17 contenedores con status `ok`, conteos y SHA-256.
6. Guardar el snapshot en volumen cifrado, fuera de Git, con acceso mínimo.
7. Tomar copia separada e inmutable del manifest.

Los 15 contenedores de negocio se importan. `authSessions` y `securityRateLimits` se conservan solo en el snapshot restringido y se omiten de la carga operativa.

El primer snapshot puede capturarse con el portal activo para construir/ensayar. El snapshot final requiere pausa de escrituras y timers porque Cosmos no ofrece una transacción global entre contenedores.

Gate C: snapshot completo, hashes verificados y 0 secretos reales detectados.

### Fase 4 — raw y staging

Por cada corrida:

1. Crear `migration.migration_runs` con estado `started`.
2. Cargar cada documento original en `migration.raw_documents`, conservando container, ID, JSON y SHA-256.
3. Cargar `stage_*` sin normalizar ni descartar campos.
4. Contar documentos raw/stage contra manifest.
5. Ejecutar validaciones estructurales antes de tocar tablas finales.

Errores críticos previos a carga final:

- ID vacío/duplicado.
- JSON inválido o hash distinto.
- fechas obligatorias inválidas.
- referencias jerárquicas inexistentes.
- valores de secretos en claro.
- discriminador desconocido de `publicDownloads`.
- Base64 inválido, tamaño inconsistente o PDF sin firma.

### Fase 5 — transformación y carga final

Orden de carga:

1. Catálogos de ambientes y permisos.
2. Usuarios y roles; role-permissions, visibilidad y user-roles.
3. Clientes.
4. Dominios y responsables.
5. Perfiles de acceso y bases; responsables.
6. Módulos y asignaciones de licencia reconciliadas.
7. Programaciones y todas sus tablas hijas.
8. Tareas, asignados, fuentes, recordatorios, alertas e historial derivado.
9. Settings, destinatarios y recordatorios administrativos.
10. Fuentes/formatos y descargas; normalizar `fuenteIds[]` en el puente muchos-a-muchos y cargar archivos a Blob con SHA-256.
11. Idempotencia/notificaciones.
12. Auditoría sanitizada.
13. Tablas reservadas de implementaciones vacías.
14. Constraints e índices que se difirieron durante bulk load.

Transformaciones especiales:

- IDs Cosmos se conservan.
- `admin→super_admin` y `formatos_impresion.admin→print_formats_admin`; otros roles retirados requieren resolución de referencias.
- Licencias embebidas en clientes se reconcilian con `licenseAssignments`; no se duplican.
- `rootScheduleId` es la FK estable; IDs sintéticos quedan como evidencia/fuente.
- nombres denormalizados se comparan con maestros y se conservan solo como snapshots históricos.
- archivos Base64 se decodifican, validan, hashean y cargan a Blob; SQL guarda metadata/versión.
- sesiones/rate limits no se cargan.

Cada bloque corre en transacción cuando el volumen lo permita. Bulk load grande usa lotes con checkpoint de corrida, nunca commits invisibles sin registro.

### Fase 6 — reconciliación de datos

Validaciones obligatorias por corrida:

| Control | Criterio |
|---|---|
| Conteos | Cada container = raw = stage; final explicado por normalización. |
| IDs | 100% presentes o anomalía aprobada. |
| Estados | Conteos active/inactive/deleted y estados de tarea equivalentes. |
| Arrays | Suma de roles, assignees, targets, weekdays, scopes, licencias, recipients y sources. |
| Relaciones | 0 FK huérfanas críticas. |
| Unicidad | 0 duplicados no resueltos de email, externalId, dominio, módulo, dedupeKey y slug. |
| Secretos | 0 contraseñas/tokens reales en SQL, logs o artefactos compartidos. |
| Archivos | 100% con mismo byte count/hash; PDFs abren. |
| Idempotencia | No se repite recordatorio/correo ya enviado. |
| Auditoría | Conteos/filtros equivalentes y JSON dentro de allowlist. |

Toda diferencia queda clasificada `critical`, `warning` o `accepted`. Solo el dueño del portal puede aceptar diferencias de negocio.

Gate D: 0 errores críticos y warnings resueltos/aceptados.

Estado 2026-07-21: la corrida certificada 1 ya completó raw/stage y las fases operacionales `009`, `010`, `011`, `015` y `016` en `PortalSAGWeb`. Los 39 objetos (968.128 bytes) están en Blob privado, verificados por byte count/SHA-256 y enlazados desde SQL; las 65 reconciliaciones finales pasaron. Las 88 sesiones y 9 ventanas de rate limit se conservaron solo como evidencia raw y no se cargaron operativamente, según diseño. Esto certifica la carga de datos, no el cutover de la aplicación.

### Fase 7 — capa de acceso SQL

No reescribir endpoints directamente. Introducir repositorios por dominio con el mismo DTO público:

```text
api/src/data/
  contracts/
  cosmos/
  sql/
  provider.ts
```

Configuración implementada:

- `DATA_BACKEND=cosmos`: comportamiento actual y valor seguro predeterminado.
- `DATA_BACKEND=dual-read`: responde desde Cosmos, lee SQL para comparar DTOs/conteos sanitizados y no escribe en SQL.
- `DATA_BACKEND=sql`: responde desde SQL; solo podrá habilitarse globalmente cuando todos los repositorios y escrituras transaccionales estén terminados.

No usar `dual-read` para enviar correo ni ejecutar mutaciones/timers duplicados. Los comparadores nunca registran hashes, accesos técnicos ni nombres de secretos.

Estado runtime 2026-07-21:

- conexión SQL con pool, TLS estricto y preflight del contrato de motor/base/collation: implementada;
- conexión local del proyecto preparada en `dual-read`: launcher con credenciales efímeras, validación de rol `portal_runtime`, rechazo de `db_owner/db_ddladmin/portal_migrator`, seis timers deshabilitados, proxy frontend `/api` y endpoint sanitizado `/api/portal-runtime-status`;
- acceso runtime resuelto el 2026-07-21: `SAGWebDev` fue retirado de `db_owner` y agregado únicamente a `portal_runtime` mediante transacción auditada; verificación final: 1 membresía runtime, 0 membresías elevadas y 1 evento append-only. DDL futuro requiere una identidad de migración separada controlada por el proveedor;
- Clientes, Dominios, Bases de Datos y Licenciamiento (listas, detalles, jerarquías, módulos y asignaciones), Programaciones (lista, detalle, alcance normalizado y resumen operativo), Tareas (lista/detalle consolidados y visibilidad por rol), configuración de Alertas y Correos, Usuarios/Roles (listas y autorización normalizada), Descargas Públicas, Formatos de Impresión y consulta de Auditoría: lecturas SQL y comparación `dual-read` implementadas;
- Licenciamiento compara contra la proyección normalizada: 0 documentos explícitos + 55 licencias embebidas de clientes = 55 filas SQL, sin reintroducir una segunda representación;
- Programaciones reconstruye targets, weekdays, asignados, recordatorios, grupos de alcance y alcance de licenciamiento desde tablas hijas; el resumen usa `workflow.task_sources` para contabilizar una tarea compartida en cada programación relacionada sin duplicarla dentro de una misma programación;
- validación SQL Server 2019 en vivo: 10/10 programaciones reconstruidas con JSON válido para todas las colecciones normalizadas; consulta y resumen ejecutados sin exponer valores de negocio;
- validación SQL Server 2019 en vivo de tareas: 90 tareas operativas no canceladas, 90 identidades lógicas y 90/90 proyecciones normalizadas válidas; solo se devolvieron agregados sanitizados;
- Alertas y Correos reconstruye el singleton, días, roles, correos actuales/legacy, weekdays, bloqueos y recordatorios administrativos; la referencia de Key Vault se usa solo internamente y se elimina del DTO público;
- validación SQL Server 2019 en vivo de configuración/seguridad: 1/1 settings válido, 6/6 roles válidos, 157 permisos concedidos, 7/7 usuarios válidos y 8 asignaciones de rol; solo se devolvieron conteos y flags sanitizados;
- filtros y paginación de Dominios/Bases: ejecutados en SQL; las listas ordinarias de bases no seleccionan host, usuario SQL ni referencia de secreto;
- archivos públicos y PDF: redirección temporal a Blob privado sin materializar bytes en SQL;
- base SQL de seguridad implementada: carga interna de credenciales sin DTO público, hashes binarios de refresh token, rotación/replay detection dentro de una transacción `SERIALIZABLE`, y consumo atómico de rate limits con `UPDLOCK/HOLDLOCK`; una validación read-only en la base confirmó tablas operativas vacías, 4/4 índices de sesión, 3/3 índices de rate limit y `row_version` en ambas tablas;
- writers transaccionales SQL de auditoría/outbox implementados: auditoría reutiliza la allowlist vigente y se clasifica `confidential`; el reset encola solo plantilla fija, referencia de usuario y destinatario con dedupe de 15 minutos. El token se genera al reclamar, SQL conserva solo su hash y cada reintento invalida de forma segura el token anterior;
- validación read-only del destino confirmó trigger append-only de auditoría, unique de idempotencia, índice de claim del worker, constraint JSON, permiso runtime `INSERT` y denegaciones `UPDATE/DELETE`; no se insertó ninguna fila de prueba;
- `SQL_SECURITY_RUNTIME_ENABLED=false` permanece como compuerta independiente hasta el ensayo de autenticación. Login, sesiones, cambio/reset de contraseña, setup, usuarios, roles, revocación, auditoría y outbox ya tienen ruta SQL; `dual-read` nunca duplica efectos de seguridad;
- Clientes, Dominios y Bases disponen de CRUD/estado SQL, responsables, licencias, acceso técnico y auditoría transaccional. Sus eliminaciones en cascada coordinan schedules, tareas de dominio y base, asignaciones de licencia y soft-delete jerárquico en una sola transacción;
- Licenciamiento dispone localmente de CRUD SQL transaccional para módulos y asignaciones, generación de códigos bajo bloqueo serializable, validación de jerarquía/estado/ambiente, protección de dependencias al eliminar, soft-delete y auditoría append-only en la misma unidad. El smoke vivo con `portal_runtime` ejercitó altas, cambios de estado, bajas y auditoría dentro de una transacción y confirmó 0 filas persistidas después del rollback;
- Programaciones dispone de CRUD/estado SQL y reconstrucción completa de targets, weekdays, responsables, recordatorios y alcance manual/licenciamiento. Generación manual/automática crea tareas idempotentes, sincroniza asignaciones, marca obsoletas y completa frecuencias `once`, con historial y auditoría en las mismas transacciones;
- Tareas dispone de cambios de estado SQL (`start/complete/fail/block/resolve/reopen/cancel`) con bloqueo de fila, timestamps/motivos, actualización de maestro, historial y auditoría. Las notificaciones de estado se encolan en SQL en lugar de enviarse dentro de la petición;
- la coordinación SQL/Key Vault usa compensación: cada rotación crea una referencia nueva, SQL y auditoría confirman el cambio como una unidad, un fallo SQL elimina la referencia nueva y el secreto anterior solo se retira después del commit; un fallo de limpieza posterior no revierte una escritura SQL ya confirmada y queda señalado sin imprimir el nombre del secreto;
- los smoke tests vivos con `portal_runtime` insertaron cliente, dominio, perfil de acceso y base sintéticos con sus auditorías dentro de transacciones explícitas y confirmaron rollback total: las filas fueron visibles dentro de cada transacción y todos los deltas persistidos fueron 0;
- Alertas, recordatorios, pruebas de correo y notificaciones de tareas usan un outbox con idempotencia, claim con lease, backoff, límite de intentos, auditoría y recuperación automática de filas `processing` cuyo lease venció;
- Descargas Públicas admite documentos/videos y Formatos de Impresión admite relación N:M de fuentes y PDF versionado. Los bytes quedan en Blob privado; un fallo SQL intenta eliminar únicamente un Blob sin referencias SQL;
- verificación 2026-07-23: builds API/frontend correctos, 363 pruebas API y 174 frontend correctas, manifest `002..020` consistente y scripts `000..020` válidos con parser T-SQL 150;
- `PortalSAGWeb-TEST` tiene `017..020` aplicadas: 0 identidades de dominio con slash final, descripción de módulos de 2.000 caracteres Unicode, tipos `task_status_notification`/`test_email` habilitados y transición de intentos `processing→sent/failed` probada;
- el smoke vivo rollback-only ejercitó seguridad/autenticación, programación/alcance, generación y transición de tareas, outbox con recuperación de lease, video público, formato con dos fuentes, archivos, licencias y cascadas. Pasó como `portal_runtime` sin `db_owner` y dejó 0 filas sintéticas;
- QA conserva 65/65 reconciliaciones correctas, 39/39 archivos enlazados, 0 constraints/FK inválidos, 0 validaciones críticas abiertas y `DBCC CHECKDB PHYSICAL_ONLY` correcto;
- los writers SQL y las migraciones `017..020` ya están desplegados en la API y aplicados al destino productivo; el backend productivo permanece intencionalmente en `dual-read`, por lo que Cosmos sigue atendiendo respuestas y escrituras.

Estado productivo 2026-07-22:

- el cutover solicitado el 2026-07-22 fue detenido en preflight con decisión `NO-GO`: no se activó mantenimiento, no se detuvieron timers, no se escribió en SQL/Blob/Key Vault, no se desplegó y `DATA_BACKEND` permaneció en `dual-read`; evidencia detallada en `migration/intake/PRODUCTION_CUTOVER_PREFLIGHT_2026-07-22.md`;
- `data14.sagerp.co,54103` / `PortalSAGWeb` fue designada por el propietario como la base SQL de producción. Ya no se considera desechable ni apta para ensayos; ningún build/import/loader marcado `nonproduction` puede apuntar a este destino;
- esta designación identifica el destino final, pero no constituye cutover: las filas actuales corresponden a una corrida de ensayo anterior y no son el dataset final certificado. Cosmos continúa como fuente de verdad hasta completar Gate C–F y la carga final durante una ventana controlada;
- los launchers históricos que apuntaban a esta base como `disposable pre-live` quedaron retirados, y los scripts genéricos de build, raw/stage, cargas operacionales, transferencia Blob y rehearsal rechazan explícitamente el endpoint productivo antes de solicitar credenciales;
- API SQL-capable desplegada con endpoint sanitizado `/api/portal-runtime-status`;
- Function App configurada en `DATA_BACKEND=dual-read`; Cosmos sigue respondiendo y recibiendo todas las escrituras, mientras SQL ejecuta lecturas sombra;
- contraseña runtime SQL guardada en Azure Key Vault y referenciada por la Function App; no se imprimió ni escribió localmente;
- health productivo confirmó `backend=dual-read`, conexión SQL activa, `SQL_SECURITY_RUNTIME_ENABLED=false`, descarga pública `200` y endpoint protegido `401` sin autenticación;
- rollback de runtime ensayado `dual-read → cosmos → dual-read`; ambos backends alcanzaron estado saludable y la descarga pública regresó a `200` después del warm-up de cada reinicio;
- compuerta de mantenimiento implementada y desactivada por defecto: `PORTAL_MAINTENANCE_MODE=true` bloquea globalmente mutaciones HTTP con `503`, convierte los seis triggers timer en no-op y conserva lecturas; `Run-Production-Maintenance-Entry.cmd` deshabilita además los seis timers mediante app settings, valida una mutación sintética bloqueada y restaura los settings anteriores si el probe falla;
- el rollback productivo restaura `DATA_BACKEND=cosmos`, desactiva mantenimiento y elimina los seis flags de timer antes de comprobar el endpoint público;
- el controlador de rehearsal exige ahora cero tablas de usuario al inicio de cada corrida 1/2, mide las seis fases, emite evidencia agregada ignorada por Git y compara ambas corridas contra la ventana aprobada con margen mínimo de 30%; no crea, limpia ni restaura bases;
- decisión explícita del propietario 2026-07-23: las herramientas de patch/migración deben preservar los permisos efectivos de `SAGWebDev` y no pueden retirarlo de `db_owner`, revocar `CONTROL` ni reducir sus grants. El controlador exige que SQL confirme `db_owner` + `CONTROL`, registra `permissionMutationPolicy=preserve-existing`, y el antiguo script de downgrade falla antes de modificar la base. Se acepta como excepción consciente el mayor radio de impacto de usar una identidad runtime con capacidad DDL;
- verificación productiva 2026-07-23: `SAGWebDev` autenticó con full control y conserva también `portal_runtime`; el `DENY` del rol sobre `migration` exige contexto `dbo` limitado a la sesión. El controlador aplica `EXECUTE AS USER='dbo'` tras la autorización y `REVERT` al cerrar, sin cambiar membresías. Intake agregado: migraciones `002..020` aplicadas sin fallos, una corrida antigua completa de 2.890 documentos/462 warnings/65 reconciliaciones correctas, cero constraints no confiables y `DBCC CHECKDB PHYSICAL_ONLY` correcto. La base aún no contiene la corrida vigente de 2.987 documentos;
- backup productivo 2026-07-23: se creó un full backup SQL nativo `COPY_ONLY`, comprimido y con checksum; `msdb` confirmó finalización y checksums. `RESTORE VERIFYONLY` no pudo ejecutarse con permisos a nivel de base porque SQL Server exige capacidad server-level para planificar la restauración. La validación/restore por el proveedor sigue siendo una compuerta pendiente y el backup no debe sobrescribirse;
- `Run-Production-CurrentSnapshot-Staging.cmd` prepara una segunda corrida aditiva con el snapshot vigente de 2.987 documentos. El modo `production-stage` exige el endpoint exacto, snapshot productivo, migraciones hasta `020`, `db_owner + CONTROL`, confirmación específica y contexto `dbo` limitado a la conexión. Solo escribe `migration.raw_documents`, tablas `migration.stage_*`, validaciones y reconciliaciones; no reemplaza filas operativas ni cambia permisos;
- checkpoint productivo 2026-07-23: la corrida `2` del snapshot `cosmos-export-prod-20260722-155753` quedó `validated` bajo schema `020`, con 2.987/2.987 documentos raw/stage, 17/17 conteos de staging reconciliados, 0 fallos y 0 validaciones críticas abiertas. Los conteos operativos clave permanecieron en los valores de la corrida `1` (7 usuarios, 40 clientes, 45 dominios, 55 bases, 10 schedules, 338 tareas y 2.183 auditorías), demostrando que staging no reemplazó datos. `SAGWebDev` siguió con `db_owner + CONTROL`;
- el rol temporal de escritura de secretos concedido al operador fue retirado; la identidad administrada de la Function App conserva acceso de lectura al secreto;
- este despliegue prueba conectividad, writers, mantenimiento y rollback del selector, pero no autoriza `DATA_BACKEND=sql`: los dos rebuilds limpios en SQL Server 2019 separado, el ensayo completo de cutover y la prueba de backup/restore de Gate C–F siguen pendientes.

Snapshot incremental 2026-07-22:

- se capturó nuevamente Cosmos de forma read-only a las `17:34:16Z` usando la configuración existente de Azure sin mostrar ni guardar la cadena de conexión. Los 17 hashes y conteos coinciden exactamente con el snapshot revisado de `15:57:53Z`: 2.987 documentos y 0 contenedores con drift;
- el snapshot fresco pasó perfil estructural 17/17, cobertura canónica con 0 campos observados sin mapping, 44 checks de negocio con 0 errores críticos/464 warnings conocidos, plan de 341 tareas lógicas/32 aliases y contrato Blob de 39 archivos/968.128 bytes;
- nuevo export read-only completo: 17/17 contenedores, 2.987 documentos y 0 errores críticos de perfil;
- validación de negocio: 44 checks, 0 errores críticos y 464 warnings determinísticos pendientes de aceptación de corrida;
- plan de transformación: 341 tareas lógicas, 32 aliases, 39 archivos y 0 errores críticos de transformación;
- drift frente a la corrida 1: `updateSchedules` 10→11, `updateTasks` 370→373, `auditLogs` 2.182→2.250, `authSessions` 88→115 y `securityRateLimits` 9→7; sesiones/rate limits siguen siendo solo evidencia raw;
- la comparación pública detectó que los IDs de documentos descargables coinciden, pero las identidades operacionales de secciones y formatos no equivalen completamente; la corrida 1 no puede considerarse snapshot final;
- una verificación agregada detectó que 44 dominios de la corrida 1 conservaban slash final en `domain_name_normalized`; esto divergía de la regla de duplicados de la aplicación. La migración idempotente `017_normalize_domain_url_identity.sql` corrige datos y loader, valida colisiones antes de escribir y ya pasa el parser T-SQL 150. La migración aditiva `018_expand_license_module_description.sql` alinea el límite SQL de descripciones con las 2.000 posiciones Unicode aceptadas por la API. Ninguna se aplicó parcialmente con `SAGWebDev`: requieren la identidad migradora separada o una base limpia, donde el manifest `002..018` las ejecuta y registra;
- `SAGWebDev` confirmó 0 permisos `SELECT/INSERT` sobre schema `migration`, 0 `EXECUTE` sobre los tres loaders y 0 `ALTER DATABASE`; la corrida 2 requiere el migrador separado controlado por el proveedor y nunca debe elevar al runtime.
- se agregó `Run-Current-Snapshot-SQL-Rehearsal.cmd`: valida el contrato 17/2.987/0/464, reutiliza una sola credencial efímera del migrador para todas las fases y una sola autorización exacta, rechaza la cuenta runtime y se detiene antes de escribir si la base conserva filas o corridas anteriores;
- el destino Blob vigente fue verificado read-only: container privado, versionado y retención de borrado habilitados, 39 objetos de migración presentes; no se emitieron nombres, IDs, hashes ni contenido.

Por tanto, no cambiar todavía la Function App a `DATA_BACKEND=sql`.

Implementar primero seguridad/core, luego licensing/scheduling/workflow, después settings/content/notifications/audit. Mantener handlers delgados y transacciones en servicios/repositorios.

### Fase 8 — pruebas de equivalencia

Ejecutar:

- suites API completas, con repositorios Cosmos y SQL;
- auth, sessions, password, JWT, rate limits;
- roles, permisos, visibilidad y lifecycle;
- CRUD y cascadas de clientes/dominios/bases/licencias;
- scheduling, scope manual/licensing, generación, `once`, obsoletas y dedupe;
- estados/bloqueos/reaperturas de tareas;
- recordatorios y alertas con email provider mock;
- formatos/descargas públicas y hashes de archivo;
- auditoría, reportes, dashboard, filtros y paginación;
- frontend completo contra API SQL de staging.

Comparar usuarios representativos:

- `super_admin`.
- actualizador de dominios.
- actualizador de bases.
- administrador de formatos.
- al menos un rol custom con visibilidad `none`, `assigned` y `all`.

Gate E: tests, builds, comparación shadow y criterios de negocio aprobados.

### Fase 9 — ensayos de migración

Realizar al menos dos ensayos desde una base limpia:

1. Restaurar/recrear SQL no productivo.
2. Ejecutar todos los DDL.
3. Importar un snapshot completo.
4. Registrar duración por fase y volumen.
5. Ejecutar validaciones y smoke tests.
6. Probar rollback a Cosmos.
7. Repetir hasta obtener resultado reproducible.

El segundo ensayo debe demostrar que la ventana final cabe en el tiempo aprobado con margen mínimo de 30%.

### Fase 10 — cutover productivo

#### Preparación T-24h

- confirmar responsables y canal de incidente;
- confirmar backup/PITR de SQL y snapshot previo de Cosmos;
- congelar cambios de schema/código/datos masivos;
- validar secretos, red, Blob, métricas y rollback;
- avisar mantenimiento;
- dejar scripts y checksums etiquetados/versionados.

#### Ventana

1. Activar modo mantenimiento: bloquear escrituras y acceso de usuarios.
2. Deshabilitar los cuatro timers de correo y el generador de tareas.
3. Confirmar que no hay ejecuciones activas.
4. Tomar snapshot Cosmos final de 17 contenedores y verificar manifest.
5. Re-crear o limpiar staging de la corrida final, nunca tablas fuera de alcance.
6. Ejecutar importación completa o delta ensayado.
7. Ejecutar todas las validaciones Gate D.
8. Configurar runtime `DATA_BACKEND=sql`; no reactivar timers.
9. Forzar logout: SQL inicia sin auth sessions y rate limits.
10. Ejecutar smoke tests en modo mantenimiento/read-only.
11. Si pasan, abrir el portal a un grupo interno y validar permisos/tareas.
12. Autorizar go-live y abrir escrituras.
13. Reactivar timers uno por uno, confirmando idempotencia y lease lógico.
14. Monitorear intensivamente y registrar hora oficial de corte.

#### Smoke tests mínimos

- login/logout/reset sin mostrar secretos;
- sidebar/rutas según permiso;
- listas y detalle de cada maestro;
- tarea asignada visible y tarea no autorizada invisible;
- programación/preview sin generar duplicados;
- crear/editar un registro de prueba autorizado y auditarlo;
- formato PDF y descarga pública con hash correcto;
- settings sanitizados;
- dashboard y auditoría;
- timer ejecutado en modo controlado sin duplicar correo.

### Gate F — go/no-go

Go-live solo si:

- 0 errores críticos de migración;
- todos los hashes/conteos reconciliados;
- smoke y permisos pasan;
- no hay secretos expuestos;
- CPU/conexiones/latencia dentro de umbrales;
- timers siguen detenidos hasta autorización explícita;
- rollback sigue disponible.

## 6. Rollback

### Rollback limpio

Mientras el portal siga en mantenimiento/read-only después de importar SQL:

1. Cambiar `DATA_BACKEND=cosmos`.
2. Revocar/retirar temporalmente acceso runtime SQL si es necesario.
3. Verificar Cosmos intacto.
4. Rehabilitar portal y timers Cosmos una sola vez.
5. Conservar SQL fallido para análisis; no limpiarlo manualmente.

### Después de abrir escrituras SQL

El rollback ya requiere reconciliar cambios realizados en SQL. Por eso la decisión final se toma antes de abrir escrituras. Si ocurre una falla posterior:

- entrar nuevamente en mantenimiento;
- detener timers;
- identificar transacciones SQL posteriores al corte mediante auditoría/outbox;
- decidir restaurar SQL, corregir forward o aplicar un delta inverso controlado;
- no alternar proveedores repetidamente.

Triggers de rollback inmediato:

- pérdida/corrupción de datos;
- usuarios acceden a datos no autorizados;
- incapacidad de completar tareas críticas;
- duplicación de tareas o correos;
- fallos de autenticación generalizados;
- archivos corruptos;
- latencia o bloqueos fuera de umbral sin mitigación rápida.

## 7. Estabilización y cierre

Primeras 24 horas:

- revisar errores API, conexiones, deadlocks, CPU/storage y queries lentas;
- revisar auditoría, creación/estado de tareas y correos;
- comparar conteos clave contra snapshot final;
- no realizar cambios estructurales no urgentes.

Primera semana:

- reconciliación diaria de entidades/tareas/notificaciones;
- revisar planes/índices con carga real;
- confirmar backups y ejecutar restore de prueba;
- cerrar anomalías aceptadas.

Retiro de Cosmos:

- mantener read-only durante período aprobado;
- conservar snapshot final cifrado según retención;
- revocar connection string solo después de aprobación formal;
- eliminar datos/recursos únicamente mediante procedimiento separado y autorizado.

## 8. Artefactos que construiremos

| Artefacto | Momento |
|---|---|
| Informe de intake de la base | Al recibirla. |
| DDL/historial y carga `001..011` | Preparados y certificados offline; pendientes dos builds/ensayos no-productivos. |
| Importador raw/stage/final | Con DDL estable. |
| Migrador de archivos a Blob | Preparado/certificado offline; ejecutar en Blob no-productivo antes de `011`. |
| Validador Cosmos↔SQL | En paralelo al importador. |
| Repositorios SQL y selector de provider | Después de schema/load inicial. |
| Comparador shadow sanitizado | Antes de ensayos funcionales. |
| Scripts de cutover/rollback | Antes del segundo ensayo. |
| Informe de reconciliación por corrida | Cada importación. |
| Acta go/no-go y cierre | Cutover y estabilización. |

## 9. Información que necesito al recibir la base

Compartir únicamente datos no secretos en el chat:

- plataforma y versión;
- nombre del servidor y base si no se consideran sensibles internamente;
- si está vacía;
- método de autenticación disponible;
- estado de firewall/private endpoint;
- si existe ambiente no productivo;
- si Blob Storage ya está disponible;
- ventana y tolerancia de mantenimiento;
- quién puede aprobar DDL, backups y cutover.

Las credenciales se configuran directamente en la terminal/Key Vault. Con esa información comenzaremos por el intake read-only y no por la creación de tablas.
