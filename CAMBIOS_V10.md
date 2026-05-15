# Cambios incrementales — Versión 10

## UX de tareas

- Se eliminaron `window.prompt`, `alert` y `confirm` de los flujos de negocio de tareas.
- **Reabrir** una tarea completada usa modal propio:
  - Motivo de reapertura opcional.
  - Transición `completed -> pending`.
  - Auditoría `task_reopened`.
- **Resolver bloqueo** usa modal propio:
  - Comentario de resolución opcional.
  - Nuevo estado obligatorio: pendiente, en progreso o completada.
  - Transiciones `blocked -> pending`, `blocked -> in_progress`, `blocked -> completed`.
  - Auditoría `task_block_resolved`.
- Una tarea bloqueada no muestra **Reabrir**.
- Una tarea completada no muestra **Resolver bloqueo**.

## Programaciones especiales

- La selección jerárquica por cliente -> dominio -> base conserva `scopeGroups`.
- **+ Agregar dominios** abre modal con búsqueda y checkboxes.
- **+ Agregar bases** abre modal con búsqueda y checkboxes.
- Se pueden seleccionar varios dominios o varias bases antes de cerrar el modal.
- Las bases seleccionadas se muestran como chips/filas removibles.
- Las opciones **Incluir todos los dominios activos** e **Incluir todas las bases activas** deshabilitan la selección manual correspondiente.

## Recordatorios a actualizadores

- La sección **Recordatorios a actualizadores** se documenta y muestra como configuración global por defecto.
- Si una frecuencia no tiene recordatorios propios, el timer usa:
  - `defaultReminderDaysBefore`
  - `defaultReminderTime`
  - `defaultTimezone`
- Si la frecuencia tiene override en `reminders`, ese override prevalece sobre la configuración global.

## Alertas de bloqueos

- El envío inmediato al bloquear queda como regla natural cuando las alertas de bloqueos están activas.
- La UI deja de mostrar el checkbox prominente **Enviar inmediatamente al bloquear**.
- Se agregó configuración de **Recordatorios si el bloqueo sigue sin resolverse**:
  - Activar recordatorios.
  - Días después del bloqueo.
  - Hora.
  - Zona horaria.
- Los recordatorios usan los mismos destinatarios de bloqueos y se deduplican con `emailNotifications`.

## Recordatorios administrativos

- Cada recordatorio administrativo tiene **Regla de envío**:
  - Primer día del mes.
  - Último día del mes.
  - Último día hábil del mes.
  - Día fijo del mes.
- La regla por defecto es **Último día hábil del mes**.
- Si el mes termina sábado o domingo, se generan dos envíos:
  - Viernes anterior.
  - Lunes siguiente.
- El lunes siguiente conserva el periodo del mes anterior.
- La idempotencia usa `admin-reminder:{type}:{period}:{sendDate}`.

## UI general

- Los acordeones de **Alertas y correos** muestran resúmenes en el encabezado.
- Las columnas **Acciones** se alinean a la derecha.
- Los botones destructivos permanecen al final.

## Licenciamiento y reporte maestro

- Se mantiene la integración V9: el reporte maestro incluye licencias/módulos activos por cliente.
- Las licencias se deduplican y no se incluyen secretos ni datos técnicos sensibles.

## Pruebas validadas

- Backend: 23 archivos, 147 pruebas.
- Frontend: 14 archivos, 94 pruebas.
