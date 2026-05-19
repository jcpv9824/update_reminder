# CAMBIOS V16 - Objetivo manual en programaciones especiales

## Programaciones especiales

- La frecuencia por defecto para **Nueva programación especial** se mantiene explícitamente como **Única**.
- **Única** usa la **Fecha de actualización**, genera tareas una sola vez y luego la programación queda inactiva/completada automáticamente.
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
- Corrección crítica: una programación **Única** no se desactiva por estar dentro de la ventana futura de generación. Solo queda inactiva/completada cuando su **Fecha de actualización** es hoy o una fecha anterior.

## Pruebas

- Se agregaron pruebas backend para confirmar que una programación manual **Solo bases de datos** no genera tarea de dominio.
- Se agregaron pruebas backend para confirmar que una programación manual **Solo dominios** no genera tareas de base.
- Se agregó prueba frontend para confirmar que la UI guarda `manualTargetTypes = "databases_only"` y las bases seleccionadas.
