# Qué hay de nuevo · Huecos de lógica y decisiones propuestas

Cada hueco trae una **propuesta** con la que el diseño ya está escrito. Si Juan Camilo la cambia, se actualizan el documento `01` y los demás.

| ID | Hueco | Por qué importa | Propuesta en el diseño |
|---|---|---|---|
| H-01 | Una persona puede tener las áreas **Desarrollo y Soporte**. | No se sabe qué visión ver. Además, podría probar su propia entrada. | Selector de visión arriba. **Nadie prueba una entrada que creó él mismo**: el backend lo bloquea. |
| H-02 | **El enlace para clientes es abierto, pero hay entradas Nuevo ligadas a un cliente concreto.** | Un desarrollo especial de un cliente quedaría visible para todos los demás clientes y para cualquiera con el enlace. | Una entrada con cliente asignado **no se puede mostrar en el enlace abierto**: la casilla «Mostrar a clientes» queda deshabilitada y explica por qué. Más adelante: un enlace por cliente con token, o la versión con inicio de sesión. **Requiere confirmación.** |
| H-03 | **¿Qué hace que una entrada esté «Fallida»?** El prototipo solo tenía «Marcar probado». | Sin un estado explícito, la pestaña Fallidas no tiene cómo llenarse. | Botón **Marcar fallida**, que exige al menos un hallazgo. «Marcar probado» exige el checklist completo. ¿Se puede marcar probado con hallazgos menores? Propuesta: sí, y los hallazgos quedan visibles. |
| H-04 | **¿Quién escribe lo que ve el cliente?** La tarjeta muestra «Título de la novedad» y «Qué hace ahora el sistema», pero el formulario del desarrollador no tiene título. | «Qué cambió» está escrito para Soporte y puede tener detalles internos. | Al activar «Mostrar a clientes», el asesor escribe **Título** y **Texto para clientes**, con el editor compacto, partiendo de una copia de «Qué cambió». El cliente solo ve eso. |
| H-05 | **SP crítico y Rediseño** frente a las categorías del cliente. | Un SP crítico es un cambio técnico interno. | **SP crítico nunca se muestra** al cliente. Rediseño, Mejora y Regla de negocio se agrupan en **Mejoras**. |
| H-06 | **«Pedir asesoría»** aparece en el prototipo del cliente, pero no se mencionó. | Sin un destino, el botón no hace nada. | Se retira de esta versión. Si se quiere, que abra el canal de soporte vigente (correo o portal de tickets) con la ruta prellenada. |
| H-07 | **Rutas de SAG Clásico.** La vía «Barra lateral o Barra de navegación» es de SAG Web. | El Clásico tiene otro menú. | Para SAG Clásico, el nivel 1 es «Menú principal» y no hay sugerencias hasta que se cargue un menú del Clásico. Se escribe con «Otro». |
| H-08 | **Fecha de liberación** que ve el cliente. | No está definido de dónde sale. | Es la fecha en que se marcó **probado**, mostrada como mes y año. Si se quiere atar a la versión del mes o a un parche, se agrega el campo «Liberada en» (versión o parche) al marcar probado. **Requiere confirmación.** |
| H-09 | **Correo de hallazgos.** El prototipo decía «se enviará por correo a Gerencia, Gestión de Proyectos y el desarrollador», pero ahora el correo se envía con «Enviar reporte», eligiendo personas. | Si nadie envía el reporte, el desarrollador no se entera de que su entrada falló. | El desarrollador **ve el estado en «Mis entradas»** y lo filtra. Como mejora opcional, avisar automáticamente al desarrollador cuando su entrada pasa a Fallida. Desactivado por defecto; **requiere decisión.** |
| H-10 | **Soltar** reinicia la prueba. | Se pierde trabajo hecho y no queda constancia de quién soltó. | La ronda soltada se conserva en el historial, con checklist, notas y quién soltó. La siguiente ronda empieza con el checklist en blanco. |
| H-11 | Una entrada que el desarrollador quiere **corregir mientras está en pruebas**. | Habría dos personas editando lo mismo al tiempo. | Solo puede corregir cuando la entrada está en `sin_probar` o en `fallida`. En `en_pruebas` debe pedirle al asesor que la suelte. Concurrencia optimista con `row_version`. |
| H-12 | **Cliente sin fuente de datos.** | Una entrada Nuevo no se podría publicar. | Mientras no haya fuente, el selector permite escribir el nombre del cliente a mano. La entrada guarda el texto y, cuando exista la fuente, se agrega la referencia. Así no se bloquea la publicación. |
| H-13 | **Menú de referencia desactualizado** o con opciones nuevas que todavía no están en el menú. | Las sugerencias no alcanzan. | Siempre existe «Otro…». Lo escrito a mano queda marcado como «fuera del menú» para revisarlo al cargar el siguiente menú. |
| H-14 | **Mención @** en el editor, como en la barra que mostró Juan Camilo. | Una mención sugiere que llega un aviso. | En esta versión, @ inserta el nombre de un usuario del portal como texto resaltado, **sin notificación**. El aviso queda para una versión futura. |
| H-15 | Las **imágenes del editor en la página pública**. | El almacenamiento es privado, pero el cliente no inicia sesión. | Endpoint público que entrega un archivo **solo si** pertenece al texto para clientes de una entrada visible. Responde 302 a una URL firmada de vida corta y nunca expone el localizador. |
| H-16 | **Retención.** | No está definido qué pasa al eliminar un borrador o cuando un archivo queda huérfano. | Se puede eliminar un borrador, con borrado lógico. Los objetos que quedan sin referencia se limpian con el ciclo de reclamos de borrado ya existente. Lo publicado no se borra, solo se archiva. |
| H-17 | **Reporte PDF de una pestaña con muchas entradas.** | Generar un PDF grande puede agotar el tiempo de respuesta. | Límite de 200 entradas por reporte; por encima, se pide filtrar por mes. El PDF se genera en el servidor. |

## Resoluciones a los hallazgos de QA (documento `08`, QA-01 a QA-27)

| QA | Resolución aplicada al diseño |
|---|---|
| QA-01 (bloqueante) | La regla «una entrada con cliente nunca es pública» impediría mostrar cualquier entrada Nuevo. **Se cambia H-02:** al activar «Mostrar a clientes» en una entrada Nuevo, el asesor confirma con la casilla **«Disponible para todos los clientes»**. Sin esa confirmación, la entrada no es pública. **El nombre del cliente nunca sale en la página pública.** Confirmación del propietario pendiente. |
| QA-02 | El **Asesor a cargo** tiene prioridad, no exclusividad. La entrada muestra «Asignada a X», hay un filtro «Asignadas a mí» y cualquier asesor puede tomarla. |
| QA-03 | Los desarrolladores ven todas las entradas en solo lectura. Solo editan **las suyas**. |
| QA-04 | No prueba la entrada quien la creó **ni quien la editó o corrigió**. |
| QA-05 | Cliente y asesor se validan al **publicar**. Si después el asesor queda inactivo, la entrada sigue igual, con el aviso «Asesor inactivo». |
| QA-06 | Solo lectura **salvo** la corrección, que se permite en `sin_probar` y en `fallida`. Ya está en el diagrama del documento `01`. |
| QA-07 y QA-08 | Quien tenga `configuration.whats_new.manage` puede **reasignar el autor** y **forzar Soltar** una entrada en pruebas. Se audita y se registra el motivo. |
| QA-09 | El **texto para clientes es de la entrada, no de la ronda**: sobrevive a Soltar y a las correcciones. Lo edita quien tiene la ronda activa. Después de `probado`, lo edita quien tiene `updates.whats_new.publish_client`. |
| QA-10 | Se agrega el estado **`archivada`**, que se alcanza desde `probado` con `manage`. La entrada sale de la página pública y sigue visible en los reportes. |
| QA-11 | «Marcar fallida» y «Marcar probado» miran solo la **ronda actual**. |
| QA-12 | Máximo **10 rutas** por entrada. No se permiten dos rutas idénticas. |
| QA-13 | Al copiar «Qué cambió» al texto para clientes, **se quitan las menciones**, que quedan como texto plano sin el nombre. Las imágenes copiadas pasan a ser del texto para clientes, de modo que el endpoint público las sirve. |
| QA-14 | Los límites numéricos están en el documento `05`. Mientras tanto, los casos que dependen de ellos siguen pendientes. |
| QA-15 y QA-16 | Los permisos están en el documento `06`. `super_admin` no necesita área para configurar ni para ver reportes, pero **sí la necesita para crear o probar entradas**. |
| QA-17 | En «Solo hallazgos» salen los hallazgos de **todas las rondas**, agrupados por ronda. Las entradas sin hallazgos aparecen con la marca «Sin hallazgos». |
| QA-18 | Al publicar, se guarda una copia del nombre de cada acción requerida. Siempre debe quedar al menos una acción activa. |
| QA-19 y QA-20 | La versión del menú y el formato de la hoja «Menú Final» se definen en los documentos `03` y `04`. Se puede reactivar una versión anterior, y la marca «fuera del menú» se recalcula al activar una versión. |
| QA-21 | Las respuestas públicas llevan `Cache-Control: no-store`. Apagar la publicación tiene efecto inmediato. |
| QA-22 | La página pública ordena por fecha de liberación, de la más reciente a la más antigua, y muestra como máximo 100 entradas. |
| QA-23 | El detalle público usa un **identificador aleatorio** (GUID), nunca el ID secuencial. |
| QA-24 | Todas las fechas de mes y año usan la zona horaria **America/Bogota**. |
| QA-25 | Publicar, Tomar, Marcar, Corregir y Enviar reporte llevan **llave de idempotencia** (documento `04`). |
| QA-26 | Un hallazgo no se borra: se **anula** con un motivo, que es un registro nuevo. Queda tachado en la historia. |
| QA-27 | Enviar el reporte **Completo** a usuarios sin acceso a la opción expone notas internas. **Propuesta:** el destinatario puede ser cualquier usuario activo, pero el diálogo advierte «X no tiene acceso a Qué hay de nuevo» antes de enviar. Confirmación del propietario pendiente. |

## Cierre por el propietario (2026-11-18, segunda ronda)

| Hueco | Decisión final |
|---|---|
| H-02 y QA-01 | Mostrar a clientes es mostrar a todos. Las entradas Nuevo se publican **sin** el cliente, el desarrollador, los asesores, las reglas de negocio ni los videos. Se retira la casilla «Disponible para todos los clientes». |
| H-08 | La fecha de liberación es el mes de aprobación. El cliente filtra por Mes actual, Últimos 3 meses, Último año, Todo o Rango. |
| H-09 | El desarrollador ve el resultado en «Mis entradas». El reporte incluye al desarrollador y a todos los asesores que participaron. |
| H-17 | Ya no hay PDF. El reporte es HTML y se genera solo desde la pestaña Probadas. |
| QA-17 | Se reemplaza la elección «Solo hallazgos / Completo» por **Todas / Solo aprobadas / Solo fallidas**. |
| QA-27 | Cualquier usuario del portal puede recibir el reporte, sin advertencia. |
| Menú de referencia (H-07 y H-13) | **Se elimina.** Las rutas se escriben siempre a mano y la única ayuda es el nivel 1 fijo (Barra de navegación o Barra lateral). |
| QA-07 | El Desarrollador es siempre el autor y no se reasigna. Un líder puede corregir en su nombre, y queda en la bitácora. |
| Enlace del reporte | Exige iniciar sesión. |
