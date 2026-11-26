# Contrato técnico de Checklists

Fuente de requisitos: especificación 1.2. API camelCase, rutas de la sección
10, cuerpo de errores `{ error, message, details? }` en español. Controladores
delgados, validación Zod estricta y repositorios SQL parametrizados.

## Transporte y permisos

- Identificadores de las nuevas entidades: UUID; cliente: UUID estable del
  catálogo ERP. Usuario responsable: identidad autenticada, nunca del cuerpo.
  `rowVersion`: representación opaca de los 8 bytes de ROWVERSION.
- `implementation.checklists.view`: lista, detalle y contenido de evidencia
  guardada (pendiente: solo su responsable o superadministrador). Escrituras:
  dueño o superadministrador con acceso a la opción. La creación y búsqueda de
  clientes requieren `implementation.checklists.create`. No dar acceso a
  fuentes ERP no autorizadas ni requerir permiso de la pantalla Clientes.
  Reutilizar `ErpClientCombobox` de Novedades con la consulta de Checklists
  inyectada y etiqueta «Clientes». Reutilizar la proyección ERP y el control
  de fuentes del catálogo; no invocar el guard de Desarrollador de Novedades
  ni modificar sus permisos, filtros o límites. Aplicar el tope de 20 en
  la respuesta de Checklists.
- `configuration.checklist_templates.view`: API-20,21,22 y 24–28;
  únicamente superadministrador para API-23. Sin nuevos permisos de edición
  ni asignaciones automáticas a roles ordinarios.
- 401 sin sesión, 403 sin permiso, 404 si el recurso visible no existe,
  400 para parámetros/cuerpo inválidos, 409 para conflicto de estado/versión
  y 422 para publicación/finalización incompleta.

## Formas de la API

| API | Entrada (además de la ruta de la especificación) | Respuesta correcta |
|---|---|---|
| 20 | Sin cuerpo | `{ items: TemplateSummary[] }` |
| 21 | `{ name: string }` 1–150 tras trim | 201 `TemplateDetail` |
| 22 | ID UUID | `TemplateDetail` |
| 23 | ID UUID | 204 |
| 24 | ID UUID, sin cuerpo | 201 `VersionDetail` |
| 25 | ID UUID, número entero positivo | `VersionDetail` |
| 26 | `{ requiresEnvironment: boolean, points: PointInput[], rowVersion: string }` | `VersionDetail` |
| 27 | ID UUID, número entero positivo | `VersionDetail` |
| 28 | ID UUID, número entero positivo | 204 |
| 01 | `status?: in_progress\|completed, q?: string, page?: int` | `{ items: ChecklistSummary[], counts: { all, inProgress, completed }, total, page, pageSize, availableTemplates?: CurrentTemplate[] }`; opciones vigentes solo con permiso de crear |
| 02 | `q` recortado, al menos 3 caracteres | `{ items: { id, name }[] }`, máximo 20 |
| 03 | `{ clientId, templateId, environment?, confirmDuplicate? }` | 201 `ChecklistDetail` |
| 04 | ID UUID | `ChecklistDetail` |
| 05,06 | `{ points: { pointId, checked, notes }[], evidence: { add: UUID[], remove: UUID[] }, rowVersion }` | `ChecklistDetail` |
| 07 | ID UUID | `ChecklistDetail` |
| 08 | ID UUID | 204 |
| 09 | JSON `{ kind: "link", url }` o `{ kind: "text", text }`; multipart `kind, file` para binarios | 201 `Evidence` pendiente |
| 10 | ID UUID | Bytes con autorización y cabeceras del archivo, no URL firmada en JSON |

- `TemplateSummary = { id, name, currentVersion: number|null, uses, createdAt, canDelete }`.
  `TemplateDetail` añade `versions: VersionSummary[]`.
- `VersionSummary = { id, number, status, requiresEnvironment, uses, rowVersion }`;
  estados `editing | current | frozen`. `VersionDetail` añade
  `templateId, templateName, points: Point[]`.
- `PointInput = { id?: UUID, title, detail?: string|null }`; título recortado
  1–200, detalle máximo 1000 o NULL, máximo 100 puntos, orden del arreglo.
  `Point = { id, position, title, detail }`.
- `CurrentTemplate = { id, name, number, requiresEnvironment }`.
- `ChecklistSummary = { id, clientId, clientName, templateId, templateName, versionNumber, environment, status, ownerId, ownerName, progress, createdAt, completedAt, canEdit, canDelete }`.
  Ambiente `testing | production | demo | null`. Instantes ISO UTC; fechas
  se muestran en Bogotá. `ChecklistDetail` añade `rowVersion`, `points`
  con `Point` + `checked, notes, evidence`, y `canReopen`.
- `Evidence = { id, pointId, kind, status, url?, text?, fileName?, contentType?, sizeBytes? }`.
  Las notas se validan y reconstruyen con el saneador de Novedades; cualquier
  referencia de imagen debe pertenecer al punto y checklist autorizados.
- Claves de conflicto: `name_taken`, `editing_exists`, `version_locked`,
  `in_use`, `stale`, `duplicate_in_progress`, `duplicate_completed`;
  las dos últimas devuelven `details.existing` con los datos mínimos para el
  mensaje y el enlace. Finalizar devuelve 422 `missing_points` con
  `details.pointIds`. Publicar sin puntos devuelve 422 `no_points`.
- API-26: si se incluye un ID de punto debe pertenecer a la versión en edición
  y no repetirse. Al copiar una versión se crean IDs nuevos; nunca se cambia
  un punto de una versión ya publicada.
- API-05/06: `points` es el estado completo del formulario, con exactamente
  un elemento por punto de la versión. No admitir puntos ajenos ni repetidos.
  `notes: null` representa un editor vacío; no se descarta el documento al
  desmarcar un punto. Las listas de evidencias no permiten IDs duplicados,
  cruzados entre agregar y quitar, ni ajenos a ese checklist.

## Unidad transaccional SQL

En la base `8c62330` el siguiente número disponible es 085; confirmar
contra `origin/main` y el historial efectivo antes de cerrar el candidato.
Las seis tablas pertenecen a `implementation`. La FK de cliente referencia
`core.catalog_customer_ids(customer_id)` y las de usuario usan
`security.users(user_key)`; la capa HTTP expone IDs de usuario del portal,
no claves internas. Las FK compuestas garantizan que plantilla/versión y
checklist/punto correspondan; no depender solo de UUID enviados por la UI.
La unicidad del nombre usa comparación sin tildes ni mayúsculas y solo
plantillas no eliminadas; la combinación de checklist normaliza el ambiente
nulo para que no eluda la restricción de unicidad.

- El repositorio de escritura es dueño de la transacción. Bloquear primero la
  plantilla en operaciones de versión y al fijar la vigente para un checklist.
  Crear plantilla y 1.0 en edición juntos; publicar congela la vigente,
  promueve la nueva y audita en la misma transacción. Solo la última vigente
  sin uso puede retirarse y reactivar la anterior; las históricas se conservan.
  «Última» se evalúa entre todas las versiones no eliminadas, incluida la que
  esté en edición: retirar una anterior no puede abrir un hueco de numeración.
- Crear o reabrir comprueba la misma combinación cliente ERP/plantilla/ambiente
  normalizado; índice único filtrado para los no eliminados en progreso.
  Un choque concurrente debe devolver el mismo 409 que la validación previa.
  La cabecera fija la versión y el nombre del ERP obtenido en servidor;
  los puntos iniciales y el evento de auditoría se confirman juntos.
- Guardar/finalizar valida dueño/estado/ROWVERSION y pertenencia de todos los
  puntos y evidencias bajo el bloqueo de la cabecera; finalización incompleta
  no guarda parcialmente. Reabrir limpia la fecha/autor de finalización.
- No mantener transacciones SQL abiertas al contactar SeaweedFS. Validar
  metadatos y bytes, almacenar en privado, vincular con estado pendiente;
  el guardado promueve los IDs verificados, y la limpieza solo retira
  pendientes vencidos, nunca evidencia guardada. No persistir bytes o secretos.

## Validación

Pruebas primero y con identificador CA; además permisos por escritura,
concurrencia, errores sin cambios parciales, límites y archivo real, editor
saneado, accesibilidad por teclado y perfil de solo lectura. La evidencia de
cada fase se agrega a la matriz de la especificación y a VERIFICACION.md.
