# Cambios V14 — Excepciones por licenciamiento y frecuencia única

## Resumen

Esta ronda actualiza las programaciones especiales antes de avanzar a la Fase 4 de migración relacional. No se reconstruyó la app ni se agregó el modo cancelado **Todos los clientes activos**.

## Programaciones por licenciamiento

- El preview por licenciamiento ahora permite marcar excepciones manuales.
- Se pueden excluir dominios específicos de esta programación.
- Se pueden excluir bases de datos específicas de esta programación.
- Excluir un dominio solo evita la tarea de dominio; sus bases siguen incluidas salvo que se excluyan una por una.
- Excluir una base no afecta la tarea del dominio.
- Las excepciones se guardan como IDs en `licensingScope.excludedDomainIds` y `licensingScope.excludedDatabaseIds`.
- Si cambian licencias, coincidencia, ambiente u objetivo después del preview, el preview queda desactualizado y no se permite guardar hasta previsualizar de nuevo.
- Al reprevisualizar, se conservan excepciones que todavía pertenecen al alcance y se descartan las que ya no aplican.

## Frecuencia única

- Se agregó `frequencyType = "once"`.
- **Única** es la frecuencia por defecto al crear una nueva programación especial.
- Cuando la frecuencia es **Única**, la UI muestra solo **Fecha de actualización** y oculta campos recurrentes.
- El texto **Frecuencia activa** se reemplazó por **Programación activa**.
- Las programaciones únicas activas generan tareas solo en su fecha de actualización.
- Después de generar tareas, la programación única queda inactiva con `completedReason = "one_time_schedule_executed"`.
- Refrescar de nuevo no duplica tareas y no vuelve a ejecutar la programación única.

## Recordatorios en programaciones especiales

- La UI muestra **Usar configuración global de recordatorios** activado por defecto.
- Los valores globales vienen de **Alertas y correos → Recordatorios a actualizadores**.
- Si se usa global, la programación no guarda `reminders` propio y el backend aplica los defaults globales al enviar.
- Si el usuario desmarca la opción global, puede capturar **Días previos separados por coma** y **Hora de envío**.
- Ejemplo: `2,1,0` envía recordatorios 2 días antes, 1 día antes y el mismo día.
- `0` significa el mismo día de la actualización.
- El backend valida que los días sean números no negativos y que la hora tenga formato `HH:mm`.

## Reglas conservadas

- No se agregó filtro de ambiente al modo manual.
- Los modos siguen siendo solo **Selección manual** y **Por licenciamiento**.
- La deduplicación sigue siendo por `entityType + entityId + scheduledDate`.
- Las excepciones no saltan la deduplicación.
- No se usan `alert`, `confirm` ni `prompt` del navegador para este flujo.

## Pruebas

- Backend: preview con IDs, excepciones de dominio/base, expansión por licenciamiento, frecuencia única, desactivación lógica de programación única y preservación de tareas abiertas del día.
- Frontend: frecuencia única por defecto, campos visibles/ocultos, preview con excepciones, resumen actualizado, preview desactualizado y guardado con excepciones.
