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
