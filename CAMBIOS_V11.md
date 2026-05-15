# Cambios incrementales — Versión 11

## Licenciamiento

- La vista `/licenciamiento` queda enfocada en el maestro de módulos.
- La pestaña **Asignaciones** queda oculta por defecto con `VITE_ENABLE_ADVANCED_LICENSE_ASSIGNMENTS=false`.
- Las asignaciones avanzadas por dominio/base se conservan en backend para una fase futura, pero no forman parte del flujo normal.
- El campo **Código** del módulo es opcional.
- Si el código viene vacío, backend genera uno desde el nombre:
  - Mayúsculas.
  - Sin tildes.
  - Espacios como guion bajo.
  - Sin caracteres especiales.
  - Sufijo `_2`, `_3`, etc. si ya existe.

## Licencias En Clientes

- Los clientes ahora soportan `licenseModuleIds`.
- En **Nuevo cliente** y **Editar cliente** se agregó la sección **Licencias del cliente**.
- Se pueden seleccionar cero, una o varias licencias activas.
- El modal **Ver dominios y bases** muestra las licencias del cliente o **Sin licencias registradas**.
- El reporte maestro usa `clients.licenseModuleIds` como fuente principal.

## Programaciones Por Licenciamiento

- **Programaciones especiales** ahora tiene **Tipo de alcance**:
  - Selección manual.
  - Por licenciamiento.
- En modo por licenciamiento se configuran:
  - Licencias a actualizar.
  - Coincidencia: cualquiera o todas.
  - Ambiente: todos, producción, pruebas o demo.
  - Objetivo: dominios y bases, solo dominios o solo bases.
  - Solo activos.
- Se agregó `POST /api/special-schedules/preview-licensing-scope`.
- Las programaciones guardan el criterio en `licensingScope`, no solo un snapshot.
- La generación de tareas re-resuelve el criterio para incluir clientes licenciados agregados después.
- La deduplicación por entidad/día se mantiene para programaciones normales, manuales y por licencia.

## Reporte Maestro

- El reporte **Reporte maestro ERP — clientes, dominios y empresas** muestra licencias por cliente desde `licenseModuleIds`.
- Se excluyen módulos inactivos o eliminados.
- No se incluyen usuarios SQL, servidores, cadenas de conexión, secretos ni contraseñas.

## Pruebas

- Se agregaron pruebas backend para generación de código de licencias, preview por licenciamiento, expansión dinámica y deduplicación.
- Se agregaron pruebas frontend para licencias en clientes, ocultamiento de asignaciones y programación especial por licenciamiento.
