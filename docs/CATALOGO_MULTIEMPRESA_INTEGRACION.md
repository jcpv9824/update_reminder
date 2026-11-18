# Catálogo multiempresa: integración local y criterios de activación

Este avance no habilita el catálogo ni ejecuta migraciones en QA o en producción. No forma parte del corte de almacenamiento.

## Flujos integrados

- **Configuración → Conexiones.** Reutiliza perfiles SQL existentes. El registro de fuentes distingue los ERP que suministran clientes de la fuente SAG Admin. Guardar un vínculo sólo registra un borrador: no comprueba la conexión, no publica datos, no habilita lecturas y no cambia permisos de la base remota.
- **Clientes.** Vista de sólo lectura, con filtros iniciales Activos y En SAG Web. El selector parte de todas las fuentes ERP autorizadas para quien consulta. Las fuentes fallidas se muestran como desactualizadas o no disponibles, no como clientes inactivos ni fuera de SAG Web. La vista anterior se conserva hasta el corte deliberado; no es un fallback ante errores del catálogo nuevo.
- **Acceso.** Los endpoints requieren sesión y permiso de Portal. Además, el backend comprueba el acceso a cada ERP en SQL, no a partir de los filtros enviados por el navegador. La migración 034 no siembra nuevos accesos. El contrato de lectura no devuelve identificaciones en claro, contraseñas, hosts ni cadenas de conexión.
- **Preparación de una revisión.** El servicio de carga sólo admite vínculos activos del entorno indicado. Exige una lectura externa completa en una transacción `SNAPSHOT` y conserva la diferencia entre «sin registros» y «no disponible». Entrega al publicador la versión del vínculo y del perfil, el identificador interno de fila, el estado normalizado y un token HMAC del documento; no entrega el documento original. Antes de abrir la fuente, SQL asigna un número de intento que ordena resultados concurrentes independientemente de su hora de finalización. Las coincidencias de SAG Admin sólo se consideran de un emisor cuando existe un mapeo revisado, y las filas sin emisor no permiten afirmar que otros clientes están fuera de SAG Web.

## Interruptores, desactivados por defecto

| Flujo | API | Frontend (compilación) |
| --- | --- | --- |
| Registro de fuentes | `PORTAL_CATALOG_ADMIN_ENABLED=true` | `VITE_PORTAL_CATALOG_ADMIN_ENABLED=true` |
| Lectura de clientes | `PORTAL_CATALOG_READ_ENABLED=true` | `VITE_PORTAL_CATALOG_READ_ENABLED=true` |

La API requiere un entorno explícito `PORTAL_SAG_ENVIRONMENT=qa` o `production`. El lector requiere una versión de la clave de emparejamiento en `PORTAL_CATALOG_MATCH_KEY_VERSION`, coincidente con las revisiones publicadas. Esto no es la clave ni autoriza guardarla en el repositorio.

## Antes de activar

1. Integrar estas migraciones encima de la 030 ya publicada; certificar el ejecutor de migraciones y sus verificaciones en QA. Los hashes de 031–034 están fijados sobre texto LF.
2. Integrar y certificar la carga de revisiones con cuentas de sólo lectura, credenciales referenciadas y pruebas de aislamiento por fuente. Un borrador no cuenta como fuente habilitada y un endpoint que responde no equivale a un catálogo alimentado.
3. Certificar las relaciones cliente–dominio–base, el catálogo de licencias, la deduplicación en la programación y en tareas, el tratamiento al corte y el conteo de usuarios activos. El código base para destinos y conteo no prueba por sí solo los flujos de extremo a extremo ni el esquema `usuarios` de una base remota.
4. Deshabilitar la escritura de clientes heredada desde el servidor al cortar, una vez migrados sus consumidores. Verificar permisos, historial, tareas, reportes y reversión en QA antes de habilitar los interruptores de producción.
