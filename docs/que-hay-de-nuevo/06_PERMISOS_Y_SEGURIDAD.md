# Qué hay de nuevo · Permisos y seguridad

> Histórico de diseño: prevalece [11_CONTRATO_IMPLEMENTACION.md](11_CONTRATO_IMPLEMENTACION.md). El desarrollador es inmutable; no existe reasignación. Los reportes requieren usuario activo autenticado, sin requisito de opción, área ni destinatario; no son anónimos. Cambiar áreas exige `configuration.users.edit`, ETag vigente y auditoría transaccional; la clasificación nunca concede permisos por sí sola.

Estado: **diseño, sin construir**.
Fuentes: `api/src/lib/permissionModel.ts`, `roleDefinitions.ts`, `rateLimit.ts`, `audit.ts`, `docs/PERMISSIONS_AND_TASK_VISIBILITY_DESIGN.md`, `ARCHITECTURE.md`, y `02` (QA-15 y QA-16).
**La autorización la decide el backend.** Ocultar menús, botones o rutas en el frontend es solo comodidad (`06` §9).

## 1. Claves de permiso

Siguen `<módulo>.<opción>.<acción>` y van en `PERMISSION_CATALOG`. La migración 032 las inserta en `security.permissions` y las concede a `super_admin`.

| Clave | Etiqueta | Qué permite |
|---|---|---|
| `updates.whats_new.view` | Ver | Abrir **Actualizaciones › Qué hay de nuevo**. Ningún endpoint interno responde sin esta clave. |
| `updates.whats_new.author` | Crear y editar entradas | Visión Desarrollador: crear, guardar borrador, publicar, eliminar borrador y corregir **sus** entradas. **Exige el área Desarrollo.** |
| `updates.whats_new.test` | Probar entradas | Visión Asesor: tomar, soltar, checklist, notas, hallazgos y marcar probado o fallida. **Exige el área Soporte.** |
| `updates.whats_new.publish_client` | Publicar a clientes | Editar el texto para clientes y su visibilidad cuando la entrada está en `probado`. **Exige el área Soporte.** |
| `updates.whats_new.report` | Reportes | Generar, descargar y enviar reportes de las entradas que puede ver. **No exige área.** |
| `updates.whats_new.view_all` | Ver todas (lectura) | Visión de solo lectura de todas las entradas publicadas, para Gerencia o Gestión de Proyectos. **No exige área.** |
| `configuration.whats_new.view` | Ver | Abrir **Configuración › Qué hay de nuevo** |
| `configuration.whats_new.manage` | Administrar | Menú de referencia, acciones predefinidas e interruptor público. Además: forzar Soltar, reasignar autor, archivar, eliminar cualquier borrador y anular cualquier hallazgo (QA-07, QA-08, QA-10 y QA-26). **No exige área.** |

- Las acciones son de la opción, no CRUD genérico, como pide `PERMISSIONS_AND_TASK_VISIBILITY_DESIGN.md`.
- `view_all` y `manage` no conceden por sí mismos `author` ni `test`.

## 2. Área y permiso combinados

La regla es `permiso && área`, con `area ∈ security.user_business_areas` del usuario. Se consulta **en cada petición**: no se guarda en el JWT, así que un cambio de área aplica de inmediato (QN-PER-12).

| Acción | Permiso | Área | `super_admin` |
|---|---|---|---|
| Crear, editar, publicar, corregir y eliminar sus borradores | `author` | Desarrollo | Necesita el **área** (QA-16) |
| Tomar, soltar, checklist, notas, hallazgos, marcar | `test` | Soporte | Necesita el **área** (QA-16) |
| Texto para clientes en `probado` | `publish_client` | Soporte | Necesita el **área** (**Decisión propuesta**: la decisión de qué ve el cliente es de Soporte, `01` §1) |
| Texto para clientes en `en_pruebas` | Tener la ronda (que ya exige `test` y Soporte) | Soporte | — |
| Reportes | `report` | — | Sin área (QA-15) |
| Lectura de todas las publicadas | `view_all` | — | Sin área |
| Configuración y acciones administrativas | `configuration.whats_new.view` / `.manage` | — | Sin área (QA-15) |

`super_admin` tiene todas las claves (`hasPermissionFromRoles`). La única excepción del módulo es que **el área no se omite** para crear ni para probar. Así se cumple la regla «solo alguien que tenga esta marca» y H-01 sigue protegido.

## 3. Visiones

`GET /api/whats-new/me` calcula `views`:

| Visión | Condición |
|---|---|
| `desarrollador` | `author` y área Desarrollo |
| `asesor` | `test` y área Soporte |
| `lectura` | `view_all` o `report`, y ninguna de las anteriores |

- Si hay varias, se muestra el selector de visión (H-01).
- Con `view` y ninguna visión, la página dice «No tienes una visión asignada en Qué hay de nuevo» y la API de listas responde 403 `area_requerida` o `sin_permiso`.

## 4. Reglas por objeto

Viven en `whatsNewAccess.ts` y se aplican en el servicio **dentro de la transacción**, después de leer la fila con bloqueo, nunca antes, para que no haya carreras entre la comprobación y el uso.

| Regla | Detalle |
|---|---|
| Ver un borrador | Solo su autor vigente y `manage`. Para cualquier otro: **404** (no 403), para no revelar que existe |
| Ver una entrada publicada (`sin_probar` a `archivada`) | `view` **y** (visión `desarrollador`, `asesor` o `lectura`). Los desarrolladores ven todas en solo lectura (QA-03) |
| Ver una entrada `eliminada` | Solo `manage` |
| Editar el borrador, publicar, eliminar | Autor vigente (`author_user_key = actor`) + `author` + Desarrollo, en estado `borrador`. Otro desarrollador: 403 `no_es_autor` (QN-PER-09) |
| Corregir | Autor vigente + `author` + Desarrollo, en `sin_probar` o `fallida`. En `en_pruebas`: 409 |
| Tomar | `test` + Soporte, estado `sin_probar`, y el actor **no** está en `whats_new.entry_contributors` (creó, editó, publicó, corrigió o fue autor; QA-04, H-01). 403 `autor_no_puede_probar` |
| Acciones de la ronda (checklist, nota, hallazgo, soltar, marcar) | `round.status = 'tomada'` **y** `holder_user_key = actor` **y** el actor sigue con `test` + Soporte. Si perdió el área o el permiso: 403, y solo `manage` puede forzar Soltar (QN-PER-12) |
| Texto para clientes | En `en_pruebas`, quien tiene la ronda. En `probado`, `publish_client` + Soporte. En cualquier otro estado: 409 |
| Visibilidad para clientes | Bloqueada si es `sp_critico`, o si es `nuevo` sin «Disponible para todos los clientes» (QA-01). El disparador de SQL lo repite. El nombre del cliente nunca sale en la API pública. |
| Anular un hallazgo | Quien lo registró, con su ronda todavía `tomada`, o `manage` |
| Archivar, reasignar autor, forzar Soltar | `manage`, con motivo de 10 a 500 caracteres. Reasignar exige un usuario activo con `author` y Desarrollo |
| Leer un archivo interno | Puede ver la entrada del archivo. Un `fileId` de otra entrada, inexistente o no visible: 404 |
| Cargar un archivo | Puede editar el contenido de destino (`05` §5.1) |
| Reporte de una entrada o pestaña | `report` + cada entrada incluida es visible para el actor (los borradores nunca entran) |
| PDF de un reporte | Quien lo generó, un destinatario de ese reporte (`report_recipients`), o `report`. Para cualquier otro: 404 |
| Asesor a cargo | Usuario activo con área Soporte, validado al **publicar** (QA-05). Tiene prioridad, no exclusividad (QA-02) |

Los identificadores son UUID o GUID aleatorios, pero **no se usan como secreto**: cada lectura vuelve a comprobar el permiso.

## 5. Página pública

| Regla | Detalle |
|---|---|
| Exposición | Solo los campos de `PublicCardDto` y `PublicDetailDto` (`04` §11). Hay una prueba de contrato que compara las claves exactas de la respuesta con una lista permitida. |
| Filtro | Se aplica **en SQL**, siempre completo (publicación activa, `probado`, mostrar, no SP crítico, Nuevo solo con confirmación, título y cuerpo presentes). Si cualquier condición falla, el resultado es el mismo que si la entrada no existiera. |
| Identificadores | `publicId` es un GUID con `NEWID()`, sin relación con `source_id` ni con `entry_number` (QA-23). Las imágenes usan `fileId` de archivos `cliente_imagen`, distintos de los internos (`05` §6.3). |
| Enumeración | Mismo 404 y mismo cuerpo para un id mal formado, inexistente u oculto. La lista tiene como máximo 100 elementos, sin paginación ni búsqueda (QA-22). |
| Caché | `Cache-Control: no-store` en todo (QA-21): apagar la publicación o archivar una entrada aplica en la siguiente petición. |
| Encabezados | `X-Content-Type-Options: nosniff` y `Referrer-Policy: no-referrer`. La página `/novedades` del frontend hereda la CSP de Static Web Apps; `img-src` debe incluir el origen de storcube para seguir el 302. |
| Sin sesión | Los endpoints públicos no leen el token ni las cookies. La página no hace llamadas autenticadas. |

## 6. Límites de frecuencia

Se agregan a `RATE_LIMIT_POLICIES` y se aplican con `enforceRequestRateLimit`.

| Ámbito | Política | Clave |
|---|---|---|
| `whats_new_public` | 120 solicitudes / 300 s; bloqueo 300 s | IP |
| `whats_new_public_file` | 300 / 300 s; bloqueo 300 s | IP |
| `whats_new_upload` | 60 autorizaciones / 600 s; bloqueo 900 s | IP e identidad |
| `whats_new_report_generate` | 20 / 3 600 s | Identidad |
| `whats_new_report_send` | 10 / 3 600 s; bloqueo 3 600 s | IP e identidad |
| `whats_new_menu_upload` | 10 / 3 600 s | Identidad |

- Además están las cuotas de `05` §1: 200 cargas y 1 GB por usuario al día, y 500 MB por entrada.
- **Costo conocido:** `rateLimit.ts` escribe una fila en `security.rate_limits` por solicitud limitada. En la página pública eso es una escritura en SQL por visita. Con el tráfico esperado (clientes de P&A) se acepta. Si la página crece, se pasa a un límite en el borde (Front Door o Static Web Apps).
- `getRequestIp` usa el último salto de `X-Forwarded-For`. QA debe confirmar en el entorno real que ese salto es el del proxy de Azure y no un valor que el cliente pueda falsificar.

## 7. Auditoría

Se registra con `writeAuditLog` en la misma transacción que la operación. Cada acción nueva necesita su esquema en `ACTION_METADATA_SCHEMAS` y cada entidad nueva el suyo en `ENTITY_SNAPSHOT_SCHEMAS`.

- **Nunca** se registran texto enriquecido, texto plano, títulos para clientes, motivos libres, URL firmadas, localizadores, correos de destinatarios ni nombres de archivo.
- Sí se registran IDs, estados, conteos, códigos, tamaños y longitudes. Los motivos quedan en `entry_status_events.reason_text`; la auditoría solo guarda `reasonLength`.

| `entity_type` | `action` | Metadatos permitidos |
|---|---|---|
| `user` | `user_business_areas_updated` | `before: AreaCode[]`, `after: AreaCode[]` |
| `whats_new_entry` | `whats_new_entry_created`, `_published`, `_corrected`, `_deleted`, `_archived`, `_author_reassigned` | `entryNumber`, `fromStatus`, `toStatus`, `revisionNo`, `routeCount`, `actionCount`, `reasonLength`, `previousAuthorId`, `newAuthorId` |
| `whats_new_entry` | `whats_new_round_taken`, `_released`, `_force_released`, `_marked_tested`, `_marked_failed` | `roundNo`, `revisionNo`, `fromStatus`, `toStatus`, `checklistDone`, `checklistTotal`, `findingsInRound`, `reasonLength` |
| `whats_new_entry` | `whats_new_finding_registered`, `whats_new_finding_annulled`, `whats_new_note_registered` | `roundNo`, `findingNo`, `textLength` |
| `whats_new_entry` | `whats_new_client_text_updated` | `showToClients`, `availableToAllClients`, `titleLength`, `bodyLength`, `imageCount`, `visibilityChanged` |
| `whats_new_file` | `whats_new_file_upload_authorized`, `_completed`, `_rejected` | `entryId`, `fileId`, `purpose`, `kind`, `byteCount`, `rejectionCode` |
| `whats_new_report` | `whats_new_report_generated`, `_downloaded`, `_sent` | `scope`, `tab`, `content`, `entryCount`, `recipientCount`, `recipientsWithoutAccess` |
| `whats_new_config` | `whats_new_public_setting_changed`, `whats_new_action_created`, `_updated`, `_reordered`, `whats_new_menu_uploaded`, `_activated`, `_discarded` | `publicEnabled`, `actionId`, `active`, `menuVersionNo`, `system`, `nodeCount`, `warningCount`, `routesRecalculated` |
| `whats_new_entry` | `whats_new_access_denied` | `operation`, `reasonCode`, solo en reglas por objeto (no en 401). Muestreado: uno por actor y operación por minuto |

- El guardado del borrador y el autoguardado **no** se auditan, para no inundar la auditoría con una fila cada 30 s. Quedan en `updated_at` y `updated_by`, y en `entry_contributors`.
- Las transiciones también quedan en `entry_status_events`.

## 8. Modelo de amenazas

| Amenaza | Vector | Control | Prueba |
|---|---|---|---|
| XSS almacenado por el texto enriquecido | JSON manipulado con `<script>`, atributos `on*`, `style`, `src` externo o `javascript:` | No se guarda HTML. Validador cerrado de nodos, marcas y atributos (`05` §8). TipTap renderiza con el mismo esquema, sin `innerHTML`. El texto plano se escapa en el PDF y el correo. | QN-RTX-*: carga de vectores OWASP y JSON fuera de esquema → 400; renderizar no ejecuta nada |
| XSS por archivos | SVG o HTML subido como imagen; PDF con JavaScript | Lista cerrada de tipos y firma; sin SVG ni HTML; MIME forzado al servir; `nosniff`; Word y Excel siempre `attachment` | QN-CAR-*: polígloto PNG+HTML, SVG renombrado, MIME falso |
| Mención suplantada | `mention.label` con otro nombre | El servidor vuelve a escribir `label` con el nombre vigente; `id` debe existir | Caso unitario |
| SSRF | Enlaces, URL de adjuntos, imágenes externas | El servidor **nunca** pide URL de usuarios: sin vista previa ni comprobación; las imágenes solo por `fileId` interno | Revisión de código: no hay `fetch` con datos del usuario |
| Redirección abierta | 302 de archivos | `Location` siempre sale de `createPrivateObjectUrl` sobre un localizador de SQL; nunca de la petición | Caso: parámetros de la petición no alteran `Location` |
| IDOR en entradas | Cambiar `{id}` por el de otra entrada o un borrador ajeno | Reglas de §4 en el servicio; borradores ajenos → 404 | QN-PER-09 y QN-PER-10 |
| IDOR en archivos | `fileId` de otra entrada en el JSON o en `GET files` | El validador exige la misma entrada; la lectura vuelve a comprobar la entrada | Caso: `fileId` cruzado → 400 en el guardado, 404 en la lectura |
| Fuga pública | Notas, hallazgos, cliente, nombres o imágenes internas | DTO público con lista permitida; filtro en SQL; imágenes `cliente_imagen` copiadas; menciones eliminadas | QN-VIS-*, QN-PUB-* y prueba de contrato de claves |
| Enumeración pública | Recorrer IDs | GUID aleatorio, 404 uniforme, límite por IP, máximo 100 en la lista | QN-PUB-* |
| Abuso de carga | Archivos enormes, muchos archivos, contenido distinto del declarado, URL de escritura reutilizada | Límites declarados y reales; cuotas; firma, tamaño y SHA-256 al completar; URL de 300 s ligada a la clave y al tipo; una sola emisión; barrido de pendientes | QN-CAR-* |
| Bomba ZIP o XML | Libro del menú | Límites de `05` §10, sin DTD | QN-MEN-12 y QN-MEN-13 |
| DoS del validador | JSON profundo o enorme | Límite de bytes antes de analizar, recorrido iterativo, `L_NODOS` y `L_PROF` | QN-RTX-08 con tiempo medido |
| Abuso de correo | Enviar a direcciones arbitrarias, spam, encabezados inyectados | Solo IDs de usuarios activos; correos sacados de SQL; máximo 30; límite 10 por hora; asunto de plantilla fija; mensaje escapado y de 500 caracteres como máximo; enlace con `frontendBaseUrl` de la configuración, nunca del `Host` | QN-REP-* |
| Destinatario sin acceso | Reporte Completo con notas internas a alguien sin la opción | Advertencia con `hasOptionAccess` y confirmación `confirmExposure` (QA-27); el PDF solo lo abre quien lo generó, un destinatario o `report` | QN-REP-*; **requiere confirmación del propietario** |
| Carrera en transiciones | Dos asesores toman a la vez; marcar mientras otro suelta | `UPDLOCK` + `row_version` + índice único de la ronda abierta + idempotencia | QN-CON-* y QN-EST-05 |
| Escalada por roles | Darse `author` o un área | Las áreas solo con `configuration.users.edit` y quedan auditadas; los permisos solo con `configuration.roles.manage_permissions` | QN-USR-* |
| Alterar la historia | `UPDATE` o `DELETE` de hallazgos, revisiones o eventos | Disparadores con `THROW` (efectivos aunque `SAGWebDev` sea `db_owner`) más `DENY` | QN-SQL-07 y caso SQL directo |
| Fuga en logs | URL firmadas o contenido en logs y auditoría | Esquemas de auditoría con lista permitida; las respuestas idempotentes nunca guardan URL; los logs de Functions sin cuerpos | Revisión de logs en QA (QN-PUB-14) |

## 9. Frontend: solo comodidad

- La ruta y el menú se muestran según `/me`. Los botones según `capabilities` del detalle.
- Un botón deshabilitado explica el motivo, por ejemplo «Tú creaste esta entrada».
- Nada de esto reemplaza las comprobaciones de §4: QA las prueba llamando a la API directamente (QN-PER-*).

## 10. Roles sugeridos

La migración 032 los crea **si no existen**. No los asigna a nadie, no son de sistema y se pueden editar.

| Rol | Permisos |
|---|---|
| `whats_new_developer` · Desarrollador · Qué hay de nuevo | `updates.whats_new.view`, `.author` |
| `whats_new_support` · Asesor de Soporte · Qué hay de nuevo | `updates.whats_new.view`, `.test`, `.publish_client`, `.report` |
| `whats_new_reader` · Consulta · Qué hay de nuevo | `updates.whats_new.view`, `.view_all`, `.report` |

- `configuration.whats_new.*` queda solo en `super_admin` hasta que el propietario diga otra cosa.
- Los roles existentes no cambian (QN-SQL-04).

## 11. Lo que QA debe demostrar

1. **Matriz completa de permiso, área y estado:** para cada endpoint interno y cada combinación de permiso (sí o no) y área (sí o no), y para `super_admin` sin área, el código HTTP esperado. Incluye la exención de área para configuración y reportes y su ausencia para crear y probar.
2. **Reglas por objeto:**
   - el autor, el editor y el corrector no pueden tomar;
   - nadie distinto de quien tiene la ronda puede modificarla;
   - los borradores ajenos dan 404;
   - perder el área a mitad de una ronda bloquea, y `manage` libera la entrada con motivo.
3. **Máquina de estados:** todos los pares (estado, acción); solo los de `03` §5 tienen éxito y el resto da 409 sin efectos. La reversión es atómica (QN-EST-21).
4. **Página pública:**
   - cero campos internos;
   - el filtro no confía en la casilla (datos forzados en SQL);
   - mismo 404 para lo inexistente y lo oculto;
   - `no-store`;
   - un `fileId` interno no se sirve por la ruta pública.
5. **Texto enriquecido:** el corpus de XSS y SSRF se rechaza; los límites `L_NODOS` y `L_PROF` se cumplen en tiempo acotado; no hay HTML guardado.
6. **Cargas:**
   - tipos y firmas;
   - tamaños declarados y reales en los bordes;
   - SHA-256 distinto → rechazo y borrado del objeto;
   - la URL de escritura vence y no se vuelve a emitir;
   - lectura 302 → 200 y 206 en QA;
   - CORS de storcube probado con el origen exacto.
7. **Correo:**
   - solo IDs;
   - 0 y 31 destinatarios → 400;
   - la advertencia y la confirmación de exposición;
   - la fila del outbox en la misma transacción que el envío;
   - repetir con la misma llave no duplica.
8. **Historia:** `UPDATE` y `DELETE` directos sobre las tablas de solo inserción fallan, incluso con un usuario `db_owner`, por los disparadores.
9. **Auditoría:** un evento por acción, sin contenido libre, URL ni localizadores.
10. **Migraciones:** el manifiesto coincide; son reejecutables; no reducen permisos existentes; las claves coinciden con `PERMISSION_CATALOG`.
