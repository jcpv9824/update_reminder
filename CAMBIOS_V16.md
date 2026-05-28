# CAMBIOS V16 - Objetivo manual en programaciones especiales

## Programaciones especiales

- La frecuencia por defecto para **Nueva programación especial** se mantiene explícitamente como **Única**.
- **Única** usa la **Fecha de actualización** y genera tareas para esa fecha sin duplicarlas.
- Generar tareas no cierra la programación por sí solo; la programación única solo queda inactiva/completada cuando sus tareas asociadas ya están cerradas.
- En el modo **Selección manual** se agregó el campo **Objetivo de la actualización**.
- El valor por defecto es **Dominios y bases de datos**.
- Las opciones disponibles son:
  - **Dominios y bases de datos**.
  - **Solo dominios**.
  - **Solo bases de datos**.
- Cuando el objetivo es **Solo bases de datos**, la UI permite seleccionar bases directamente desde el cliente, sin obligar al usuario a crear una tarea de dominio.
- Internamente las bases siguen agrupadas por dominio para preservar integridad, pero el generador no crea tareas de dominio si el objetivo es solo bases.

## Backend

- Las programaciones especiales manuales guardan `manualTargetTypes`.
- El generador de tareas respeta `manualTargetTypes`:
  - `domains_and_databases`: genera tareas de dominio y base.
  - `domains_only`: genera solo tareas de dominio.
  - `databases_only`: genera solo tareas de base.
- Corrección crítica: una programación **Única** no se desactiva por estar dentro de la ventana futura de generación ni por haber generado tareas. Solo queda inactiva/completada cuando su **Fecha de actualización** es hoy o una fecha anterior y todas sus tareas asociadas ya están `completed` o `cancelled`.
- Corrección adicional: si una corrida anterior dejó tareas futuras como `cancelled` con `result = "obsolete"` y la programación sigue activa, el refresh las reactiva como pendientes en vez de omitirlas silenciosamente. Las tareas completadas siguen bloqueando duplicados.
- Nueva regla de reprogramación: si una programación **Única** activa cambia de fecha antes de cerrarse, el backend cancela como `obsolete` las tareas abiertas de la fecha anterior asociadas a esa programación. Las tareas completadas o ya canceladas se conservan como historial.
- Los recordatorios de actualización se calculan sobre tareas pendientes/abiertas; no deben depender de que la programación especial siga activa después de que la tarea ya existe.

## Pruebas

- Se agregaron pruebas backend para confirmar que una programación manual **Solo bases de datos** no genera tarea de dominio.
- Se agregaron pruebas backend para confirmar que una programación manual **Solo dominios** no genera tareas de base.
- Se agregó prueba frontend para confirmar que la UI guarda `manualTargetTypes = "databases_only"` y las bases seleccionadas.
- Se agregaron pruebas backend para evitar que tareas obsoletas/canceladas oculten tareas futuras de programaciones activas.
- Se agregó prueba frontend para confirmar que después de **Refrescar** las tareas futuras generadas aparecen en **Próximas**.
- Se agregaron pruebas backend para impedir el cierre prematuro de programaciones únicas con tareas pendientes.
- Se agregaron pruebas backend para cancelar tareas abiertas de la fecha anterior al reprogramar una programación única.
- Se agregó prueba backend para confirmar que los recordatorios pueden enviarse sobre tareas pendientes aunque la programación asociada ya esté inactiva.
