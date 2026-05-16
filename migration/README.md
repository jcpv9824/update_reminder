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

Antes de diseñar Fase 4, considerar los campos V14 de `updateSchedules`: frecuencia única (`once`), `completedAt`, `completedReason` y excepciones por licenciamiento (`excludedDomainIds`, `excludedDatabaseIds`).
