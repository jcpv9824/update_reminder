# Retiro de Cosmos DB — Portal SAG Web

Estado: **fase 1 en implementación; no autoriza eliminar la cuenta**

## Objetivo

Retirar `erpupdsch4645-cosmos` sin romper rutas poco frecuentes, timers, autenticación, archivos ni recuperación. SQL Server es la fuente operacional; Blob Storage conserva los archivos.

## Fase 1 — canary de independencia

1. Exigir `DATA_BACKEND=sql` y `SQL_SECURITY_RUNTIME_ENABLED=true`.
2. Bloquear toda llamada Cosmos cuando el backend sea SQL.
3. Corregir creación de programaciones, recordatorios programados, usuarios, roles y setup.
4. Ejecutar pruebas SQL-only sin `COSMOS_CONNECTION_STRING`.
5. Desplegar conservando temporalmente la cadena Cosmos.
6. Probar CRUD, permisos, timers, correo, reportes, formatos y descargas.
7. Confirmar cero actividad sobre contenedores Cosmos durante siete días completos.

Un error `Dependencia Cosmos inesperada durante la ejecución SQL` detiene el retiro y debe corregirse antes de continuar.

## Fase 2 — paquete SQL-only

1. Eliminar ramas `cosmos` y `dual-read` de `api/src`.
2. Eliminar `api/src/lib/cosmos.ts`.
3. Retirar `@azure/cosmos` de `package.json` y regenerar `package-lock.json`.
4. Reemplazar o archivar scripts de seed, sanitización, dual-read y rollback.
5. Añadir una prueba CI que rechace `@azure/cosmos`, `getContainer`, `COSMOS_` y `dual-read` dentro del runtime.
6. Desplegar sin `COSMOS_CONNECTION_STRING` ni `COSMOS_DATABASE_NAME`.

## Fase 3 — recuperación y eliminación

1. Generar un último snapshot read-only de los 17 contenedores.
2. Verificar conteos, estados y SHA-256 contra el snapshot aprobado.
3. Cifrar el snapshot y moverlo a almacenamiento inmutable con retención aprobada.
4. Restaurar el backup SQL en QA y validar integridad y arranque.
5. Rotar las claves Cosmos y comprobar que producción continúa saludable.
6. Eliminar la cuenta Cosmos mediante una operación separada y explícitamente aprobada.

## Criterios de salida

- Cero referencias Cosmos en el runtime y el paquete desplegado.
- Cero actividad de contenedores durante la ventana aprobada.
- Todas las rutas y los seis timers funcionan sin variables Cosmos.
- Backup SQL restaurado satisfactoriamente.
- Snapshot final cifrado, inmutable y con retención.
- Rollback actualizado para usar restauración SQL y redeploy, no Cosmos desactualizado.
