# Cambios V13 — Operación, UX y validaciones

## Resumen

Esta ronda consolidó mejoras operativas incrementales sin cambiar la arquitectura de la aplicación.

## Maestros

- Se agregó paginación de 10 registros por página en clientes, dominios, bases de datos, licenciamiento, programaciones especiales, auditoría y usuarios.
- Se agregó búsqueda general en dominios, bases de datos, licenciamiento, programaciones especiales, clientes y auditoría.
- Al cambiar búsqueda o filtros, la vista vuelve a página 1.
- Auditoría ya no renderiza todos los registros de golpe desde el frontend.

## Validaciones

- El backend bloquea clientes duplicados por nombre normalizado.
- El backend bloquea dominios duplicados por URL normalizada.
- El backend bloquea bases duplicadas por cadena de conexión normalizada.
- Se aplica trim en campos principales de clientes, dominios, bases, usuarios, SMTP, alertas, licencias y programaciones.
- Las URLs de dominio deben iniciar con `https://`.
- Las listas de correos separados por punto y coma permiten `;`, ignoran valores vacíos finales y reportan el correo inválido en español.

## Clientes y dominios

- El modal de cliente muestra chips en **Licencias seleccionadas**.
- Desde clientes se puede usar **Agregar dominio** con el cliente preseleccionado.
- El modal **Ver dominios y bases** permite editar dominio, agregar base y editar base.
- Dominios permite **Agregar base de datos** con cliente/dominio preseleccionados.
- La tabla de dominios ya no muestra versión web, agrega **Recurrente** y **Próxima actualización**.
- Un dominio nuevo no activa frecuencia automática por defecto.
- El modal **Bases asociadas al dominio** permite copiar contraseña de forma explícita y segura, y editar la base.

## Licenciamiento

- La vista queda simplificada como maestro de módulos.
- La pestaña de asignaciones avanzadas permanece oculta por defecto mediante `VITE_ENABLE_ADVANCED_LICENSE_ASSIGNMENTS`.
- El código del módulo es opcional; si se omite, el backend genera uno a partir del nombre.
- Se bloquea nombre duplicado de módulo por nombre normalizado.
- Se mantiene paginación y búsqueda por nombre, código, descripción y estado.

## Programaciones especiales

- Solo existen dos modos de alcance: **Selección manual** y **Por licenciamiento**.
- No se implementa el modo cancelado **Todos los clientes activos**.
- El modo por licenciamiento muestra licencias activas con chips en **Licencias seleccionadas**.
- El alcance por licenciamiento siempre resuelve solo clientes, dominios, bases y módulos activos.
- El preview muestra conteos y árbol de clientes/dominios/bases.
- El criterio se guarda como `licensingScope`, no solo como snapshot.
- V14 agrega excepciones por dominio/base dentro del preview y frecuencia **Única** por defecto para nuevas programaciones especiales.

## Tareas

- Las tareas bloqueadas muestran **Completar** y **Resolver bloqueo**, pero no **Reabrir**.
- Las tareas completadas muestran **Reabrir**, pero no **Completar**.
- Completar una bloqueada usa modal nativo con **Comentario de cierre** opcional.
- Resolver bloqueo usa modal nativo con comentario opcional y nuevo estado obligatorio.
- Reabrir completada usa modal nativo con motivo opcional.
- No se usan `alert`, `confirm` ni `prompt` del navegador para flujos de negocio.

## Ventana operativa

La vista **Tareas** muestra:

- Vencidas abiertas o bloqueadas sin límite hacia atrás.
- Tareas de hoy.
- Próximas hasta 4 días.
- Completadas recientes de los últimos 4 días.

No muestra completadas antiguas ni próximas más allá de 4 días.

## Deduplicación

- Se mantiene la regla: máximo una tarea por `entityType + entityId + scheduledDate`.
- Aplica a frecuencia normal, programación especial manual y programación por licenciamiento.
- Si una segunda programación coincide, no se crea duplicado y se agrega fuente en `sources` cuando aplica.

## Pruebas

Se agregaron o actualizaron pruebas backend y frontend para paginación, búsqueda, duplicados, trim/validaciones, licencias en clientes, acciones rápidas, dominios, bases asociadas, licenciamiento, programaciones por licenciamiento, acciones de tareas, ventana operativa y deduplicación.
