# Qué hay de nuevo · Diseño funcional

Estado: **diseño funcional de referencia**. El estado y los límites de la implementación local están en los documentos 11 y 12. Fuente: instrucciones de Juan Camilo del 2026-11-18 y prototipos de Figma «Que hay de nuevo Portal Web», con las tres visiones: Desarrollador, Asesor y Cliente.
Ubicación: **Actualizaciones › Qué hay de nuevo**. La configuración va en **Configuración › Qué hay de nuevo**.


> **Decisiones del propietario, segunda ronda (2026-11-18). Prevalecen sobre cualquier texto de este documento o de los demás.**
>
> 1. **Pestañas del asesor:** Sin probar · En pruebas · Probadas. **No hay pestaña Fallidas.** Dentro de Probadas hay un filtro de resultado: Sin errores · Fallidas · Ambas. El estado `fallida` se conserva.
> 2. **Soltar** devuelve la entrada a Sin probar y reinicia la prueba. No envía nada.
> 3. **Reportes:**
>    - **solo desde la pestaña Probadas**; no hay reporte por entrada;
>    - se elige qué incluir: **Todas**, **Solo aprobadas** o **Solo fallidas**;
>    - los destinatarios son uno o varios usuarios del portal, elegidos con casillas, sin advertencias;
>    - el reporte es **HTML**: el correo lleva el resumen y el enlace «Para ver el reporte completo, abra el enlace»;
>    - **no se genera PDF**.
> 4. **Equipo de la entrada:**
>    - cada entrada tiene el campo interno **Desarrollador**, que por defecto es el autor;
>    - guarda a **todos los asesores** que participaron en las pruebas, incluidos quienes la rechazaron y quienes la volvieron a probar;
>    - lleva una **bitácora** de cada acción, con quién y cuándo;
>    - el reporte incluye al desarrollador y a los asesores.
> 5. **Página del cliente:**
>    - mostrar a clientes es **mostrar a todos los clientes**, sin confirmación adicional; las entradas Nuevo **sí** se muestran;
>    - **nunca** se publican el nombre del cliente, el desarrollador, los asesores, los documentos de reglas de negocio ni los videos;
>    - SP crítico no se muestra.
> 6. **Fecha de liberación:** es el **mes en que se aprobó**, al marcarla probado. El cliente filtra por Mes actual · Últimos 3 meses · Último año · Todo · Rango de fechas.
> 7. **Sin lectura de Excel en ninguna parte.** Los adjuntos (Word, Excel, PDF y video) solo se suben y se descargan.
> 8. **Almacenamiento:** solo SeaweedFS. La estructura de carpetas está en el documento `10_ARQUITECTURA.md`.
> 9. **Rutas siempre a mano, sin menú de referencia:**
>    - no hay árbol de menú configurado ni sugerencias, porque las opciones nuevas todavía no están en ningún menú;
>    - la única ayuda es el nivel 1, un selector fijo: **Barra de navegación** o **Barra lateral**;
>    - los submenús y la opción se escriben a mano;
>    - con esto se retira el «Menú de referencia» de la configuración (§7) y del modelo de datos.
> 10. **Desarrollador:** es **siempre quien crea la entrada**, no se puede elegir. Si el autor ya no está, un líder con `configuration.whats_new.manage` puede corregir la entrada en su nombre, queda en la bitácora y el campo Desarrollador **no cambia**. Esto reemplaza la «reasignación de autor» de QA-07.
> 11. **Enlace del reporte en el correo:** pide **iniciar sesión** si la persona no la tiene abierta. Cualquier usuario activo del portal con el enlace puede abrirlo; no se exige un área, permiso de la opción ni pertenecer a los destinatarios.

## 1. Propósito

Todo cambio que libera Desarrollo queda registrado en un solo lugar, con estas características:

- **Desarrollo** lo describe una vez, con ruta, qué cambió y la acción que debe hacer Soporte.
- **Soporte** lo prueba siguiendo su checklist, registra hallazgos y reporta.
- El **cliente** ve lo que Soporte decidió mostrarle. Lo ve en lenguaje simple, desde un enlace abierto.

Reemplaza la plantilla de Word «Qué Hay de Nuevo SAG Web» y aplica las LUP DEV-001 y DEV-002.

## 2. Quién ve qué

| Visión | Quién entra | Cómo se decide |
|---|---|---|
| Desarrollador · «Mis entradas» | Usuario con permiso `updates.whats_new.author` **y** con la marca de área **Desarrollo** | Permiso y área. El backend exige las dos cosas. |
| Asesor · «Bandeja de pruebas» | Usuario con permiso `updates.whats_new.test` **y** con la marca de área **Soporte** | Permiso y área |
| Cliente · «Novedades de SAG Web» | Cualquiera con el enlace abierto `/novedades` | Sin inicio de sesión, igual que `/formatos-impresion`. Solo ve las entradas que Soporte marcó para mostrar a clientes. |

Una persona con las dos marcas y los dos permisos ve un selector de visión arriba de la página. Ver la decisión H-01 en el documento de huecos.

## 3. Marca de área en Usuarios

En **Configuración › Usuarios y Roles**, cada usuario tiene **Área**, con selección múltiple: Soporte, Desarrollo, Ventas y Administrativa.

- Es una **clasificación**, no un permiso. Sirve para tres cosas:
  - llenar el selector «Asesor a cargo de pruebas iniciales», que solo muestra usuarios activos con el área Soporte;
  - exigir el área junto con el permiso para crear o probar entradas, tal como se pidió: «solo alguien que tenga esta marca»;
  - filtrar y agrupar los reportes.
- Se audita cada cambio de área.

## 4. Visión Desarrollador

### 4.1 Mis entradas (índice)

Arriba de la lista se muestra un resumen: total de entradas, borradores, sin probar, en pruebas, fallidas y probadas.

- **Filtros:** tipo, sistema, estado y una búsqueda por ruta o por texto.
- **Pestañas:** Todas · Borradores · Publicadas.
- **Columnas:** Tipo · Ruta · Qué cambió (resumen de una línea) · Sistema · Estado (con un detalle como «Faltan campos» o «2 hallazgos») · Creada · Acción.
- **Acciones:** **Continuar** si es un borrador y **Ver detalle** si ya se publicó. Una entrada publicada es de solo lectura, salvo la corrección del autor en `sin_probar` o `fallida` (ver 4.4 y 02 · QA-06).
- **Aviso fijo:** «Las entradas publicadas son de solo lectura. Si un asesor registra un hallazgo, lo verás en el detalle de la entrada».

### 4.2 Nueva entrada · formulario

| N.º | Campo | Control | Regla |
|---|---|---|---|
| 1 | Tipo | Radio | Nuevo · Mejora o cambio de funcionalidad · Regla de negocio · SP crítico · Rediseño o refactorización. Solo **Nuevo** muestra la sección «Solo desarrollos nuevos». |
| 2 | Sistema | Radio | SAG Web · SAG Clásico |
| 3 | Ruta | Constructor dinámico | Ver 4.3. Se requiere al menos una ruta. |
| 4 | Qué cambió | Editor enriquecido **mediano**, de unas 5 filas | Obligatorio. Usa el lenguaje del usuario. Si es un parámetro, se escribe su nombre y en qué maestro está. |
| 5 | Acción requerida | Casillas y un editor **compacto** por casilla, de 2 filas | Al menos una. Las opciones fijas son: Leer las reglas de negocio · Dar permiso a la opción · Probar estas opciones o módulos · Otro. Cada casilla marcada abre su propio editor compacto y obligatorio. |
| 6 | Cliente | Selector buscable | Solo para Nuevo. **Por ahora es un selector abierto sin fuente de datos**, porque la marca «activo en SAG Web» la está construyendo otra línea de trabajo. Se puede guardar vacío en borrador; para publicar debe tener un valor. |
| 7 | Asesor a cargo de pruebas iniciales | Selector buscable | Solo para Nuevo. Lista los usuarios activos con área Soporte. |
| 8 | Documento de reglas de negocio | Lista de adjuntos | Opcional, solo para Nuevo. Acepta varios elementos, cada uno **Archivo** (Word, PDF o Excel) o **Enlace** (URL https). |
| 9 | Video de la entrega | Lista de adjuntos | Opcional, solo para Nuevo. Igual que el anterior; el archivo puede ser mp4 o webm. |

**Panel lateral «¿Va en el Qué hay de nuevo?»**: se actualiza con lo vigente de la LUP DEV-001. Cada pregunta tiene un tipo de respuesta:

| Pregunta | Tipo de entrada |
|---|---|
| ¿El sistema hace algo significativo que antes no hacía? | Nuevo |
| ¿Cambié cómo funciona algo que ya existía? | Mejora |
| ¿Cambió el resultado de una acción del usuario o de un parámetro? | Regla de negocio |
| ¿Modificaste un SP de un proceso crítico? | SP crítico |
| ¿Cambié tanto una opción que habría que volver a probarla? | Rediseño o refactorización |

- **No va:** corrección de errores, cambios internos o cambios pequeños de diseño.
- **Vista previa para Soporte:** se ve en vivo cómo leerá Soporte la entrada.

**Botones:**

| Botón | Qué valida | Resultado |
|---|---|---|
| **Guardar borrador** | Nada, salvo el tamaño del contenido | Estado `borrador` |
| **Publicar a Soporte** | Todo | Estado `sin_probar` |

Todo queda a nombre del usuario autenticado: quién creó la entrada, quién la editó por última vez y quién la publicó, con la fecha de cada acción. **Autoguardado** del borrador cada 30 s o al salir de un campo, con el aviso «Guardado hace 1 min».

### 4.3 Constructor de ruta

- **Nivel 1, fijo:** Barra lateral o Barra de navegación, para SAG Web. Para SAG Clásico, ver H-07.
- **Niveles intermedios:** Submenú. Con **+** se agrega otro submenú; el último nivel siempre es la **Opción**. Con **×** se quita el último submenú agregado.
- **Mínimo 3 niveles** (vía, submenú y opción) y **máximo 5**.
- **Sugerencias:** cada nivel sugiere valores del **menú cargado en la configuración**, filtrados por el nivel anterior. Siempre existe **«Otro…»** para escribirlo a mano, porque las opciones nuevas todavía no están en el menú.
- **+ Agregar ruta relacionada:** se pueden agregar varias rutas. Una de ellas es la principal, la primera; las demás son relacionadas.
- Se muestra como texto `Barra lateral › Ventas › Facturas › Factura de venta`.

### 4.4 Después de publicar

- El desarrollador ve el estado y los hallazgos en el detalle de la entrada.
- Si la entrada **falla**, el desarrollador puede **«Corregir y volver a publicar»**:
  - la entrada pasa a `sin_probar` con una nueva ronda de pruebas;
  - la historia anterior se conserva;
  - puede editar solo «Qué cambió» y «Acción requerida» y agregar una nota de corrección.

## 5. Visión Asesor · Bandeja de pruebas

### 5.1 Índice

- **Filtros:** tipo, sistema, mes y año, y una búsqueda por ruta o por texto.
- **Pestañas, con conteo:**
  - **Sin probar**, la que se ve por defecto;
  - **En pruebas**;
  - **Fallidas**;
  - **Probadas**.
- **Lista a la izquierda y detalle a la derecha.** Si no hay nada seleccionado, el panel muestra tres pasos: 1 Revisa una entrada sin probar · 2 Tómala para probar · 3 Registra hallazgos y márcala.
- **«En pruebas»** muestra quién la tiene y el avance del checklist, por ejemplo «Felipe Cardona · 2 de 3».

### 5.2 Ciclo de una entrada

```
borrador ──Publicar──▶ sin_probar ──Tomar──▶ en_pruebas ──Marcar probado──▶ probado ──Archivar──▶ archivada
              ▲           │  ▲   ▲                 │   │
              │ Corregir  │  │   └────Soltar───────┘   └──Marcar fallida──▶ fallida
              │ (autor)   ◀──┘                                                 │
              └──────────────────Corregir y volver a publicar (autor)───────────┘
```

Las dos flechas de corrección **terminan en `sin_probar`**, nunca en `borrador`: la entrada sigue publicada y abre una ronda nueva.

- **Tomar para probar:**
  - lo puede hacer cualquier asesor;
  - deja la entrada a nombre de quien la tomó;
  - nadie más puede editar la prueba;
  - los demás la ven de solo lectura, con el aviso «La tiene X».
- **Soltar:**
  - el asesor decide no seguir;
  - la entrada vuelve a `sin_probar` y **la prueba empieza de nuevo** cuando otro la tome;
  - la ronda soltada queda en el historial como «soltada», con su checklist y sus notas.
- **Marcar probado:** exige el checklist completo.
- **Marcar fallida:** exige al menos un hallazgo.
- **Corregir y volver a publicar:** lo hace el desarrollador y abre una ronda nueva.

### 5.3 Detalle de la entrada (asesor)

- Etiquetas de tipo, sistema y estado.
- La ruta o rutas.
- Qué cambió, en formato enriquecido y de solo lectura.
- **Mi checklist:** un ítem por cada acción requerida, con su texto y avance «2 de 3».
- **Referencias:** reglas de negocio y video, con archivos y enlaces.
- **Hallazgos registrados:** número, fecha y hora, autor y texto enriquecido. No se borran.
- **Notas de prueba y hallazgo:**
  - un editor enriquecido mediano, que acepta imágenes y adjuntos;
  - **Registrar hallazgo** convierte la nota en un hallazgo numerado;
  - la nota también puede quedar como nota de prueba sin ser hallazgo.
- **Mostrar esta novedad a los clientes:** abre el bloque «Texto para clientes», con título y descripción en palabras simples. Ver H-04.
- **Botones:** Soltar · Registrar hallazgo · Marcar fallida · Marcar probado.
- Se ve el aviso «Avance guardado automáticamente · hace 1 min».

### 5.4 Reportes

Hay dos alcances:

1. **De una entrada:** desde su detalle, en cualquier estado publicado.
2. **De la pestaña actual:** lo que esté en **Fallidas** o **Probadas**, con los filtros aplicados.

El asesor elige el **contenido**:

| Contenido | Qué incluye |
|---|---|
| **Solo hallazgos** | Por cada entrada: ruta, tipo, desarrollador y sus hallazgos |
| **Completo** | Todo lo anterior, más qué cambió, acciones requeridas, checklist, notas, quién probó, fechas y rondas |

Y la **salida**:

- **Descargar**: un PDF del reporte.
- **Enviar por correo**: un diálogo con **casillas de selección múltiple** que lista a los usuarios activos del portal, buscables por nombre o correo. Sale por el outbox de correos existente.

En la pestaña **Sin probar** no hay reporte de pestaña. En **En pruebas** tampoco, porque el reporte es de resultados. Sí está disponible el reporte de una entrada.

## 6. Visión Cliente · Novedades de SAG Web

- **Enlace abierto** `/novedades`, **sin inicio de sesión y sin barra lateral**: es una página completa, como `/formatos-impresion`.
- **Encabezado:** la marca del portal y el título «Novedades de SAG Web», con el subtítulo «Lo nuevo y mejorado en tu sistema, explicado en palabras simples».
- **Filtros:**
  - **Todo**;
  - **Opciones nuevas**, para el tipo Nuevo;
  - **Mejoras**, que agrupa Mejora, Regla de negocio y Rediseño. **No hay categoría propia de reglas de negocio**: van dentro de Mejoras.
  - Las de tipo SP crítico no se muestran; ver H-05.
- **Tarjeta:** etiqueta (Nuevo o Mejora), fecha de liberación, título, descripción simple, «Dónde lo encuentras» (la ruta principal) y el botón **Ver detalle**.
- **Ver detalle:** abre la descripción completa para clientes, con sus imágenes.
- **No hay** «Marcar todo como leído». «Pedir asesoría» queda sujeto a H-06.
- Solo aparecen entradas en estado **probado** y con **Mostrar a clientes** activo. Lo que ve el cliente es el **texto para clientes**, nunca las notas internas, los hallazgos ni los nombres del equipo.
- La página termina al final de la lista. No tiene paginación infinita ni nada más.

## 7. Configuración › Qué hay de nuevo

- **Menú de referencia:**
  - se carga **Menu Sag Web.xlsx**, de la hoja «Menú Final»;
  - el sistema lo convierte en un árbol de vía, submenús y opción, que alimenta las sugerencias de rutas;
  - cada carga queda versionada, con quién la cargó y cuándo;
  - se puede previsualizar el árbol antes de activarlo.
- **Acciones requeridas predefinidas:** una lista editable con nombre, orden y si está activa. Las cuatro que trae el prototipo son las iniciales.
- **Enlace para clientes:**
  - muestra la URL `/novedades` y un botón para copiarla;
  - tiene un interruptor de «Publicación activa»; si está apagado, el enlace muestra «Sin novedades por ahora».

## 8. Almacenamiento

- **Solo SeaweedFS**, con su gateway S3 y el perfil de almacenamiento del portal. No se usa Azure Blob.
- Las imágenes del editor, los adjuntos de reglas de negocio y video, y los adjuntos de notas y hallazgos van bajo el prefijo `<base>/Archivos/que-hay-de-nuevo/<entry_id>/…`.
- SQL guarda solo el localizador, el proveedor, el tipo, el tamaño y el SHA-256; nunca los bytes.
- Detalle técnico en el documento `05`.

## 9. Fuera de alcance de esta versión

- Notificaciones automáticas por cada hallazgo; el correo sale con «Enviar reporte».
- Comentarios en hilo entre desarrollador y asesor.
- Versión del cliente con inicio de sesión o filtrada por empresa; ver H-02.
- La fuente de datos del selector Cliente.
