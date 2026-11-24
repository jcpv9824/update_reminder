# Qué hay de nuevo · Contrato de API

> Histórico de diseño: el contrato ejecutable vigente es [11_CONTRATO_IMPLEMENTACION.md](11_CONTRATO_IMPLEMENTACION.md). Este documento contiene propuestas reemplazadas (PDF, menú/Excel, cuarta pestaña, reasignación y confirmación de clientes); no implementarlas. Solo reportes HTML desde Probadas. SeaweedFS y catálogo de clientes siguen pendientes, con errores explícitos, sin éxito simulado.

Estado: **diseño, sin construir**. Este contrato se congela antes de que el frontend reemplace los datos simulados (`09`, paso 2).
Runtime: Azure Functions v4, Node 20, TypeScript estricto y zod 4. Las rutas se registran con `authLevel: "anonymous"` y la autenticación la hace `requireUser` y `loadUserProfile`, como en el resto de la API.
Modelo de datos: `03`. Archivos y texto enriquecido: `05`. Permisos y amenazas: `06`.

## 1. Convenciones

| Tema | Regla |
|---|---|
| Rutas | Internas: `/api/whats-new/...`. Públicas: `/api/public/novedades...`. La ruta del frontend público es `/novedades`. |
| Identificadores | `id` = `source_id` (UUID) de la entrada, la ronda o el reporte. `fileId` = `entry_files.public_id`. `publicId` = `entry_client_texts.public_id`, el GUID aleatorio de la página pública. Nunca se exponen claves `BIGINT`, localizadores, `bucket`, `object_key` ni URL firmadas en JSON. |
| Nombres | Campos JSON en `camelCase`. Los valores de enumeración son los de SQL (`sin_probar`, `regla_negocio`, etc.). |
| Fechas | ISO 8601 en UTC. El cliente las muestra en America/Bogota. Los filtros de mes llegan como `YYYY-MM` y se interpretan en Bogotá (QA-24). |
| Concurrencia | Toda respuesta de un recurso editable lleva `ETag: "<base64 de row_version>"`. Toda escritura sobre él exige `If-Match`. Si falta: `428 version_requerida`. Si no coincide: `409 version_desactualizada`, con la versión vigente en `details.currentEtag`. |
| Idempotencia | Encabezado `Idempotency-Key` (ASCII visible, de 8 a 200 caracteres), obligatorio en las operaciones marcadas «Sí» (QA-25). Guardado por `(actor, operación, llave)` durante 7 días (`03` §10). La misma llave con el mismo cuerpo devuelve la respuesta original con `Idempotency-Replayed: true`. Con otro cuerpo: `409 llave_idempotencia_reutilizada`. |
| Errores | `{ "error": "<mensaje en español>", "code": "<codigo>", "details"?: {...} }`. Extiende el `{ error }` actual de `lib/http.ts`; el frontend debe leer `code` para decidir, no `error`. Nunca hay detalle SQL, del proveedor ni de la pila. |
| Caché | Internas: `Cache-Control: private, no-store`. Públicas: `no-store` (QA-21). Redirecciones 302: `private, no-store`, `X-Content-Type-Options: nosniff` y `Referrer-Policy: no-referrer`. |
| Activación | Flag de API `WHATS_NEW_ENABLED=true`. Apagado, todas las rutas responden `404 no_encontrado`. Con almacenamiento distinto de `seaweedfs`, las cargas y lecturas de archivo responden `503 almacenamiento_no_disponible`. |

### 1.1 Códigos de error

| HTTP | `code` | Mensaje |
|---|---|---|
| 400 | `solicitud_invalida` | «La solicitud no es válida.» (primer mensaje de zod en `error`) |
| 400 | `texto_enriquecido_invalido` | «El contenido tiene un formato no permitido.» `details.path` y `details.rule` |
| 401 | `no_autenticado` | «No autenticado.» |
| 403 | `sin_permiso` | «No tiene permisos para esta acción.» |
| 403 | `area_requerida` | «Necesita el área Desarrollo para esta acción.» / «Necesita el área Soporte para esta acción.» |
| 403 | `autor_no_puede_probar` | «Quien creó o editó esta entrada no puede probarla.» |
| 403 | `no_es_autor` | «Solo el autor puede modificar esta entrada.» |
| 403 | `no_tiene_la_ronda` | «La prueba la tiene {nombre}.» |
| 404 | `no_encontrado` | «No encontrado.» También para recursos que existen y el usuario no puede ver (06 §4) |
| 409 | `estado_no_permite_accion` | «La entrada está en {estado} y no permite esta acción.» |
| 409 | `en_pruebas_pidale_soltar` | «La entrada está en pruebas. Pídale al asesor que la suelte.» |
| 409 | `checklist_incompleto` | «Complete el checklist antes de marcar probado.» `details.done` y `details.total` |
| 409 | `requiere_hallazgo` | «Registre al menos un hallazgo en esta ronda.» |
| 409 | `version_desactualizada` | «Alguien más modificó esta información. Recargue para ver la versión vigente.» |
| 409 | `llave_idempotencia_reutilizada` | «La llave de idempotencia ya se usó con otra solicitud.» |
| 409 | `visibilidad_bloqueada` | «Esta entrada no se puede mostrar a clientes: {motivo}.» (SP crítico; Nuevo sin «Disponible para todos los clientes») |
| 409 | `ruta_duplicada` | «Hay dos rutas iguales.» |
| 409 | `carga_ya_autorizada` | «Esta carga ya fue autorizada.» (la repetición nunca devuelve otra URL) |
| 409 | `confirmar_exposicion` | «Hay destinatarios sin acceso a Qué hay de nuevo. Confirme el envío del reporte completo.» `details.userIds` |
| 409 | `debe_quedar_una_accion` | «Debe quedar al menos una acción requerida activa.» |
| 413 | `contenido_muy_grande` | «El contenido supera el tamaño permitido ({límite}).» |
| 415 | `tipo_no_permitido` | «Tipo de archivo no permitido.» |
| 422 | `validacion_publicacion` | «Faltan campos para publicar.» `details.fields: string[]` |
| 422 | `archivo_no_verificado` | «El archivo no coincide con lo declarado.» `details.reason` |
| 422 | `reporte_muy_grande` | «El reporte supera 200 entradas. Filtre por mes.» `details.count` |
| 422 | `menu_invalido` | «La hoja Menú Final no tiene el formato esperado.» `details.errors[]` (fila, columna, código) |
| 428 | `version_requerida` | «Debe enviar If-Match con la versión vigente.» |
| 428 | `idempotencia_requerida` | «Debe enviar Idempotency-Key.» |
| 429 | `demasiadas_solicitudes` | «Demasiadas solicitudes. Intente en {n} s.» `Retry-After` |
| 503 | `almacenamiento_no_disponible` | «El almacenamiento de archivos no está disponible.» |

## 2. Tipos compartidos (TypeScript)

```ts
export type EntryStatus = "borrador" | "sin_probar" | "en_pruebas" | "fallida" | "probado" | "archivada";
export type EntryType = "nuevo" | "mejora" | "regla_negocio" | "sp_critico" | "rediseno";
export type SystemCode = "sag_web" | "sag_clasico";
export type ViaCode = "sidebar" | "navbar" | "menu_principal";
export type RoundStatus = "tomada" | "soltada" | "fallida" | "probada";
export type AreaCode = "soporte" | "desarrollo" | "ventas" | "administrativa";
export type QueueTab = "sin_probar" | "en_pruebas" | "fallidas" | "probadas";
export type RichDoc = { type: "doc"; content?: RichNode[] };   // esquema en 05 §8
export type RichNode = { type: string; attrs?: Record<string, unknown>; marks?: { type: string; attrs?: Record<string, unknown> }[]; text?: string; content?: RichNode[] };

export type UserRef = { id: string; displayName: string; active: boolean };

export type RouteLevelDto =
  | { levelNo: 1; kind: "via"; viaCode: ViaCode; label: string }
  | { levelNo: 2 | 3 | 4 | 5; kind: "submenu" | "opcion"; label: string;
      isFreeText: boolean; menuNodeId: string | null };     // menuNodeId = menu_code@versión
export type RouteDto = { routeNo: number; isPrimary: boolean; levels: RouteLevelDto[];
  displayText: string; outOfActiveMenu: boolean };

export type RequiredActionDto = { ordinal: number; actionCode: string; label: string; detail: RichDoc | null };
export type FileDto = { fileId: string; purpose: "editor_imagen" | "editor_adjunto" | "reglas_negocio" | "video" | "cliente_imagen";
  kind: "imagen" | "documento" | "video"; name: string; mimeType: string; byteCount: number;
  status: "pendiente" | "lista" | "rechazada" | "vencida" | "huerfana"; contentPath: string }; // contentPath = /api/whats-new/files/{fileId}
export type AttachmentDto =
  | { id: string; group: "reglas_negocio" | "video"; kind: "archivo"; ordinal: number; file: FileDto }
  | { id: string; group: "reglas_negocio" | "video"; kind: "enlace"; ordinal: number; url: string; label: string | null };

export type EntrySummaryDto = {
  id: string; number: string;                  // "QHN-000123"
  status: EntryStatus; type: EntryType | null; system: SystemCode | null;
  primaryRoute: string | null; summary: string | null;
  author: UserRef; initialTester: UserRef | null; assignedToMe: boolean;
  openFindings: number; missingFields: string[];  // «Faltan campos», solo en borrador
  holder: UserRef | null; checklistDone: number | null; checklistTotal: number | null;
  createdAt: string; lastPublishedAt: string | null; testedAt: string | null;
};

export type EntryDetailDto = EntrySummaryDto & {
  etag: string;
  whatChanged: RichDoc | null;
  routes: RouteDto[];
  requiredActions: RequiredActionDto[];
  client: { name: string | null; clientId: string | null } | null;   // solo usuarios internos
  attachments: AttachmentDto[];
  revisions: { revisionNo: number; kind: "publicacion" | "correccion"; publishedAt: string;
               publishedBy: UserRef; correctionNote: RichDoc | null }[];
  rounds: RoundDto[];
  findings: FindingDto[];
  clientText: ClientTextDto | null;
  capabilities: EntryCapabilities;     // calculadas por el servidor; la UI solo las refleja
};

export type RoundDto = {
  id: string; roundNo: number; revisionNo: number; status: RoundStatus; etag: string | null; // etag solo si está tomada
  holder: UserRef; takenAt: string; closedAt: string | null; closedBy: UserRef | null;
  forced: boolean; forcedReason: string | null;
  checklist: { itemNo: number; label: string; checked: boolean; checkedAt: string | null; checkedBy: UserRef | null }[];
  noteDraft: RichDoc | null; noteDraftSavedAt: string | null;   // solo visible para quien la tiene, mientras está tomada
  notes: { id: string; body: RichDoc; createdAt: string; createdBy: UserRef }[];
};
export type FindingDto = { id: string; number: number; roundNo: number; body: RichDoc; createdAt: string;
  createdBy: UserRef; annulled: null | { reason: string; at: string; by: UserRef } };

export type ClientTextDto = { etag: string; publicId: string; showToClients: boolean; availableToAllClients: boolean;
  title: string | null; body: RichDoc | null; blockedReason: null | "sp_critico" | "nuevo_sin_confirmar" };

export type EntryCapabilities = {
  canEditDraft: boolean; canPublish: boolean; canDelete: boolean; canCorrect: boolean;
  canTake: boolean; takeBlockedReason: null | "autor_no_puede_probar" | "area_requerida" | "estado";
  canRelease: boolean; canForceRelease: boolean; canEditChecklist: boolean; canAddNote: boolean;
  canAddFinding: boolean; canMarkTested: boolean; canMarkFailed: boolean;
  canEditClientText: boolean; canArchive: boolean; canReassignAuthor: boolean; canReport: boolean;
};

export type Page<T> = { items: T[]; page: number; pageSize: number; total: number };
```

### 2.1 Esquemas zod comunes

```ts
const Uuid = z.string().uuid();
const Segment = z.string().trim().min(1).max(120)                 // L_SEG
  .refine(s => !/[›<>\u0000-\u001f\u007f]/.test(s), "El nivel contiene caracteres no permitidos.");
const RouteLevelIn = z.discriminatedUnion("kind", [
  z.object({ levelNo: z.literal(1), kind: z.literal("via"), viaCode: z.enum(["sidebar","navbar","menu_principal"]) }),
  z.object({ levelNo: z.number().int().min(2).max(5), kind: z.enum(["submenu","opcion"]), label: Segment,
             isFreeText: z.boolean(), menuNodeId: z.string().max(80).nullable() }),
]);
const RouteIn = z.object({ levels: z.array(RouteLevelIn).min(3).max(5) });
const RichDocIn = z.unknown();     // lo valida validateRichDoc(perfil) de 05 §8; zod no lo recorre
const MonthIn = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const SearchIn = z.string().trim().min(2).max(100);
```

## 3. Sesión de la opción

| Método | Ruta | Permiso | Respuesta |
|---|---|---|---|
| GET | `/api/whats-new/me` | `updates.whats_new.view` | `{ views: ("desarrollador"\|"asesor"\|"lectura")[]; defaultView; areas: AreaCode[]; permissions: string[]; publicEnabled: boolean }` |

`views` lo calcula el servidor (`06` §3). La UI muestra el selector de visión solo si hay más de una.

## 4. Visión Desarrollador

| Método | Ruta | Permiso y objeto | Idem. | If-Match | Notas |
|---|---|---|---|---|---|
| GET | `/api/whats-new/entries` | `view` | | | `?scope=mine\|all&tab=todas\|borradores\|publicadas&type&system&status&q&page&pageSize`. `scope=all` excluye los borradores ajenos (QA-03). Respuesta: `Page<EntrySummaryDto> & { summary: { total; borradores; sin_probar; en_pruebas; fallidas; probadas } }` |
| POST | `/api/whats-new/entries` | `author` + Desarrollo | Sí | | Crea un borrador vacío o con contenido parcial. 201 `EntryDetailDto` + `ETag` |
| GET | `/api/whats-new/entries/{id}` | `view` + visibilidad (06 §4) | | | `EntryDetailDto` + `ETag` |
| PUT | `/api/whats-new/entries/{id}/draft` | Autor dueño + `author` + Desarrollo; estado `borrador` | No | Sí | Autoguardado y «Guardar borrador». Solo valida forma y tamaño. 200 `{ etag, savedAt, missingFields }` |
| POST | `/api/whats-new/entries/{id}/publish` | Igual | Sí | Sí | Validación completa → `sin_probar`, revisión 1. 200 `EntryDetailDto`. 422 `validacion_publicacion` |
| DELETE | `/api/whats-new/entries/{id}` | Autor dueño o `manage`; estado `borrador` | No | Sí | Borrado lógico → `eliminada`. 204 |
| POST | `/api/whats-new/entries/{id}/correct` | Autor dueño + `author` + Desarrollo; estado `sin_probar` o `fallida` | Sí | Sí | En `en_pruebas`: 409 `en_pruebas_pidale_soltar` |

```ts
type DraftIn = {                                  // PUT draft y cuerpo opcional de POST entries
  type?: EntryType | null; system?: SystemCode | null;
  routes?: { levels: RouteLevelIn[] }[];          // máx. 10 (L_RUTAS); la primera es la principal
  whatChanged?: RichDoc | null;                   // perfil medio
  requiredActions?: { actionCode: string; detail: RichDoc | null }[]; // máx. 10, sin códigos repetidos
  clientName?: string | null;                     // máx. 200; solo Nuevo (H-12)
  initialTesterId?: string | null;                // solo Nuevo
  attachments?: ({ group: "reglas_negocio" | "video"; kind: "archivo"; fileId: string }
               | { group: "reglas_negocio" | "video"; kind: "enlace"; url: string; label?: string })[]; // máx. 10 por grupo
};
type CorrectIn = { whatChanged: RichDoc; requiredActions: { actionCode: string; detail: RichDoc }[]; correctionNote: RichDoc };
```

**Reglas del servidor:**

- **Al guardar el borrador**:
  - si el tipo deja de ser Nuevo, el servidor **borra** cliente, asesor y adjuntos, y lo informa en `details.cleared`;
  - si llegan campos de Nuevo en otro tipo: 400;
  - rutas idénticas, comparadas sin mayúsculas ni tildes: 409 `ruta_duplicada`;
  - una URL de enlace debe ser `https:` con host, sin credenciales ni espacios y de hasta 2000 caracteres;
  - un `fileId` de adjunto debe pertenecer a la misma entrada, estar `lista` y tener el `purpose` del grupo.
- **Al publicar**, además de los campos obligatorios de `03` §5:
  - el nivel 1 debe corresponder al sistema;
  - el último nivel debe ser `opcion` y los intermedios `submenu`;
  - las acciones deben tener detalle no vacío;
  - en Nuevo, el asesor debe estar activo y tener el área Soporte (QA-05);
  - se toma la copia del nombre de cada acción (QA-18);
  - el autor y el editor entran en `entry_contributors`.
- **Corregir** ignora cualquier campo distinto de los de `CorrectIn`: zod `strict()` responde 400 si llegan otros campos (QN-EST-14). La nota de corrección es obligatoria (QN-EST-13).

**Decisión propuesta para QN-EST-17:** corregir en `sin_probar` está permitido (`01` §5.2 actualizado). Crea la revisión n+1 sin abrir ronda.

## 5. Visión Asesor

| Método | Ruta | Permiso y objeto | Idem. | If-Match | Notas |
|---|---|---|---|---|---|
| GET | `/api/whats-new/queue` | `view` + (`test` y Soporte, o `view_all`) | | | `?tab=sin_probar\|en_pruebas\|fallidas\|probadas&type&system&month=YYYY-MM&q&assignedToMe=true&page&pageSize`. Respuesta: `Page<EntrySummaryDto> & { counts: Record<QueueTab, number> }`. `month` filtra por `last_published_at` en las tres primeras pestañas y por `tested_at` en Probadas, en Bogotá. Orden: Sin probar, la más antigua primero (FIFO); las demás, la más reciente primero. |
| POST | `/api/whats-new/entries/{id}/take` | `test` + Soporte; no está en `entry_contributors` | Sí | Sí (entrada) | → `en_pruebas`. 200 `EntryDetailDto`. Si quien llama ya la tiene: repetir con la misma llave devuelve lo mismo; con otra llave, 409 (QN-EST-05) |
| POST | `/api/whats-new/entries/{id}/release` | Quien tiene la ronda + `test` + Soporte | Sí | Sí (entrada) | → `sin_probar`; ronda `soltada` |
| POST | `/api/whats-new/entries/{id}/force-release` | `configuration.whats_new.manage` | Sí | Sí (entrada) | `{ reason: string(10..500) }` |
| PATCH | `/api/whats-new/rounds/{roundId}/checklist` | Quien tiene la ronda | No | Sí (ronda) | `{ items: { itemNo: number; checked: boolean }[] }` (1 a 10). 200 `{ etag, done, total }` |
| PUT | `/api/whats-new/rounds/{roundId}/note-draft` | Quien tiene la ronda | No | Sí (ronda) | Autoguardado de la nota: `{ body: RichDoc \| null }` (perfil medio). 200 `{ etag, savedAt }` |
| POST | `/api/whats-new/rounds/{roundId}/notes` | Quien tiene la ronda | Sí | Sí (ronda) | `{ body?: RichDoc }`. Sin `body`, usa el borrador de la nota y lo vacía. 201 `{ note, roundEtag }` |
| POST | `/api/whats-new/rounds/{roundId}/findings` | Quien tiene la ronda | Sí | Sí (ronda) | Igual. Asigna `finding_no` y aumenta `open_findings_count`. 201 `{ finding, roundEtag, entryEtag }` |
| POST | `/api/whats-new/findings/{findingId}/annul` | Autor del hallazgo con su ronda abierta, o `manage` | Sí | No | `{ reason: string(10..500) }`. 201 (QA-26) |
| POST | `/api/whats-new/entries/{id}/mark-tested` | Quien tiene la ronda | Sí | Sí (entrada) | 409 `checklist_incompleto`. Si se muestra a clientes y está incompleto: 422 `validacion_publicacion` con `clientText.*` |
| POST | `/api/whats-new/entries/{id}/mark-failed` | Quien tiene la ronda | Sí | Sí (entrada) | 409 `requiere_hallazgo` si no hay hallazgo **no anulado de la ronda actual** |
| PUT | `/api/whats-new/entries/{id}/client-text` | En `en_pruebas`, quien tiene la ronda; en `probado`, `publish_client` + Soporte (QA-09) | No | Sí (texto) | Ver abajo |
| POST | `/api/whats-new/entries/{id}/archive` | `manage`; estado `probado` | Sí | Sí | `{ reason }` |
| POST | `/api/whats-new/entries/{id}/reassign-author` | `manage` | Sí | Sí | `{ newAuthorId: string; reason: string(10..500) }` |

Texto para clientes:

```ts
type ClientTextIn = { showToClients: boolean; availableToAllClients: boolean; title: string | null; body: RichDoc | null };
```

- Al activar por primera vez sin `body`, el servidor **precarga** una copia de «Qué cambió» con estas transformaciones (QA-13):
  - las menciones se reemplazan por el texto `@` sin nombre;
  - las imágenes se copian como archivos `cliente_imagen` (ver `05` §6.3);
  - se quitan los nodos que el perfil `cliente` no admite.
- En SP crítico, `showToClients = true` responde 409 `visibilidad_bloqueada`. En Nuevo, sin `availableToAllClients = true`, también.
- La respuesta incluye `ETag` y el `ClientTextDto`.

## 6. Archivos

| Método | Ruta | Permiso y objeto | Idem. | Notas |
|---|---|---|---|---|
| POST | `/api/whats-new/entries/{id}/uploads` | Puede editar el contenido al que va el archivo (06 §4) | Sí | Autoriza la carga (`05` §5) |
| POST | `/api/whats-new/entries/{id}/uploads/{fileId}/complete` | Quien autorizó | Sí | Verifica y registra |
| GET | `/api/whats-new/files/{fileId}` | Puede ver la entrada | No | `?download=1` fuerza `attachment`. **302** a una URL firmada de lectura. Nunca JSON con la URL |

```ts
type UploadAuthorizeIn = { purpose: "editor_imagen" | "editor_adjunto" | "reglas_negocio" | "video";
  fileName: string /*1..200*/; mimeType: string; sizeBytes: number; sha256: string /*64 hex*/ };
type UploadAuthorizeOut = { fileId: string; status: "pendiente";
  upload: { method: "PUT"; url: string; headers: Record<string, string>; expiresAt: string } };
type UploadCompleteOut = FileDto;     // status "lista"
```

- La URL de escritura solo aparece en la **primera** respuesta de autorizar. Repetir con la misma llave devuelve `409 carga_ya_autorizada`, con el estado y sin URL. La URL nunca se guarda en SQL, en `idempotency_keys` ni en registros.
- `purpose = 'cliente_imagen'` no se autoriza directamente: el servidor lo crea al copiar o al subir desde el editor del texto para clientes, con `PUT client-text` y `purpose` interno. **Decisión propuesta:** para subir una imagen nueva al texto para clientes, se autoriza con `purpose: "editor_imagen"` y el campo `target: "texto_cliente"`. El servidor la registra como `cliente_imagen`, y solo la puede pedir quien puede editar el texto para clientes.

## 7. Listas de apoyo

| Método | Ruta | Permiso | Respuesta |
|---|---|---|---|
| GET | `/api/whats-new/lookups/support-users` | `author` + Desarrollo | `UserRef[]`: activos con área Soporte, por nombre |
| GET | `/api/whats-new/lookups/mentionable-users?q=` | `author` o `test` | Hasta 20 `{ id, displayName }` activos; `q` de 2 a 60 caracteres. **Sin correo.** |
| GET | `/api/whats-new/lookups/recipients?q=` | `report` | Hasta 50 `{ id, displayName, email, hasOptionAccess }` activos (QA-27) |
| GET | `/api/whats-new/lookups/required-actions` | `view` | Activas: `{ code, label, isOther }[]` por orden |
| GET | `/api/whats-new/lookups/menu?system=&parentNodeId=&q=` | `author` + Desarrollo | Hasta 50 hijos `{ nodeId, label, level, isLastLevel, developed }` de la versión activa. Sin `parentNodeId` devuelve las vías. `q` filtra por `label_normalized LIKE`. |

**Decisión propuesta:** no hay endpoint de clientes mientras no exista la fuente (H-12). El campo es texto libre.

## 8. Reportes

| Método | Ruta | Permiso | Idem. | Notas |
|---|---|---|---|---|
| POST | `/api/whats-new/reports` | `report` + visibilidad de cada entrada | Sí | Genera el PDF en el servidor y lo guarda. 201 |
| GET | `/api/whats-new/reports/{reportId}/pdf` | Quien lo generó, un destinatario de ese reporte, o `report` | No | 302 `attachment` |
| POST | `/api/whats-new/reports/{reportId}/send` | `report` | Sí | Pone el correo en el outbox. 202 |

```ts
type ReportIn =
  | { scope: "entrada"; entryId: string; content: "solo_hallazgos" | "completo" }
  | { scope: "pestana"; tab: "fallidas" | "probadas"; content: "solo_hallazgos" | "completo";
      filters: { type?: EntryType; system?: SystemCode; month?: string; q?: string } };
type ReportOut = { reportId: string; entryCount: number; generatedAt: string; pdfPath: string };
type ReportSendIn = { recipientIds: string[] /*1..30 (L_DEST), sin repetidos*/; message?: string /*≤500, texto plano*/;
  confirmExposure?: boolean /*obligatorio si es completo y hay destinatarios sin acceso*/ };
type ReportSendOut = { queued: boolean; recipientCount: number; recipientsWithoutAccess: number };
```

**Generar:**

- No hay reporte de pestaña en Sin probar ni En pruebas: zod lo rechaza.
- El reporte de una entrada se permite en cualquier estado publicado.
- Si se pasa del límite: 422 `reporte_muy_grande`, que se evalúa con `COUNT` **antes** de generar.
- «Solo hallazgos»: ruta, tipo, desarrollador y hallazgos de **todas** las rondas, agrupados por ronda. Los anulados salen tachados, con su motivo. Las entradas sin hallazgos llevan la marca «Sin hallazgos» (QA-17).
- «Completo»: además, qué cambió, acciones, checklist, notas, quién probó, fechas y rondas.
- Las imágenes aparecen como «[Imagen: nombre]» (`05` §9).
- Generación: síncrona, con un límite de 60 s y 200 entradas. Plantilla en `api/src/lib/whatsNewReportPdf.ts`.

**Enviar:**

- Destinatarios: **solo IDs** de usuarios activos. El servidor obtiene los correos de `security.users` y nunca acepta direcciones libres.
- Cada destinatario sin `updates.whats_new.view` se cuenta en `recipientsWithoutAccess`. El diálogo ya lo advirtió con `hasOptionAccess` (QA-27). Si `content = completo` y hay destinatarios sin acceso, el cuerpo debe traer `confirmExposure: true`; si no, responde 409 `confirmar_exposicion`.
- El correo usa una plantilla fija:
  - asunto «Reporte Qué hay de nuevo · {alcance} · {fecha}»;
  - resumen con conteos y la lista de entradas (número y ruta principal);
  - mensaje opcional, escapado;
  - botón al portal `{frontendBaseUrl}/actualizaciones/que-hay-de-nuevo/reportes/{reportId}`, que descarga por `GET pdf`.
- `frontendBaseUrl` sale de la configuración de correo, **nunca** del encabezado `Host`.
- Límite de frecuencia: `whatsNewReportSend` (`06` §6).

## 9. Configuración

| Método | Ruta | Permiso | Idem. | If-Match | Notas |
|---|---|---|---|---|---|
| GET | `/api/whats-new/config` | `configuration.whats_new.view` | | | `{ settings: { publicEnabled; etag }; publicUrl; actions: ActionCatalogDto[]; menuVersions: MenuVersionDto[] }` |
| PUT | `/api/whats-new/config/settings` | `manage` | No | Sí | `{ publicEnabled: boolean }`. Efecto inmediato (QA-21) |
| POST | `/api/whats-new/config/actions` | `manage` | Sí | | `{ label: string(1..120); isOther?: false }` |
| PUT | `/api/whats-new/config/actions/{id}` | `manage` | No | Sí | `{ label; active; sortOrder }`. Si desactiva la última activa: 409 `debe_quedar_una_accion` |
| PUT | `/api/whats-new/config/actions/order` | `manage` | No | No | `{ ids: string[] }`, todas las acciones exactamente una vez |
| POST | `/api/whats-new/config/menu-versions` | `manage` | Sí | | Carga el libro (sección 9.1). 201 `MenuVersionDto` en estado `previa` |
| GET | `/api/whats-new/config/menu-versions/{id}/tree?parentNodeId=` | `configuration.whats_new.view` | | | Vista previa por niveles: hijos de un nodo, hasta 500 |
| POST | `/api/whats-new/config/menu-versions/{id}/activate` | `manage` | Sí | Sí | `previa` o `inactiva` → `activa`; la anterior pasa a `inactiva`; recalcula «fuera del menú» (QA-19 y QA-20). 200 `{ version, routesRecalculated, outOfMenuCount }` |
| POST | `/api/whats-new/config/menu-versions/{id}/discard` | `manage` | No | Sí | Solo desde `previa` |

```ts
type ActionCatalogDto = { id: string; code: string; label: string; sortOrder: number; active: boolean; isOther: boolean; etag: string };
type MenuVersionDto = { id: string; system: SystemCode; versionNo: number; status: "previa" | "activa" | "inactiva" | "descartada";
  originalName: string; nodeCount: number; maxLevel: number; warnings: { row: number; code: string }[];
  uploadedBy: UserRef; uploadedAt: string; activatedAt: string | null; etag: string };
```

### 9.1 Carga del menú de referencia

- Cuerpo JSON: `{ system: "sag_web" | "sag_clasico"; fileName: string; fileBase64: string }`, igual que Archivos Públicos.
- El archivo decodificado no puede pasar de **5 MB** (`L_XLSX`). El cuerpo HTTP, en base64, no puede pasar de 7 MB: se comprueba `content-length` antes de leer el cuerpo y, si se pasa, responde 413.
- La extensión debe ser `.xlsx` y la firma ZIP `PK\x03\x04`. Se rechazan `.xlsm` y `.xls`.
- Lectura acotada en `05` §10. Formato de la hoja en `03` §4.4.
- Si hay errores: 422 `menu_invalido`, sin crear la versión. Si es válido, en este orden:
  1. el libro se guarda en SeaweedFS;
  2. se registra en `content.files`;
  3. se crean la versión `previa` y sus nodos en una transacción.
- **Decisión propuesta:** la carga del menú de SAG Clásico usa el mismo formato. Si la hoja del Clásico es distinta, se hará un adaptador cuando exista el archivo (H-07).

## 10. Área en Usuarios

| Método | Ruta | Permiso | Notas |
|---|---|---|---|
| GET | `/api/business-areas` | `configuration.users.view` | Catálogo |
| PUT | `/api/users/{id}/business-areas` | `configuration.users.edit` | `{ areas: AreaCode[] /*0..4, sin repetidos*/ }`. Una transacción con la auditoría `user_business_areas_updated`. 200 `{ areas }` |

`GET /api/users` agrega `areas: AreaCode[]` a cada usuario. Es un cambio aditivo en `users.ts` y `securityUsersSqlRepository.ts`.

## 11. Página pública

Estos endpoints no exigen autenticación, ni encabezados de idempotencia ni `If-Match`. Todos responden `Cache-Control: no-store` y pasan por el límite `whatsNewPublic` (`06` §6).

| Método | Ruta | Respuesta |
|---|---|---|
| GET | `/api/public/novedades?categoria=todo\|nuevas\|mejoras` | `{ enabled: boolean; items: PublicCardDto[] }`. Con la publicación apagada: `{ enabled: false, items: [] }` |
| GET | `/api/public/novedades/{publicId}` | `PublicDetailDto`, o 404 |
| GET | `/api/public/novedades/{publicId}/imagenes/{fileId}` | 302 a una URL firmada `inline`, o 404 |

```ts
type PublicCardDto = { publicId: string; category: "nuevo" | "mejora"; releaseMonth: string /*"2026-11", Bogotá*/;
  title: string; summary: string /*≤ 280 caracteres del texto plano*/; whereToFind: string | null };
type PublicDetailDto = PublicCardDto & { body: RichDoc /*perfil cliente; imágenes con src público*/ };
```

- Filtro común:
  - `settings.public_enabled = 1`;
  - `entries.status = 'probado'` (archivada no);
  - `show_to_clients = 1`;
  - `entry_type <> 'sp_critico'`;
  - `entry_type <> 'nuevo' OR available_to_all_clients = 1`;
  - título y cuerpo presentes.
- La categoría: Nuevo → `nuevo`; Mejora, Regla de negocio y Rediseño → `mejora`.
- Orden: `tested_at DESC`. Máximo **100** tarjetas, sin paginación (QA-22).
- `whereToFind` es el texto de la ruta principal.
- **No** se exponen el cliente, los nombres del equipo, el número QHN, el `source_id`, los hallazgos, las notas ni «Qué cambió».
- En `body`, cada imagen sale con `attrs.fileId` y el servidor agrega `attrs.src = "/api/public/novedades/{publicId}/imagenes/{fileId}"`. Ningún otro atributo de origen se acepta ni se emite.
- Un `publicId` mal formado, inexistente o no visible devuelve el mismo 404 `no_encontrado`, con el mismo cuerpo y tiempo similar (sin oráculo).

## 12. Idempotencia y concurrencia por operación

| Operación | Idempotency-Key | If-Match sobre |
|---|---|---|
| Crear entrada | Sí | — |
| Guardar borrador | No (autoguardado) | Entrada |
| Publicar, Corregir, Tomar, Soltar, Forzar Soltar, Marcar probado, Marcar fallida, Archivar, Reasignar | Sí | Entrada |
| Checklist, borrador de la nota | No | Ronda |
| Registrar nota o hallazgo | Sí | Ronda |
| Anular hallazgo | Sí | — (el hallazgo es inmutable; la PK impide anular dos veces) |
| Texto para clientes | No | Texto para clientes |
| Autorizar o completar carga | Sí | — |
| Generar o enviar reporte | Sí | — |
| Cargar menú | Sí | — |
| Activar menú, configuración, acciones | Activar: Sí; las demás: No | Versión, configuración o acción |

El autoguardado lo serializa el frontend: una petición a la vez por recurso, con el último ETag. Si recibe `409 version_desactualizada`, deja de autoguardar y muestra el aviso de conflicto. Nunca sobrescribe a ciegas.

## 13. Organización del código

| Capa | Archivo |
|---|---|
| HTTP | `api/src/functions/whatsNew.ts`, `whatsNewConfig.ts`, `whatsNewPublic.ts`; temporizador `whatsNewSweep.ts` |
| Dominio | `api/src/lib/whatsNewService.ts` (máquina de estados y reglas), `whatsNewAccess.ts` (06), `whatsNewRichText.ts` (05 §8), `whatsNewUploads.ts`, `whatsNewMenuImport.ts`, `whatsNewReportPdf.ts` |
| SQL | `whatsNewSqlRepository.ts` (lecturas), `whatsNewSqlWriteRepository.ts` (transacciones con `runSqlTransaction`) |
| Catálogo | `permissionModel.ts`: opción `whats_new` en `updates` y en `configuration`; `audit.ts`: esquemas de entidad y metadatos (06 §7); `rateLimit.ts`: políticas nuevas; `emailOutboxSqlRepository.ts`: tipo `whats_new_report` |
