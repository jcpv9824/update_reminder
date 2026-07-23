# Checklist 03 — Migración a SQL Server

Revisión: **2026-07-16**
Estado global: **listo para construcción no productiva; producción NO autorizada**

Fuentes canónicas:

- `docs/COSMOS_TO_SQL_MIGRATION_MATRIX.md`
- `docs/RELATIONAL_MODEL_PROPOSAL.md`
- `docs/SQL_SERVER_PHYSICAL_DATA_DICTIONARY.md`
- `docs/SQL_SERVER_MIGRATION_RUNBOOK.md`
- `migration/intake/COSMOS_SNAPSHOT_PROFILE_2026-07-16.md`

Este checklist reemplaza la revisión del 2026-06-27. Ya no se exige SQL Server 2022: la plataforma recibida y aceptada condicionalmente es SQL Server 2019 Standard, compatibility 150.

## Gate A — infraestructura

- [x] Endpoint, autenticación SQL y TLS estricto probados.
- [x] SQL Server 2019 Standard/compatibility 150 y collation confirmados.
- [x] Base `PortalSAGWeb` vacía al intake.
- [ ] Backup/restore point inmediatamente anterior a cualquier DDL.
- [ ] Política de log backups/restore probado para recovery FULL.
- [ ] Cifrado en reposo acreditado (TDE o volumen equivalente).
- [ ] Cuenta runtime separada de mínimo privilegio.
- [ ] Conectividad Function App y capacidad/crecimiento confirmados.
- [ ] Blob Storage privado disponible.
- [ ] `READ_COMMITTED_SNAPSHOT` y snapshot isolation habilitados en ventana aprobada.

Gate A: **condicional**. Permite preparar artefactos locales/no productivos; no autoriza cambios productivos.

## Gate B — inventario, mapeo y datos

- [x] 17/17 contenedores exportados read-only.
- [x] 2.890 documentos; hashes, conteos e IDs verificados.
- [x] Todos los campos observados tienen regla canónica; 0 gaps.
- [x] Campos históricos de formatos preservados como `legacy_*`.
- [x] Relación muchos-a-muchos Formato–Fuente modelada con fuente primaria compatible, puente ordenado, vistas públicas e importación de `fuenteIds[]`/`fuenteId` legado.
- [x] `rootScheduleId` y `sources[]` resueltos sin FK falsa.
- [x] Sesiones/rate limits existentes excluidos del target operativo.
- [x] Settings, destinatarios, archivos, roles y licencias normalizados.
- [x] 42 controles semánticos: 0 críticos.
- [x] 462 warnings explicados por siete transformaciones deterministas, incluida la preservación deny-all de un usuario activo sin roles.

Gate B: **aprobado para construcción no productiva**. Debe repetirse con cada snapshot.

## Gate C — schema y seguridad

- [x] Crear historial y schemas versionados.
- [x] Crear DDL security/core.
- [x] Crear DDL licensing/scheduling/workflow.
- [x] Crear DDL settings/notifications/content/audit.
- [x] Crear raw/staging/validation/reconciliation para 17 contenedores.
- [x] Crear índices, checks, FKs, permisos, vistas sanitizadas y seeds.
- [x] Validar gramática T-SQL 150; cero errores de parseo en `000..011`.
- [ ] Construir dos bases limpias con mismo checksum/metadata.
- [ ] Probar principals migrator/runtime/reporting.

Gate C: **artefactos generados; pendiente construcción repetible en bases no productivas**.

## Gate D — importación/reconciliación

- [x] Proyección raw→17 staging repetible creada en migración `008`.
- [x] Importador raw/stage reanudable preparado; dry-run productivo: 17/17, 2.890, 0 críticos.
- [x] Plan agregado de transformación final: 338 tareas, 32 aliases, 39 archivos, 0 críticos; pruebas sintéticas aprobadas.
- [x] Control/checkpoints, ledger de archivos y primera fase transaccional security/core/licensing creados en `009`.
- [x] Fase transaccional/reconciliada scheduling/workflow creada en `010`: 10 schedules, 338 tareas lógicas, 32 aliases y tablas hijas/history.
- [x] Fase operacional final `011` creada: settings, 39 enlaces Blob verificados, contenido, 6 idempotencias de correo y 2.182 auditorías; 20 reconciliaciones.
- [x] Contrato de perfiles validado: 55 perfiles históricos, 50 fingerprints activos únicos; pares eliminados conservan su referencia de secreto inactiva.
- [x] Preparador de payload Blob privado validado: nombres opacos, idempotencia y detección de manipulación; dry-run real 39/968.128 bytes.
- [x] Ejecutor Blob no-productivo protegido implementado y certificado offline: identidad Azure existente, Storage privado TLS/versionado, carga sin overwrite, descarga y SHA-256 remoto, ledger SQL `verified`.
- [x] Migración `016` preparada: archivos públicos document/video, vista de assets, índice por sección/tipo/estado y eliminación de la descripción del maestro de fuentes.
- [ ] Ejecutar raw/stage en dos bases no productivas y reconciliar 17/17 conteos.
- [ ] Ejecutar/reconciliar fases `009`, `010` y `011` en dos bases no productivas.
- [x] Completar offline fase transaccional settings/content/notifications/audit (`011`).
- [x] Codificar y validar offline 370 tareas fuente → 338 tareas lógicas + 32 aliases/history.
- [ ] Históricos orphan conservan snapshots y FK nullable controlada.
- [ ] Schedules históricos ausentes conservan source ID sin filas ficticias.
- [ ] Base64 validado/movido a Blob; bytes/hash/MIME equivalentes.
- [ ] Conteos, estados, arrays, relaciones y permisos reconciliados.
- [ ] 0 errores críticos; warnings resueltos/aprobados.

## Gate E — aplicación, comportamiento y escala

- [ ] Repositorios Cosmos/SQL y selector `DATA_PROVIDER`.
- [ ] SQL shadow-read sanitizado; no dual-write ni timers duplicados.
- [ ] Auth/sessions/rate limits/roles/permissions pasan sobre SQL.
- [ ] CRUD, scheduling, dedupe, tareas, alerts y reportes equivalentes.
- [ ] Server-side pagination y queries acotadas.
- [ ] Concurrencia rowversion, applocks/outbox e idempotencia probadas.
- [ ] Carga representativa, Query Store, P95/P99 y crecimiento aprobados.

## Gate F — operaciones/cutover

- [ ] Dos ensayos completos desde base limpia.
- [ ] Ventana de corte con 30% de margen.
- [ ] Backup/restore y rollback cronometrados.
- [ ] Freeze de writes/timers y snapshot final ensayados.
- [ ] Smoke tests, monitoreo y reinicio uno-a-uno de timers.
- [ ] Cosmos read-only durante retención aprobada.
- [ ] Go-live explícitamente aprobado.

## Próximo entregable

QA ya tiene `017..020` aplicadas y verificadas. El smoke rollback-only integral pasó con `portal_runtime` y dejó cero filas sintéticas; las suites completas y builds también pasan. El siguiente entregable es aplicar `017..020` en `PortalSAGWeb`, desplegar el paquete validado manteniendo `dual-read` y `SQL_SECURITY_RUNTIME_ENABLED=false`, confirmar backup/rollback y ejecutar el cutover controlado. Al terminar DDL, `SAGWebDev` debe volver a pertenecer únicamente a `portal_runtime`.
