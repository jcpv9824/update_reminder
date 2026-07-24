# Retiro de Cosmos DB — Portal SAG Web

Estado: **fase 2 terminada y validada localmente; lista para rehearsal, no autoriza eliminar la cuenta**

## Objetivo

Retirar `erpupdsch4645-cosmos` sin romper rutas poco frecuentes, timers, autenticación, archivos ni recuperación. SQL Server es la fuente operacional; los archivos migrarán al bucket privado S3/MinIO del proveedor.

## Fase 1 — canary de independencia

1. Exigir `DATA_BACKEND=sql` y `SQL_SECURITY_RUNTIME_ENABLED=true`.
2. Bloquear toda llamada Cosmos cuando el backend sea SQL.
3. Corregir creación de programaciones, recordatorios programados, usuarios, roles y setup.
4. Ejecutar pruebas SQL-only sin `COSMOS_CONNECTION_STRING`.
5. Desplegar conservando temporalmente la cadena Cosmos.
6. Probar CRUD, permisos, timers, correo, reportes, formatos y descargas.
7. Confirmar cero actividad sobre contenedores Cosmos durante siete días completos.

Un error `Dependencia Cosmos inesperada durante la ejecución SQL` detiene el retiro y debe corregirse antes de continuar.

### Canary productivo — 2026-07-23

- Código: commit `32cc033` (`Guard SQL runtime from Cosmos fallback`).
- Despliegue activo: `b5d4f55f087c4c90bedc4add13bdaef8`, completado correctamente a las `2026-07-23T22:26:43Z`.
- Configuración verificada: backend `sql`, seguridad SQL habilitada, mantenimiento desactivado y cero timers deshabilitados.
- Smoke tests iniciales: estado runtime `200`, descargas públicas `200`, fuentes y formatos públicos `200`, activo PDF servido desde Blob `200` y frontera protegida sin sesión `401`.
- Application Insights desde el despliegue: cero requests fallidas, cero `5xx`, cero excepciones, cero trazas de error y cero activaciones del guard Cosmos.
- Métrica nativa `TotalRequests` de Cosmos desde el despliegue: cero solicitudes a contenedores en la primera comprobación.
- La cadena Cosmos permanece configurada únicamente para el período canary. El conteo de siete días comienza en `2026-07-23T22:26:43Z`; cualquier actividad posterior reinicia la ventana.

## Fase 2 — paquete SQL-only

1. Eliminar ramas `cosmos` y `dual-read` de `api/src`.
2. Eliminar `api/src/lib/cosmos.ts`.
3. Retirar `@azure/cosmos` de `package.json` y regenerar `package-lock.json`.
4. Reemplazar o archivar scripts de seed, sanitización, dual-read y rollback.
5. Añadir una prueba CI que rechace `@azure/cosmos`, `getContainer`, `COSMOS_` y `dual-read` dentro del runtime.
6. Desplegar sin `COSMOS_CONNECTION_STRING` ni `COSMOS_DATABASE_NAME`.

### Evidencia fase 2 — 2026-07-23

- Eliminadas todas las ramas `cosmos` y `dual-read` del runtime.
- Eliminados `api/src/lib/cosmos.ts`, `api/src/lib/taskCleanup.ts` y `@azure/cosmos`.
- Convertidos a SQL los maestros, seguridad, sesiones, rate limiting, auditoría, configuración, reportes, licencias, programaciones, tareas, timers, formatos y descargas.
- Los binarios permanecen fuera de SQL. Durante la transición siguen en el almacenamiento legado y sólo se retira éste después de transferir y reconciliar cada objeto en S3/MinIO.
- Retirados los scripts de exportación, seed y saneamiento que dependían del SDK documental.
- Añadido `npm run check:no-cosmos-runtime`.
- API compilada y 379 pruebas backend aprobadas.
- Frontend compilado y pruebas aprobadas.
- Pendiente: construir el artefacto reproducible, desplegar el segundo canary sin las dos variables heredadas y ejecutar los smoke tests productivos.

## Fase 3 — recuperación y eliminación

1. Generar un último snapshot read-only de los 17 contenedores.
2. Verificar conteos, estados y SHA-256 contra el snapshot aprobado.
3. Cifrar el snapshot y moverlo a almacenamiento inmutable con retención aprobada.
4. Restaurar el backup SQL en QA y validar integridad y arranque.
5. Rotar las claves Cosmos y comprobar que producción continúa saludable.
6. Eliminar la cuenta Cosmos mediante una operación separada y explícitamente aprobada.

La ventana de siete días iniciada el `2026-07-23T22:26:43Z` termina como mínimo el
`2026-07-30T22:26:43Z`. Cualquier solicitud observada reinicia el conteo. Antes de
esa fecha solo se permite el rehearsal y el canary SQL-only; no se permite eliminar
la cuenta.

## Criterios de salida

- Cero referencias Cosmos en el runtime y el paquete desplegado.
- Cero actividad de contenedores durante la ventana aprobada.
- Todas las rutas y los seis timers funcionan sin variables Cosmos.
- Backup SQL restaurado satisfactoriamente.
- Snapshot final cifrado, inmutable y con retención.
- Rollback actualizado para usar restauración SQL y redeploy, no Cosmos desactualizado.
