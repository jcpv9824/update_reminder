# Contrato de implementación · Qué hay de nuevo

Estado: implementación local, sin migrar ni desplegar. Este contrato sustituye las secciones obsoletas de `03`–`06`: no menú/Excel, PDF, reasignación del desarrollador, cuarta pestaña ni confirmación de exposición.

## Límites congelados

- API desactivada por defecto: `WHATS_NEW_ENABLED=true` habilita las rutas; sin ella, 404.
- Prototipo simulado independiente: nunca se utiliza como fallback de la API.
- SQL Server 2019; el paquete integrado usa 060–063. No reemplaza las migraciones del catálogo ni de Programaciones. La selección para un desarrollo nuevo usa el catálogo observado del ERP: solo clientes con una fuente ERP autorizada y vigente, activos o con estado no verificado y con presencia en SAG Web confirmada o no verificada. No se ofrecen clientes solo de SAG Admin, inactivos ni confirmados fuera de SAG Web.
- Archivos solo SeaweedFS; conector pendiente. Cargas, lecturas de archivo y envío de reportes responden 503 `almacenamiento_no_disponible` **antes de cualquier escritura**, firma, outbox o éxito.
- El usuario actual, su estado activo, roles y áreas se consultan en SQL por petición. Nunca se acepta autor/desarrollador en JSON. Permiso y área son requisitos independientes.

## DTO y transporte

JSON camelCase; enumeraciones de `api/src/lib/whatsNewModel.ts`. Ruta manual: `{ via: "barra_lateral" | "barra_navegacion", submenus: string[], option: string }`, 1–3 submenús al publicar. Las rutas son idénticas para ambos sistemas. Documentos enriquecidos son JSON TipTap validado en servidor.

`EntryDetail` devuelve `{ id, number, status, type, system, developer: {id, displayName}, clientName, initialTesterId, whatChanged, routes, requiredActions: [{code,label,detail}], attachments, revisions, rounds, findings, participants, log, clientText, etag, createdAt, updatedAt, resultAt, releaseMonth }`. Las rondas incluyen `id, roundNo, revisionNo, holderId, holderName, status, takenAt, closedAt, checklist:[{itemNo,label,checked}], notes:[{id,body,createdById,createdAt}], noteDraft, etag`; hallazgos incluyen `id, number, roundNo, body, createdById, createdAt, annulled:null|{reason,at}`. `clientText` es `null|{showToClients,title,body,etag}`. Sin claves SQL ni localizadores. DTO públicos son tipos diferentes, no `Omit<EntryDetail,...>`.

Listas usan `EntrySummary`, no agregados completos: `{id,number,status,type,system,developer,summary,primaryRoute,initialTesterId,holder:null|{id,displayName},checklistDone,checklistTotal,openFindings,etag,createdAt,updatedAt,resultAt,releaseMonth}`. Detalle se consulta al seleccionar. Listar hace dos consultas SQL acotadas (conteo y página); reportes usan trece consultas por lote de hasta 200 entradas, no por entrada. El directorio de contexto solo consulta IDs referenciados, hasta 200, no todos los usuarios.

Todas las respuestas internas: `Cache-Control: private, no-store`. Errores: `{error,code,details?}` sin errores internos. `ETag` entre comillas, base64 de `row_version`. Mutaciones de entrada requieren `If-Match` de entrada; operaciones de ronda exigen su ETag. Falta versión → 428; obsoleta → 409.

Crear entrada y los comandos POST de entrada/ronda/hallazgo requieren `Idempotency-Key` (8–200 ASCII visible), guardado por actor + operación + llave durante siete días, dentro de la transacción de la operación. Repetición exacta devuelve el snapshot de respuesta original, no el estado actual; cuerpo diferente → 409. Huella canónica incluye operación, destino y cuerpo, no el ETag; replay se resuelve antes de verificar la versión, pero después de validar permiso/área vigentes y confirmar que la entrada sigue siendo visible para ese actor (si no, 404). PUT/PATCH de borrador, checklist, texto para clientes y nota en borrador, y DELETE, requieren ETag pero no llave de idempotencia. Reportes persistentes exigen llave aunque, por ahora, su almacenamiento/envío responde 503 sin efectos. Crear acciones de configuración no exige llave: etiqueta normalizada única (sin diferencias de mayúsculas, tildes o espacios), serializada con bloqueo de catálogo; repetir una creación devuelve la acción existente y no la duplica. Renombrar a una etiqueta existente responde 409 `accion_duplicada`.

## Rutas internas

Base `/api/whats-new`:

- `GET /me`: `{ user:{id,displayName,email}, views, defaultView, areas, permissions, publicEnabled, storageAvailable:false, clientCatalogAvailable:false }`. Permite acceso de opción **o** configuración; un usuario solo de configuración recibe `views:[]`, sin acceso a entradas, cola ni directorio.
- `GET /entries?scope=mine|all&status&type&system&q&page&pageSize`: `{items,total,page,pageSize}`. Sin borradores ajenos salvo `manage`.
- `POST /entries`: borrador parcial (`DraftInSchema`), 201 detalle. Para el cliente recibe `clientId`, nunca un nombre libre. El servidor vuelve a verificar el identificador contra el ERP y conserva el nombre canónico como dato histórico. Omitir el cliente en la edición conserva ese nombre; `null` lo limpia.
- `GET /entries/{id}`; `PUT /entries/{id}/draft`; `DELETE /entries/{id}`.
- `POST /entries/{id}/{publish|correct|take|release|force-release|mark-tested|mark-failed|archive}`. Correct exige `{whatChanged,requiredActions:[{actionCode,detail}],correctionNote}`; forzar/archivar `{reason}`; demás `{}`.
- `PUT /entries/{id}/client-text`: `{showToClients,title,body}`. No se precarga contenido interno automáticamente; imágenes deben ser públicas verificadas. SP crítico no se publica.
- `GET /queue?tab=sin_probar|en_pruebas|probadas&result=sin_errores|fallidas|ambas&month=YYYY-MM&type&system&q&page&pageSize`: estados probados y fallidos juntos en Probadas; filtro antes de paginar y contar. Mes en Bogotá.
- `PATCH /rounds/{id}/checklist`: `{items:[{itemNo,checked}]}`; `POST /rounds/{id}/notes` y `/findings`: `{body}`. `PUT /rounds/{id}/note-draft`: `{body:RichDoc|null}`.
- `POST /findings/{id}/annul`: `{reason}`. Bitácora y rondas previas se conservan; Soltar nunca envía correo.
- `GET /lookups/{support-users|required-actions|recipients|mentionable-users}`. Destinatarios son usuarios activos; no correos libres. `q` acotado y resultados limitados.
- `GET /lookups/clients?q=...`: lista acotada `[{id,label}]` para elegir clientes del ERP. Aplica los permisos de Novedades y el alcance de fuentes del actor; si el origen no está disponible, muestra un error y no usa el maestro antiguo ni datos simulados.
- `GET /config`; `PUT /config/settings` `{publicEnabled}`; `POST /config/actions` `{label}`; `PUT /config/actions/{id}` `{label,active,sortOrder}`. Siempre queda una activa.
- `GET /business-areas`: `[{code,label}]`; `GET/PUT /users/{id}/business-areas` devuelve `{areas,etag}` (PUT recibe `{areas}` + `If-Match`), autorización `configuration.users.view/edit`, actualización de versión de usuario, áreas y auditoría transaccionales; falta versión 428, obsoleta 409.

## Reportes

Solo Probadas, con la misma población visible que la pestaña: `probado` y `archivada` cuentan como aprobadas; `fallida` como fallida. `POST /reports/preview`: `{include:"todas"|"aprobadas"|"fallidas",filters?:{type,system,month,q}}`, respuesta HTML seguro y conteos (máximo 200). No persiste ni envía. `POST /reports`: mismo cuerpo más `recipientIds:string[]` (1–30 activos, únicos); mientras falte almacenamiento devuelve 503 sin efectos.

Reporte persistido futuro: HTML inmutable completo en SeaweedFS, hash del contenido y metadatos de snapshot, además de nombres, resultados y evidencia histórica congelados; nunca regenerarlo desde IDs actuales. `GET /reports/{id}` permite **cualquier usuario activo con sesión** del portal, sin `*.view`, área ni restricción de destinatario. Anónimos reciben 401. Correo con resumen y enlace autenticado; ningún envío automático por hallazgo. Reintentos con igual llave no duplican reporte/correos.

## Público

`GET /api/public/novedades?categoria=todo|nuevas|mejoras&periodo=mes_actual|ultimos_3_meses|ultimo_ano|todo|rango&desde=YYYY-MM-DD&hasta=YYYY-MM-DD&page&pageSize` devuelve `{enabled,items,total,page,pageSize}`. Filtra antes de paginar; fechas Bogotá, rango inclusivo por día. Detalle `GET /api/public/novedades/{publicId}`.

Proyección cerrada `{publicId,category,releaseMonth,title,summary,whereToFind}`; detalle agrega `body` de perfil cliente sin menciones, adjuntos, código ni imágenes internas. Solo entradas `probado`, configuración activa, Mostrar activado, texto/título completos, no SP crítico. Regla de negocio/rediseño se agrupan en Mejora. Nunca cliente, desarrollador, asesores, hallazgos, notas, videos, documentos o ID interno. `Cache-Control:no-store`. Rutas de imágenes públicas permanecen 503 mientras falte conector; sin copia automática de archivos privados.
