# Qué hay de nuevo · Plan de pruebas

Estado: **diseño, antes de desarrollar**. Autor: QA. Fecha: 2026-11-18.
Fuentes: `01_DISENO_FUNCIONAL.md`, `02_HUECOS_DE_LOGICA.md` (con sus propuestas como vigentes), `AGENTS.md`, `ARCHITECTURE.md`, `DESIGN_SYSTEM.md`, `BUSINESS_RULES_TEST_MATRIX.md` y `docs/ENGINEERING_SKILLS_AND_TESTING.md`.

Este documento no depende de los documentos `03` a `07`, que se escriben en paralelo. Donde un caso necesita un nombre de endpoint, tabla, permiso o límite que todavía no existe, usa un **símbolo** (por ejemplo `L_TEXTO`) o un nombre provisional entre corchetes. Al congelar los contratos, el desarrollador reemplaza cada símbolo por el valor real en la columna «Prueba» de su suite y QA actualiza esta tabla. Un caso con un símbolo sin valor queda **pendiente**, no aprobado.

## 0. Convenciones

- **ID de caso:** `QN-<grupo>-<n>`. Los IDs son estables; si un caso se retira, se marca «retirado», no se renumera.
- **Capa:** `U` unidad (función pura o servicio en `api/src/lib` o utilidades del frontend), `API` handler HTTP con autenticación real de la app y repositorio simulado o SQL de QA, `UI` página o componente con Vitest, jsdom y Testing Library, `E2E` flujo real en el entorno de QA con navegador, `SQL` consulta o restricción contra la base de QA.
- **Evidencia:** lo que se debe guardar para que el caso cuente como aprobado. «Salida de prueba» significa el nombre del test y su resultado en la corrida del SHA candidato. Un caso no observado es **pendiente**, nunca aprobado.
- **Resultado 403 y 404:** donde dice «denegado», el cuerpo de respuesta es un error controlado en español, sin detalle de SQL, almacenamiento, permisos internos ni existencia del objeto, salvo que el caso diga lo contrario.
- **Permisos provisionales:** `updates.whats_new.author`, `updates.whats_new.test` (vienen de `01`); `[updates.whats_new.view]`, `[updates.whats_new.configure]` y `[updates.whats_new.report]` son supuestos de QA hasta que `06` los fije (ver QA-15).
- **Zona horaria:** las fechas «mes y año» se evalúan en `America/Bogota` (ver QA-24).

### 0.1 Límites simbólicos

| Símbolo | Qué limita | Valor |
|---|---|---|
| `L_QC` | Tamaño del documento JSON de «Qué cambió» | Por fijar en `05` |
| `L_ACC` | Tamaño del JSON de cada editor de acción requerida | Por fijar en `05` |
| `L_NOTA` | Tamaño del JSON de una nota o hallazgo | Por fijar en `05` |
| `L_CLI_TIT` / `L_CLI_TXT` | Título y texto para clientes | Por fijar en `05` |
| `L_NODOS` / `L_PROF` | Cantidad de nodos y profundidad de anidamiento del JSON enriquecido | Por fijar en `05` |
| `L_IMG` | Tamaño de una imagen del editor | Por fijar en `05` |
| `L_DOC` | Tamaño de un archivo de reglas de negocio (Word, PDF, Excel) | Por fijar en `05` |
| `L_VID` | Tamaño de un video (mp4, webm) | Por fijar en `05` |
| `L_ADJ` | Cantidad de adjuntos por lista o por nota | Por fijar en `05` |
| `L_RUTAS` | Cantidad de rutas por entrada | Por fijar en `04` |
| `L_SEG` | Longitud de un segmento de ruta escrito con «Otro…» | Por fijar en `04` |
| `L_XLSX` | Tamaño del libro de menú de referencia | Por fijar en `05` |
| `L_REP` | Entradas por reporte | **200** (H-17) |
| `L_DEST` | Destinatarios por envío de reporte | Por fijar en `04` |
| `L_URL` | Vida de la URL firmada de lectura pública | Por fijar en `05` |

Cada límite se prueba en `L` (aceptado), `L+1` (rechazado con error controlado) y, cuando aplica, en `0` o vacío.

## 1. Criterios de aceptación por visión

Cada criterio es observable: se verifica mirando la UI, una respuesta HTTP o una fila SQL. Entre paréntesis, los casos de la sección 2 que lo cubren.

### 1.1 Desarrollador · «Mis entradas»

- **CA-DEV-01** Un usuario con `updates.whats_new.author` **y** área Desarrollo ve la opción **Actualizaciones › Qué hay de nuevo** con la visión «Mis entradas». Si le falta cualquiera de las dos, no ve la visión y la API de autoría responde 403 (QN-PER-01..06).
- **CA-DEV-02** El índice muestra solo entradas creadas por el usuario autenticado, con los conteos total, borradores, sin probar, en pruebas, fallidas y probadas, y esos conteos coinciden con las filas de SQL (QN-DEV-01, 02).
- **CA-DEV-03** Los filtros tipo, sistema, estado y búsqueda por ruta o texto, y las pestañas Todas, Borradores y Publicadas, devuelven exactamente las entradas que cumplen todos los filtros (QN-DEV-03, 04).
- **CA-DEV-04** «Guardar borrador» guarda con cualquier combinación de campos vacíos, solo rechaza contenido por encima de los límites y deja el estado `borrador` (QN-DEV-05..07).
- **CA-DEV-05** «Publicar a Soporte» solo pasa a `sin_probar` si todos los campos obligatorios del tipo están completos; si no, la UI señala cada campo con su mensaje y la API devuelve la lista de errores por campo sin cambiar el estado (QN-DEV-08..16).
- **CA-DEV-06** La sección «Solo desarrollos nuevos» (cliente, asesor a cargo, reglas de negocio y video) solo aparece y solo se valida para el tipo Nuevo; si el tipo cambia de Nuevo a otro, esos datos no se publican (QN-DEV-17, 18).
- **CA-DEV-07** El constructor de ruta acepta entre 3 y 5 niveles, el último es siempre Opción, sugiere valores del menú activo filtrados por el nivel anterior, siempre ofrece «Otro…» y muestra la ruta como texto con `›` (QN-RUT-01..14).
- **CA-DEV-08** Creado por, editado por y publicado por quedan con el usuario autenticado y la fecha, sin importar lo que envíe el cliente HTTP (QN-DEV-19, QN-SQL-03).
- **CA-DEV-09** El autoguardado ocurre a los 30 s o al salir de un campo, muestra «Guardado hace …» y nunca sobrescribe en silencio una versión más nueva (QN-CON-01..05).
- **CA-DEV-10** Una entrada publicada es de solo lectura para su autor, salvo «Corregir y volver a publicar» desde `fallida`, que solo permite editar «Qué cambió» y «Acción requerida» y exige una nota de corrección (QN-EST-12..16).
- **CA-DEV-11** El autor ve en el detalle el estado, las rondas y los hallazgos de su entrada, pero no puede tomarla, probarla ni registrar hallazgos (QN-PER-08, QN-EST-20).

### 1.2 Asesor · «Bandeja de pruebas»

- **CA-ASE-01** Un usuario con `updates.whats_new.test` **y** área Soporte ve la bandeja; las pestañas Sin probar (por defecto), En pruebas, Fallidas y Probadas muestran conteos iguales a las filas que listan (QN-ASE-01..03).
- **CA-ASE-02** Sin selección, el panel derecho muestra los tres pasos; con selección, muestra etiquetas, rutas, Qué cambió de solo lectura, checklist con avance «n de m», referencias y hallazgos (QN-ASE-04, 05).
- **CA-ASE-03** «Tomar» deja la entrada en `en_pruebas` a nombre de un solo asesor aunque dos lo intenten al tiempo; el otro recibe un conflicto y ve «La tiene X» (QN-EST-04, QN-CON-06).
- **CA-ASE-04** Solo el asesor que la tiene puede marcar el checklist, escribir notas, registrar hallazgos, soltar, marcar fallida o marcar probado (QN-PER-10..12).
- **CA-ASE-05** «Soltar» devuelve la entrada a `sin_probar`, cierra la ronda como «soltada» conservando checklist, notas, hallazgos y quién soltó, y la siguiente ronda empieza con el checklist en blanco (QN-EST-07..09).
- **CA-ASE-06** «Marcar probado» exige el checklist completo de la ronda actual; «Marcar fallida» exige al menos un hallazgo de la ronda actual (QN-EST-10, 11, QN-HAL-05, 06).
- **CA-ASE-07** Ningún usuario toma ni prueba una entrada que creó él mismo, aunque tenga ambas áreas y ambos permisos (QN-PER-07).
- **CA-ASE-08** Los hallazgos son numerados, tienen fecha, hora y autor, y no se pueden borrar por la UI ni por la API (QN-HAL-01..04).
- **CA-ASE-09** «Mostrar esta novedad a los clientes» abre Título y Texto para clientes, precargado con una copia de Qué cambió; está deshabilitado con explicación si la entrada tiene cliente asignado o es SP crítico (QN-VIS-01..06).
- **CA-ASE-10** Los reportes cumplen la sección 5.4: alcance por entrada o por pestaña Fallidas o Probadas, contenido «Solo hallazgos» o «Completo», salida PDF o correo por outbox a usuarios activos elegidos (QN-REP-01..20).

### 1.3 Cliente · «Novedades de SAG Web» (`/novedades`)

- **CA-CLI-01** `/novedades` carga sin sesión, sin barra lateral ni enlaces internos del portal, con la marca, el título y el subtítulo definidos (QN-PUB-01, 02).
- **CA-CLI-02** Solo aparecen entradas en `probado`, con «Mostrar a clientes» activo, sin cliente asignado, de tipo distinto de SP crítico, no archivadas, y solo si «Publicación activa» está encendido (QN-VIS-07..14).
- **CA-CLI-03** Los filtros Todo, Opciones nuevas (Nuevo) y Mejoras (Mejora, Regla de negocio y Rediseño) clasifican sin categoría propia de reglas de negocio (QN-PUB-03..05).
- **CA-CLI-04** Cada tarjeta muestra etiqueta, fecha de liberación como mes y año, título, descripción simple, ruta principal y «Ver detalle»; no hay «Marcar todo como leído» ni «Pedir asesoría» (QN-PUB-06, 07).
- **CA-CLI-05** Ni la página, ni la respuesta de la API pública, ni los archivos públicos contienen notas internas, hallazgos, Qué cambió, acciones requeridas, nombres o correos del equipo, cliente asignado, IDs internos ni localizadores (QN-PUB-08..13).
- **CA-CLI-06** Una imagen del texto para clientes se entrega con 302 a una URL firmada de vida corta; cualquier otro archivo, o una entrada que deja de ser visible, responde 404 indistinguible (QN-PUB-14..18).
- **CA-CLI-07** Con «Publicación activa» apagado, la página muestra «Sin novedades por ahora» y la API y los archivos públicos no entregan contenido (QN-VIS-12, QN-PUB-17).

### 1.4 Configuración › Qué hay de nuevo

- **CA-CFG-01** Solo un usuario con el permiso de configuración ve y usa la página; la API la protege igual (QN-PER-13, 14).
- **CA-CFG-02** Cargar `Menu Sag Web.xlsx` lee solo la hoja «Menú Final», construye el árbol vía › submenús › opción, permite previsualizarlo y solo alimenta sugerencias después de activarlo (QN-MEN-01..04).
- **CA-CFG-03** Cada carga queda versionada con quién y cuándo; activar una versión no borra las anteriores (QN-MEN-05, 06).
- **CA-CFG-04** Un libro inválido, sin la hoja «Menú Final», con columnas faltantes, vacío o demasiado grande se rechaza sin cambiar el menú activo (QN-MEN-07..12).
- **CA-CFG-05** La lista de acciones requeridas predefinidas se edita con nombre, orden y activo; las entradas existentes no cambian al renombrar o desactivar una acción (QN-CFG-01..04).
- **CA-CFG-06** El enlace para clientes muestra `/novedades`, el botón copia la URL completa y el interruptor «Publicación activa» cambia lo que ve el público de inmediato (QN-CFG-05..07).

### 1.5 Usuarios y Roles · Área

- **CA-USR-01** Cada usuario tiene Área con selección múltiple entre Soporte, Desarrollo, Ventas y Administrativa; se puede dejar vacía (QN-USR-01, 02).
- **CA-USR-02** Solo quien puede editar usuarios cambia el área; la API rechaza valores fuera de la lista (QN-USR-03, 04).
- **CA-USR-03** Cada cambio de área deja un evento de auditoría con antes, después, quién y cuándo (QN-USR-05).
- **CA-USR-04** El selector «Asesor a cargo de pruebas iniciales» lista solo usuarios activos con área Soporte (QN-USR-06, 07).
- **CA-USR-05** Agregar la columna de área no cambia los permisos, roles, sesiones ni el comportamiento existente de Usuarios y Roles (QN-REG-03).

## 2. Matriz de casos

Formato de cada fila: **ID · Precondición · Pasos o entrada · Resultado esperado · Evidencia · Capa**.

### 2.1 Usuarios y área (USR)

| ID | Precondición | Pasos o entrada | Resultado esperado | Evidencia | Capa |
|---|---|---|---|---|---|
| QN-USR-01 | Admin con edición de usuarios; `u.ventas` sin área | Marcar Soporte y Desarrollo, guardar, recargar | Las dos áreas persisten; la fila SQL tiene dos vínculos | Captura UI + consulta SQL | UI, SQL |
| QN-USR-02 | `u.mixto` con dos áreas | Desmarcar todas y guardar | Área vacía aceptada; ningún vínculo en SQL | Salida de prueba + SQL | API, SQL |
| QN-USR-03 | Usuario con `configuration.users.view` sin edición | PUT del área de otro usuario | 403; sin cambios en SQL ni auditoría | Salida de prueba | API |
| QN-USR-04 | Admin | Enviar área `"Gerencia"`, `""`, duplicada `["Soporte","Soporte"]` y `null` | 400 para valores fuera de la lista y `null`; la duplicada se normaliza a una o se rechaza, según `04` | Salida de prueba | U, API |
| QN-USR-05 | Admin | Cambiar área de `u.sop1` | Evento de auditoría con antes, después, actor y fecha; sin datos sensibles | Fila de `audit` | API, SQL |
| QN-USR-06 | `u.sop1` activo Soporte; `u.inactivo` Soporte inactivo; `u.dev1` Desarrollo | Abrir selector «Asesor a cargo» | Lista solo `u.sop1`, `u.sop2`, `u.mixto` (activos con Soporte) | Salida de prueba UI y API | UI, API |
| QN-USR-07 | Ninguno | POST de entrada con `asesor_id` de `u.inactivo` y luego de `u.dev1` | 400 al publicar; el borrador puede guardarlo, según QA-05 | Salida de prueba | API |

### 2.2 Permisos, área y visión (PER)

| ID | Precondición | Pasos o entrada | Resultado esperado | Evidencia | Capa |
|---|---|---|---|---|---|
| QN-PER-01 | `u.dev1`: author + Desarrollo | Abrir la opción | Ve «Mis entradas»; sin selector de visión | Salida de prueba UI | UI |
| QN-PER-02 | `u.dev.sinarea`: author sin área | Abrir la opción; POST crear entrada | No ve la visión; API 403 | Salida de prueba | UI, API |
| QN-PER-03 | `u.ventas`: área Desarrollo sin permiso author | POST crear entrada | 403 | Salida de prueba | API |
| QN-PER-04 | `u.sop.sinpermiso`: Soporte sin test | POST tomar | 403; la entrada sigue en `sin_probar` | Salida de prueba + SQL | API |
| QN-PER-05 | `u.ventas` sin permisos de la opción | Navegar a la ruta interna por URL | Redirección o pantalla de acceso denegado; el menú no muestra la opción; API 403 | Salida de prueba | UI, API |
| QN-PER-06 | `u.mixto` con ambas áreas y permisos | Abrir la opción | Ve selector de visión; cambiarlo no recarga la sesión y conserva filtros por visión | Salida de prueba UI | UI |
| QN-PER-07 | `u.mixto` creó E1, E1 en `sin_probar` | Tomar E1 desde UI y por API directa | Botón deshabilitado con explicación; API 403 o 409 con código «autor no puede probar» | Salida de prueba | UI, API |
| QN-PER-08 | `u.dev1` autor de E1 en `sin_probar` | POST tomar, hallazgo, probado con su token | 403 en todos | Salida de prueba | API |
| QN-PER-09 | `u.dev2` (otro desarrollador) | GET detalle y PUT de borrador de `u.dev1` | GET según QA-03; PUT 403 o 404 | Salida de prueba | API |
| QN-PER-10 | E1 `en_pruebas` tomada por `u.sop1` | `u.sop2` marca checklist, escribe nota, registra hallazgo, suelta, marca fallida, marca probado | 403 o 409 en todas; nada cambia en SQL | Salida de prueba + SQL | API |
| QN-PER-11 | Igual | `u.sop2` abre el detalle | Solo lectura con aviso «La tiene Felipe Cardona» | Salida de prueba UI | UI |
| QN-PER-12 | `u.sop1` tiene E1 y luego pierde el área Soporte | `u.sop1` intenta marcar probado | 403; ver QA-08 para liberar la entrada | Salida de prueba | API |
| QN-PER-13 | `u.sop1` sin permiso de configuración | GET y POST a la configuración y carga de menú | 403; menú de Configuración sin la opción | Salida de prueba | UI, API |
| QN-PER-14 | `u.config` con permiso de configuración sin área | Cargar menú y cambiar interruptor | Permitido; la configuración no exige área | Salida de prueba | API |
| QN-PER-15 | Usuario `super_admin` sin área | Crear entrada y tomar entrada | Comportamiento según QA-16 (área obligatoria o exención explícita); el resultado se documenta y se prueba | Salida de prueba | API |
| QN-PER-16 | Token vencido o ausente | Cualquier endpoint interno de la opción | 401 sin detalle | Salida de prueba | API |
| QN-PER-17 | Usuario inactivo con sesión abierta | Llamar a tomar | 401 o 403 según el contrato vigente de sesiones | Salida de prueba | API |

### 2.3 Formulario del desarrollador (DEV)

| ID | Precondición | Pasos o entrada | Resultado esperado | Evidencia | Capa |
|---|---|---|---|---|---|
| QN-DEV-01 | `u.dev1` con 2 borradores, 1 de cada estado publicado; `u.dev2` con 3 entradas | Abrir índice | Lista y conteos solo de `u.dev1`: total 7, borradores 2, etc. | Salida de prueba + SQL | UI, API |
| QN-DEV-02 | Igual | Comparar resumen con `SELECT COUNT` por estado | Iguales | Consulta SQL | SQL |
| QN-DEV-03 | Fixture de 12 entradas variadas | Filtrar tipo Mejora + sistema SAG Web + estado fallida + texto «Factura» | Solo las que cumplen todo; búsqueda insensible a mayúsculas y tildes | Salida de prueba | UI, API |
| QN-DEV-04 | Igual | Pestañas Todas, Borradores, Publicadas | Publicadas = todo estado distinto de `borrador` | Salida de prueba | UI |
| QN-DEV-05 | Formulario vacío | Guardar borrador | 201, estado `borrador`, campos vacíos permitidos, detalle «Faltan campos» | Salida de prueba | API, UI |
| QN-DEV-06 | Borrador | Qué cambió con JSON de tamaño `L_QC` y luego `L_QC+1` | Primero guarda; segundo 413 o 400 con mensaje en español; sin escritura parcial | Salida de prueba | API |
| QN-DEV-07 | Borrador | Guardar con tipo inválido `"Hotfix"` y sistema `"Otro"` | 400 aun en borrador (los enums se validan siempre) | Salida de prueba | API |
| QN-DEV-08 | Borrador tipo Mejora completo | Publicar | `sin_probar`; ronda 1 abierta; publicado por y fecha | Salida de prueba + SQL | API |
| QN-DEV-09 | Igual sin tipo | Publicar | 400 con error de campo `tipo` | Salida de prueba | API, UI |
| QN-DEV-10 | Sin ruta | Publicar | 400 «Se requiere al menos una ruta» | Salida de prueba | API, UI |
| QN-DEV-11 | Qué cambió vacío, solo espacios, o solo un párrafo vacío `{"type":"doc","content":[{"type":"paragraph"}]}` | Publicar | 400; un documento sin texto ni imagen cuenta como vacío | Salida de prueba | U, API |
| QN-DEV-12 | Ninguna acción requerida marcada | Publicar | 400 «Marca al menos una acción» | Salida de prueba | API, UI |
| QN-DEV-13 | Acción «Otro» marcada con editor vacío | Publicar | 400 en el editor de esa acción; las demás acciones no se marcan en error | Salida de prueba | UI, API |
| QN-DEV-14 | Acción desmarcada después de escribir su texto | Guardar y publicar | El texto de la acción desmarcada no se publica ni se guarda como acción | Salida de prueba | UI, API |
| QN-DEV-15 | Tipo Nuevo sin cliente | Publicar | 400 en cliente (ver QA-01, contradicción con H-02) | Salida de prueba | API |
| QN-DEV-16 | Tipo Nuevo sin asesor a cargo | Publicar | 400 o aceptado según QA-05; el resultado queda fijado en `04` | Salida de prueba | API |
| QN-DEV-17 | Tipo Mejora | Revisar formulario | La sección «Solo desarrollos nuevos» no aparece | Salida de prueba UI | UI |
| QN-DEV-18 | Borrador Nuevo con cliente, asesor, 2 adjuntos | Cambiar tipo a Regla de negocio y publicar | Se publica sin cliente, asesor ni adjuntos de Nuevo; los objetos quedan huérfanos y entran a limpieza | Salida de prueba + SQL | API, SQL |
| QN-DEV-19 | Ninguno | POST con `creado_por`, `publicado_por`, `estado:"probado"`, `id` ajenos en el cuerpo | Se ignoran o 400; quedan el usuario del token y `borrador` | Salida de prueba | API |
| QN-DEV-20 | Borrador | Eliminar borrador | Borrado lógico; desaparece del índice; objetos marcados para limpieza (H-16) | Salida de prueba + SQL | API, SQL |
| QN-DEV-21 | Entrada `sin_probar` | DELETE | 409 o 403; lo publicado no se elimina | Salida de prueba | API |
| QN-DEV-22 | Borrador | Publicar dos veces seguidas (doble clic o reintento con la misma clave) | Una sola transición y una sola ronda; el segundo devuelve el mismo resultado o 409 | Salida de prueba + SQL | API |
| QN-DEV-23 | Formulario | Vista previa para Soporte | Muestra en vivo Qué cambió y acciones como las verá el asesor, con el mismo sanitizado | Salida de prueba UI | UI |
| QN-DEV-24 | Formulario | Panel «¿Va en el Qué hay de nuevo?» | Muestra las 5 preguntas con su tipo y la lista «No va» | Salida de prueba UI | UI |
| QN-DEV-25 | Lista de adjuntos Nuevo | Agregar enlace `http://…`, `ftp://…`, `javascript:…`, `https://` sin host | Rechazados; solo `https://host/…` aceptado | Salida de prueba | U, API |

### 2.4 Constructor de ruta (RUT)

| ID | Precondición | Pasos o entrada | Resultado esperado | Evidencia | Capa |
|---|---|---|---|---|---|
| QN-RUT-01 | SAG Web | Nivel 1 | Solo Barra lateral o Barra de navegación | Salida de prueba UI | UI |
| QN-RUT-02 | Ruta con 2 niveles (vía + opción) | Publicar | 400 «mínimo 3 niveles»; en UI no se puede quitar el único submenú | Salida de prueba | U, API, UI |
| QN-RUT-03 | 3 niveles | Publicar | Aceptado | Salida de prueba | U, API |
| QN-RUT-04 | 5 niveles | Publicar | Aceptado; el botón **+** queda deshabilitado | Salida de prueba | U, UI |
| QN-RUT-05 | 6 niveles enviados por API | Publicar y guardar borrador | 400 en ambos (el máximo es estructural) | Salida de prueba | U, API |
| QN-RUT-06 | 4 niveles | Pulsar **×** | Quita el último submenú, no la opción | Salida de prueba UI | UI |
| QN-RUT-07 | Menú activo cargado | Elegir Ventas en nivel 2 | Nivel 3 sugiere solo hijos de Ventas | Salida de prueba | UI, API |
| QN-RUT-08 | Cambiar nivel 2 después de llenar nivel 3 | Elegir otro submenú | Los niveles siguientes se limpian o se marcan inválidos; no queda una ruta incoherente | Salida de prueba UI | UI |
| QN-RUT-09 | Sin menú activo | Abrir sugerencias | Solo «Otro…»; sin error | Salida de prueba | UI |
| QN-RUT-10 | «Otro…» | Escribir segmento de `L_SEG` y `L_SEG+1`, vacío, solo espacios, con `›`, `<script>` | `L_SEG` aceptado; resto rechazado o escapado; nunca se interpreta HTML | Salida de prueba | U, API, UI |
| QN-RUT-11 | Segmento escrito a mano | Guardar | Marcado «fuera del menú» (H-13) | SQL | API, SQL |
| QN-RUT-12 | SAG Clásico | Nivel 1 | «Menú principal», sin sugerencias, solo «Otro» (H-07) | Salida de prueba | UI |
| QN-RUT-13 | 1 ruta principal | Agregar `L_RUTAS` relacionadas y luego una más | Hasta el límite aceptado; la siguiente rechazada; la primera es la principal | Salida de prueba | API, UI |
| QN-RUT-14 | 2 rutas idénticas | Publicar | Rechazo o deduplicación según QA-12 | Salida de prueba | API |
| QN-RUT-15 | Ruta guardada | Ver índice y detalle | Texto `Barra lateral › Ventas › Facturas › Factura de venta` | Salida de prueba UI | UI |

### 2.5 Máquina de estados (EST)

Estados: `borrador`, `sin_probar`, `en_pruebas`, `fallida`, `probado` y, si se confirma, `archivada` (ver QA-10). Todas las transiciones ocurren en una sola transacción SQL con la ronda, el historial y la auditoría.

| ID | Precondición | Pasos o entrada | Resultado esperado | Evidencia | Capa |
|---|---|---|---|---|---|
| QN-EST-01 | Tabla completa de pares (estado, acción) | Ejecutar cada acción en cada estado | Solo las transiciones del diagrama de `01` 5.2 tienen éxito; todas las demás 409 sin efectos | Salida de prueba tabular | U |
| QN-EST-02 | `borrador` | Tomar, Soltar, Fallida, Probado | 409 | Salida de prueba | API |
| QN-EST-03 | `sin_probar` | Soltar, Fallida, Probado | 409 | Salida de prueba | API |
| QN-EST-04 | `sin_probar` | `u.sop1` toma | `en_pruebas`, tomada por `u.sop1`, ronda n con inicio | Salida de prueba + SQL | API, SQL |
| QN-EST-05 | `en_pruebas` de `u.sop1` | `u.sop1` vuelve a tomar | 409 o idempotente sin crear otra ronda | Salida de prueba | API |
| QN-EST-06 | `probado` | Tomar, Soltar, Fallida, Corregir | 409 | Salida de prueba | API |
| QN-EST-07 | `en_pruebas` con 2 de 3 ítems, 2 notas y 1 hallazgo | `u.sop1` suelta | `sin_probar`; ronda cerrada «soltada» con actor y fecha; checklist, notas y hallazgo conservados en historial | Salida de prueba + SQL | API, SQL |
| QN-EST-08 | Después de QN-EST-07 | `u.sop2` toma | Ronda n+1 con checklist en blanco y sin notas; la ronda n visible en historial de solo lectura | Salida de prueba | API, UI |
| QN-EST-09 | Después de QN-EST-07 | Pestaña Fallidas | La entrada soltada con hallazgo no cuenta como fallida | Salida de prueba | API |
| QN-EST-10 | `en_pruebas` con 2 de 3 ítems | Marcar probado | 409 «checklist incompleto»; UI deshabilita el botón | Salida de prueba | API, UI |
| QN-EST-11 | `en_pruebas` sin hallazgos en la ronda actual pero con hallazgos de una ronda anterior | Marcar fallida | 409 «registra al menos un hallazgo» | Salida de prueba | API |
| QN-EST-12 | `fallida`, autor `u.dev1` | Corregir con nuevo Qué cambió y nota de corrección | `sin_probar`, ronda nueva, historia anterior intacta, nota de corrección guardada | Salida de prueba + SQL | API, SQL |
| QN-EST-13 | `fallida` | Corregir sin nota de corrección | 400 | Salida de prueba | API |
| QN-EST-14 | `fallida` | Corregir enviando cambios de tipo, sistema, ruta o cliente | 400 o se ignoran; solo Qué cambió y acciones cambian | Salida de prueba | API |
| QN-EST-15 | `fallida` | `u.dev2` (no autor) corrige | 403 (ver QA-07) | Salida de prueba | API |
| QN-EST-16 | `en_pruebas` | El autor intenta corregir | 409 «pídele al asesor que la suelte» (H-11) | Salida de prueba | API |
| QN-EST-17 | `sin_probar` | El autor intenta corregir | Resultado según QA-11; se fija en `03` y se prueba | Salida de prueba | API |
| QN-EST-18 | Corrección cambia las acciones requeridas de 3 a 2 | Siguiente asesor toma | Checklist de la ronda nueva con 2 ítems; la ronda anterior conserva 3 | Salida de prueba + SQL | API, SQL |
| QN-EST-19 | `en_pruebas` | Marcar fallida con un hallazgo | `fallida`; ronda cerrada «fallida»; el desarrollador la ve con «n hallazgos» | Salida de prueba | API, UI |
| QN-EST-20 | Entrada `fallida` | El autor abre detalle | Ve estado, rondas y hallazgos; botón «Corregir y volver a publicar» | Salida de prueba UI | UI |
| QN-EST-21 | Fallo simulado de SQL a mitad de una transición | Marcar probado con error inyectado tras actualizar el estado | Rollback completo: estado, ronda, historial y auditoría sin cambios | Salida de prueba | U, SQL |
| QN-EST-22 | Restricción de base | `UPDATE` directo a un estado fuera de la lista | La restricción `CHECK` lo rechaza | Salida SQL | SQL |

### 2.6 Concurrencia y autoguardado (CON)

| ID | Precondición | Pasos o entrada | Resultado esperado | Evidencia | Capa |
|---|---|---|---|---|---|
| QN-CON-01 | Borrador en edición | Esperar 30 s sin cambios | No se envía guardado si no hubo cambios | Salida de prueba con temporizadores falsos | UI |
| QN-CON-02 | Borrador con cambios | Esperar 30 s; luego salir de un campo | Un guardado por evento; aviso «Guardado hace …» actualizado | Salida de prueba | UI |
| QN-CON-03 | Mismo borrador abierto en dos pestañas, `row_version` v1 | Pestaña A guarda (v2); pestaña B autoguarda con v1 | B recibe 409; la UI de B muestra conflicto y no sobrescribe; el texto de B no se pierde | Salida de prueba | API, UI |
| QN-CON-04 | Autoguardado en curso | El usuario pulsa Publicar | Publicar espera el guardado o usa la última versión; nunca publica contenido viejo | Salida de prueba | UI |
| QN-CON-05 | Red caída | Autoguardar | Aviso de error visible; reintento; sin «Guardado» falso | Salida de prueba | UI |
| QN-CON-06 | E1 `sin_probar` | `u.sop1` y `u.sop2` llaman a tomar en paralelo (20 repeticiones) | Exactamente uno gana cada vez; el otro 409; una sola ronda en SQL | Salida de prueba + SQL | API, SQL |
| QN-CON-07 | E1 `en_pruebas` | Soltar y marcar probado simultáneos del mismo asesor | Solo una transición se aplica; la otra 409 | Salida de prueba | API |
| QN-CON-08 | E1 `fallida` | Autor corrige mientras admin archiva (si existe) | Una gana por `row_version`; la otra 409 | Salida de prueba | API |
| QN-CON-09 | Asesor con detalle abierto | Autoguardado del checklist después de que otro proceso soltó la entrada | 409; la UI pasa a solo lectura y avisa | Salida de prueba | API, UI |
| QN-CON-10 | Dos administradores | Activan dos versiones de menú al mismo tiempo | Una sola versión activa al final | SQL | API, SQL |

### 2.7 Asesor: índice, checklist, notas y hallazgos (ASE, HAL)

| ID | Precondición | Pasos o entrada | Resultado esperado | Evidencia | Capa |
|---|---|---|---|---|---|
| QN-ASE-01 | Fixture con entradas en cada estado | Abrir bandeja | Pestaña Sin probar por defecto; conteos correctos; los borradores nunca aparecen | Salida de prueba | UI, API |
| QN-ASE-02 | Igual | Filtros tipo, sistema, mes y año, búsqueda | Resultado correcto; mes y año en hora de Colombia | Salida de prueba | API |
| QN-ASE-03 | En pruebas | Ver fila | «Felipe Cardona · 2 de 3» | Salida de prueba UI | UI |
| QN-ASE-04 | Sin selección | Ver panel | Tres pasos | Salida de prueba UI | UI |
| QN-ASE-05 | Selección | Ver detalle | Etiquetas, rutas, Qué cambió de solo lectura, checklist, referencias, hallazgos, botones | Salida de prueba UI | UI |
| QN-HAL-01 | Asesor con la entrada | Registrar hallazgo | Número consecutivo dentro de la entrada, fecha, hora y autor del token | Salida de prueba + SQL | API |
| QN-HAL-02 | Dos hallazgos registrados al tiempo | Paralelo | Números distintos, sin huecos ni duplicados (restricción única) | Salida de prueba + SQL | API, SQL |
| QN-HAL-03 | Hallazgo existente | DELETE y PUT por API | 404 o 405; no existe ruta de borrado; nada cambia | Salida de prueba | API |
| QN-HAL-04 | Hallazgo existente | Revisar permisos SQL del usuario de runtime | Documentar que la inmutabilidad la da la aplicación, no SQL (riesgo residual por `db_owner`) | Nota de QA | SQL |
| QN-HAL-05 | Nota sin registrar | Marcar fallida | 409; una nota no es hallazgo | Salida de prueba | API |
| QN-HAL-06 | Hallazgo registrado y checklist completo | Marcar probado | Aceptado (H-03); hallazgos visibles en detalle y reporte | Salida de prueba | API |
| QN-HAL-07 | Nota vacía | Registrar hallazgo | 400 | Salida de prueba | API, UI |
| QN-HAL-08 | Nota de tamaño `L_NOTA` y `L_NOTA+1` | Registrar | Aceptada y rechazada | Salida de prueba | API |
| QN-HAL-09 | Checklist | Marcar y desmarcar ítems | El avance persiste por autoguardado y el contador cambia | Salida de prueba | UI, API |
| QN-HAL-10 | Checklist | Enviar ID de ítem de otra entrada o de una ronda cerrada | 400 o 404; sin cambios | Salida de prueba | API |
| QN-HAL-11 | Mención @ en una nota | Insertar `@Felipe` | Texto resaltado; ninguna fila de outbox ni notificación (H-14) | Salida de prueba + SQL | U, API |

### 2.8 Visibilidad para clientes (VIS)

| ID | Precondición | Pasos o entrada | Resultado esperado | Evidencia | Capa |
|---|---|---|---|---|---|
| QN-VIS-01 | Asesor con entrada Mejora sin cliente | Activar «Mostrar a clientes» | Aparecen Título y Texto para clientes precargados con copia de Qué cambió | Salida de prueba UI | UI |
| QN-VIS-02 | Entrada Nuevo con cliente asignado | Ver la casilla | Deshabilitada con explicación (H-02) | Salida de prueba UI | UI |
| QN-VIS-03 | Igual | Activar por API | 400 o 409 | Salida de prueba | API |
| QN-VIS-04 | Entrada SP crítico | Ver casilla y activar por API | Deshabilitada; API rechaza (H-05) | Salida de prueba | UI, API |
| QN-VIS-05 | Mostrar activo | Título vacío o texto vacío | No se puede marcar probado con mostrar activo y texto vacío, o no se publica (definir en QA-09) | Salida de prueba | API |
| QN-VIS-06 | Copia de Qué cambió con mención @ e imagen interna | Activar | La mención se convierte en texto plano o se quita; la imagen se re-vincula al texto para clientes (ver QA-13) | Salida de prueba | U, API |
| QN-VIS-07 | `probado` + mostrar + sin cliente + Mejora + publicación activa | GET API pública | Aparece | Salida de prueba | API |
| QN-VIS-08 | Igual en `sin_probar`, `en_pruebas`, `fallida`, `borrador` | GET API pública | No aparece en ninguno | Salida de prueba tabular | API |
| QN-VIS-09 | `probado` con mostrar apagado | GET | No aparece | Salida de prueba | API |
| QN-VIS-10 | `probado` con cliente asignado, forzado en SQL con mostrar activo | GET | No aparece (el filtro público no confía en la casilla) | Salida de prueba + SQL | API, SQL |
| QN-VIS-11 | `probado` SP crítico forzado con mostrar activo en SQL | GET | No aparece | Salida de prueba | API, SQL |
| QN-VIS-12 | Publicación activa apagada | GET página y API | «Sin novedades por ahora»; API sin entradas | Salida de prueba | API, UI |
| QN-VIS-13 | Entrada visible | Se archiva o se desactiva mostrar | Desaparece en la siguiente carga, respetando la caché definida (QA-21) | Salida de prueba | API, E2E |
| QN-VIS-14 | Entrada visible | Fecha de liberación | Mes y año de la fecha en que pasó a `probado` (H-08), en hora de Colombia | Salida de prueba | U, API |

### 2.9 Página pública y aislamiento (PUB)

| ID | Precondición | Pasos o entrada | Resultado esperado | Evidencia | Capa |
|---|---|---|---|---|---|
| QN-PUB-01 | Navegador sin sesión | Abrir `/novedades` | Carga sin redirigir a login; ningún llamado a endpoints autenticados | Red del navegador | E2E, UI |
| QN-PUB-02 | Usuario con sesión abierta | Abrir `/novedades` | Página completa sin `AppLayout`, sin barra lateral ni enlaces internos | Salida de prueba UI + captura | UI, E2E |
| QN-PUB-03 | Fixture con Nuevo, Mejora, Regla, Rediseño visibles | Filtro Opciones nuevas | Solo Nuevo | Salida de prueba | UI |
| QN-PUB-04 | Igual | Filtro Mejoras | Mejora, Regla y Rediseño, todos con etiqueta «Mejora» | Salida de prueba | UI |
| QN-PUB-05 | Igual | Todo | Todas, en el orden fijado en QA-22 | Salida de prueba | UI, API |
| QN-PUB-06 | Tarjeta | Revisar | Etiqueta, mes y año, título, descripción, ruta principal, Ver detalle | Salida de prueba UI | UI |
| QN-PUB-07 | Página | Buscar textos | No existe «Marcar todo como leído» ni «Pedir asesoría» | Salida de prueba UI | UI |
| QN-PUB-08 | Entrada visible con notas, hallazgos, mención, cliente, nombres de autor y asesor con valores centinela únicos (`ZZ_NOTA_123`, etc.) | GET API pública y HTML renderizado | Ningún centinela aparece en el JSON ni en el DOM | Salida de prueba con búsqueda de centinelas | API, E2E |
| QN-PUB-09 | Igual | Revisar llaves del DTO público | Lista blanca exacta: id público, etiqueta, fecha, título, texto, ruta principal, imágenes públicas | Salida de prueba de contrato | API |
| QN-PUB-10 | Igual | Ruta principal en público | Solo la principal; sin rutas relacionadas ni marcas «fuera del menú» | Salida de prueba | API |
| QN-PUB-11 | Igual | Revisar encabezados de la respuesta | Sin datos de servidor, SQL ni proveedor; `Cache-Control` según QA-21 | Captura de red | API, E2E |
| QN-PUB-12 | IDs de entradas no visibles | `GET /api/[novedades]/{id}` con ID secuencial, GUID inventado, ID de borrador, ID de entrada con cliente | Todas 404 idénticas en cuerpo y tiempo razonable; ninguna distingue «existe pero oculta» | Salida de prueba | API |
| QN-PUB-13 | Página pública | 200 solicitudes por minuto desde una IP | Limitación según el contrato público vigente; sin 5xx | Registro de prueba | API, E2E |
| QN-PUB-14 | Imagen del texto para clientes de entrada visible | GET archivo público | 302 a URL firmada; vence en `L_URL`; la URL no se registra en logs ni auditoría | Salida de prueba + revisión de logs | API, E2E |
| QN-PUB-15 | Imagen de Qué cambió, de una nota o de un hallazgo de la misma entrada visible | GET archivo público con su ID | 404 | Salida de prueba | API |
| QN-PUB-16 | Adjunto de reglas de negocio o video de una entrada Nuevo visible | GET archivo público | 404 (no son públicos) | Salida de prueba | API |
| QN-PUB-17 | Imagen pública de una entrada que luego se oculta, se archiva, o con publicación apagada | GET archivo público | 404 | Salida de prueba | API |
| QN-PUB-18 | URL firmada obtenida | Usarla después de `L_URL` | Rechazada por SeaweedFS | Evidencia E2E en QA | E2E |
| QN-PUB-19 | Página pública | Inspeccionar HTML y JS servidos | Sin token, llaves de API ni rutas internas; CSP aplicada como en `/formatos-impresion` | Captura de red | E2E |

### 2.10 Seguridad del texto enriquecido (RTX)

Aplica a Qué cambió, acciones requeridas, notas, hallazgos y texto para clientes. El servidor valida el JSON contra el esquema de `05` (lista blanca de nodos, marcas y atributos) y el frontend renderiza sin `dangerouslySetInnerHTML` sobre contenido no sanitizado.

| ID | Precondición | Pasos o entrada | Resultado esperado | Evidencia | Capa |
|---|---|---|---|---|---|
| QN-RTX-01 | Ninguno | Nodo de texto `<img src=x onerror=alert(1)>` | Se guarda como texto y se muestra literal; no ejecuta | Salida de prueba | U, UI |
| QN-RTX-02 | Ninguno | Nodo con tipo desconocido `{"type":"html","content":"<script>"}` | 400 | Salida de prueba | U, API |
| QN-RTX-03 | Ninguno | Atributos extra: `onclick`, `style`, `class`, `data-*` en cualquier nodo | 400 o se eliminan | Salida de prueba | U |
| QN-RTX-04 | Ninguno | Marca link con `javascript:`, `JaVaScRiPt:`, `java\tscript:`, `data:text/html`, `vbscript:`, `//evil.example`, `\u0001javascript:` | Rechazados; solo `https:` (y `mailto:` si `05` lo admite) | Salida de prueba tabular | U, API |
| QN-RTX-05 | Enlace válido | Renderizar | `rel="noopener noreferrer"` y `target` controlado | Salida de prueba UI | UI |
| QN-RTX-06 | Ninguno | Nodo imagen con `src` externo `https://evil.example/x.png`, `data:image/svg+xml`, `blob:` | 400; las imágenes solo referencian IDs de archivo del portal | Salida de prueba | U, API |
| QN-RTX-07 | Ninguno | Imagen con ID de archivo de otra entrada | 400; el archivo debe pertenecer a la misma entrada | Salida de prueba | API |
| QN-RTX-08 | Ninguno | JSON de `L_NODOS+1` nodos o `L_PROF+1` niveles de anidamiento | 400 sin agotar CPU ni memoria | Salida de prueba con tiempo | U |
| QN-RTX-09 | Ninguno | JSON malformado, `null`, arreglo en lugar de objeto, texto con 10 MB | 400 o 413 controlado | Salida de prueba | API |
| QN-RTX-10 | Ninguno | Texto con caracteres de control, RTL override, emojis de 4 bytes, tildes | Se conservan los válidos; los de control se eliminan; ñ y tildes intactas | Salida de prueba | U |
| QN-RTX-11 | Payloads de QN-RTX-01..06 almacenados vía SQL directa (simulando dato viejo) | Renderizar en vista asesor, vista desarrollador, PDF y página pública | Ningún script corre; el renderizador también filtra (defensa en profundidad) | Salida de prueba + PDF revisado | UI, E2E |
| QN-RTX-12 | Payloads XSS en títulos, nombres de archivo, segmentos de ruta y nombres de cliente | Renderizar en UI, PDF y correo | Escapados en todos | Salida de prueba | UI, U |
| QN-RTX-13 | Contenido pegado desde Word con estilos | Pegar en el editor | Solo quedan formatos permitidos | Salida de prueba UI | UI |

### 2.11 Cargas a SeaweedFS (CAR)

| ID | Precondición | Pasos o entrada | Resultado esperado | Evidencia | Capa |
|---|---|---|---|---|---|
| QN-CAR-01 | Proveedor `seaweedfs` en QA | Subir PNG válida al editor | Objeto bajo `<base>/Archivos/que-hay-de-nuevo/<entry_id>/…`; SQL con localizador, proveedor `s3`, tipo, tamaño y SHA-256; sin bytes en SQL | SQL + listado del bucket | API, SQL, E2E |
| QN-CAR-02 | Ninguno | Archivo `.png` que en realidad es HTML o SVG con script | Rechazado por firma, no solo por extensión | Salida de prueba | U, API |
| QN-CAR-03 | Ninguno | `.exe` renombrado a `.pdf`, `.docm`, `.xlsm` con macros | Rechazados (solo Word, PDF, Excel sin macros si `05` lo fija) | Salida de prueba | U, API |
| QN-CAR-04 | Ninguno | Video `.mov`, `.avi`, `.mp4` con firma de webm | Solo mp4 y webm coherentes | Salida de prueba | U, API |
| QN-CAR-05 | Ninguno | Imagen de `L_IMG` y `L_IMG+1`; documento `L_DOC`/`+1`; video `L_VID`/`+1` | Aceptados y rechazados; el rechazo ocurre antes de guardar todo el cuerpo cuando el tamaño declarado excede | Salida de prueba | API |
| QN-CAR-06 | Tamaño declarado distinto del real | Completar carga | Rechazo en la verificación; registro marcado inválido; objeto a limpieza | Salida de prueba | API |
| QN-CAR-07 | Carga iniciada sin completar | Esperar vencimiento | El registro pendiente no aparece en la entrada; el objeto se limpia con el ciclo de reclamos de borrado | SQL + bucket | API, SQL, E2E |
| QN-CAR-08 | `L_ADJ` adjuntos | Agregar uno más | Rechazado | Salida de prueba | API, UI |
| QN-CAR-09 | Imagen subida y luego eliminada del texto antes de guardar | Guardar y correr limpieza | El objeto queda sin referencia y se limpia; los referenciados nunca se borran | SQL + bucket | API, SQL |
| QN-CAR-10 | Objeto referenciado por una entrada publicada | Correr limpieza | No se borra | SQL + bucket | SQL, E2E |
| QN-CAR-11 | Usuario sin permiso sobre la entrada | Subir a `entry_id` ajeno | 403 | Salida de prueba | API |
| QN-CAR-12 | Nombre de archivo con `../`, `\`, NUL, 300 caracteres, tildes | Subir | La llave del objeto la genera el servidor; el nombre original se guarda saneado y se muestra escapado | Salida de prueba | U, API |
| QN-CAR-13 | Archivo interno | GET archivo interno con sesión autorizada | 302 a URL firmada; sin la URL en logs, auditoría ni JSON | Salida de prueba + logs | API |
| QN-CAR-14 | Archivo interno | GET sin sesión o con usuario sin permiso | 401 o 403/404 | Salida de prueba | API |
| QN-CAR-15 | Objeto escrito con `azure_blob` en un registro histórico simulado | Leer | Lectura despachada por el proveedor del registro (regla de `ARCHITECTURE.md`), aunque la opción escriba solo en SeaweedFS | Salida de prueba | U |
| QN-CAR-16 | SeaweedFS no disponible | Subir | Error controlado; sin registro SQL huérfano marcado como completo | Salida de prueba | API |

### 2.12 Reportes (REP)

| ID | Precondición | Pasos o entrada | Resultado esperado | Evidencia | Capa |
|---|---|---|---|---|---|
| QN-REP-01 | Entrada con 2 rondas y 3 hallazgos | Reporte de entrada «Solo hallazgos» | Ruta, tipo, desarrollador y hallazgos (de todas las rondas, marcados por ronda, según QA-17); nada más | PDF + extracción de texto | U, API |
| QN-REP-02 | Igual | «Completo» | Lo anterior más qué cambió, acciones, checklist, notas, quién probó, fechas y rondas | PDF + extracción | U, API |
| QN-REP-03 | Entrada en `sin_probar`, `en_pruebas`, `fallida`, `probado` | Reporte de entrada | Disponible en todos | Salida de prueba | API, UI |
| QN-REP-04 | Borrador | Reporte de entrada por API | 409 o 404 | Salida de prueba | API |
| QN-REP-05 | Pestaña Fallidas con filtros | Reporte de pestaña | Solo las entradas visibles con esos filtros; el PDF imprime los filtros y la hora de generación | PDF | API, E2E |
| QN-REP-06 | Pestaña Probadas | Reporte de pestaña | Igual | PDF | API |
| QN-REP-07 | Pestañas Sin probar y En pruebas | Ver UI; llamar API con `pestaña=sin_probar` | Sin botón; API 400 | Salida de prueba | UI, API |
| QN-REP-08 | Filtro con 200 entradas | Reporte | Generado | Salida de prueba + tiempo | API |
| QN-REP-09 | Filtro con 201 entradas | Reporte | 400 con «filtra por mes»; sin PDF parcial | Salida de prueba | API |
| QN-REP-10 | Probadas sin hallazgos | «Solo hallazgos» | Cada entrada aparece con «Sin hallazgos» o se omite, según QA-17 | PDF | U |
| QN-REP-11 | Texto enriquecido con imágenes y payloads de QN-RTX | PDF | Imágenes incrustadas o referenciadas según `05`; ningún payload activo; sin URL firmada dentro del PDF | PDF revisado | U, E2E |
| QN-REP-12 | Diálogo de envío | Abrir | Lista solo usuarios activos; buscable por nombre y correo; selección múltiple con casillas | Salida de prueba UI | UI, API |
| QN-REP-13 | Ninguno | Enviar por API con ID de usuario inactivo, inexistente, correo libre `externo@evil.example` | 400; solo IDs de usuarios activos del portal | Salida de prueba | API |
| QN-REP-14 | Ninguno | Enviar con 0 destinatarios y con `L_DEST+1` | 400 | Salida de prueba | API |
| QN-REP-15 | Envío válido a 3 usuarios | Enviar | Una fila de outbox por destinatario (o por envío, según `04`), escrita en la misma transacción que el registro del envío; auditoría del envío | SQL | API, SQL |
| QN-REP-16 | Igual | Repetir la solicitud con la misma clave de idempotencia (doble clic, reintento de red) | Ningún correo duplicado en outbox | SQL | API, SQL |
| QN-REP-17 | Outbox en QA | Procesar | Correo entregado; asunto y cuerpo en español; contenido escapado | Registro de entrega en QA | E2E |
| QN-REP-18 | Usuario destinatario se desactiva entre envío y entrega | Procesar outbox | Comportamiento documentado (se entrega o se omite) y probado | Salida de prueba | U |
| QN-REP-19 | Usuario sin permiso de prueba ni de reporte | Generar o enviar reporte por API | 403 (ver QA-16) | Salida de prueba | API |
| QN-REP-20 | Reporte de entrada | El autor desarrollador lo pide | Resultado según QA-16 | Salida de prueba | API |
| QN-REP-21 | Generación | Medir | PDF de 200 entradas «Completo» dentro del tiempo límite de la Function | Tiempo registrado | E2E |

### 2.13 Configuración: menú de referencia, acciones e interruptor (MEN, CFG)

| ID | Precondición | Pasos o entrada | Resultado esperado | Evidencia | Capa |
|---|---|---|---|---|---|
| QN-MEN-01 | `Menu Sag Web.xlsx` real de referencia | Cargar | Árbol con vía, submenús y opción; conteo de nodos igual al de la hoja | Salida de prueba + conteo | U, API |
| QN-MEN-02 | Carga correcta | Previsualizar | Árbol navegable; todavía no alimenta sugerencias | Salida de prueba | UI, API |
| QN-MEN-03 | Previsualización | Activar | Las sugerencias usan la versión nueva | Salida de prueba | API |
| QN-MEN-04 | Libro con varias hojas | Cargar | Solo se lee «Menú Final»; las demás se ignoran | Salida de prueba | U |
| QN-MEN-05 | Tres cargas | Consultar historial | Tres versiones con quién y cuándo; una activa | SQL | API, SQL |
| QN-MEN-06 | Versión 3 activa | Activar versión 2 | Vuelve la 2; la 3 se conserva (ver QA-19) | SQL | API |
| QN-MEN-07 | Libro sin hoja «Menú Final» (o «Menu Final», «menú final ») | Cargar | Rechazo con mensaje que nombra la hoja esperada; el menú activo no cambia. Se documenta si la comparación ignora tildes y espacios | Salida de prueba | U, API |
| QN-MEN-08 | Archivo `.xlsx` corrupto, `.xls`, `.csv` renombrado, ZIP bomba | Cargar | Rechazo controlado sin agotar memoria | Salida de prueba | U, API |
| QN-MEN-09 | Hoja con columnas faltantes o en otro orden | Cargar | Rechazo, o mapeo por encabezado si `05` lo define | Salida de prueba | U |
| QN-MEN-10 | Hoja vacía o solo encabezados | Cargar | Rechazo «menú vacío» | Salida de prueba | U |
| QN-MEN-11 | Filas con profundidad mayor a 5, celdas combinadas, fórmulas, duplicados | Cargar | Política documentada (rechazo o advertencia) y probada; ver QA-20 | Salida de prueba | U |
| QN-MEN-12 | Libro de `L_XLSX+1` | Cargar | 413 | Salida de prueba | API |
| QN-MEN-13 | Celdas con `=HYPERLINK(...)`, `<script>`, texto de 2 000 caracteres | Cargar y ver sugerencias | Se usa el valor de texto; se escapa; se recorta o rechaza según `L_SEG` | Salida de prueba | U, UI |
| QN-MEN-14 | Segmentos «fuera del menú» guardados | Cargar menú que los incluye | Se recalcula o se informa la marca, según QA-19 | SQL | API |
| QN-CFG-01 | Lista inicial de 4 acciones | Agregar, reordenar, desactivar | El formulario del desarrollador refleja orden y activas | Salida de prueba | UI, API |
| QN-CFG-02 | Entrada publicada con la acción «Dar permiso a la opción» | Renombrar la acción | La entrada y su checklist conservan el texto original | SQL | API, SQL |
| QN-CFG-03 | Todas las acciones desactivadas | Abrir formulario | Se impide desactivar la última o el formulario lo maneja; ver QA-18 | Salida de prueba | API |
| QN-CFG-04 | Nombre vacío, duplicado o de 500 caracteres | Guardar | 400 | Salida de prueba | API |
| QN-CFG-05 | Página de configuración | Pulsar Copiar | Portapapeles con la URL absoluta de `/novedades`; aviso accesible | Salida de prueba UI | UI |
| QN-CFG-06 | Interruptor encendido | Apagar | Público en «Sin novedades por ahora»; auditoría con actor | Salida de prueba + auditoría | API, E2E |
| QN-CFG-07 | Interruptor apagado | Encender | Las entradas visibles vuelven a aparecer | Salida de prueba | API |

### 2.14 Accesibilidad y teclado (ACC)

| ID | Precondición | Pasos o entrada | Resultado esperado | Evidencia | Capa |
|---|---|---|---|---|---|
| QN-ACC-01 | Editor enriquecido | Recorrer la barra con Tab y flechas | La barra es un `toolbar` con nombre; un solo punto de tabulación y flechas entre botones (roving tabindex); cada botón tiene nombre accesible | Salida de prueba | UI |
| QN-ACC-02 | Editor | Ctrl+B, Ctrl+I, Ctrl+K | Aplican negrita, cursiva y enlace; `aria-pressed` refleja el estado | Salida de prueba | UI |
| QN-ACC-03 | Editor | Tab dentro del área de texto | Sale del editor (no queda atrapado) | Salida de prueba | UI |
| QN-ACC-04 | Insertar imagen | Solo teclado | Se abre el selector, se sube, se exige texto alternativo o se documenta su ausencia | Salida de prueba | UI |
| QN-ACC-05 | Carga en curso | Lector de pantalla | Progreso anunciado en región viva sin mover el foco | Salida de prueba | UI |
| QN-ACC-06 | Constructor de ruta | Solo teclado | **+**, **×**, sugerencias y «Otro…» operables; **+** y **×** con nombre accesible «Agregar submenú» y «Quitar último submenú»; el foco va al nivel nuevo | Salida de prueba | UI |
| QN-ACC-07 | Sugerencias de ruta | Flechas, Enter, Escape | Patrón combobox de `SelectorBuscable` con `aria-activedescendant` | Salida de prueba | UI |
| QN-ACC-08 | Errores de publicar | Enviar formulario incompleto | Foco al resumen de errores; cada campo con `aria-invalid` y `aria-describedby` | Salida de prueba | UI |
| QN-ACC-09 | Diálogo de envío de reporte | Abrir y cerrar | `role="dialog"`, `aria-modal`, foco atrapado y restaurado al botón | Salida de prueba | UI |
| QN-ACC-10 | Pestañas del asesor y filtros públicos | Teclado | Patrón `tablist`; conteos dentro del nombre accesible | Salida de prueba | UI |
| QN-ACC-11 | Aviso «Guardado hace …» y «La tiene X» | Lector | Región de estado cortés, no alerta | Salida de prueba | UI |
| QN-ACC-12 | Página pública | Revisión automática y manual | Sin violaciones críticas de axe; contraste AA; zoom 200 %; ancho 375 px sin desplazamiento horizontal | Informe axe + capturas | E2E |

### 2.15 Datos, auditoría y SQL (SQL)

| ID | Precondición | Pasos o entrada | Resultado esperado | Evidencia | Capa |
|---|---|---|---|---|---|
| QN-SQL-01 | Migración nueva | Validador de migraciones y `MANIFEST.sha256` | Hash coincide; sintaxis SQL Server 2019 nivel 150; reejecutable | Salida del validador | SQL |
| QN-SQL-02 | Base de QA con respaldo | Aplicar y revertir la migración | Aplicación limpia; rollback documentado; datos previos intactos | Registro de ejecución | SQL |
| QN-SQL-03 | Toda transición y edición | Revisar auditoría | Evento por acción con actor, entrada, estado anterior y nuevo; sin contenido enriquecido completo ni URLs firmadas | SQL | SQL |
| QN-SQL-04 | Migración | Revisar permisos de rol | No reduce permisos existentes del usuario de runtime ni de roles actuales | Diff de permisos antes y después | SQL |
| QN-SQL-05 | Consultas | Plan de ejecución de bandeja, índice y público con 5 000 entradas | Sin escaneos completos evitables; tiempos registrados | Planes + tiempos | SQL |
| QN-SQL-06 | Todas las consultas nuevas | Búsqueda de concatenación de SQL | Todo parametrizado | Revisión de diff | U |
| QN-SQL-07 | Restricciones | Insertar ronda duplicada abierta, hallazgo con número repetido, versión de menú con dos activas | Rechazadas por restricción | SQL | SQL |

## 3. Plan estático, dinámico y de seguridad

### 3.1 Estático

- `npm run build` en `api` y `frontend` (TypeScript estricto; no hay lint).
- `npm run check:no-cosmos-runtime`, `npm run security:audit:prod` y `npm run security:audit` en ambos paquetes. La excepción de picomatch vigente hasta 2026-12-15 es la única tolerada.
- Revisión defensiva del diff: autorización en cada handler nuevo (permiso, área, objeto y estado), validación Zod en el borde, consultas parametrizadas, transacciones con `runSqlTransaction`, sin `dangerouslySetInnerHTML` sobre contenido de usuario, sin URL firmada en logs, auditoría ni JSON salvo el 302.
- Búsqueda de `window.alert|confirm|prompt` en `frontend/src` (regla vigente de la matriz de negocio).
- Validador de migraciones y hash del manifiesto.
- Contrato cruzado: una prueba que compara los tipos de `frontend/src/types.ts` con los DTO de `04` (lección de la retrospectiva del Constructor de guías: estados y forma de respuesta divergieron).
- Si se añade una dependencia de editor o de PDF: versión exacta, auditoría limpia, tamaño del bundle antes y después, y revisión de que no trae su propio renderizado HTML sin sanitizar.

### 3.2 Dinámico

1. Pruebas enfocadas del módulo (`whatsNew*` en API, `queHayDeNuevo` en frontend).
2. Pruebas de regresión de las áreas en riesgo (3.4).
3. Suites completas de API y frontend **cuando los agentes dejaron de editar**, nunca en paralelo con ediciones (retrospectiva).
4. E2E en QA con datos sintéticos: flujo completo desarrollador → asesor → cliente, incluido Soltar, Fallida, Corregir y Probado, con un reporte por correo y la página pública verificada sin sesión.
5. Prueba de concurrencia real: dos sesiones tomando la misma entrada contra SQL de QA.

### 3.3 Seguridad (agente `security-adversary`, aislado del historial de esta tarea)

- Matriz de autorización exhaustiva: cada endpoint × {anónimo, sin permiso, permiso sin área, área sin permiso, autor, otro desarrollador, asesor dueño, otro asesor, `u.mixto` sobre su entrada, configurador, `super_admin`}.
- IDOR: IDs de entradas, rondas, hallazgos, archivos y versiones de menú ajenos en cada ruta.
- XSS almacenado y reflejado en los cuatro renderizadores: UI interna, PDF, correo y página pública.
- Fugas en la página pública con centinelas (QN-PUB-08) y enumeración (QN-PUB-12).
- Cargas: firma, tamaño, nombres, ZIP bomba en XLSX, URLs firmadas fuera de logs.
- Correo: inyección de encabezados por asunto o nombres, destinatarios fuera del portal.
- Abuso del endpoint público: tasa, tamaño de respuesta, caché.

### 3.4 Regresión de áreas en riesgo

| Área | Riesgo | Pruebas existentes a correr | Prueba nueva |
|---|---|---|---|
| `AppLayout` y menú | Nueva opción bajo Actualizaciones y bajo Configuración; visibilidad por permiso | `npm test -- AppLayout permissionAccess` | QN-REG-01: la opción aparece solo con permiso; Tareas sigue siendo la entrada por defecto; módulos existentes intactos |
| Rutas públicas | `/novedades` fuera de `AppLayout`, junto a `/formatos-impresion` | `npm test -- FormatosImpresionPage retiredGuideRoute`; API `publicDtos publicFilesSqlRepository publicDownloadFiles` | QN-REG-02: `/formatos-impresion` y `/login` siguen igual; `/novedades` no cae en el comodín que redirige a login |
| Usuarios y Roles | Nueva columna de área en el editor y en la API de usuarios | `npm test -- UsuariosPage`; API `securitySqlRepositories roleDefinitions roleLifecycle permissionModel managementAccess` | QN-REG-03: crear, editar, desactivar usuario y asignar roles sin área funciona igual; DTO de usuario sin campos sensibles |
| Modelo de permisos | Nuevas llaves `updates.whats_new.*` | API `permissionModel roleDefinitions`; frontend `permissionAccess` | QN-REG-04: roles existentes no ganan las llaves nuevas por defecto salvo `super_admin` |
| Outbox y correo | Nuevo tipo de mensaje de reporte | API `sqlAuditOutbox emailService emailTemplates emailEscape emailRecipients taskNotifications` | QN-REG-05: los correos existentes no cambian; el procesador acepta el tipo nuevo sin reintentos infinitos |
| Almacenamiento de objetos | Nuevo prefijo, limpieza de huérfanos, lectura pública | API `objectStorage contentFileSqlSchema companyStorageSetup guideUploadStorageContract` | QN-REG-06: la limpieza de huérfanos de la opción no toca objetos de otros prefijos (formatos, guías, logo) |
| Auditoría | Nuevos tipos de evento | API `auditLog auditLogsSqlRepository` | QN-REG-07: la página de Auditoría filtra y muestra los eventos nuevos sin romper los existentes |
| Limitación de tasa | Nuevo endpoint anónimo | API `rateLimit` | Cubierto por QN-PUB-13 |

## 4. Datos de prueba, fixtures y evidencia por puerta

### 4.1 Usuarios sintéticos (QA y fixtures de prueba)

| Usuario | Áreas | Permisos | Estado | Uso |
|---|---|---|---|---|
| `u.dev1`, `u.dev2` | Desarrollo | author | Activo | Autoría, propiedad, otro desarrollador |
| `u.sop1` («Felipe Cardona»), `u.sop2` | Soporte | test | Activo | Tomar, concurrencia, solo lectura |
| `u.mixto` | Desarrollo, Soporte | author, test | Activo | Selector de visión, autoprueba |
| `u.dev.sinarea` | Ninguna | author | Activo | Permiso sin área |
| `u.sop.sinpermiso` | Soporte | Ninguno de la opción | Activo | Área sin permiso |
| `u.ventas` | Ventas | Ninguno | Activo | Sin acceso; destinatario de reporte |
| `u.inactivo` | Soporte | test | Inactivo | Selector y destinatarios |
| `u.config` | Ninguna | configure | Activo | Configuración |
| `u.admin` | Ninguna | `super_admin` | Activo | Exención (QA-16) |
| Anónimo | — | — | — | Página pública |

Las contraseñas de estos usuarios viven en el archivo de semillas de QA del repositorio o en el gestor de secretos de QA, nunca en este documento ni en chat.

### 4.2 Entradas y contenido

- **E-set básico:** una entrada por tipo × sistema × estado (5 × 2 × 5 = 50), creada por fixture, con autores y asesores variados.
- **E-visibilidad:** 8 entradas `probado` que recorren las combinaciones de mostrar (sí/no), cliente asignado (sí/no), SP crítico (sí/no) y archivada, más el interruptor encendido y apagado.
- **E-rondas:** una entrada con historia Publicar → Tomar → Soltar → Tomar → Fallida → Corregir → Tomar → Probado, con hallazgos en rondas 2 y 3.
- **E-volumen:** 200 y 201 entradas fallidas o probadas en un mismo mes; 5 000 entradas para planes de consulta.
- **Centinelas:** cadenas únicas `ZZ_NOTA_*`, `ZZ_HALLAZGO_*`, `ZZ_QC_*`, `ZZ_CLIENTE_*`, `ZZ_AUTOR_*` sembradas en cada campo interno.
- **Payloads de texto enriquecido:** archivo JSON con los casos de QN-RTX-01..10 (OWASP XSS cheat sheet adaptado al esquema de `05`).
- **Archivos:** PNG, JPEG, WebP y GIF válidos; SVG con script; HTML con extensión `.png`; PDF, DOCX y XLSX válidos; DOCM y XLSM con macros; EXE renombrado; MP4 y WebM cortos; MOV; un archivo de cada límite y de límite + 1 byte, generados al vuelo (no se versionan archivos grandes).
- **Menús:** copia sanitizada del `Menu Sag Web.xlsx` real (solo estructura del menú, sin datos de clientes); variantes sin la hoja, hoja renombrada, vacía, con columnas faltantes, con profundidad 6, con fórmulas y celdas combinadas, corrupta y ZIP bomba.
- **Limpieza:** cada caso E2E crea sus datos con un prefijo `QA-QN-<fecha>` y deja anotado cómo borrarlos (borrado lógico de entradas, limpieza de objetos por el ciclo de reclamos). No se usan ni se modifican datos reales de clientes.

### 4.3 Evidencia por puerta (hitos de `09`)

| Puerta | Casos obligatorios | Evidencia requerida |
|---|---|---|
| H0 · Diseño | Esta matriz y respuestas a QA-01..QA-24 | Decisiones de Juan Camilo registradas en `02` y `01`; los símbolos de 0.1 con valor en `04` y `05` |
| H1 · Área, permisos y menú | USR, PER-01..06, PER-13..17, MEN, CFG-01..04, SQL-01..04, REG-01, 03, 04 | SHA candidato; salida de pruebas enfocadas y completas; validador de migraciones; migración aplicada en QA con respaldo y rollback documentado; diff de permisos |
| H2 · Desarrollador | DEV, RUT, CON-01..05, EST-01..03 | Salidas de prueba; capturas del formulario con errores; contrato DTO cruzado en verde |
| H3 · Editor y cargas | RTX, CAR, ACC-01..05, REG-06 | Informe del agente de seguridad; listado del bucket de QA antes y después de limpieza; 302 → 200 en QA con la URL fuera de logs |
| H4 · Asesor | ASE, HAL, EST-04..22, CON-06..10, VIS-01..06, REP, ACC-06..11, REG-05, 07 | Prueba de concurrencia real en QA (20 repeticiones); PDFs de muestra de los cuatro tipos de reporte; filas de outbox y entrega real en QA; prueba de idempotencia |
| H5 · Página del cliente | PUB, VIS-07..14, CFG-05..07, ACC-12, REG-02 | Búsqueda de centinelas en JSON y DOM sin resultados; prueba de enumeración; informe axe; capturas en 375 px y escritorio |
| H6 · Despliegue | Paridad CI completa y humo en QA | Lo exige el agente de despliegue; QA entrega la matriz pasa, falla o pendiente del SHA exacto |

Una puerta solo pasa con **todos** sus casos en «pasa». Un caso no ejecutado, o ejecutado sobre otro SHA, queda «pendiente».

## 5. Hallazgos de QA sobre el diseño

Solo se listan huecos **nuevos**, que no están en `02`. Cada uno trae por qué importa y una resolución sugerida. Los marcados **bloqueante** impiden escribir pruebas deterministas o producen un comportamiento contradictorio.

| ID | Hallazgo | Por qué importa | Resolución sugerida |
|---|---|---|---|
| QA-01 | **Bloqueante. Ninguna entrada Nuevo podría verse en `/novedades`.** `01` 4.2 dice que una entrada Nuevo exige cliente para publicar; H-02 dice que una entrada con cliente asignado no se puede mostrar en el enlace abierto; H-12 permite escribir el nombre a mano, lo que también cuenta como asignado. | El filtro público «Opciones nuevas» quedaría siempre vacío; contradice el propósito de la página. | Separar «desarrollo para un cliente» de «opción nueva general»: en Nuevo, una casilla «Desarrollo exclusivo de un cliente»; solo si está marcada se exige cliente y se bloquea la publicación al público. Alternativa: cliente opcional en Nuevo. |
| QA-02 | **El «Asesor a cargo de pruebas iniciales» no tiene efecto definido.** `01` 5.2 dice que cualquier asesor puede tomar. | No se puede probar qué cambia al asignarlo: ¿filtra, notifica, restringe Tomar? Además puede ser el propio autor si tiene ambas áreas, chocando con H-01. | Definirlo como informativo con filtro «Asignadas a mí» en la bandeja; validar asignado ≠ autor; decidir si es obligatorio para publicar. |
| QA-03 | **No está definido si un desarrollador ve o edita entradas de otro.** «Mis entradas» sugiere solo propias, pero no hay regla de lectura de detalle ajeno ni de edición de borradores ajenos. | Las pruebas de IDOR (QN-PER-09) no tienen resultado esperado. | Lectura: solo propias en «Mis entradas»; edición de borrador solo el creador. Escribirlo en `06`. |
| QA-04 | **Ampliar la regla de H-01 a quien editó o corrigió.** H-01 solo bloquea a quien creó la entrada. | Si en el futuro otro desarrollador corrige (ver QA-07), esa persona podría probar su propio arreglo. | «Nadie prueba una entrada que creó, editó o corrigió». |
| QA-05 | **Validación del asesor a cargo y del cliente en borrador.** No se dice si el borrador puede guardar un asesor inactivo o sin Soporte, ni qué pasa si el asesor pierde el área después de publicar. | Datos inválidos persistidos; comportamiento distinto entre UI y API. | Validar referencias siempre (también en borrador); al publicar, revalidar; si después pierde el área, conservar el dato histórico. |
| QA-06 | **Contradicción entre «publicada es solo lectura» (4.1) y H-11, que permite corregir en `sin_probar`.** El diagrama de 5.2 solo muestra corregir desde `fallida`. | El resultado de QN-EST-17 es indeterminado. | Elegir una: (a) en `sin_probar` el autor edita sin abrir ronda nueva (aún nadie la probó) o (b) solo desde `fallida`. Actualizar el diagrama. |
| QA-07 | **Quién corrige si el autor ya no está.** Solo el autor corrige; si se desactiva o pierde el área, la entrada queda en `fallida` para siempre. Igual para borradores huérfanos. | Entradas atascadas sin salida. | Permitir que un usuario con author + Desarrollo «reasigne autoría» con auditoría, o un permiso de administración de la opción. |
| QA-08 | **Entrada tomada por un asesor que se desactiva o pierde el área o el permiso.** Solo el dueño puede soltar. | La entrada queda en `en_pruebas` sin dueño válido. | Acción «Liberar» para un rol de supervisión (o automática al desactivar al usuario) que cierre la ronda como «liberada por X», preservando el historial. |
| QA-09 | **Ciclo de vida del texto para clientes.** No se define: si se puede editar después de `probado`, quién lo edita (nadie tiene la entrada tomada), si sobrevive a Soltar y a Corregir, ni si se exige al marcar probado con «Mostrar» activo. | No hay forma de corregir un error tipográfico visible al público ni de retirar una novedad publicada; QN-VIS-05 y QN-VIS-13 sin resultado esperado. | Texto para clientes ligado a la entrada, no a la ronda; editable después de probado por cualquier asesor con permiso, con auditoría y `row_version`; obligatorio si «Mostrar» está activo al marcar probado; «Mostrar» se puede apagar en cualquier momento. |
| QA-10 | **El estado «archivada» no está en la máquina de estados.** H-16 dice que lo publicado «solo se archiva», pero no hay transición, actor, estados de origen ni efecto en pestañas y página pública. | No se puede probar ni implementar el archivo. | Agregar `archivada` con origen en cualquier estado publicado, permiso explícito, sale de todas las pestañas salvo un filtro «Archivadas», nunca visible al público. |
| QA-11 | **Hallazgos y checklist: ¿por ronda o acumulados?** «Marcar fallida exige al menos un hallazgo» y «probado exige checklist completo» no dicen si cuentan rondas anteriores. | Una entrada corregida podría marcarse fallida sin hallazgos nuevos. | Ambas reglas cuentan solo la ronda actual (así está escrito QN-EST-11). Confirmar en `03`. |
| QA-12 | **Rutas: duplicadas, cantidad máxima y profundidad del menú.** No hay límite de rutas relacionadas ni regla para rutas repetidas. | Pruebas de límite indeterminadas; listas públicas inconsistentes. | Fijar `L_RUTAS` (por ejemplo 10) y rechazar rutas idénticas dentro de una entrada (comparación sin mayúsculas ni tildes). |
| QA-13 | **La copia de «Qué cambió» al texto para clientes arrastra menciones e imágenes internas.** H-04 propone copiar; H-14 inserta nombres del equipo con @; H-15 solo sirve imágenes del texto para clientes. | Fuga de nombres del equipo (prohibida en `01` 6) e imágenes rotas en la página pública. | Al copiar: convertir menciones en texto plano sin nombre o quitarlas; deshabilitar @ en el editor de clientes; registrar las imágenes copiadas como pertenecientes al texto para clientes (nueva referencia al mismo objeto o copia). |
| QA-14 | **Límites numéricos ausentes.** «Guardar borrador valida el tamaño del contenido» sin valor; tampoco hay tamaños de imagen, documento, video, cantidad de adjuntos ni longitud de títulos. | Declaraciones no comprobables; riesgo de abuso de almacenamiento (los videos no tienen techo). | Completar la tabla 0.1 en `04` y `05` antes de H2. |
| QA-15 | **Permisos sin nombre para ver la opción, configurar y reportar.** `01` solo nombra `author` y `test`. | No se puede probar la Configuración ni el menú; el patrón del portal separa `*.view` de las acciones. | Definir `updates.whats_new.view`, `configuration.whats_new.manage` (o similar) y decidir si reportar es parte de `test`. |
| QA-16 | **Exenciones y reportes.** No se dice si `super_admin` necesita área para crear o probar, ni si el desarrollador puede descargar el reporte de su propia entrada, ni si un asesor puede reportar una entrada `en_pruebas` que tiene otro. | Resultados indeterminados en QN-PER-15 y QN-REP-19, 20. | `super_admin` también exige área para crear y probar (la regla de negocio es de área, no de poder); el autor puede descargar el reporte de su entrada; cualquier asesor con `test` puede reportar en cualquier estado publicado. |
| QA-17 | **Contenido del reporte «Solo hallazgos» con varias rondas y con entradas sin hallazgos.** | El PDF de la pestaña Probadas en «Solo hallazgos» puede salir casi vacío o confuso. | Incluir hallazgos de todas las rondas agrupados por ronda; entradas sin hallazgos aparecen con «Sin hallazgos» en el reporte de entrada y se omiten en el de pestaña, indicando cuántas se omitieron. |
| QA-18 | **Acciones requeridas predefinidas: instantánea y mínimo.** No se dice si las entradas guardan el texto de la acción o una referencia, ni qué pasa si se desactivan todas. | Renombrar una acción cambiaría checklists ya probados; el formulario quedaría sin opciones. | Guardar instantánea del nombre en la entrada; exigir al menos una acción activa; «Otro» siempre disponible. |
| QA-19 | **Versionado del menú: reactivar, y la marca «fuera del menú».** No se dice si se puede volver a una versión anterior ni si la marca de H-13 se recalcula al cargar un menú nuevo. | Sin regla no hay resultado esperado en QN-MEN-06 y QN-MEN-14. | Permitir activar cualquier versión anterior; la marca se recalcula al activar una versión, sin modificar el texto de la ruta guardada. |
| QA-20 | **Formato de «Menú Final» no especificado.** No se describen columnas, cómo se codifica la profundidad ni qué hacer con más de 5 niveles, celdas combinadas o duplicados. | No se puede escribir el analizador ni sus pruebas negativas. | Documentar en `05` las columnas exactas con un ejemplo de 5 filas y la política para cada anomalía (rechazo con número de fila). |
| QA-21 | **Caché del endpoint público y del archivo público.** No se define `Cache-Control` ni cómo se invalida al apagar «Mostrar» o «Publicación activa». | Contenido retirado seguiría visible en caché del navegador o CDN; QN-VIS-13 no es comprobable. | `Cache-Control: no-store` o `max-age` corto (por ejemplo 60 s) declarado en `04`; la 302 con `no-store`. |
| QA-22 | **Orden y tamaño de la lista pública.** «Termina al final de la lista» sin orden ni tope. | Resultado no determinista; con años de entradas la respuesta crece sin límite. | Orden por fecha de liberación descendente y luego por ID; tope documentado (por ejemplo, últimos 12 meses o 100 tarjetas). |
| QA-23 | **Identificador público de «Ver detalle».** No se dice si existe `/novedades/:id` ni qué ID usa. | Un ID secuencial permite enumerar entradas no visibles. | Usar un identificador opaco (GUID) separado del ID interno; 404 idéntico para inexistente y no visible. |
| QA-24 | **Zona horaria de «mes y año».** El filtro del asesor, la fecha de liberación y el corte de 200 por mes no fijan zona. | Una entrada probada el último día del mes a las 20:00 en Colombia caería en el mes siguiente en UTC. | Calcular en `America/Bogota`; guardar UTC en SQL. |
| QA-25 | **Idempotencia de Publicar, transiciones y envío de reportes.** `01` no la exige. | Doble clic o reintento de red duplicaría rondas o correos (lección del Constructor de guías). | Clave de idempotencia en Publicar, Corregir y Enviar reporte; transiciones condicionadas por `row_version`. |
| QA-26 | **Hallazgos inmutables sin forma de corregir errores.** «No se borran», pero tampoco se dice si se editan. | Un hallazgo mal escrito queda así para siempre, o alguien lo edita sin rastro. | Inmutables; se agrega un hallazgo «Aclaración del n.º X» o una anulación con motivo que lo deja tachado y visible. |
| QA-27 | **Los reportes por correo salen a cualquier usuario activo del portal**, incluidos los que no tienen acceso a la opción. | El modo «Completo» lleva notas internas y nombres a personas sin permiso sobre la opción; es una decisión de negocio, no un error, pero debe ser explícita. | Confirmar con Juan Camilo; si se mantiene, advertir en el diálogo «Incluye notas internas» y auditar destinatarios. |

Ningún hallazgo de esta lista exige cambiar código existente; todos se resuelven con una decisión escrita en `01`, `02` o en los documentos `03` a `06`.
