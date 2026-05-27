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

Antes de diseñar Fase 4, considerar:

- V14/V16 de `updateSchedules`: frecuencia única (`once`), `completedAt`, `completedReason`, `manualTargetTypes` y excepciones por licenciamiento (`excludedDomainIds`, `excludedDatabaseIds`).
- V15 de clientes: `externalId` opcional, único si existe, y futuro candidato a obligatorio.
- Catálogo cerrado de ambientes operativos: `production`, `test`, `demo`.
- Regla crítica de tareas: `cancelled` + `result = "obsolete"` puede ser reactivada por una programación activa; `completed` sí bloquea duplicados.
