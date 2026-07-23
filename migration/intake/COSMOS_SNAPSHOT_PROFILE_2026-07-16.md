# Perfil estructural del snapshot Cosmos

Fecha: **2026-07-16**

Estado: **Gate B aprobado para construcción no productiva; 0 errores críticos**

Este informe contiene únicamente conteos, nombres de campos y tipos. No contiene valores de documentos, PII, hashes, IDs de registros ni secretos.

## Resultado del export

- Base fuente: `erp-update-scheduler`.
- Contenedores esperados/exportados: **17/17**.
- Documentos totales: **2.890**.
- Errores de manifest, archivo, SHA-256, conteo o ID: **0**.
- IDs ausentes o duplicados detectados: **0**.
- Rutas con posible secreto en texto plano según perfil estructural refinado: **0**.
- El snapshot está bajo `migration/backups/`, protegido por `.gitignore`, y debe tratarse como dato productivo restringido.

La ausencia de alertas heurísticas no reemplaza el saneamiento de auditoría ni la validación específica de secretos antes de cargar staging.

## Conteos por contenedor

| Contenedor | Documentos |
|---|---:|
| `users` | 7 |
| `clients` | 40 |
| `domains` | 45 |
| `databases` | 55 |
| `updateSchedules` | 10 |
| `updateTasks` | 370 |
| `licenseModules` | 21 |
| `licenseAssignments` | 0 |
| `auditLogs` | 2.182 |
| `appSettings` | 1 |
| `emailNotifications` | 6 |
| `securityRateLimits` | 9 |
| `authSessions` | 88 |
| `roles` | 2 |
| `fuentesFormatos` | 13 |
| `formatosImpresion` | 37 |
| `publicDownloads` | 4 |

Los cuatro documentos de descargas públicas tienen discriminator válido: dos `section` y dos `document`. Las seis notificaciones existentes son `administrative_reminder`.

## Delta real frente al mapeo documental

La comparación usa nombres de campos reales contra `docs/COSMOS_TO_SQL_MIGRATION_MATRIX.md`. Un campo agrupado conceptualmente pero no enumerado continúa siendo un gap de especificación: el importador necesita una regla inequívoca por campo.

| Contenedor/campo | Evidencia | Decisión canónica cerrada |
|---|---|---|
| `updateTasks.rootScheduleId` | 158 de 370 tareas; `string` | `primary_schedule_key` nullable; `task_sources` es autoritativa y el schedule se preserva como tombstone. |
| `authSessions.mfaVerifiedAt` | 4 de 88 sesiones; `string` | Raw-only legado; no se migran sesiones activas ni se crea columna MFA operativa. |
| `formatosImpresion.codigoImportacion` | 37 de 37; `string` | `content.print_formats.legacy_import_code`; no participa en identidad/filtros. |
| `formatosImpresion.estadoImportacion` | 37 de 37; `string` | `legacy_import_status`; se preserva sin inventar enum. |
| `formatosImpresion.variante` | 37 de 37; `string` | `legacy_variant`; no participa en unicidad. |
| `appSettings` | 33 campos top-level antes agrupados | Sección 10 canónica ahora los mapea individualmente a settings/tablas hijas. |
| `securityRateLimits` | 3 campos reales no enumerados individualmente | Documentar `blockedUntil`, `keyType` y `windowStartedAt`; el estado no se importa, pero el diseño runtime SQL/Redis debe conservar el contrato. |
| `authSessions` | 7 campos reales no enumerados individualmente | Documentar rotación, revocación, reemplazo y expiración, aunque las filas antiguas no se importen. |
| `formatosImpresion` | 6 campos reales no enumerados individualmente | Completar metadata de archivo, activo y los tres campos de importación. |
| `publicDownloads` | 3 campos reales no enumerados individualmente | Enumerar `activo`, nombre original y MIME, además de la regla Blob/versiones. |

## Resultado de cobertura

`migration/tools/validate-mapping-coverage.js` comparó el perfil real con la matriz canónica:

```text
Mapping coverage passed for 17 container(s); 0 uncovered observed field paths.
```

## Resultado semántico

`migration/tools/validate-cosmos-business-data.js` ejecutó 42 controles sobre el snapshot sin emitir valores:

```text
Critical errors: 0; warnings: 462; checks: 42
```

| Warning histórico | Cantidad | Transformación aprobada |
|---|---:|---|
| Grupos dedupe migrables | 32 | 370 documentos producen 338 tareas lógicas + 32 aliases; cancelled/obsolete se convierte en history inferido. |
| Tareas terminales con dominio master ausente | 4 | FK nullable solo para import histórico, source snapshots obligatorios, `is_historical_orphan=1`. |
| Tareas terminales con destino ausente | 2 | Misma regla de histórico; runtime nuevo no puede crearlas. |
| Tarea completada con jerarquía histórica distinta | 1 | FK usa jerarquía real del target; snapshots conservan el valor histórico. |
| Tareas con primary/root schedule ausente | 91 | Conservar `primary_schedule_source_id`; FK nullable. Solo 2 raíces distintas. |
| Filas de sources con schedule ausente | 331 | Conservar `schedule_source_id`; FK nullable. 225 referencias distintas, sin inventar schedules. |
| Usuario activo sin roles | 1 | Preservar cero filas en `security.user_roles`; mantiene acceso deny-all del runtime y no asigna un rol implícito. |

Los warnings suman 462 y están completamente explicados por esas siete reglas. Cualquier snapshot posterior debe volver a ejecutar ambos validadores; un error crítico nuevo reabre Gate B.

## Decisión de arquitectura

El inventario, mapeo y semántica de anomalías quedan cerrados para este snapshot. El siguiente gate es C:

1. generar DDL no productivo desde `SQL_SERVER_PHYSICAL_DATA_DICTIONARY.md`;
2. crear staging/importador con las siete transformaciones anteriores;
3. construir dos bases limpias idénticas;
4. validar permisos y reconciliación antes de cualquier DDL productivo.

El snapshot y `profile.json` no se copian a documentación ni se versionan. Permanecen en la carpeta restringida ignorada por Git.
