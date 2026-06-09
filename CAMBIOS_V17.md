# CAMBIOS V17 - Actualizaciones programadas y alcance explicito

## Resumen

Esta ronda centraliza la programacion de dominios y bases en la vista **Actualizaciones programadas**.

La frecuencia embebida en el formulario de dominios/bases queda retirada de la UI. Las bases de un dominio se programan desde el alcance explicito de una actualizacion programada.

## Cambios principales

- La opcion del menu antes llamada **Programaciones especiales** ahora se llama **Actualizaciones programadas**.
- La pagina mantiene ruta `/frecuencias` por compatibilidad, pero el texto visible usa el nuevo nombre.
- Las actualizaciones programadas pueden ser unicas o recurrentes.
- Las recurrentes no tienen un unico estado operativo; su salud se deriva de las tareas generadas por fecha.
- Las tareas generadas guardan `rootScheduleId` para vincularse con la actualizacion programada original.
- Al crear, editar o reactivar una actualizacion programada, el backend intenta generar/reconciliar tareas de forma idempotente.
- La vista **Tareas** ya no muestra el boton **Refrescar** como flujo operativo.

## Alcance de bases de datos

Para programar bases de un dominio:

- Seleccionar cliente.
- Seleccionar dominio.
- Marcar **Incluir todas las bases activas de este dominio** o seleccionar bases puntuales.
- Si se requiere solo base de datos, usar **Objetivo de la actualizacion -> Solo bases de datos**.

Excluir o no crear tarea de dominio no impide crear tareas de bases si las bases estan seleccionadas.

## Dominios y bases

- El formulario de dominio ya no muestra **Activar frecuencia automatica para este dominio**.
- El formulario de base de datos ya no crea frecuencias propias.
- Ambos formularios muestran una nota indicando que la programacion se realiza desde **Actualizaciones programadas**.

## Compatibilidad

- El backend conserva tolerancia a algunos campos antiguos para no romper clientes desactualizados.
- La UI normal no debe enviar `frequency`, `disableAutomaticFrequency` ni depender de `domain_default` para nuevas configuraciones.

## Pruebas agregadas/actualizadas

- Backend:
  - Programacion plana de dominio no genera bases implicitas.
  - Alcance explicito con **Incluir todas las bases** genera tareas de bases.
  - Ventana de generacion no crea bases heredadas si no estan en alcance.
- Frontend:
  - Dominios no muestra frecuencia embebida ni columnas Recurrente/Proxima actualizacion.
  - Actualizaciones programadas muestra el nuevo titulo y el alcance explicito.
  - Tareas no muestra boton Refrescar y muestra el nombre de la actualizacion programada.

## Complemento de verificacion (notificaciones, duplicar y agrupacion)

Tras revisar en detalle, se completaron tres piezas que faltaban respecto al plan acordado:

- **Notificaciones por estado (matriz "Atencion + fallida + exito")**:
  - Tarea **fallida** ahora envia correo inmediato de problema a los destinatarios configurados (gobernado por `blockedAlertsEnabled`).
  - Tarea **completada con exito** (sin problemas) envia un correo de confirmacion a los encargados (destinatarios de alertas de vencidos).
  - Se mantiene: completada-con-problemas y bloqueada -> correo de problema. En progreso / cancelada / reabierta -> sin correo.
  - La decision se extrajo a `api/src/lib/taskNotifications.ts` (`decidirNotificacionPorEstado`) con pruebas unitarias.
- **Duplicar actualizacion programada**: accion "Duplicar" en cada fila que abre el formulario de creacion precargado con toda la configuracion (alcance, frecuencia, responsables, recordatorios) y nombre sugerido `"<nombre> (copia)"`. Reusa `POST /schedules`.
- **Agrupacion por estado**: la lista se separa en **Requiere atencion / Al dia / Completadas / Inactivas** (estado de vida + salud derivada), sin fusionar la programacion en un unico estado; cada ocurrencia sigue visible en la vista de Tareas.

Pruebas agregadas: `api/src/tests/taskNotifications.test.ts` (6) y dos casos en `frontend/src/tests/FrecuenciasPage.test.tsx` (agrupacion por estado y duplicar).

## Correccion: eliminacion idempotente de actualizaciones programadas

Sintoma: al eliminar una actualizacion programada, a veces aparecia el error crudo de Cosmos `Entity with the specified id does not exist in the system` (404 en Delete) aunque la eliminacion si se realizaba.

Causa: `findSchedule` usa una consulta cross-particion que podia devolver un documento ya eliminado en una segunda peticion (doble clic o lectura eventualmente consistente); el `.delete()` posterior chocaba con un documento inexistente y se propagaba el 404.

Solucion:
- `DELETE /schedules/{id}` ahora es **idempotente**: si el `.delete()` devuelve 404, se trata como ya eliminado y no se propaga el error.
- La cancelacion de tareas de la programacion tolera tareas que desaparecieron de forma concurrente (404 por tarea se omite).
- Tras eliminar, se ejecuta una regeneracion para que una tarea **compartida** por otra programacion activa (p. ej. una copia con el mismo alcance) se vuelva a vincular de inmediato.
- Frontend: el boton de confirmacion de borrado ignora clics repetidos mientras la operacion esta en curso.

## Correccion de tareas huerfanas sin actualizaciones programadas

Se corrigio un caso en el que seguian apareciendo tareas viejas vencidas o fallidas aunque ya no existieran actualizaciones programadas:

- Al desactivar o eliminar una actualizacion programada ahora se cancelan **todas** sus tareas abiertas asociadas, incluyendo vencidas antiguas, no solo tareas futuras.
- El listado `/tasks` filtra cualquier tarea cuyo `rootScheduleId` ya no pertenezca a una actualizacion programada existente.
- Las tareas sin referencia comprobable a una actualizacion programada raiz tambien se ocultan de la vista operativa.
- Las tareas abiertas solo se muestran si su actualizacion programada existe y esta activa.
- Las tareas completadas se preservan como historial reciente solo si su actualizacion programada todavia existe.
- Prueba agregada: `api/src/tests/taskVisibility.test.ts`.
