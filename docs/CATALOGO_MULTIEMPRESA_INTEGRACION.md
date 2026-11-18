# Catálogo multiempresa: integración local y criterios de activación

Este avance no habilita el catálogo. Es independiente del corte de almacenamiento.

La primera ejecución del paquete de esquema en `PortalSAGWeb-TEST` registró las cinco migraciones 031–035 y pasó la verificación del ejecutor. Una consulta posterior de solo lectura confirmó 0 fuentes activas, 0 revisiones publicadas y 0 nuevas ejecuciones de tareas. No se publicó el API de QA ni se modificó producción.

## Flujos integrados

- **Configuración → Conexiones.** Reutiliza perfiles SQL existentes. El registro distingue los ERP que suministran clientes de SAG Admin. Guardar un vínculo sólo crea un borrador. **Verificar** necesita el permiso de prueba y comprueba TLS, permisos de solo lectura, esquema y una fila como máximo, sin mostrar datos. **Activar** necesita además el permiso de edición, repite la prueba y guarda la certificación sólo si el vínculo y el perfil siguen siendo los mismos. También permite revalidar una fuente activa cuando el perfil cambió; no cambia su rol ni la sustituye. Verificar o activar no publica revisiones ni cambia permisos de la base remota.
- **Clientes.** Vista de sólo lectura, con filtros iniciales Activos y En SAG Web. El selector parte de todas las fuentes ERP autorizadas para quien consulta. Las fuentes fallidas se muestran como desactualizadas o no disponibles, no como clientes inactivos ni fuera de SAG Web. La vista anterior se conserva hasta el corte deliberado; no es un fallback ante errores del catálogo nuevo.
- **Acceso.** Los endpoints requieren sesión y permiso de Portal. Además, el backend comprueba el acceso a cada ERP en SQL, no a partir de los filtros enviados por el navegador. La migración 034 no siembra nuevos accesos. El contrato de lectura no devuelve identificaciones en claro, contraseñas, hosts ni cadenas de conexión.
- **Preparación de una revisión.** El servicio de carga sólo admite vínculos activos del entorno indicado. Exige una lectura externa completa en una transacción `SNAPSHOT` y conserva la diferencia entre «sin registros» y «no disponible». Entrega al publicador la versión del vínculo y del perfil, el identificador interno de fila, el estado normalizado y un token HMAC del documento; no entrega el documento original. Antes de abrir la fuente, SQL asigna un número de intento que ordena resultados concurrentes independientemente de su hora de finalización. Las coincidencias de SAG Admin sólo se consideran de un emisor cuando existe un mapeo revisado, y las filas sin emisor no permiten afirmar que otros clientes están fuera de SAG Web.
- **Evidencia de SAG Admin.** La migración 035 permite sellar y conservar el dominio candidato, el ambiente, las letras de licenciamiento aceptadas y las fechas conocidas de inicio por ambiente. El SELECT emite únicamente el hostname y los tres días autorizados; no devuelve la URL completa ni el JSON original. Ausencia o invalidez se conservan como desconocidas. El hostname por sí solo no habilita una conexión ni acredita una base o un despliegue.
- **Corte de tareas.** La reconciliación local compara la versión de la ejecución y de cada vínculo y guarda estado e historial en una transacción. Antes del corte, un vínculo no comprobado deja de verse; después, la decisión se toma con evidencia vigente a la hora original del corte. Una tarea física sigue visible si conserva un vínculo activo, que es el que se muestra en el tablero. El registro de la ejecución y la generación heredada comparten un bloqueo por tipo y fecha para no generar la misma base o dominio dos veces. La limpieza heredada no cancela ejecuciones del catálogo. La mutación y el acceso a credenciales heredados no utilizan un vínculo de catálogo retirado ni una tarea histórica como autorización. No se eliminan las filas de tareas o programaciones.
- **Conteo de usuarios.** El adaptador SQL admite una vista de agregado aprobada o una columna de `dbo.usuarios` certificada con tipo y valores de estado explícitos. Un destino no certificado, sin conectividad o sin permisos de lectura produce «No pudimos obtener los datos de esta base de datos.»; nunca un conteo de cero inferido.

## Interruptores, desactivados por defecto

| Flujo | API | Frontend (compilación) |
| --- | --- | --- |
| Registro de fuentes | `PORTAL_CATALOG_ADMIN_ENABLED=true` | `VITE_PORTAL_CATALOG_ADMIN_ENABLED=true` |
| Lectura de clientes | `PORTAL_CATALOG_READ_ENABLED=true` | `VITE_PORTAL_CATALOG_READ_ENABLED=true` |

La API requiere un entorno explícito `PORTAL_SAG_ENVIRONMENT=qa` o `production`. El lector requiere una versión de la clave de emparejamiento en `PORTAL_CATALOG_MATCH_KEY_VERSION`, coincidente con las revisiones publicadas. Esto no es la clave ni autoriza guardarla en el repositorio.

## Antes de activar

1. Repetir la verificación de esquema 031–035 en QA cuando se arme el candidato final. `Apply-PortalSAGWeb-PendingMigrationsThroughSession.ps1 -Environment qa -IncludeCatalog` suma 031–035 al paquete. Los hashes de 031–035 están fijados sobre texto LF. El API con guardas de tareas debe instalarse después de la migración 032; el publicador SAG con evidencia, después de la 035.
2. Integrar y certificar la carga de revisiones con cuentas de sólo lectura, credenciales referenciadas y pruebas de aislamiento por fuente. Un borrador no cuenta como fuente habilitada y un endpoint que responde no equivale a un catálogo alimentado.
3. Conectar y certificar las relaciones cliente–dominio–base, el catálogo de licencias, la deduplicación en la programación y en tareas, y el reporte de usuarios activos. El código de comparación, corte y conteo no habilita por sí solo el programador, no identifica destinos físicos sin evidencia aprobada y no prueba el esquema `usuarios` de una base remota. Antes de abrir conexiones desde una tarea quedan pendientes la autorización por asignación y vínculo vigente y la auditoría de apertura, revelación y copia.
4. Deshabilitar la escritura de clientes heredada desde el servidor al cortar, una vez migrados sus consumidores. Verificar permisos, historial, tareas, reportes y reversión en QA antes de habilitar los interruptores de producción.

## Preflight de un perfil inicial

Después de compilar el API, ejecutar desde `api/`: `node scripts/verify-catalog-origin.cjs <archivo-env-fuera-del-repo> <erp_v1|sag_admin_v1>`. El comando sólo devuelve el contrato y el estado; no copia el archivo, no publica datos ni modifica la configuración. El servidor debe ser un hostname con puerto numérico opcional (`servidor,puerto` o variable separada). Las credenciales nunca se pasan por argumentos.

El inventario actual de Azure no tiene un API o frontend dedicado de QA. El workflow principal apunta al API de producción, así que no se usa como prueba de QA. La base `PortalSAGWeb-TEST` sí está disponible; al revisar, no tenía perfiles SQL guardados para certificar.
