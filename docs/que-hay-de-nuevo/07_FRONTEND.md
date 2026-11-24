# Qué hay de nuevo · Frontend

## Implementación integrada (2026-11-18)

El contrato vigente es `11_CONTRATO_IMPLEMENTACION.md`; prevalece sobre las secciones históricas del prototipo de este documento.

- **Producción:** `VITE_WHATS_NEW_ENABLED=true` habilita las rutas y el menú. Apagada por defecto. `LivePages.tsx` usa TanStack Query y `api/client.ts`; `contrato.ts` tipa y adapta los DTO ingleses. Nunca se recurre al prototipo cuando falla la API.
- **Actor y acceso:** `/whats-new/me` obtiene identidad, áreas y permisos vigentes de SQL. No hay selector de usuario. Los estados privados de consulta llevan ID y roles del usuario de AuthContext; se desmontan y eliminan del caché al cambiar de sesión. Errores 401/403 no muestran filas antiguas. Las áreas no conceden permisos.
- **Entradas:** lista resumida paginada y detalle independiente; rutas manuales, cliente libre y desarrollador inmutable. Crear/guardar/publicar/corregir llaman la API real. Las mutaciones llevan `If-Match` y los POST persistentes una llave de idempotencia; los conflictos conservan el formulario y piden recargar. Cada formulario conserva en memoria su creación incierta: reintenta el cuerpo y la llave originales y, si entretanto se editaron campos, actualiza la misma entrada por PUT. Un rechazo explícito de validación/pre-mutuación permite corregir y enviar otra llave; errores de red/5xx no la cambian. El estado no se guarda en almacenamiento del navegador y termina al desmontarse el formulario/cambiar de sesión; no ofrece recuperación de una respuesta perdida después de cerrar o recargar la página.
- **Pruebas:** tres pestañas, resultado dentro de Probadas. Checklist, notas, borrador automático de notas, hallazgos/anulación, tomar/soltar, aprobar/fallar, publicación para clientes e historial se leen/escriben en la API. Soltar advierte que conserva la historia y no manda correo. Vista Lectura permite supervisión sin conceder acciones; quien solo tiene reportes entra directamente a Probadas.
- **Reportes:** vista previa HTML real, en iframe aislado sin scripts. Destinatarios activos del lookup, 1–30 usuarios. El envío presenta el 503 pendiente del servidor, sin éxito simulado. `/actualizaciones/que-hay-de-nuevo/reportes/:id` está fuera de la protección por opción/área: solo exige sesión activa; al iniciar sesión vuelve al mismo enlace. Lee el snapshot HTML, no reconstruye desde entradas actuales.
- **Público:** `/novedades` no tiene sidebar ni exige sesión. Solo consulta DTO públicos cerrados, con filtros y paginación en servidor; nunca descarga el estado privado. Fecha por mes de aprobación Bogotá. El visor quita imágenes/adjuntos pendientes, menciones y código; solo conserva enlaces HTTP(S) seguros. No copia automáticamente texto interno al editor público.
- **Almacenamiento pendiente:** producción no llama a subidas simuladas, no crea URLs Blob, ni importa imágenes privadas al texto público. La barra explica que no están conectados los archivos; pegar HTML no puede agregar nodos de imagen al esquema de producción. Se pueden registrar enlaces HTTPS de referencias internas.
- **Configuración:** usa permisos vigentes `configuration.whats_new.view/manage`, con acciones y publicación pública respaldadas por API. Sin árbol de menú, Excel ni PDF.
- **Prototipo aislado:** `VITE_WHATS_NEW_PROTOTYPE=true` solo tiene efecto cuando `import.meta.env.DEV` es verdadero. Rutas sin sesión exclusivamente `/__dev/que-hay-de-nuevo/*`, `/__dev/configuracion-que-hay-de-nuevo` y `/__dev/novedades`. No añade menú de producción ni altera autorización real.

Verificación enfocada: `npm test -- queHayDeNuevo --maxWorkers=1`; método PATCH compartido: `npm test -- ApiClient --maxWorkers=1`; tipos/build durante la ventana de integración secuencial. No se desplegó ni se aplicaron migraciones.

## Referencia histórica: prototipo

Estado: **prototipo navegable con datos simulados en memoria**. No llama a la API, no tiene backend ni SQL.
Todo el código vive en `frontend/src/pages/queHayDeNuevo/` y solo existe con la bandera `VITE_WHATS_NEW_PROTOTYPE=true`.

Este documento ya incluye las decisiones del propietario de la segunda y la tercera ronda (2026-11-18). Cuando contradicen al documento `01` o a las resoluciones de QA del `02`, **manda lo de aquí**. La lista está en la sección 10.

## 1. Cómo correrlo

```bash
cd frontend
npm ci
# Bash / Git Bash
VITE_WHATS_NEW_PROTOTYPE=true npm run dev
# PowerShell
$env:VITE_WHATS_NEW_PROTOTYPE = "true"; npm run dev
```

- Abre `http://localhost:5173`.
- Las opciones internas están dentro del portal, así que hay que **iniciar sesión**. El proxy de Vite apunta a la API local (`127.0.0.1:7071`), que debe estar corriendo.
- `/novedades` es pública y abre sin sesión.
- El menú muestra «Qué hay de nuevo» a quien tenga `updates.whats_new.view` y la configuración a quien tenga `configuration.whats_new.view`. Hoy esas llaves no están en el catálogo de permisos, así que en la práctica solo las ve `super_admin`. El catálogo se actualiza con el documento `06`.
- Los datos viven en memoria. **Al recargar, todo vuelve al estado inicial.** Para ver en `/novedades` los cambios de la sesión, usa el enlace «Abrir página del cliente» de la configuración, que navega en la misma pestaña.
- Sin la bandera, no existen las rutas ni las opciones de menú. Las páginas y los datos simulados se cargan bajo demanda (`React.lazy`), así que no entran al paquete principal. Con la bandera apagada, sus *chunks* se compilan pero nunca se descargan.

## 2. Mapa de páginas y rutas

| Ruta | Dónde | Qué muestra | Permiso (solo de UX) |
|---|---|---|---|
| `/actualizaciones/que-hay-de-nuevo` | Dentro de `AppLayout` | Visión Desarrollador «Mis entradas» o Visión Asesor «Bandeja de pruebas», según el selector | `updates.whats_new.view` |
| `/actualizaciones/que-hay-de-nuevo/nueva` | Ídem | Formulario de nueva entrada | Ídem, más el área Desarrollo |
| `/actualizaciones/que-hay-de-nuevo/:id/editar` | Ídem | «Continuar» un borrador propio | Ídem |
| `/actualizaciones/que-hay-de-nuevo/:id/corregir` | Ídem | «Corregir y volver a publicar» | Ídem |
| `/actualizaciones/que-hay-de-nuevo/:id` | Ídem | Detalle de solo lectura, para el desarrollador | Ídem |
| `/actualizaciones/que-hay-de-nuevo/reportes/:id` | Ídem | Reporte completo enviado, que es el destino del enlace del correo. **Exige sesión.** | Ídem, más cualquier área |
| `/configuracion/que-hay-de-nuevo` | Ídem | Acciones requeridas predefinidas y enlace para clientes | `configuration.whats_new.view` |
| `/novedades` | **Fuera** de `AppLayout`, sin sesión y sin barra lateral, como `/formatos-impresion` | Novedades de SAG Web | Ninguno |

Cambios mínimos fuera de la carpeta, todos condicionados por la bandera:

- `featureFlags.ts`, que es nuevo;
- `App.tsx`: las rutas y el `ProveedorQueHayDeNuevo`;
- `menu.ts`: las dos opciones;
- `package.json` y el *lock*, con TipTap.

## 3. Árbol de componentes

```
App
└─ ProveedorQueHayDeNuevo  (almacen.tsx · contexto con el estado simulado; se carga bajo demanda)
   ├─ /novedades → NovedadesPublicPage
   │    └─ Dialogo (Ver detalle) → VisorEnriquecido
   └─ AppLayout
      ├─ /actualizaciones/que-hay-de-nuevo/* → QueHayDeNuevoPage
      │    ├─ AvisoPrototipo · selector «Usuario simulado» · selector de visión (H-01)
      │    ├─ reportes/:id → ReporteGuardado → CuerpoReporte
      │    ├─ Visión Desarrollador (rutas anidadas)
      │    │    ├─ MisEntradas (contadores, filtros, pestañas, tabla)
      │    │    ├─ FormularioEntrada (nueva | editar | corregir)
      │    │    │    ├─ ConstructorRutas → FilaRuta
      │    │    │    ├─ EditorEnriquecido (mediano: Qué cambió, nota de corrección)
      │    │    │    ├─ EditorEnriquecido (compacto: una por acción requerida)
      │    │    │    ├─ SelectorBuscable (Asesor a cargo), dentro de <label>
      │    │    │    ├─ ListaAdjuntos ×2 (reglas de negocio, video)
      │    │    │    ├─ Panel «¿Va en el Qué hay de nuevo?» + «Vista previa para Soporte»
      │    │    │    └─ Dialogo (Eliminar borrador)
      │    │    └─ DetalleDesarrollador (ListaRutas, VisorEnriquecido, ListaHallazgos, Historial)
      │    └─ Visión Asesor → BandejaPruebas
      │         ├─ filtros · pestañas · filtro «Resultado» (solo Probadas) · lista
      │         ├─ DetalleAsesor (acciones, checklist, hallazgos, notas, BloqueClientes, Historial, rondas)
      │         │    └─ Dialogo (Soltar) · Dialogo (Anular hallazgo)
      │         └─ DialogoReporte (solo Probadas) → CuerpoReporte · CorreoReporte
      └─ /configuracion/que-hay-de-nuevo → ConfiguracionQueHayDeNuevoPage
           ├─ AccionesPredefinidas
           └─ EnlaceClientes (BotonCopiar · interruptor «Publicación activa»)
```

Archivos:

| Archivo | Responsabilidad |
|---|---|
| `tipos.ts` | Modelo: entrada, rondas, hallazgos, historial, reportes y configuración |
| `logica.ts` | Reglas puras sin React: validación, ciclo de estados, visibilidad pública y fechas. Es la referencia para el backend. |
| `datosSimulados.ts` | 8 usuarios y 10 entradas en todos los estados y tipos |
| `almacen.tsx` | Contexto con el estado y las acciones. Cada acción devuelve `null` o el mensaje del error de regla. |
| `rutas.tsx` | Carga perezosa de las páginas y del proveedor |
| `componentes/EditorEnriquecido.tsx`, `extensiones.ts`, `subidaSimulada.ts` | Editor TipTap y carga simulada |
| `componentes/ConstructorRuta.tsx`, `ListaAdjuntos.tsx`, `Reportes.tsx`, `Comunes.tsx` | Piezas de las vistas |
| `queHayDeNuevo.css` | Estilos propios con los tokens de `styles.css`. Las clases llevan el prefijo `qhdn-`. |

## 4. Estados por pantalla

En el prototipo no hay carga ni errores de red, porque todo está en memoria. Los estados de carga y de error se listan para la versión con API.

| Pantalla | Cargando | Vacío | Error | Deshabilitado / sin acceso |
|---|---|---|---|---|
| Entrada a la opción | «Cargando...», mientras baja el *chunk* | — | — | Sin área Desarrollo ni Soporte: tarjeta «No tienes un área habilitada para esta opción» |
| Mis entradas | Con API: esqueleto de tabla | «Aún no tienes entradas…» / «No hay entradas con estos filtros.» | Con API: `alerta-error` con reintento | Las entradas de otros (filtro «Todo el equipo») abren en solo lectura |
| Formulario | — | Valores iniciales | Resumen `role="alert"` que recibe el foco, más un error por campo (`aria-invalid` y `aria-describedby`) | Corregir en `en_pruebas`: «Pídele al asesor que la suelte». Editar algo ajeno o publicado: mensaje con enlace al detalle. |
| Detalle (desarrollador) | — | «Sin hallazgos registrados.» | «La entrada no existe…» | «Corregir y volver a publicar» deshabilitado, con el motivo visible |
| Bandeja | — | Por pestaña: «No hay entradas en «X» con estos filtros.» Sin selección: ayuda de 3 pasos | Errores de regla en `alerta-error` con `role="alert"` | Tomar, Marcar fallida y Marcar probado deshabilitados, con el motivo debajo. Lo que tiene otro asesor se ve en solo lectura, con «La tiene X». |
| Reporte | — | «No hay entradas para incluir…» | — | «Enviar» deshabilitado sin destinatarios o sin entradas |
| `/novedades` | «Cargando...» | «Sin novedades por ahora.» (publicación apagada o nada visible) / «No hay novedades con estos filtros.» | Con API: mensaje genérico, sin detalles técnicos | — |
| Configuración | — | — | Acciones: «Debe quedar al menos una acción activa», nombres vacíos o repetidos | — |

## 5. Editor enriquecido (`EditorEnriquecido`)

- **Motor:** TipTap 3.32.2, con versión exacta y publicada hace más de dos semanas. Paquetes: `@tiptap/react`, `@tiptap/pm`, `@tiptap/core`, `@tiptap/starter-kit` (incluye enlace, subrayado, listas, cita, código y deshacer), `@tiptap/extension-text-style` (`TextStyle` y `Color`), `@tiptap/extension-image` y `@tiptap/extensions` (`Placeholder`). `npm run security:audit:prod` pasa.
- **Valor:** siempre el **JSON de TipTap** (`JSONContent`). Nunca se recibe ni se guarda HTML. Para mostrar en solo lectura se usa el mismo editor con `editable: false` (`VisorEnriquecido`), sin `dangerouslySetInnerHTML`.
- **Nodos propios** (`extensiones.ts`):
  - `mencion`: `{ id, etiqueta }`. Inserta el nombre resaltado de un usuario, **sin notificación** (H-14).
  - `adjuntoArchivo`: `{ href, nombre, tamano }`. Es una ficha en línea con descarga.
- **Barra**, modelada en el editor pequeño de Azure DevOps:
  - Estilo de párrafo (Normal o Título, que es `h3`);
  - Negrita, Cursiva, Subrayado y Tachado;
  - Enlace;
  - Lista con viñetas, Lista numerada, Cita, Código en línea y Bloque de código;
  - Color del texto, con 5 colores de la paleta más «Automático»;
  - Adjuntar archivo, Insertar imagen y Mencionar a un usuario.
- **Accesibilidad de la barra:**
  - `role="toolbar"` con el nombre «Formato de …»;
  - una sola parada de tabulación, y flechas, Inicio y Fin para moverse;
  - cada botón tiene `aria-label` y `title`;
  - los de formato usan `aria-pressed`;
  - los que abren panel (enlace, color y mención) usan `aria-expanded` y `aria-controls`;
  - los paneles cierran con Escape;
  - el área editable es `role="textbox"` con `aria-multiline`, nombrada por la etiqueta visible (`aria-labelledby`).
- **Tamaños:**
  - `mediano`, con un mínimo de unas 5 filas (112 px): Qué cambió, notas de prueba y nota de corrección;
  - `compacto`, con un mínimo de unas 2 filas (48 px): cada acción requerida y el texto para clientes.
  - Los dos crecen con el contenido.
- **Enlaces:** solo `https://`, `http://` o `mailto:`. Se abren con `rel="noopener noreferrer nofollow"`.
- **Imágenes y archivos, en el prototipo:**
  - imágenes PNG, JPG, GIF o WebP de hasta 5 MB;
  - archivos de hasta 20 MB;
  - la carga se simula con progreso anunciado (`role="status"` y `<progress>`) y termina en una **URL de objeto local** (`blob:`).
- La mención solo aparece si el editor recibe usuarios. El texto para clientes no ofrece menciones y, al copiar «Qué cambió», se quitan las menciones y los adjuntos internos (QA-13).

## 6. Detalles de interacción

### Visión Desarrollador

- **Contadores:** Total, Borradores, Sin probar, En pruebas, Fallidas y Probadas.
- **Filtros:** Ver (Mis entradas o Todo el equipo en solo lectura, QA-03), Tipo, Sistema, Estado y Búsqueda.
- **Pestañas:** Todas, Borradores y Publicadas.
- **Columna Estado:** trae un detalle, como «Faltan campos», «Listo para publicar», «Felipe Cardona · 2 de 3» o «2 hallazgos». Así el desarrollador ve sus fallidas y sus hallazgos desde «Mis entradas».
- **Formulario:**
  - Tipo, Sistema, **Desarrollador** y Ruta. El Desarrollador es siempre el autor; se muestra en solo lectura y no se elige.
  - Qué cambió.
  - Acción requerida: las casillas salen de la configuración y cada una abre su editor compacto obligatorio.
  - Solo desarrollos nuevos, solo para el tipo Nuevo:
    - Cliente, como texto libre (H-12);
    - Asesor a cargo, con `SelectorBuscable` de usuarios activos con área Soporte, sin incluir al autor;
    - adjuntos de reglas de negocio y de video, cada uno Archivo o Enlace https.
  - Si el tipo cambia, los datos de Nuevo se descartan al guardar.
- **Constructor de rutas** (tercera ronda):
  - el nivel 1 es una lista fija con «Barra de navegación» y «Barra lateral»;
  - los submenús y la Opción se escriben **a mano**; no hay menú de referencia, sugerencias ni «Otro…»;
  - «+ Submenú» agrega un submenú antes de la Opción y «× Submenú» quita el último;
  - cada ruta tiene de 3 a 5 niveles;
  - hay hasta 10 rutas, sin rutas repetidas;
  - la primera ruta es la principal.
- **Panel lateral:**
  - las 5 preguntas, cada una con un botón «Sí: <tipo>» que fija el tipo;
  - «No va»;
  - la vista previa en vivo para Soporte.
- **Guardar borrador:** solo valida el tamaño, con un tope de 512 KB en el prototipo.
- **Autoguardado:** cada 30 s si hay cambios, y al salir de un campo. Muestra «Guardado hace 1 min» en `role="status"`. No cambia la URL, para no remontar el formulario ni perder el foco.
- **Publicar a Soporte:** valida todo, muestra el resumen de errores y les pone el foco; si pasa, deja la entrada en `sin_probar`.
- **Corregir y volver a publicar:**
  - el autor lo hace en `sin_probar` o en `fallida`, nunca en `en_pruebas` (H-11 y QA-06);
  - solo se editan Qué cambió y Acción requerida, más una nota opcional;
  - desde `fallida` abre una ronda nueva y conserva los hallazgos.

### Visión Asesor

- **Pestañas** (segunda ronda): **Sin probar**, la que se ve por defecto, **En pruebas** y **Probadas**. No hay pestaña Fallidas.
  - En Probadas, el filtro **Resultado** ofrece «Ambas», que es el valor por defecto, «Sin errores» y «Fallidas».
  - Las archivadas (QA-10) también caen en Probadas, dentro de «Sin errores».
- **Filtros:** tipo, sistema, mes, año, búsqueda y la casilla «Asignadas a mí» (QA-02). La insignia «Asignada a X» indica prioridad, no exclusividad.
- **Detalle de la entrada:**
  - etiquetas;
  - **Desarrollador**, que es el autor, y **Asesores que han probado**: todos los que tomaron una ronda, incluidas las soltadas, las fallidas y las re-pruebas;
  - rutas y Qué cambió;
  - Mi checklist, con barra de avance;
  - referencias, hallazgos y notas;
  - Para clientes;
  - Historial de la entrada y Rondas de prueba.
- **Ciclo** (`logica.ts`):
  - **Tomar:** lo hace cualquier asesor activo de Soporte. Nunca lo hace el autor ni quien editó o corrigió la entrada (H-01 y QA-04).
  - **Soltar:** pide confirmación. La entrada vuelve a Sin probar y la prueba empieza de nuevo. La ronda queda como «soltada», con su checklist y sus notas, y no se envía nada.
  - **Registrar hallazgo:** convierte la nota en un hallazgo numerado. También existe «Guardar como nota».
  - **Anular:** pide un motivo y deja el hallazgo tachado; nunca lo borra (QA-26).
  - **Marcar fallida:** exige un hallazgo vigente de la ronda actual (QA-11).
  - **Marcar probado:** exige el checklist completo de la ronda actual.
  - **Archivar:** sale de Probado. Pide el permiso `manage`, que el prototipo no simula.
  - Cada acción agrega un evento al **historial** de la entrada.
- **Para clientes:**
  - el interruptor `role="switch"` «Mostrar esta novedad a los clientes» abre «Título para clientes» y «Texto para clientes»;
  - el texto para clientes parte de una copia de Qué cambió, sin menciones;
  - mostrar a clientes significa mostrar a **todos los clientes**, también las entradas Nuevo que tienen cliente asignado (segunda ronda);
  - el interruptor queda deshabilitado, con su explicación, cuando la entrada es SP crítico (H-05) o cuando el usuario no puede editar;
  - en pruebas lo edita quien tiene la ronda activa; ya probada, un asesor que no sea autor ni editor.
  - El texto pertenece a la entrada y sobrevive a Soltar (QA-09).
- **Reporte** (segunda ronda): **solo desde la pestaña Probadas**, con el botón «Enviar reporte». No hay reporte por entrada ni en otras pestañas.
  - El diálogo pide **qué incluir**: Todas, Solo aprobadas o Solo fallidas, con su conteo.
  - Pide los **destinatarios**: usuarios activos del portal, con búsqueda por nombre o correo y casillas de selección múltiple. No hay aviso de «sin acceso».
  - «Ver reporte» abre la vista previa en HTML.
  - «Enviar a N personas» simula el correo. El cuerpo trae el resumen y la frase «Para ver el reporte completo, abra el enlace», que lleva a `/actualizaciones/que-hay-de-nuevo/reportes/:id`, una ruta interna que **exige sesión**.
  - No se genera PDF.
  - El reporte completo trae, por entrada: resultado, tipo, sistema, desarrollador, asesores, fechas, qué cambió, acciones, hallazgos de todas las rondas (o «Sin hallazgos»), rondas con checklist y notas, e historial.

### Página pública `/novedades`

- **Encabezado:** la marca, el título «Novedades de SAG Web» y el subtítulo.
- **Filtro de tipo:** Todo, Opciones nuevas (tipo Nuevo) y Mejoras (Mejora, Regla de negocio y Rediseño).
- **Filtro de fecha de liberación:** Mes actual, Últimos 3 meses, Último año, Todo (el valor por defecto) y Rango de fechas, con Desde y Hasta.
  - La fecha de liberación es el **mes en que la entrada quedó probada**, en hora de Bogotá.
  - «Últimos 3 meses» toma el mes actual y los dos anteriores.
  - «Último año» toma el mes actual y los 11 anteriores.
- **Tarjeta:** insignia, «Mes de año», título, texto simple recortado a 3 líneas, «Dónde lo encuentras» (la ruta principal) y «Ver detalle», que abre un diálogo con el texto completo y sus imágenes.
  - El detalle usa el `idPublico` aleatorio en `?detalle=` (QA-23).
- **Qué aparece:** solo entradas `probado` con «Mostrar» activo, título y texto. Nunca SP crítico ni archivadas.
- **Orden:** de la más reciente a la más antigua, con un máximo de 100 (QA-22).
- **Lo que nunca aparece:** cliente, desarrollador, asesores, documentos de reglas de negocio, videos, notas ni hallazgos.
- No hay «Marcar todo como leído» ni «Pedir asesoría».

### Configuración

Tercera ronda: solo quedan la lista de acciones y el enlace. **No hay menú de referencia ni carga de Excel.**

- **Acciones requeridas predefinidas:**
  - se puede renombrar, activar o desactivar, subir o bajar y agregar;
  - siempre debe quedar una activa;
  - las entradas guardan una copia del nombre.
- **Enlace para clientes:**
  - la URL `/novedades` con «Copiar enlace»;
  - «Abrir página del cliente», en la misma pestaña;
  - el interruptor «Publicación activa».

## 7. Accesibilidad

- Toda etiqueta visible está ligada a su control:
  - con `htmlFor` e `id`;
  - con `<label>` envolvente para `SelectorBuscable`, que no recibe `id`;
  - con `aria-labelledby` para los editores.
- Los grupos de radios y casillas usan `fieldset` y `legend`. Las pestañas usan `role="tab"` y `aria-selected`.
- Los botones de icono tienen nombre accesible y los íconos son `aria-hidden`.
- **`Dialogo` propio** (`componentes/Comunes.tsx`), con las mismas clases que `Modal`:
  - `role="dialog"`, `aria-modal` y título asociado;
  - foco inicial y trampa de foco;
  - Escape para cerrar y foco restaurado al salir.
  - No se modificó el `Modal` compartido, para no tocar otras pantallas.
- **Regiones vivas:**
  - resultados de acciones con `role="status"` o `role="alert"`;
  - autoguardado;
  - progreso de carga;
  - conteo de destinatarios;
  - estado de visibilidad para clientes.
- Una acción deshabilitada siempre explica su motivo en texto visible, enlazado con `aria-describedby`.
- Foco visible con el contorno `--color-secondary`. Se respeta `prefers-reduced-motion`.
- **Pendiente:** `SelectorBuscable` sigue sin navegación por flechas. Se reutilizó tal cual, según `DESIGN_SYSTEM.md`, porque esta tarea no lo tocaba.

## 8. Forma del almacén simulado

```ts
EstadoAlmacen = {
  entradas: Entrada[];             // ver tipos.ts
  usuarios: UsuarioPortal[];       // { id, nombre, correo, areas[], activo, accesoQhdn }
  configuracion: { accionesPredefinidas: AccionPredefinida[]; publicacionActiva: boolean };
  usuarioActualId: string;         // usuario simulado
  vision: "desarrollador" | "asesor";
  reportes: ReporteEnviado[];      // { id, fecha, autorId, filtro, entradaIds, destinatarioIds }
}

Entrada = {
  id, idPublico, tipo, sistema, rutas: { id, niveles: { valor }[] }[],
  queCambio: JSONContent | null, acciones: { accionId, nombre, texto }[],
  cliente, asesorInicialId, reglasNegocio: Adjunto[], videos: Adjunto[],
  estado: "borrador" | "sin_probar" | "en_pruebas" | "fallida" | "probado" | "archivada",
  autorId /* = Desarrollador */, creadaEn, editadaPorId, editadaEn, editoresIds[],
  publicadaPorId, publicadaEn, tomadaPorId,
  rondas: { numero, asesorId, tomadaEn, cerradaEn, resultado, checklist: Record<accionId, boolean>, notas[] }[],
  hallazgos: { numero, ronda, fecha, autorId, texto, anulacion: { fecha, autorId, motivo } | null }[],
  correcciones: { fecha, autorId, ronda, texto }[],
  historial: { fecha, usuarioId, accion }[],
  probadaEn, archivadaEn, mostrarClientes, tituloClientes, textoClientes
}
```

**Acciones del contexto**, cada una devuelve `null` o el mensaje del error:

- `guardarBorrador`, `publicar`, `eliminarBorrador` y `corregir`;
- `tomar`, `soltar`, `alternarChecklist`, `agregarNota`, `anularHallazgo`, `marcarFallida`, `marcarProbado` y `archivar`;
- `actualizarTextoClientes` y `enviarReporte`;
- `guardarAccionesPredefinidas` y `cambiarPublicacionActiva`;
- `cambiarUsuario` y `cambiarVision`, que son solo del prototipo.

**Semilla:**

| Entrada | Situación |
|---|---|
| e-101 | Borrador propio, con campos faltantes |
| e-102 | Mejora sin probar, de otro desarrollador |
| e-103 | Regla de negocio sin probar, propia: no se puede tomar |
| e-104 | Nuevo en pruebas con Felipe, 2 de 3, con cliente |
| e-105 | SP crítico en pruebas con Laura |
| e-106 | Rediseño fallido, propio, con 2 hallazgos |
| e-107 | Mejora probada y visible, con imagen y un hallazgo menor |
| e-108 | Nuevo probado y visible |
| e-109 | Regla de negocio probada y no visible |
| e-110 | SP crítico probado |

El usuario inicial es **Laura Méndez**, que tiene las áreas Desarrollo y Soporte, así que ve el selector de visión.

## 9. Qué cambia cuando llegue la API

1. **Datos.** `almacen.tsx` se reemplaza por consultas y mutaciones de React Query sobre `api/client`, con los DTO del documento `04`. Los componentes ya consumen funciones con el mismo nombre que devuelven `null` o un error.
   - El usuario y las áreas salen de `/me` y el selector de usuario simulado desaparece.
   - El selector de visión queda solo para quien tiene las dos áreas.
2. **Reglas.** `logica.ts` queda como validación de interfaz. El backend es la autoridad sobre permiso, área, objeto, estado y `row_version` (concurrencia, H-11). Cada acción de cambio de estado envía su llave de idempotencia (QA-25).
3. **Cargas.**
   - `useSubidaSimulada` y `urlDeObjeto` pasan a la carga a SeaweedFS del documento `05`: pedir la URL de escritura, subir con progreso y confirmar.
   - Los nodos `image` y `adjuntoArchivo` guardan el **id del archivo**, no la URL, y la lectura pasa por el endpoint que responde 302.
   - No se lee el contenido de Excel, Word, PDF ni video: solo se suben y se descargan.
4. **Reporte.**
   - `enviarReporte` pasa a `POST` contra el outbox de correos.
   - El enlace del correo apunta a la ruta del reporte guardado en el servidor, que exige sesión.
5. **Página pública.**
   - `/novedades` lee un endpoint público con `Cache-Control: no-store` (QA-21) que ya devuelve solo los campos públicos.
   - El filtro de fechas puede ir al servidor.
   - Las imágenes se sirven por el endpoint público de H-15.
6. **Permisos.**
   - Se agregan al catálogo de permisos las llaves del documento `06`: `updates.whats_new.view`, `author`, `test`, `publish_client` y `manage`, y `configuration.whats_new.view`.
   - Archivar y forzar Soltar se muestran solo con `manage`.
7. **Bandera.** Cuando el backend esté listo, se cambia por una bandera de *release* o se retira.

## 10. Decisiones del propietario aplicadas y ambigüedades resueltas

| Tema | Decisión aplicada |
|---|---|
| Pestañas del asesor | Sin probar, En pruebas y Probadas. Fallidas queda dentro de Probadas, con el filtro Resultado: Ambas, Sin errores o Fallidas. |
| Reportes | Solo desde Probadas. El diálogo elige qué incluir (Todas, Solo aprobadas o Solo fallidas) y los destinatarios. Se genera HTML con vista previa y un correo simulado con el enlace, que exige sesión. Sin PDF, sin «Solo hallazgos o Completo» y sin aviso QA-27. |
| Desarrollador | Siempre es el autor, en solo lectura. Las entradas guardan todos los asesores que participaron y un historial. Ambos se muestran en los dos detalles y en el reporte. |
| Página pública | Mostrar significa mostrar a todos los clientes. Las entradas Nuevo sí se muestran. Se retiró «Disponible para todos los clientes» y el bloqueo por cliente asignado (QA-01 y H-02 quedan reemplazados). Nunca aparecen cliente, desarrollador, asesores, reglas de negocio ni videos. SP crítico sigue oculto. |
| Fechas públicas | Mes actual, Últimos 3 meses, Último año, Todo y Rango. La fecha es el mes de aprobación. |
| Rutas | Siempre a mano. Nivel 1 fijo (Barra de navegación o Barra lateral) también para SAG Clásico, lo que reemplaza el «Menú principal» de H-07. Sin menú de referencia, sin sugerencias y sin «Otro…». |
| Configuración | Solo acciones predefinidas y enlace para clientes. Sin carga de menú ni Excel. |
| Fallida | Exige un hallazgo **vigente** (no anulado) de la ronda actual. |
| Corregir desde `sin_probar` | No crea ronda: nadie había probado. Desde `fallida`, sí la crea. |
| Texto para clientes después de probado | Lo edita un asesor que no sea autor ni editor; `publish_client` aún no se simula. |
| Mes y año | Se calculan en America/Bogota, UTC−5 (QA-24). |
