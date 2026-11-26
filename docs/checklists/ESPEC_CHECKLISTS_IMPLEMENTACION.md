# Especificación — Checklists de implementación (Portal SAG Web)

> **Desarrollo basado en especificaciones.** Este documento es la fuente de verdad de lo que se construye.
> Cada requisito tiene un identificador (`RN-`, `P-`, `CA-`, `API-`) que deben citar el código, las pruebas y
> los commits. Si el código y este documento no coinciden, se corrige uno de los dos **antes** de seguir.
>
> - Versión del documento: 1.2 — 2026-11-26 (identidad ERP, conflicto de reapertura y versiones coexistentes)
> - Dueño: Juan Camilo Palacio
> - Estado: **aprobado para implementación** con las decisiones de la sección 17
> - Mockup navegable: [`mockup_checklists.html`](mockup_checklists.html) (abrir en el navegador)

---

## 0. Cómo se usa este documento

1. **Antes de programar:** leer completo, más `docs/PORTAL_SAG_WEB_APP_GUIDELINES.md`,
   `docs/ENGINEERING_SKILLS_AND_TESTING.md` y `docs/PERMISSIONS_AND_TASK_VISIBILITY_DESIGN.md`.
2. **Pruebas primero:** cada casuística `CA-xx` (sección 9) se vuelve al menos una prueba automática **antes** de
   escribir la lógica. El nombre de la prueba cita el identificador (`it("CA-07 …")`).
3. **Cambios de alcance:** si algo no está aquí, no se construye. Se propone, se agrega a este documento con su
   identificador y se aprueba.
4. **Al terminar cada fase** (sección 15): pruebas en verde, revisión, y la matriz de trazabilidad (sección 16)
   actualizada.
5. **Idioma:** toda la interfaz, los mensajes y los correos en **español**. El código y los nombres técnicos
   siguen las convenciones del repositorio.

---

## 1. Objetivo

Que el equipo lleve, dentro del portal, **la lista de verificación de cada implementación** de un cliente:
qué se hizo, con qué evidencia, quién lo hizo y en qué va. Las listas salen de **plantillas versionadas** que se
administran en Configuración, para que el contenido de un checklist ya empezado nunca cambie por debajo.

### 1.1 Alcance

- **Implementación › Checklists:** crear, trabajar, guardar como borrador, finalizar, consultar y eliminar
  checklists de implementación por cliente.
- **Configuración › Checklists:** crear plantillas, sus versiones y sus puntos.
- Evidencias por punto: enlace, imagen, video, archivo y texto.
- Texto enriquecido por punto (el mismo editor de «Qué hay de nuevo»).

### 1.2 Fuera de alcance (versión 1)

- Autoguardado (decisión explícita: **no hay autoguardado**).
- Notificaciones o correos al finalizar un checklist.
- Cambiar el responsable (dueño) de un checklist.
- Firmas, aprobaciones de terceros o comentarios de otros usuarios.
- Conectar el checklist con las tareas de actualización o con el módulo de implementaciones de `docs/implementaciones/`.
- Exportar a PDF o Excel.

---

## 2. Glosario

| Término | Significado |
|---|---|
| **Plantilla** | Modelo de checklist (p. ej. «Migración de SAG Clásico a SAG Web»). Tiene versiones. **No tiene dueño**: la edita cualquiera con acceso a Configuración › Checklists. No hay un número fijo de plantillas. |
| **Versión** | Contenido concreto de una plantilla: sus puntos y si exige ambiente. Se numera 1.0, 2.0, 3.0… |
| **Punto** | Ítem de una versión: **título** obligatorio y **detalle** opcional. |
| **Versión vigente** | La última versión **publicada**. Es la única que se usa al crear checklists nuevos. |
| **Versión congelada** | Versión publicada que ya fue reemplazada por una más nueva. No se edita, no se elimina y no se usa para checklists nuevos. |
| **Versión en edición** | Versión nueva que aún no se publica. Nadie la puede usar. |
| **Checklist** | Instancia de una versión para un cliente (y un ambiente, si la versión lo exige). Tiene un responsable. |
| **Responsable** | Usuario que creó el checklist. Es su dueño y no cambia. |
| **Ambiente** | Pruebas, Producción o Demostración. Son los únicos tres valores posibles. |
| **Evidencia** | Enlace, imagen, video, archivo o texto que respalda un punto del checklist. |
| **Superadministrador** | Usuario con el rol `super_admin` del portal. |

---

## 3. Ubicación en el portal

| Módulo del menú | Opción (etiqueta exacta) | Ruta | Ícono (lucide) | Permiso para verla |
|---|---|---|---|---|
| Implementación | **Checklists** | `/implementacion/checklists` | `ListChecks` | `implementation.checklists.view` |
| Configuración | **Checklists** | `/configuracion/checklists` | `ClipboardList` | `configuration.checklist_templates.view` |

- Se agregan en `frontend/src/menu.ts` al final de cada módulo, y en `docs/PORTAL_SAG_WEB_APP_GUIDELINES.md`
  (tabla «Current module contents»).
- **Solo esas dos opciones van en el menú.** Lo demás son **vistas** dentro de cada opción, a las que se llega con
  botones (nunca con entradas propias en la barra lateral):
  - Implementación › Checklists: índice (P-01) → «+ Nuevo checklist» (P-02) → checklist (P-03).
    Rutas: `/implementacion/checklists`, `/implementacion/checklists/nuevo`, `/implementacion/checklists/:id`.
  - Configuración › Checklists: índice de plantillas (P-04) → plantilla y versiones (P-05) → puntos de una
    versión (P-06). Rutas: `/configuracion/checklists`, `/configuracion/checklists/:plantillaId`,
    `/configuracion/checklists/:plantillaId/versiones/:numero`.
  - Cada vista interna tiene su botón «Volver» y su ruta de migas (breadcrumb).
- Si una persona solo tiene una de las dos opciones, la página de inicio sigue la regla vigente de `rutaInicial`.

---

## 4. Permisos y actores

### 4.1 Permisos nuevos (catálogo de `permissionModel.ts`, API y frontend)

| Opción del catálogo | Prefijo | Acciones |
|---|---|---|
| Checklists (módulo Implementación) | `implementation.checklists` | `view` «Ver», `create` «Crear Checklist» |
| Checklists (módulo Configuración) | `configuration.checklist_templates` | `view` «Entrar (ver, crear y editar plantillas y versiones)» |

- Se asignan en **Configuración › Usuarios y Roles** como cualquier otro permiso.
- Migración SQL nueva con el siguiente número libre (hoy `031_checklists.sql`) que crea las tablas y registra los
  permisos, con su entrada en `MANIFEST.sha256` y en el validador de SQL Server 2019.
- `super_admin` tiene todos los permisos (comportamiento ya existente).

### 4.2 Matriz de quién puede hacer qué

| Acción | Con permiso `view` | Responsable del checklist | Superadministrador |
|---|---|---|---|
| Ver la lista y el detalle de **todos** los checklists | Sí | Sí | Sí |
| Crear un checklist | Solo con `implementation.checklists.create` | — | Sí |
| Editar, guardar, finalizar, reabrir un checklist | No | Sí (el suyo) | Sí (cualquiera) |
| Eliminar un checklist | No | Sí (el suyo) | Sí (cualquiera) |
| Agregar o quitar evidencias | No | Sí (el suyo) | Sí (cualquiera) |
| Ver, crear y editar plantillas; crear, editar, publicar y descartar versiones | Con `configuration.checklist_templates.view` (**las plantillas no tienen dueño**) | — | Sí |
| Eliminar una plantilla | No | — | Sí, si nadie la ha usado |

> La autorización se valida **en la API**, nunca solo en la interfaz. La interfaz oculta lo que no se puede hacer.

---

## 5. Modelo de datos (SQL Server 2019)

Todas las tablas en el esquema del portal, con `created_at`/`updated_at` en UTC, `row_version` para concurrencia
optimista y **borrado lógico** (`deleted_at`, `deleted_by`): nada se borra físicamente.

### 5.1 `checklist_templates` — plantillas

| Columna | Tipo | Regla |
|---|---|---|
| `id` | `uniqueidentifier` PK | |
| `name` | `nvarchar(150)` | Obligatorio. Único entre plantillas no eliminadas, sin distinguir mayúsculas ni tildes (RN-30). |
| `created_by` | FK usuario | Quien la creó (solo informativo: **no** da derechos). |
| `deleted_at`, `deleted_by` | | Borrado lógico. |

### 5.2 `checklist_template_versions` — versiones

| Columna | Tipo | Regla |
|---|---|---|
| `id` | `uniqueidentifier` PK | |
| `template_id` | FK | |
| `number` | `int` | 1, 2, 3… Se muestra como `N.0`. Único por plantilla entre no eliminadas. |
| `status` | `varchar(12)` | `editing` · `current` · `frozen` (CHECK). |
| `requires_environment` | `bit` | ¿El checklist exige escoger el ambiente? |
| `published_at`, `published_by` | | Al publicar. |
| `deleted_at`, `deleted_by` | | Borrado lógico. |

- Índice único filtrado: **una sola** versión `current` por plantilla y **una sola** `editing` por plantilla.

### 5.3 `checklist_template_points` — puntos de una versión

| Columna | Tipo | Regla |
|---|---|---|
| `id` | `uniqueidentifier` PK | |
| `version_id` | FK | |
| `position` | `int` | Orden 1..N, sin huecos. |
| `title` | `nvarchar(200)` | Obligatorio. |
| `detail` | `nvarchar(1000)` NULL | Opcional. Texto plano. NULL si viene vacío. |

### 5.4 `implementation_checklists` — checklists

| Columna | Tipo | Regla |
|---|---|---|
| `id` | `uniqueidentifier` PK | |
| `client_id` | FK a la identidad estable del catálogo ERP | No se usa la tabla de clientes heredada ni una identidad solo de SAG Admin. |
| `client_name_snapshot` | `nvarchar(200)` | Nombre del cliente al crear (se sigue mostrando aunque el cliente cambie de nombre). |
| `template_id`, `version_id` | FK | La versión **no cambia nunca** (RN-12). |
| `environment` | `varchar(12)` NULL | `testing` · `production` · `demo`. Obligatorio si la versión lo exige; NULL si no. |
| `status` | `varchar(12)` | `in_progress` · `completed`. |
| `owner_user_id` | FK usuario | El responsable. **No cambia.** |
| `created_at`, `created_by` | | **Fecha de creación** (inicio). Se muestra en el índice como «Creado». |
| `completed_at`, `completed_by` | NULL | **Fecha de finalización.** Se muestra como «Finalizado». Al reabrir se borra; se vuelve a llenar al finalizar de nuevo. |
| `deleted_at`, `deleted_by` | | |

### 5.5 `implementation_checklist_points` — estado de cada punto

| Columna | Tipo | Regla |
|---|---|---|
| `checklist_id`, `template_point_id` | PK compuesta | Se crean todas las filas al crear el checklist, copiando el orden de la versión. |
| `checked` | `bit` | |
| `notes_json` | `nvarchar(max)` NULL | Documento TipTap (JSON). **Nunca HTML.** |
| `checked_at`, `checked_by` | | Última vez que se marcó. |

### 5.6 `implementation_checklist_evidence` — evidencias

| Columna | Tipo | Regla |
|---|---|---|
| `id` | `uniqueidentifier` PK | |
| `checklist_id`, `template_point_id` | FK | |
| `kind` | `varchar(8)` | `link` · `image` · `video` · `file` · `text`. |
| `url` | `nvarchar(2000)` NULL | Solo `link`. |
| `text` | `nvarchar(2000)` NULL | Solo `text`. |
| `storage_key`, `file_name`, `content_type`, `size_bytes` | NULL | Solo `image`, `video`, `file`. |
| `status` | `varchar(8)` | `pending` (subido, sin guardar) · `saved`. |
| `created_at`, `created_by`, `deleted_at`, `deleted_by` | | |

### 5.7 Qué cuenta como «uso»

Una **versión está usada** si existe al menos un checklist **no eliminado** que la referencia, en cualquier estado
(en progreso o completado). Una **plantilla está usada** si alguna de sus versiones está usada.

---

## 6. Estados

### 6.1 Versión

```
            crear versión                publicar                   publicar la siguiente
(nada) ───────────────► EN EDICIÓN ─────────────► VIGENTE ─────────────────────────► CONGELADA
                            │                        │
                     descartar (RN-25)        eliminar si no tiene uso
                            ▼                 y es la última (RN-26)
                        (eliminada)                  ▼
                                               (eliminada; la anterior vuelve a ser vigente)
```

### 6.2 Checklist

```
crear ──► EN PROGRESO ──finalizar (todos marcados)──► COMPLETADO
               ▲                                          │
               └──────────────── reabrir ─────────────────┘
   eliminar (responsable o superadmin) desde cualquier estado ──► (eliminado, lógico)
```

En la interfaz: «En progreso» y «Completado». «Guardar borrador» guarda sin cambiar el estado.

---

## 7. Reglas de negocio

### 7.1 Checklists

- **RN-01** Para crear un checklist se exige: **Cliente**, **Plantilla** y, si la versión vigente de la plantilla
  lo exige, **Ambiente**.
- **RN-02** El desplegable **Clientes** busca solo clientes provenientes del ERP en el catálogo del portal a
  partir de **3 letras**, sin distinguir mayúsculas ni tildes, por coincidencia en cualquier parte del nombre.
  Muestra hasta 20 resultados. Solo se acepta un cliente **elegido de la lista**; texto libre no.
  La búsqueda y la creación requieren `implementation.checklists.create` y respetan el acceso a las
  fuentes ERP del usuario; no requieren acceso a la pantalla Clientes. Al crear se vuelve a validar la
  identidad autorizada y se guarda el nombre mostrado por el ERP en ese momento.
- **RN-03** Los selectores **Plantilla** y **Ambiente** empiezan **vacíos** («Seleccione…») para obligar a escoger.
  Nunca se preselecciona un valor, aunque haya una sola opción.
- **RN-04** El selector **Plantilla** solo lista plantillas no eliminadas que tengan una versión **vigente**, con el
  formato «Nombre · vN.0».
- **RN-05** El campo **Ambiente** solo aparece si la versión vigente de la plantilla elegida tiene
  `requires_environment = 1`. Opciones fijas: Pruebas, Producción, Demostración.
- **RN-06 (repetidos, en progreso)** No se puede crear un checklist si ya existe otro **en progreso** con el mismo
  cliente, la misma plantilla (cualquier versión) y el mismo ambiente (o ambos sin ambiente). Se bloquea con el
  mensaje de la sección 8 y un enlace al existente.
- **RN-07 (repetidos, completado)** Si ya existe uno **completado** con esa misma combinación, se pide confirmación
  («¿Crear otro de todos modos?»). Si confirma, se crea.
- **RN-08** Un mismo cliente sí puede tener varios checklists de la misma plantilla con **ambientes distintos**
  (p. ej. Pruebas y Producción).
- **RN-09** El checklist queda a nombre de quien lo crea (**responsable**). No cambia de dueño.
- **RN-10** Solo el responsable o un superadministrador pueden editar, guardar, finalizar, reabrir, eliminar o
  cambiar evidencias. Los demás con `view` lo ven en solo lectura.
- **RN-11** Cliente, plantilla, versión y ambiente **no se cambian** después de crear el checklist. Si se escogieron
  mal, se elimina y se crea otro.
- **RN-12** La versión del checklist es la vigente **al momento de crearlo** y **nunca cambia**, aunque después se
  publique una versión nueva de la plantilla.
- **RN-13** **No hay autoguardado.** Marcar puntos, escribir texto y agregar o quitar evidencias solo queda guardado
  al oprimir «Guardar borrador» o «Finalizar checklist». Si hay cambios sin guardar y la persona intenta salir
  (otra ruta, recargar, cerrar la pestaña), se le avisa: «Tiene cambios sin guardar. ¿Salir sin guardar?».
- **RN-14** «Guardar borrador» no exige nada: se puede guardar con cero puntos marcados.
- **RN-15** «Finalizar checklist» exige **todos** los puntos marcados. Si falta alguno: «Faltan N puntos por
  marcar» y se resaltan. El texto y las evidencias **no** son obligatorios.
- **RN-16** Al marcar un punto se abre su editor de texto debajo. Al desmarcarlo, el editor se oculta pero **el
  texto se conserva** y vuelve a aparecer si se marca de nuevo.
- **RN-17** El botón «+ Evidencia» está disponible en todos los puntos, marcados o no.
- **RN-18** Un checklist completado es de solo lectura. El responsable o un superadministrador pueden
  **reabrirlo** (vuelve a «En progreso»); queda en la auditoría.
  Si ya hay otro en progreso para el mismo cliente, plantilla y ambiente, se rechaza con 409 y el
  enlace al checklist en progreso. No se modifica ninguno.
- **RN-19** Eliminar un checklist pide confirmación y es borrado lógico. Al eliminarlo deja de contar como uso de
  su versión.
- **RN-20** Avance = puntos marcados / total de puntos, redondeado al entero (0 % a 100 %).
- **RN-20a** Se registra la **fecha de creación** (inicio) y la **fecha de finalización** de cada checklist, con quién
  lo hizo. Ambas se ven en el índice (P-01) y en el encabezado del checklist (P-03). Mientras no se finaliza,
  «Finalizado» muestra «—».
- **RN-21** Concurrencia: si el mismo checklist se guardó en otra pestaña o por un superadministrador mientras se
  editaba, el guardado se rechaza: «Alguien guardó este checklist mientras usted lo editaba. Copie lo que necesite
  y recargue.» (409, `row_version`).

### 7.2 Evidencias

- **RN-40** Tipos y límites (configurables por variables de entorno; estos son los valores por defecto):

| Tipo | Se acepta | Límite | Cómo se muestra |
|---|---|---|---|
| Enlace | Solo `https://` o `http://` | 2000 caracteres | Enlace que abre en pestaña nueva |
| Imagen | PNG, JPG, GIF, WEBP (verificado por contenido, no solo por extensión) | 10 MB | **Miniatura** (alto máx. 48 px); al hacer clic, la imagen completa |
| Video | MP4, WEBM, MOV | 100 MB | Enlace con el nombre del archivo (abre o descarga) |
| Archivo | Cualquier tipo | 25 MB | Enlace con el nombre del archivo (siempre se **descarga**, nunca se ejecuta en el navegador) |
| Texto | Texto plano | 2000 caracteres | Nota corta con ícono |

- **RN-41** Todas las evidencias son **opcionales**. Máximo 20 por punto.
- **RN-42** Cada evidencia ocupa **una línea compacta** (chip) y los chips se acomodan en fila; nada de tarjetas
  grandes.
- **RN-43** Un archivo se sube en cuanto se elige (para no perderlo), pero queda **pendiente**: solo pasa a
  guardado con «Guardar borrador» o «Finalizar». Si la persona sale sin guardar, los pendientes se descartan
  (tarea de limpieza que borra pendientes de más de 24 horas).
- **RN-44** Quitar una evidencia guardada es borrado lógico y también requiere guardar.
- **RN-45** Los archivos se guardan en el almacenamiento de objetos del portal en una ruta **privada**; se leen
  solo a través de la API con permiso `implementation.checklists.view`. Nunca con enlaces públicos.

### 7.3 Texto enriquecido

- **RN-50** Se reutiliza `EditorEnriquecido` de «Qué hay de nuevo» (TipTap): negrita, cursiva, subrayado,
  tachado, listas, enlaces, colores e imágenes. El valor es **JSON de TipTap**; nunca se guarda HTML.
- **RN-51** Las imágenes se pegan o se insertan en el texto como si fueran texto, y se **redimensionan arrastrando
  la esquina** (se guarda el ancho). Límites de imagen iguales a RN-40.
- **RN-52** El texto pasa por el mismo saneamiento del servidor que «Qué hay de nuevo» (`whatsNewRichText`), con
  sus pruebas de seguridad.

### 7.4 Plantillas y versiones

- **RN-30** Nombre de plantilla obligatorio, máx. 150 caracteres, único (sin distinguir mayúsculas ni tildes)
  entre plantillas no eliminadas.
- **RN-31** Crear una plantilla crea también su **versión 1.0 en edición**, vacía.
- **RN-32** Las plantillas **no tienen dueño**. Se guarda quién las creó solo como dato informativo.
- **RN-33** Cualquiera con `configuration.checklist_templates.view` ve **y edita** todas las plantillas: crea
  plantillas, crea versiones, edita puntos, publica y descarta. Como varias personas pueden editar la misma versión
  en edición, el guardado usa concurrencia optimista (RN-39).
- **RN-34** Solo un **superadministrador** elimina plantillas, y solo si **nadie las ha usado** (5.7). Si está
  usada, el botón no aparece y la API responde 409.
- **RN-35** Quien tiene acceso a la opción **no** puede eliminar plantillas; solo el superadministrador (RN-34).
- **RN-36** Crear, editar, publicar y descartar versiones lo puede hacer cualquiera con acceso a la opción.
- **RN-39** Si otra persona guardó o publicó la versión mientras se editaba, el guardado se rechaza: «Alguien
  cambió esta versión mientras usted la editaba. Copie lo que necesite y recargue.» (409, `row_version`).
- **RN-37** Los puntos se editan **solo en la versión en edición**: agregar, editar título y detalle, quitar y
  **reordenar arrastrando** (con alternativa de teclado: subir / bajar).
- **RN-38** Título del punto obligatorio (máx. 200); detalle opcional (máx. 1000). Si el detalle queda vacío se
  guarda NULL y **no se muestra nada** en el checklist (ni un espacio vacío).
- **RN-22** Máximo 100 puntos por versión.
- **RN-23** «Crear versión N+1»: solo si **no** hay otra versión en edición. La nueva empieza como **copia** de la
  versión vigente (puntos, orden, detalles y la casilla de ambiente). Si no hay vigente (plantilla nueva), empieza
  vacía.
- **RN-24** Publicar exige al menos 1 punto. Al publicar: la nueva pasa a **vigente**, la anterior vigente pasa a
  **congelada**. Pide confirmación con el texto de la sección 8.
  Los checklists en progreso conservan sus puntos y pueden terminar en la versión anterior. Solo la
  creación de un checklist nuevo usa la versión vigente.
- **RN-25** Una versión **en edición** se puede descartar (borrado lógico); el número queda libre y la siguiente que
  se cree vuelve a tomar ese número.
- **RN-26** Una versión **publicada** solo se puede eliminar si es la **última** y **no tiene uso**. Al eliminarla,
  la versión anterior vuelve a ser vigente. Una versión **congelada nunca** se elimina ni se edita.
- **RN-27** Las versiones publicadas **no se editan**. Para cambiar algo se crea una versión nueva.
- **RN-28** La numeración es consecutiva y sin saltos: 1.0, 2.0, 3.0…
- **RN-29** «Esta versión exige escoger el ambiente» es una casilla **de la versión** (no de la plantilla). Se
  edita solo en la versión en edición.

---

## 8. Pantallas

> El HTML navegable de todas las pantallas está en [`mockup_checklists.html`](mockup_checklists.html). Los colores,
> la tipografía y los componentes se toman de `frontend/src/styles.css` (azul `#1C3664`, dorado `#D3C193`). Los
> textos entre comillas son **exactos**.

### P-01 Implementación › Checklists (lista)

- Encabezado: «Checklists» y botón «+ Nuevo checklist» (solo con `implementation.checklists.create`).
- Pestañas: «Todos (N)», «En progreso (N)», «Completados (N)». Se recuerda la última pestaña por persona.
- Buscador por cliente o plantilla.
- Columnas: Cliente · Plantilla (con versión) · Ambiente (o «—») · Responsable · Avance (barra + %) ·
  **Creado** (dd/mm/aaaa) · **Finalizado** (dd/mm/aaaa o «—») · Acciones. Orden por defecto: más reciente primero.
- Acciones por fila: «Ver» (ojo) para todos; «Editar» (lápiz) y «Eliminar» (papelera) solo para el responsable o
  un superadministrador.
- Vacío: «Aún no hay checklists. Cree el primero con Nuevo checklist.»

### P-02 Nuevo checklist (cabecera)

- Campos: **Clientes** (desplegable con búsqueda, RN-02, ayuda «Escriba al menos 3 letras»), **Plantilla** (RN-03/04),
  **Ambiente** (RN-05). Los tres con media luna roja de obligatorio, como el resto del portal.
- Botones «Cancelar» (vuelve al índice) y «Crear checklist». Valida RN-01 y RN-06/07.
- Mensajes:
  - Sin cliente: «Seleccione un cliente de la lista».
  - Sin plantilla: «Seleccione la plantilla».
  - Sin ambiente: «Seleccione el ambiente».
  - RN-06: «Ya hay un checklist en progreso de esta plantilla para {cliente}{ en {ambiente}} (de {responsable},
    creado el {dd/mm/aaaa}). Continúe ese en vez de crear otro.» + enlace «Abrir el checklist existente».
  - RN-07: «Ya hay uno completado de esta plantilla para {cliente}{ en {ambiente}} (terminado el {dd/mm/aaaa}).
    ¿Crear otro de todos modos?» + «Ver el completado» + botón «Sí, crear otro».
- Al crear, abre P-03.

### P-03 Checklist (trabajar / ver)

- Encabezado: botón «Volver» al índice, título «{Plantilla} · v{N}.0», chip de estado («En progreso» /
  «Completado»), cliente, ambiente (si aplica), «Responsable: {nombre}», «Creado: {fecha}», «Finalizado: {fecha o
  —}», avance.
- Un bloque compacto por punto, en el orden de la versión:
  - Casilla **de 20 px** a la izquierda y el título.
  - Debajo, el detalle en letra pequeña gris, **solo si existe**.
  - Botón «+ Evidencia» a la derecha, que abre un menú: «Enlace», «Imagen», «Video», «Archivo», «Texto».
  - Si está marcado: el editor enriquecido (altura inicial de ~2 líneas, crece con el contenido).
  - Fila de chips de evidencias (RN-40/42).
- Pie: nota «Sin autoguardado: guarde el borrador antes de salir», botones «Guardar borrador» y «Finalizar
  checklist» (primario). En completado: «Reabrir» y «Eliminar» (responsable o superadministrador).
- Solo lectura (otros usuarios): sin casillas activas, sin editor ni botones; el texto se muestra con el visor.
- Mensajes: «Borrador guardado», «Checklist completado», «Faltan N puntos por marcar», RN-21.

### P-04 Configuración › Checklists (plantillas)

- Encabezado: «Plantillas de checklist», buscador y «+ Nueva plantilla».
- Columnas: Plantilla · Versión vigente (o «Sin publicar») · Usos · Creada · Acciones.
- Acciones: «Abrir» para todos; papelera **solo** para superadministrador y **solo** si «Usos» es 0.
- «Nueva plantilla» abre un cuadro con el nombre (RN-30) y crea la versión 1.0 en edición (RN-31).

### P-05 Plantilla (versiones)

- Encabezado: botón «Volver» a plantillas y nombre de la plantilla.
- Lista de versiones: chip (verde vigente, amarillo en edición, gris congelada con candado), estado, usos.
- Botón «Crear versión N+1» (RN-23). Si ya hay una en edición: «Ya hay una versión en edición.
  Publíquela o descártela antes de crear otra.»
- Cuadro de confirmación al crear: «La versión N+1 empieza como copia de la N, en edición. Nadie la puede usar
  hasta que la publique.»
- En la versión en edición: «Editar puntos», «Publicar» y «Descartar».
- Confirmación al publicar: «Al publicar la N+1, la N queda congelada: ya no se puede editar ni eliminar, y los
  checklists nuevos solo usarán la N+1. Los que ya usan la N siguen en la N.»

### P-06 Versión (puntos)

- Casilla «Esta versión exige escoger el ambiente (Pruebas, Producción o Demostración)» (RN-29).
- Lista de puntos con asa de arrastre, número, título y detalle (si hay), y «×» para quitar.
- Formulario compacto para agregar: «Título del punto» y «Detalle (opcional)», botón «Agregar punto».
  Error: «Escriba el título del punto».
- Botones «Volver» y «Guardar cambios» (la versión en edición tampoco se autoguarda).
- Versión vigente o congelada: la misma vista en solo lectura, con candado.

---

## 9. Casuísticas (criterios de aceptación)

| Id | Dado | Cuando | Entonces |
|---|---|---|---|
| CA-01 | Escribo «po» en Cliente | — | No se busca nada (menos de 3 letras). |
| CA-02 | Escribo «pol» | — | Aparecen los clientes que contienen «pol», sin importar mayúsculas ni tildes. |
| CA-03 | Escribo un nombre y no lo elijo de la lista | Oprimo «Crear checklist» | «Seleccione un cliente de la lista». |
| CA-04 | Elijo una plantilla cuya versión vigente exige ambiente | — | Aparece Ambiente vacío y obligatorio. |
| CA-05 | Elijo una plantilla que no exige ambiente | — | No aparece Ambiente y el checklist se guarda sin ambiente. |
| CA-06 | Hay uno **en progreso** de Migración para el cliente X en Pruebas | Creo otro igual | Se bloquea con enlace al existente (RN-06). |
| CA-07 | Hay uno **completado** de Migración para X en Producción | Creo otro igual | Pide confirmación; si confirmo, se crea (RN-07). |
| CA-08 | Hay uno en progreso para X en Pruebas | Creo uno para X en Producción | Se crea (RN-08). |
| CA-09 | Hay uno en progreso para X **eliminado** | Creo otro igual | Se crea (los eliminados no cuentan). |
| CA-10 | Soy otro usuario con `view` | Abro un checklist ajeno | Lo veo en solo lectura; la API rechaza cualquier escritura con 403. |
| CA-11 | Soy superadministrador | Edito o elimino un checklist ajeno | Se permite y queda en la auditoría. |
| CA-12 | Marqué 3 puntos y escribí texto | Salgo sin guardar | Aviso de cambios sin guardar; si salgo, no se guardó nada y los archivos pendientes se descartan. |
| CA-13 | Faltan 2 puntos | Oprimo «Finalizar checklist» | «Faltan 2 puntos por marcar» y se resaltan. |
| CA-14 | Todos marcados, sin texto ni evidencias | Finalizo | Se completa (texto y evidencias son opcionales). |
| CA-15 | Desmarco un punto con texto | Lo vuelvo a marcar | El texto sigue ahí. |
| CA-16 | Adjunto una imagen | — | Se ve la miniatura en la fila de evidencias del punto. |
| CA-17 | Adjunto un video, un archivo o un enlace | — | Se ve como enlace; el archivo se descarga, no se ejecuta. |
| CA-18 | Adjunto un archivo de 30 MB | — | «El archivo supera el límite de 25 MB.» y no se adjunta. |
| CA-19 | Adjunto un .png que en realidad es otra cosa | — | Se rechaza como imagen. |
| CA-20 | Inserto una imagen en el texto y arrastro la esquina | Guardo y vuelvo a abrir | La imagen conserva el tamaño. |
| CA-21 | La plantilla tiene la 2.0 vigente y un checklist en la 1.0 | Abro ese checklist | Sigue mostrando los puntos de la 1.0 (RN-12). |
| CA-22 | Tengo acceso a plantillas y hay una 3.0 en edición | Oprimo «Crear versión 4.0» | «Ya hay una versión en edición…» (RN-23). |
| CA-23 | Publico la 3.0 | — | 3.0 vigente, 2.0 congelada; los checklists nuevos usan la 3.0. |
| CA-24 | Hay una 2.0 congelada sin usos | Intento eliminarla o editarla | No hay botón; la API responde 409 (RN-26/27). |
| CA-25 | La 3.0 está vigente y sin usos | La elimino | La 2.0 vuelve a ser vigente (RN-26). |
| CA-26 | Descarto la 3.0 en edición | Creo otra versión | Se llama 3.0 de nuevo (RN-25, RN-28). |
| CA-27 | Intento publicar una versión sin puntos | — | «Agregue al menos un punto antes de publicar.» |
| CA-28 | Reordeno arrastrando y guardo | Creo un checklist con esa versión | Los puntos salen en el nuevo orden. |
| CA-29 | Un punto sin detalle | Abro el checklist | No aparece ninguna línea de detalle vacía. |
| CA-30 | Tengo acceso a plantillas (no soy superadministrador) | Busco cómo eliminar una | No hay botón; la API responde 403. |
| CA-31 | Soy superadministrador y la plantilla tiene un checklist | Intento eliminarla | No hay botón; la API responde 409. |
| CA-32 | Tengo acceso a plantillas y otra persona creó la plantilla | Creo y publico una versión nueva | Se permite (las plantillas no tienen dueño). |
| CA-33 | Creo una plantilla con el nombre de otra («migración» vs «Migración») | — | «Ya existe una plantilla con ese nombre.» |
| CA-34 | Guardo en dos pestañas el mismo checklist | La segunda guarda | 409 con el mensaje de RN-21. |
| CA-35 | Un checklist completado | El responsable lo reabre | Si no hay otro en progreso con la misma combinación, vuelve a «En progreso», limpia «Finalizado» y audita la reapertura. Si ya hay otro en progreso, responde 409 y no modifica ninguno. |
| CA-36 | Creo un checklist hoy y lo finalizo mañana | Miro el índice | «Creado» muestra hoy y «Finalizado» mañana. |
| CA-37 | Dos personas editan la misma versión en edición | La segunda guarda | 409 con el mensaje de RN-39. |
| CA-38 | Estoy en «Nuevo checklist», en un checklist o en una plantilla | Miro la barra lateral | Solo están las opciones «Checklists» de Implementación y de Configuración; las vistas internas no aparecen. |

---

## 10. API

Prefijo `/api`. Todas validan sesión, permiso y dueño **en el servidor**, con esquemas `zod` y respuestas en
español (`{ error, message, details? }`). Rutas en la convención del repositorio (`implementation/...`).

### 10.1 Checklists

| Id | Método y ruta | Permiso | Notas |
|---|---|---|---|
| API-01 | `GET implementation/checklists?status=&q=&page=` | view | Lista con avance y contadores por pestaña. |
| API-02 | `GET implementation/checklists/client-search?q=` | create | Mín. 3 letras (400 si no). Máx. 20. |
| API-03 | `POST implementation/checklists` `{ clientId, templateId, environment?, confirmDuplicate? }` | create | Toma la versión vigente. 409 `duplicate_in_progress` (con id del existente) o `duplicate_completed` (requiere `confirmDuplicate: true`). |
| API-04 | `GET implementation/checklists/{id}` | view | Incluye puntos de **su** versión, estado, notas y evidencias. `canEdit` según RN-10. |
| API-05 | `PUT implementation/checklists/{id}` `{ points:[{pointId, checked, notes}], evidence:{add:[ids], remove:[ids]}, rowVersion }` | dueño o superadmin | «Guardar borrador». 409 `stale`. |
| API-06 | `POST implementation/checklists/{id}/complete` `{ …mismo cuerpo…, rowVersion }` | dueño o superadmin | Guarda y finaliza en una transacción; 422 `missing_points` con la lista. |
| API-07 | `POST implementation/checklists/{id}/reopen` | dueño o superadmin | 409 `duplicate_in_progress` con el ID existente si la combinación ya está en progreso. |
| API-08 | `DELETE implementation/checklists/{id}` | dueño o superadmin | Lógico. |
| API-09 | `POST implementation/checklists/{id}/points/{pointId}/evidence` | dueño o superadmin | `multipart` para imagen/video/archivo; JSON para enlace/texto. Queda `pending`. |
| API-10 | `GET implementation/checklists/evidence/{evidenceId}/content` | view | Sirve el archivo con `Content-Disposition: attachment` (salvo imágenes en miniatura), `X-Content-Type-Options: nosniff`. |

### 10.2 Plantillas

| Id | Método y ruta | Permiso | Notas |
|---|---|---|---|
| API-20 | `GET configuration/checklist-templates` | view | Con versión vigente, usos y fecha de creación. |
| API-21 | `POST configuration/checklist-templates` `{ name }` | view | Crea la 1.0 en edición. 409 `name_taken`. |
| API-22 | `GET configuration/checklist-templates/{id}` | view | Versiones con estado y usos. |
| API-23 | `DELETE configuration/checklist-templates/{id}` | superadmin | 409 `in_use`. |
| API-24 | `POST configuration/checklist-templates/{id}/versions` | view | 409 `editing_exists`. |
| API-25 | `GET configuration/checklist-templates/{id}/versions/{number}` | view | Puntos en orden. |
| API-26 | `PUT configuration/checklist-templates/{id}/versions/{number}` `{ requiresEnvironment, points:[{id?, title, detail?}], rowVersion }` | view | Solo `editing`; si no, 409 `version_locked`; 409 `stale` (RN-39). El orden del arreglo es el orden. |
| API-27 | `POST configuration/checklist-templates/{id}/versions/{number}/publish` | view | 422 `no_points`. Transacción: vigente → congelada, esta → vigente. |
| API-28 | `DELETE configuration/checklist-templates/{id}/versions/{number}` | view | `editing`: descarta. `current` sin uso y última: elimina y reactiva la anterior. Otro caso: 409. |

---

## 11. Auditoría

Se registran con el mecanismo actual (`audit.ts`), con usuario, fecha y los ids:

`checklist_created`, `checklist_saved`, `checklist_completed`, `checklist_reopened`, `checklist_deleted`,
`checklist_duplicate_confirmed`, `checklist_evidence_added`, `checklist_evidence_removed`,
`checklist_template_created`, `checklist_template_deleted`, `checklist_version_created`,
`checklist_version_saved`, `checklist_version_published`, `checklist_version_discarded`,
`checklist_version_deleted`.

No se registran contenidos de texto ni archivos en la auditoría, solo identificadores y nombres.

---

## 12. Requisitos no funcionales

- **RNF-01** Accesible por teclado: casillas, menú de evidencias, editor y reordenamiento (subir/bajar con teclado).
- **RNF-02** Diseño compacto: un punto sin marcar y sin evidencias ocupa una sola línea (~40 px).
- **RNF-03** La lista (P-01) responde en menos de 1 s con 1000 checklists (paginación en el servidor).
- **RNF-04** Ninguna escritura sin validar dueño y permiso en la API.
- **RNF-05** Los archivos nunca se sirven desde una URL pública ni se ejecutan en el navegador.
- **RNF-06** Funciona a 1280 px y en pantalla de tablet; en teléfono, solo lectura cómoda.
- **RNF-07** Migración idempotente y validada para SQL Server 2019 (`Validate-SqlServer2019Scripts.ps1`).

---

## 13. Pruebas

- **API (vitest):** una prueba por CA de reglas (CA-01…CA-35 que apliquen), más permisos (403 para cada escritura
  sin ser dueño), concurrencia (409), límites de archivos, tipo real de imagen, saneamiento del texto y la
  máquina de estados de versiones.
- **Frontend (vitest + Testing Library):** buscador de 3 letras, selectores vacíos, campo Ambiente condicional,
  aviso de cambios sin guardar, finalizar con faltantes, solo lectura, menú de evidencias, reordenar con teclado.
- **SQL:** prueba de la migración en una base de juego en transacción revertida; índices únicos filtrados.
- **Manual con evidencia:** recorrido completo en el navegador con capturas antes de entregar.

---

## 14. Dependencias

- **Editor enriquecido:** `frontend/src/pages/queHayDeNuevo/componentes/EditorEnriquecido.tsx` y el saneamiento
  `api/src/lib/whatsNewRichText.ts` ya están en `main`. Se reutilizan sin duplicarlos: si hace falta, se mueven
  a un componente o módulo compartido (sin cambiar el comportamiento de «Qué hay de nuevo», con sus pruebas en
  verde).
- **Redimensionar imágenes en el editor:** confirmar si la extensión de imagen actual lo permite; si no, agregarlo
  al componente compartido (beneficia también a «Qué hay de nuevo»).
- **Almacenamiento de objetos:** el mismo del portal (SeaweedFS), en una ruta privada nueva `checklists/`.
- **Catálogo de clientes:** el de Clientes › Clientes.

---

## 15. Orden de entrega (fases)

1. **Fase 1 — Plantillas:** migración, permisos, API-20…28, P-04…P-06, pruebas. Se puede usar sola.
2. **Fase 2 — Checklists sin evidencias:** API-01…08, P-01…P-03 con casillas y texto enriquecido.
3. **Fase 3 — Evidencias:** API-09/10, subida, miniaturas, limpieza de pendientes.
4. **Fase 4 — Cierre:** auditoría completa, accesibilidad, documentación (`PORTAL_SAG_WEB_APP_GUIDELINES.md`) y
   despliegue (lo hace Codex, con autorización).

Cada fase termina con pruebas en verde, revisión y la matriz de la sección 16 al día.

---

## 16. Matriz de trazabilidad

| Requisito | Pantalla | API | Casuísticas |
|---|---|---|---|
| RN-01…05 | P-02 | API-02, API-03 | CA-01…05 |
| RN-06…08 | P-02 | API-03 | CA-06…09 |
| RN-09…11 | P-01, P-03 | API-04…08 | CA-10, CA-11 |
| RN-12 | P-03 | API-04 | CA-21 |
| RN-13…16 | P-03 | API-05, API-06 | CA-12…15 |
| RN-20a | P-01, P-03 | API-01, API-04, API-06 | CA-35, CA-36 |
| RN-18, RN-19 | P-03 | API-07, API-08 | CA-35, CA-09 |
| RN-21 | P-03 | API-05 | CA-34 |
| RN-40…45 | P-03 | API-09, API-10 | CA-16…19 |
| RN-50…52 | P-03 | API-05 | CA-20 |
| RN-30…35 | P-04 | API-20…23 | CA-30…33 |
| RN-22…29, RN-36…39 | P-05, P-06 | API-24…28 | CA-22…29, CA-32, CA-37 |
| Sección 3 (menú y vistas) | todas | — | CA-38 |

---

## 17. Decisiones y preguntas

### 17.1 Decididas con Juan Camilo (2026-11-26)

- Dos opciones: Implementación › Checklists y Configuración › Checklists, cada una con su permiso.
- Plantillas sin número fijo; versiones 1.0, 2.0…; la nueva reemplaza a la anterior para checklists nuevos; lo
  usado no se borra.
- Un checklist empezado sigue en su versión.
- El checklist es de quien lo crea; lo edita o elimina él o un superadministrador; los demás lo ven.
- **Las plantillas no tienen dueño**: cualquiera con acceso a Configuración › Checklists las ve, las crea y las
  edita (incluidas las versiones). Solo el superadministrador borra plantillas, y solo si no tienen uso.
- Solo hay dos opciones en el menú; crear, ver un checklist, ver versiones y editar puntos son vistas internas.
- Se registran y se muestran la fecha de creación y la fecha de finalización de cada checklist.
- Puntos con título y detalle opcional (el detalle vacío no se muestra); reordenar arrastrando.
- Ambiente: casilla por versión; si se marca, el checklist exige Pruebas, Producción o Demostración.
- Selectores de plantilla y ambiente empiezan vacíos.
- Evidencias por punto, opcionales: imagen con miniatura; video, archivo y enlace como enlace; texto.
- Sin autoguardado. Diseño compacto.
- Se permiten varios checklists de la misma plantilla para el mismo cliente (p. ej. por ambiente).

### 17.2 Reglas aprobadas para esta entrega

- Versión **en edición** antes de publicar (RN-23…25), para que nadie use una versión a medio armar.
- Repetidos: **bloquear** si hay uno en progreso con el mismo cliente, plantilla y ambiente; **confirmar** si hay
  uno completado (RN-06/07).
- **Reabrir** un checklist completado (RN-18).
- Límites de archivos de RN-40.
- La versión vigente sin uso se puede eliminar y la anterior vuelve a ser vigente (RN-26).
- Identidad estable ERP y copia del nombre al crear; el desplegable «Clientes» no mezcla registros
  exclusivos de SAG Admin ni exige permiso a la pantalla Clientes.
- Reabrir no puede crear dos checklists en progreso para la misma combinación (RN-18).
- Publicar una versión no afecta el trabajo de checklists existentes (RN-12, RN-24).
- Despliegue: CI verde del PR, respaldo verificado, migración SQL, API y verificación,
  y solo después fusión a `main` para publicar el frontend.

### 17.3 Preguntas abiertas

Ninguna.
