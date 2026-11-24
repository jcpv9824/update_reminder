# Qué hay de nuevo · Almacenamiento y editor enriquecido

> Histórico de diseño: prevalece [11_CONTRATO_IMPLEMENTACION.md](11_CONTRATO_IMPLEMENTACION.md). El conector de SeaweedFS queda pendiente: cargas, lecturas y envío/almacenamiento de reportes devuelven 503 antes de cualquier escritura. No Azure Blob ni lecturas de Excel. La conversión pública descarta imágenes internas, adjuntos, menciones y bloques de código; no los publica ni convierte código en texto público automáticamente.

Estado: **diseño, sin construir**.
Fuentes: `api/src/lib/objectStorage.ts`, `contentFileSqlWriter.ts`, `publicDownloadFiles.ts`, `docs/SEAWEEDFS_OBJECT_STORAGE_CUTOVER.md`, `docs/MIGRACION_ARCHIVOS_BLOB_A_STORCUBE.md`, `docs/HANDOFF_RECUPERACION_STORAGE_PUBLICO.md` y el contrato de carga de `docs/GUIDE_BUILDER_DESIGN.md`.
Este documento **fija los límites numéricos** que el plan de QA (`08` §0.1) tenía como símbolos (QA-14).

## 1. Límites

| Símbolo | Valor | Dónde se aplica |
|---|---|---|
| `L_QC` | **200 000** caracteres del JSON de «Qué cambió» (`DATALENGTH <= 400 000` bytes en `NVARCHAR`) | zod, validador y `CHECK` |
| `L_ACC` | **20 000** caracteres del JSON de cada acción requerida | Ídem |
| `L_NOTA` | **100 000** caracteres del JSON de una nota, un hallazgo, una nota de corrección o el borrador de la nota | Ídem |
| `L_CLI_TIT` | **120** caracteres del título para clientes | zod y columna `NVARCHAR(120)` |
| `L_CLI_TXT` | **50 000** caracteres del JSON del texto para clientes | zod, validador y `CHECK` |
| `L_NODOS` | **3 000** nodos por documento enriquecido (bloques, en línea y texto) | Validador |
| `L_PROF` | **10** niveles de anidamiento (`doc` = 1) | Validador |
| Texto plano | **60 000** caracteres por documento (medio), 6 000 (compacto), 20 000 (cliente) | Validador |
| `L_IMG` | **10 000 000** bytes (10 MB) por imagen; máximo **8 000 × 8 000** píxeles | Autorizar y completar |
| `L_DOC` | **20 000 000** bytes (20 MB) por documento de Word, PDF o Excel | Ídem |
| `L_VID` | **100 000 000** bytes (100 MB) por video mp4 o webm, igual que `MAX_PUBLIC_VIDEO_BYTES` | Ídem |
| `L_ADJ` | **10** elementos por lista de adjuntos (reglas de negocio o video) y **10** nodos `fileAttachment` por documento | zod y validador |
| Imágenes por documento | **20** | Validador |
| Enlaces por documento | **100**; `href` de hasta **2 000** caracteres | Validador |
| `L_RUTAS` | **10** rutas en total por entrada, incluida la principal | `04`, `CHECK` |
| `L_SEG` | **120** caracteres por nivel de ruta escrito con «Otro…» o leído del menú | `04`, columna |
| `L_XLSX` | **5 000 000** bytes del libro del menú; ver §10 para los límites al descomprimir | `04` §9.1 |
| `L_REP` | **200** entradas por reporte (H-17) | `04` §8 |
| `L_DEST` | **30** destinatarios por envío | `04` §8 |
| `L_URL` | **120 s** para la URL firmada de lectura pública; **300 s** para la interna y para la de escritura | §6 |
| Total por entrada | **500 000 000** bytes en archivos `lista` o `pendiente` | Autorizar |
| Cuota por usuario | **200** autorizaciones y **1 000 000 000** bytes declarados por día (America/Bogota) | Autorizar, sobre `entry_files` |

Los límites de bytes se comprueban **dos veces**: con el tamaño declarado al autorizar, sin aceptar ningún cuerpo, y con el tamaño real que informa SeaweedFS al completar (QN-CAR-05).

## 2. Proveedor

- **Solo SeaweedFS**, por su gateway S3. `whatsNewUploads.ts` exige `getObjectStorageProvider() === "seaweedfs"`. Con `azure_blob` o sin configurar responde `503 almacenamiento_no_disponible`. No se escribe ni se lee nada del módulo en Azure Blob.
- `content.files.storage_provider = 's3'` y `whats_new.entry_files.storage_provider = 's3'` (`CHECK`).
- Se usan el cliente y el firmador de `objectStorage.ts`, incluida la adaptación de Host de storcube (firma sin puerto y el puerto `8333` repuesto en la URL que recibe el navegador).
- Funciones nuevas en `objectStorage.ts`, todas **sin rama de Azure** y con `bucket` igual al de la configuración activa:

| Función | Uso |
|---|---|
| `createScopedObjectUpload({ relativeKey, mimeType, sizeBytes, expiresInSeconds })` | `PutObjectCommand` firmado. `relativeKey` lo arma el servidor; la función le antepone `OBJECT_STORAGE_PREFIX`, rechaza `..`, `//` y caracteres fuera de `[A-Za-z0-9/_.-]`, y exige que empiece por `que-hay-de-nuevo/`. Generaliza la ruta fija `guides/uploads` de `createPrivateObjectUpload`. |
| `inspectPrivateObject(locator, maxBytes)` | Ejecuta `HEAD` y luego `GET` en flujo con `IfMatch` del ETag. Calcula el SHA-256 en flujo y conserva los primeros 64 bytes para la firma. Corta si se pasa de `maxBytes`. |
| `storePrivateObjectAtKey({ relativeKey, bytes, sha256, mimeType })` | Para el PDF de reportes y el libro del menú: escritura con verificación posterior, como `storeSeaweedFSObject`, pero con una clave dada y no direccionada por contenido. Usa la reserva de registro existente (`tryReserveObjectRegistration`). |
| `copyPrivateObject(source, relativeKey)` | `CopyObject` dentro del mismo bucket, para las imágenes del texto para clientes (§6.3). Vuelve a verificar el tamaño y el SHA-256 en el destino. |
| `createPrivateObjectUrl(..., expiresInSeconds?)` | Parámetro opcional, acotado a `[60, configurado]`, para que la lectura pública use 120 s. |

## 3. Claves de objeto

`<prefijo>` es `OBJECT_STORAGE_PREFIX`. Por los documentos de recuperación, en producción es `PortalSAGWeb/Archivos` y en QA `PortalSAGWeb-TEST/Archivos`, que corresponden a `<base>/Archivos` de `01` §8.

```text
<prefijo>/que-hay-de-nuevo/<entry_id>/editor/<file_id>.<ext>          imágenes y adjuntos del editor (Qué cambió, acciones, notas, hallazgos, corrección)
<prefijo>/que-hay-de-nuevo/<entry_id>/reglas-negocio/<file_id>.<ext>
<prefijo>/que-hay-de-nuevo/<entry_id>/video/<file_id>.<ext>
<prefijo>/que-hay-de-nuevo/<entry_id>/cliente/<file_id>.<ext>         solo imágenes del texto para clientes
<prefijo>/que-hay-de-nuevo/_reportes/<yyyy>/<mm>/<report_id>.pdf
<prefijo>/que-hay-de-nuevo/_menu/<system>/<menu_version_id>.xlsx
```

- `<entry_id>` es `entries.source_id` (UUID). `<file_id>` es `entry_files.public_id` (GUID aleatorio). `<ext>` sale de la lista permitida (§4), nunca del nombre original. El nombre original solo se guarda en SQL y viaja en `Content-Disposition`.
- Las claves no tienen datos personales ni texto del usuario.
- **Conflicto que hay que verificar en QA:** el valor por defecto en código es `portal-sag/runtime`, y la política IAM de `SEAWEEDFS_OBJECT_STORAGE_CUTOVER.md` limita la identidad a `portal-sag/runtime/*`. Si el prefijo del entorno no es `<base>/Archivos`, las claves quedan bajo ese otro prefijo. La clave **nunca** se arma con `configuredPortalDatabase()` en el código del módulo: siempre con el prefijo configurado, para que la política IAM siga aplicando. La puerta H3 confirma el valor real por entorno.

## 4. Tipos permitidos

Se valida el tipo declarado, la extensión y la firma de los primeros bytes. Todo lo que no está en la tabla se rechaza con `415 tipo_no_permitido`.

| Clase | Extensión | MIME forzado | Firma | Límite | Propósitos |
|---|---|---|---|---|---|
| imagen | `.png` | `image/png` | `89 50 4E 47 0D 0A 1A 0A` | `L_IMG` | `editor_imagen`, `cliente_imagen` |
| imagen | `.jpg`, `.jpeg` | `image/jpeg` | `FF D8 FF` | `L_IMG` | Ídem |
| imagen | `.gif` | `image/gif` | `GIF87a` o `GIF89a` | `L_IMG` | Ídem |
| imagen | `.webp` | `image/webp` | `RIFF????WEBP` | `L_IMG` | Ídem |
| documento | `.pdf` | `application/pdf` | `%PDF-` | `L_DOC` | `editor_adjunto`, `reglas_negocio` |
| documento | `.docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | ZIP `PK\x03\x04` | `L_DOC` | Ídem |
| documento | `.xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | ZIP | `L_DOC` | Ídem |
| documento | `.doc` | `application/msword` | OLE `D0 CF 11 E0 A1 B1 1A E1` | `L_DOC` | Ídem |
| documento | `.xls` | `application/vnd.ms-excel` | OLE | `L_DOC` | Ídem |
| video | `.mp4` | `video/mp4` | `ftyp` en el byte 4 | `L_VID` | `video`, `editor_adjunto` |
| video | `.webm` | `video/webm` | `1A 45 DF A3` | `L_VID` | Ídem |

- **Rechazados siempre:**
  - SVG, HTML, XML, JavaScript;
  - archivos con macros (`.docm`, `.xlsm`), ejecutables y comprimidos genéricos;
  - imágenes de más de `8 000 × 8 000`. Las dimensiones se leen del encabezado (IHDR de PNG, SOFn de JPEG, descriptor de GIF, VP8/VP8L/VP8X de WebP) sin decodificar la imagen.
- El MIME que se guarda y se envía en la respuesta es el **forzado** por la tabla, no el que declaró el navegador ni el que guardó el objeto.

## 5. Flujo de carga

```text
navegador ─POST uploads (Idempotency-Key)─▶ API: valida permiso, propósito, tipo, tamaño, cuotas
          ◀─ { fileId, upload: { PUT url (300 s), headers } } ─ fila entry_files 'pendiente'
navegador ─PUT bytes─▶ SeaweedFS (directo, con progreso)
navegador ─POST uploads/{fileId}/complete (Idempotency-Key)─▶ API: HEAD + GET en flujo, SHA-256, firma
          ◀─ FileDto 'lista'  (o 422 archivo_no_verificado y el objeto se borra)
navegador inserta el nodo image/fileAttachment con attrs.fileId en el editor
```

### 5.1 Autorizar

1. Autenticar. Comprobar que quien llama puede editar el contenido de destino (`06` §4):
   - el autor en `borrador` o al corregir: `editor_*`, `reglas_negocio`, `video`;
   - quien tiene la ronda abierta: `editor_*` para notas y hallazgos;
   - quien puede editar el texto para clientes: `target: "texto_cliente"`.
2. zod: el nombre de 1 a 200 caracteres, sin `/`, `\` ni caracteres de control; `sha256` de 64 caracteres hexadecimales; `sizeBytes` entero positivo.
3. Validar que el MIME, la extensión y el propósito coincidan con la tabla de §4, y el tamaño declarado contra su límite. También el total por entrada y la cuota diaria del usuario.
4. Insertar `entry_files` en `pendiente`, con el `object_key` que genera el servidor y `upload_expires_at = ahora + 300 s`, y la llave de idempotencia, en una transacción.
5. Firmar con `createScopedObjectUpload`. Los encabezados firmados son `Content-Type` (el forzado) y `x-amz-meta-declared-size`.
6. Responder con la URL **una sola vez** (`04` §6). La URL no se registra en logs, auditoría ni SQL.

La URL de escritura **solo escribe** en esa clave, con ese tipo de contenido, y vence a los 300 s. S3 solo verifica el vencimiento al recibir la petición, así que una carga de video que empieza antes de vencer puede terminar después. S3 no garantiza el límite de tamaño de una URL prefirmada, por eso el paso de completar es el que decide.

### 5.2 Completar

1. La fila debe estar `pendiente`, ser del mismo usuario y de la misma entrada. Si ya está `lista`, se repite la respuesta.
2. `HEAD`: tamaño igual al declarado y dentro del límite, y `Content-Type` igual al forzado.
3. `GET` en flujo con `IfMatch` del ETag: SHA-256 igual al declarado; firma de §4 sobre los primeros bytes; dimensiones si es imagen.
4. Si algo falla:
   - `upload_status = 'rechazada'`, con `rejection_code` (`tamano_no_coincide`, `sha256_no_coincide`, `firma_no_coincide`, `dimensiones_excedidas` o `objeto_ausente`);
   - auditoría `whats_new_file_rejected`;
   - `deletePrivateObjectIfUnreferenced(locator)`. Como no tiene fila en `content.files`, el reclamo de borrado procede;
   - 422 `archivo_no_verificado`.
5. Si todo pasa, en una transacción: `ensureSqlContentFile` (proveedor `s3`, bucket, clave, ETag, nombre, MIME forzado, bytes y SHA-256) y `entry_files.upload_status = 'lista'`, con `file_key`. Auditoría `whats_new_file_completed`.
6. Ninguna transacción SQL queda abierta mientras se habla con SeaweedFS (regla de `ARCHITECTURE.md`).

### 5.3 CORS del bucket

La carga directa desde el navegador exige que SeaweedFS (storcube) permita CORS:

- origen exacto del portal, sin comodín;
- métodos `PUT`, `GET` y `HEAD`;
- encabezados `Content-Type` y `x-amz-meta-declared-size`.

`MIGRACION_ARCHIVOS_BLOB_A_STORCUBE.md` dice que **CORS no está probado**. Es una puerta de H3.

**Plan de contingencia (Decisión propuesta):** si CORS no se puede habilitar, el mismo endpoint de autorizar devuelve `upload: { method: "PUT", url: "/api/whats-new/entries/{id}/uploads/{fileId}/content" }`. El navegador sube por la API, en flujo y con el mismo límite. El contrato del frontend no cambia, porque siempre usa `upload.url`, `upload.method` y `upload.headers`.

## 6. Lectura

### 6.1 Interna

`GET /api/whats-new/files/{fileId}` funciona así:

1. Autentica y verifica que el usuario puede ver la entrada (`06` §4).
2. Exige que el archivo esté `lista`.
3. Responde **302** a `createPrivateObjectUrl` (300 s) con `ResponseContentType` = MIME forzado y `ResponseContentDisposition`:
   - imágenes y video: `inline`;
   - PDF: `inline`, salvo `?download=1`;
   - Word y Excel: siempre `attachment`.
4. Encabezados: `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` y `Referrer-Policy: no-referrer`.

La lectura de video con `Range` la atiende SeaweedFS directamente: 206 sobre la URL firmada.

### 6.2 Pública (H-15)

`GET /api/public/novedades/{publicId}/imagenes/{fileId}` responde **302** (`L_URL` = 120 s, `inline`) solo si **todo** lo siguiente se cumple, en una sola consulta:

- `settings.public_enabled = 1`;
- el texto para clientes con ese `publicId` es visible según el filtro público de `04` §11;
- `entry_files.public_id = fileId`, de **la misma entrada**, con `purpose = 'cliente_imagen'`, `kind = 'imagen'` y `upload_status = 'lista'`;
- existe `file_references(ref_source = 'texto_cliente', ref_owner_key = entry_key)` para ese archivo.

En cualquier otro caso, la respuesta es el mismo 404. Nunca se exponen el localizador ni el bucket. Encabezados: `no-store`, `nosniff` y `no-referrer`.

### 6.3 Imágenes copiadas al texto para clientes (QA-13)

Cuando el texto para clientes se precarga a partir de «Qué cambió», o cuando se guarda con una imagen que no es `cliente_imagen`, el servidor hace lo siguiente:

1. comprueba que la imagen de origen es de la misma entrada y está `lista`;
2. la copia con `copyPrivateObject` a `…/cliente/<nuevo file_id>.<ext>`;
3. crea `entry_files` `cliente_imagen`, con `copied_from_entry_file_key`;
4. registra el nuevo `content.files`;
5. reemplaza el `fileId` en el JSON del texto para clientes.

Así, el endpoint público nunca puede servir una imagen interna, aunque alguien conozca su `fileId`. La copia se hace **antes** de la transacción que guarda el texto; si esa transacción falla, la copia queda sin referencia y la limpia el barrido.

## 7. Huérfanos y retención (H-16)

Temporizador `whatsNewSweep`, cada hora. Usa `sp_getapplock` para ejecutarse una sola vez a la vez y trabaja en lotes de 100.

| Caso | Acción |
|---|---|
| `pendiente` con `upload_expires_at` vencido hace más de 30 min | Pasa a `vencida` y luego `deletePrivateObjectIfUnreferenced`: el objeto no tiene `content.files`, así que el reclamo procede |
| `lista` sin ninguna `file_references`, de más de 7 días y con la entrada en `borrador` o `eliminada` | Pasa a `huerfana`. **No se borra el objeto** (ver el conflicto abajo) |
| Copia `cliente_imagen` sin referencia de más de 7 días | Ídem |
| `idempotency_keys` vencidas | Se borran en lotes |

**Conflicto con H-16 («los objetos sin referencia se limpian con el ciclo de reclamos existente»):**

- El ciclo actual (`tryClaimUnreferencedObject`) solo reclama objetos **sin fila en `content.files`**.
- Ningún código del portal borra filas de `content.files`: hoy es una tabla de hecho inmutable.
- Por eso, con lo existente, solo se limpian las cargas que nunca se completaron.

**Decisión propuesta:**

- En esta versión, los archivos completados que quedan sin referencia se marcan `huerfana` y se conservan. Con el volumen esperado, son unos pocos MB al mes.
- Borrarlos de verdad exige un contrato nuevo de borrado de `content.files` con reclamo y auditoría. Es un cambio aparte, con su propia revisión de seguridad.
- Lo publicado nunca se borra; solo se archiva.

## 8. Formato del texto enriquecido

### 8.1 Almacenamiento

- Documento **TipTap/ProseMirror JSON** en `NVARCHAR(MAX)`, con `CHECK (ISJSON(col) = 1)` y `CHECK (DATALENGTH(col) <= 2 * límite)`.
- Junto al JSON se guarda el texto plano extraído (§9), en su columna `*_text`.
- **Nunca se guarda HTML.** El frontend renderiza el JSON con TipTap en modo de solo lectura, con el mismo esquema. Nunca usa `innerHTML` ni `dangerouslySetInnerHTML` con contenido del usuario.

### 8.2 Perfiles

| Perfil | Se usa en | Diferencias |
|---|---|---|
| `medio` | Qué cambió, borrador de nota, notas, hallazgos, nota de corrección | Todo lo de §8.3 |
| `compacto` | Detalle de cada acción requerida | Sin `heading`, `codeBlock`, `image`, `fileAttachment` ni `horizontalRule` |
| `cliente` | Cuerpo del texto para clientes | Sin `mention`, `codeBlock`, `fileAttachment` ni `mailto:`. `image` solo con archivos `cliente_imagen` |

### 8.3 Esquema permitido

Validador del servidor: `validateRichDoc(json, perfil, { entryKey })` en `api/src/lib/whatsNewRichText.ts`.

- Es una función pura que recorre el árbol de forma **iterativa** (con pila explícita, sin recursión), para no agotar la pila.
- Se detiene en el primer error, con `{ path, rule }`.
- Cualquier tipo, marca o atributo que no esté en las tablas siguientes es un **error**: no se filtra en silencio. Así, una carga manipulada no se acepta a medias.

**Nodos**

| Nodo | Atributos permitidos | Contenido | Perfiles |
|---|---|---|---|
| `doc` | — | bloques, de 0 a 500 | todos |
| `paragraph` | — | en línea | todos |
| `heading` | `level`: 2 o 3 | en línea | medio, cliente |
| `bulletList`, `orderedList` | `orderedList.start`: entero de 1 a 999 | `listItem`, de 1 a 200 | todos |
| `listItem` | — | `paragraph` seguido de bloques | todos |
| `blockquote` | — | bloques | medio, cliente |
| `codeBlock` | `language`: `null` o `sql` | solo `text` sin marcas | medio |
| `horizontalRule` | — | — | medio, cliente |
| `hardBreak` | — | — | todos |
| `text` | `text`: cadena no vacía, sin `U+0000` | — | todos |
| `image` | `fileId` (GUID, obligatorio); `alt` (0 a 200 caracteres); `width` (entero de 16 a 2 000, opcional) | — | medio, cliente |
| `fileAttachment` | `fileId` (GUID); `name` (1 a 200 caracteres, solo para mostrar) | — | medio |
| `mention` | `id` (`source_id` de un usuario activo, máx. 150); `label` (1 a 160 caracteres) | — | medio, compacto |

**Marcas**

| Marca | Atributos | Regla |
|---|---|---|
| `bold`, `italic`, `underline`, `strike`, `code` | — | `code` no se combina con `link` |
| `link` | `href` (obligatorio) | Ver las reglas de enlaces |

**Reglas de `image` y `fileAttachment`:**

- **Nunca** se acepta `src`, `href`, `url`, `data:`, `blob:` ni ningún otro atributo de origen.
- El `fileId` debe existir en `entry_files` **de la misma entrada**, con `upload_status = 'lista'`.
- La clase debe corresponder: `image` exige `kind = imagen`; `fileAttachment` exige `documento` o `video`.
- En el perfil `cliente`, `purpose = 'cliente_imagen'`. Las imágenes de otro propósito las copia el servidor antes de validar (§6.3).
- La verificación contra SQL se hace con **una** consulta `IN` sobre todos los `fileId` del documento, sin una consulta por nodo.

**Reglas de `link`:**

- `href` se analiza con `new URL()`. Solo se aceptan `https:`, `http:` y `mailto:` (este último no en el perfil `cliente`).
- Se rechaza si tiene usuario o contraseña, si no tiene host (en http y https), si tiene caracteres de control o espacios, o si mide más de 2 000 caracteres.
- `mailto:` exige una dirección válida, sin `?` (sin `cc`, `body` ni `subject`).
- `javascript:`, `data:`, `vbscript:`, `file:` y las URL relativas se rechazan.
- `target` y `rel` **no se guardan**. Al renderizar, el frontend agrega siempre `target="_blank" rel="noopener noreferrer nofollow"`.
- El servidor nunca hace peticiones a esas URL: no hay vista previa ni comprobación de enlaces, así que no hay SSRF.

**Reglas de `mention` (H-14):**

- `id` debe ser un usuario existente. `label` se **vuelve a escribir** con el `display_name` vigente al guardar, para que no se pueda suplantar con otro nombre.
- No genera ninguna notificación.
- En el perfil `cliente` no existe: al copiar, se reemplaza por el texto `@` (QA-13).

### 8.4 Límites que se comprueban al recorrer

| Límite | Valor |
|---|---|
| Nodos | `L_NODOS` = 3 000 |
| Profundidad | `L_PROF` = 10 |
| Bytes del JSON | Según el perfil y el campo (§1). Se mide **antes** de `JSON.parse`, con `Buffer.byteLength` sobre el cuerpo; el cuerpo HTTP completo tiene un límite de 1 MB. |
| Texto plano extraído | §1 |
| Imágenes, adjuntos y enlaces por documento | 20, 10 y 100 |
| Claves por objeto | Como máximo `type`, `attrs`, `marks`, `text` y `content`. Cualquier otra, incluidas `__proto__` y `constructor`, es un error. El JSON se analiza con un reviver que rechaza esas claves. |
| Marcas por nodo de texto | 6, sin repetir |

Un documento vacío (`{ "type": "doc" }` o solo párrafos vacíos) cuenta como **vacío** para las reglas de obligatoriedad al publicar.

## 9. Extracción de texto plano

`extractPlainText(doc, { forReport })` produce:

| Nodo | Salida |
|---|---|
| `paragraph`, `heading`, `blockquote`, `codeBlock` | Contenido seguido de `\n` |
| `listItem` | `• ` o `n. ` más el contenido, con sangría de dos espacios por nivel |
| `hardBreak` | `\n` |
| `horizontalRule` | `\n` |
| `mention` | `@label` |
| `image` | `[Imagen: alt]`, o `[Imagen]` si no tiene `alt` |
| `fileAttachment` | `[Adjunto: name]` |
| `link` | El texto, más ` (href)` si `forReport` y el texto no es el mismo `href` |

- El resultado se normaliza con NFC, los espacios repetidos se reducen y se recorta a los límites de §1.
- Se guarda en `*_text` y alimenta la búsqueda (`LIKE`), `what_changed_summary` (primera línea no vacía, hasta 300 caracteres), el resumen público (280 caracteres), el PDF y el correo.
- En el PDF y el correo, el texto se **escapa** (el correo usa `escapeHtml` de `emailTemplates.ts`), nunca se interpreta.

## 10. Lectura del libro del menú

- **Decisión propuesta:** dependencia `fflate`, pequeña, sin dependencias y en JavaScript puro, para descomprimir, más `@xmldom/xmldom`, que ya está en la API, para leer `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/sharedStrings.xml` y la hoja `Menú Final`.
- **No** se usa el paquete npm `xlsx` (SheetJS en npm, que no se mantiene y tiene avisos de seguridad) ni `exceljs`.
- Agregar `fflate` pasa por `SECURITY_DEPENDENCY_POLICY.md`.

| Control | Valor |
|---|---|
| Tamaño del archivo comprimido | `L_XLSX` = 5 MB |
| Entradas del ZIP | máximo 200; se rechazan rutas con `..` o absolutas |
| Tamaño descomprimido por entrada leída | máximo 20 MB; total máximo 60 MB. Se cuenta durante la descompresión en flujo y se corta al pasarse (bomba ZIP) |
| Relación de compresión | Se corta si una entrada pasa de 100:1 |
| XML | xmldom sin DTD ni entidades externas: se rechaza cualquier `<!DOCTYPE` |
| Filas | máximo 5 000; columnas leídas: A a G y M |
| Celdas | Valor `<v>` o cadena compartida. Las fórmulas (`<f>`) se ignoran y se usa el valor en caché. El texto se recorta a `L_SEG`; si es más largo, es un error con número de fila. |
| Tiempo | 10 s de CPU como máximo; si se pasa, `422 menu_invalido` |

El libro original se guarda en `…/_menu/<system>/<menu_version_id>.xlsx` solo después de validarlo. El texto de las celdas nunca se registra en logs ni en auditoría; solo números de fila y códigos.

## 11. Pruebas que QA debe ejecutar sobre este documento

| Caso | Valor de prueba |
|---|---|
| QN-DEV-06 | JSON de Qué cambió de 200 000 caracteres y de 200 001 |
| QN-HAL-08 | Nota de 100 000 y de 100 001 |
| QN-RTX-08 | 3 001 nodos; profundidad 11 |
| QN-CAR-05 | 10 000 000 y 10 000 001 bytes (imagen), 20 000 000 y 20 000 001 (documento), 100 000 000 y 100 000 001 (video) |
| QN-CAR-08 | 11.º adjunto de una lista |
| QN-MEN-12 | Libro de 5 000 001 bytes |
| QN-PUB-14 y QN-PUB-18 | La URL pública vence a los 120 s |
| QN-RUT-10 y QN-RUT-13 | Nivel de 120 y de 121 caracteres; 10 rutas y la 11.ª |
