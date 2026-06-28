# Checklist 02 - Procesos y reglas de negocio

Fecha de revision: 2026-06-27  
Fuentes contrastadas: codigo backend/frontend, `BUSINESS_RULES_TEST_MATRIX.md`, `HANDOFF.md`, README, cambios V17/V18 y suites automatizadas.

## Veredicto

**Estado: PARCIALMENTE DOCUMENTADO, con contradicciones que pueden producir tareas/correos incorrectos.**

La matriz existente es una buena base, pero quedo desactualizada respecto a cambios de junio y en algunos puntos documenta como deseado un comportamiento que contradice la vista operativa. Los items siguientes son decisiones o correcciones necesarias; no deben resolverse por intuicion del desarrollador.

## Decisiones bloqueantes

- [ ] **BUS-001 - P0 - Unificar elegibilidad de tareas para UI y todos los correos.**
  - Contradiccion actual:
    - `taskVisibility.ts` oculta tareas abiertas si la actualizacion programada raiz no existe o esta inactiva.
    - `sendOverdueAlerts.ts` ya aplica esa regla.
    - `BR-MAIL-05` declara que una tarea pendiente puede enviar recordatorio aunque la programacion este inactiva.
    - `sendScheduledReminders.ts` y `sendBlockedReminders.ts` no aplican `taskVisibility`.
  - Riesgo: correos fantasma, o tareas reales invisibles pero notificadas.
  - Decision recomendada: una tarea abierta solo es accionable/notificable si al menos una fuente activa la respalda. Las completadas pueden permanecer como historia mientras exista tombstone de la programacion.
  - Cierre: helper unico `isTaskOperationallyEligible` usado por UI/API, reminders, overdue y blocked; actualizar matriz y tests de integracion.

- [ ] **BUS-002 - P0 - Definir semantica de tareas con multiples fuentes.**
  - Evidencia: dedupe permite una tarea por entidad/dia y agrega `sources[]`, pero `syncTaskAssignmentFromSchedule` reemplaza `scheduleId` y `rootScheduleId` con la ultima programacion; `taskVisibility` consulta solo el root actual.
  - Riesgo: si la primera/ultima fuente se desactiva, una tarea puede ocultarse aunque otra fuente siga activa; responsabilidades tambien pueden cambiar segun orden de generacion.
  - Decision requerida: fuente primaria estable o elegibilidad por cualquier source activa; regla de precedencia de responsables, recordatorios, nombre y notas.
  - Cierre: modelo y pruebas normal+manual, normal+licencia, desactivacion de una fuente y conservacion de otra.

- [ ] **BUS-003 - P0 - Impedir bases asociadas a cliente y dominio de clientes diferentes.**
  - Evidencia: `databasesCreate` carga el cliente y el dominio, pero no valida `domain.clientId === client.id`.
  - Riesgo: arboles/reportes/licencias/cascadas incorrectos y futura violacion FK SQL.
  - Cierre: validacion backend, reparacion de datos existentes y constraint compuesto SQL.

- [ ] **BUS-004 - P1 - Elegir soft delete para actualizaciones programadas.**
  - Estado actual: maestros usan soft delete, pero schedules se eliminan fisicamente en varios flujos/cascadas.
  - Contradiccion: tareas y auditoria conservan `scheduleId/rootScheduleId`; la visibilidad exige que la programacion exista.
  - Recomendacion: tombstone/soft delete de schedule con `status`, `deletedAt`, `deletedBy`; no perder nombre, alcance ni frecuencia historica.

- [ ] **BUS-005 - P1 - Definir regla exacta de tarea vencida tras desactivar/eliminar programacion.**
  - Documentos antiguos: vencida abierta nunca desaparece hasta resolverse.
  - Regla reciente: si no existe actualizacion programada, no debe mostrarse ni alertar.
  - Cierre: aprobar una de estas opciones y documentarla: cancelar como obsoleta; mantener visible como pendiente historica; o mover a bandeja de excepciones. No simplemente ocultarla.

## Tareas y estados

- [x] **BUS-006 - Acciones UI principales por estado estan documentadas.**
  - Pendiente/en progreso: Completar, Bloquear. Bloqueada: Completar/Resolver. Completada: Reabrir.

- [ ] **BUS-007 - Retirar o definir endpoint `tasks/{id}/start`.**
  - Estado: UI dice que no existe accion Iniciar, pero endpoint y auditoria `task_started` siguen activos.
  - Cierre: eliminar/deprecar endpoint o documentar consumidor y permisos; prueba de que UI/API coinciden.

- [ ] **BUS-008 - Definir transiciones permitidas en una maquina de estados unica.**
  - Estado: transiciones se validan de forma dispersa; `failed`, `reopened` y `cancelled` no tienen tabla completa.
  - Cierre: matriz `estado origen -> acciones -> estado destino`, permisos, timestamps y auditoria; backend rechaza toda transicion no listada.

- [ ] **BUS-009 - Resolver legado `reopened`.**
  - Estado: tipo admite `reopened`, pero reabrir cambia `completed -> pending`.
  - Cierre: decidir si `reopened` se migra a `pending` con historial o sigue siendo estado valido.

- [ ] **BUS-010 - Definir `completedWithProblems`.**
  - Estado: tarea puede ser `completed` y a la vez mostrar salud con problemas.
  - Preguntas: ¿cuenta como cerrada para una programacion unica?, ¿genera seguimiento?, ¿afecta SLA/reporte?
  - Cierre: regla y pruebas en cierre de once, dashboard, correos y resumen de schedule.

- [ ] **BUS-011 - Cancelacion manual y reapertura.**
  - Estado: endpoint cancel existe, pero UI no lo expone y no esta claro quien puede cancelar ni si se puede revertir.
  - Cierre: permisos, motivos obligatorios, historial y regla de dedupe/regeneracion.

- [ ] **BUS-012 - SLA y severidad.**
  - Estado: `failed`, `blocked`, `completedWithProblems` existen, pero no hay severidad, prioridad, fecha limite ni escalamiento formal.
  - Cierre: decidir si el negocio necesita SLA antes de ampliar usuarios/modulos.

## Actualizaciones programadas

- [x] **BUS-013 - Modos vigentes definidos:** manual y por licenciamiento; no “Todos los clientes activos”.

- [x] **BUS-014 - Alcance manual/licenciamiento y excepciones estan documentados.**

- [ ] **BUS-015 - Estado administrativo de recurrentes.**
  - La salud se deriva de tareas, pero la tabla aun muestra `active/inactive` sin una definicion completa de pausada, cancelada, finalizada y eliminada.
  - Cierre: separar `lifecycle_status` de `health_status`; definir fecha fin alcanzada y reactivacion.

- [ ] **BUS-016 - Cierre de programacion unica.**
  - Documentado: solo completar cuando llega fecha y todas sus tareas estan terminales.
  - Falta definir: cero objetivos, objetivos eliminados, una tarea compartida por varias fuentes, `completedWithProblems`, cancelacion parcial y reactivacion posterior.

- [ ] **BUS-017 - Reprogramacion de unica.**
  - Existe cancelacion `obsolete` de tareas abiertas anteriores.
  - Falta definir efectos sobre recordatorios ya enviados, alertas, notas, tareas compartidas por otra fuente y auditoria de fecha anterior/nueva.

- [ ] **BUS-018 - Precedencia de responsables en dedupe.**
  - Si dos schedules crean la misma entidad/dia con responsables distintos, hoy la ultima sincronizacion puede ganar.
  - Cierre: prioridad explicita (usuario especifico > rol, manual > normal, o lista combinada) y prueba determinista independiente del orden.

- [ ] **BUS-019 - Precedencia de recordatorios en dedupe.**
  - Una tarea compartida puede tener schedules con dias/horas/destinatarios diferentes.
  - Cierre: union, prioridad o recordatorios por source; no usar solo `scheduleId` mutable.

- [ ] **BUS-020 - Integridad de scope al editar maestros.**
  - Falta regla completa cuando cliente/dominio/base se desactiva, mueve o elimina despues de crear scope manual/licenciamiento.
  - Cierre: revalidacion, cancelacion de tareas futuras y resumen de impacto antes de guardar.

## Recordatorios, alertas y correo

- [ ] **BUS-021 - Idempotencia por destinatario.**
  - `remindersSent` se evalua por tarea/dia, no por destinatario. Si un destinatario recibe y otro falla, el siguiente ciclo puede no reintentar al fallido.
  - Overdue marca la tarea si algun grupo tuvo exito, con riesgo equivalente.
  - Cierre: idempotency key por `task + notificationType + period + recipient` en `emailNotifications`/SQL.

- [ ] **BUS-022 - Concurrencia de timers.**
  - Patron `wasSent -> send -> markSent` no es atomico; dos instancias pueden duplicar correos.
  - Cierre: insercion/claim atomico antes de enviar, estados `pending/sent/failed`, retry seguro y unique constraint.

- [ ] **BUS-023 - Zona horaria realmente aplicada.**
  - UI/modelos permiten timezone, pero varios jobs calculan con UTC-5 fijo y `blockedReminderTimezone`/timezone administrativo no gobiernan todos los calculos.
  - Cierre: o restringir oficialmente todo a `America/Bogota`, o usar biblioteca timezone y tests por configuracion.

- [ ] **BUS-024 - “Ultimo dia habil” no contempla festivos.**
  - Implementacion solo distingue lunes-viernes vs fin de semana.
  - Cierre: renombrar “ultimo dia laboral segun fin de semana” o integrar calendario de festivos aprobado.

- [ ] **BUS-025 - Resultado de envios parciales.**
  - Definir si `sendEmail` a varios destinatarios es todo-o-nada y como reintentar rechazos parciales del proveedor.

- [ ] **BUS-026 - Notificaciones de exito/falla/bloqueo.**
  - Documentar exactamente eventos, destinatarios, dedupe, contenido sensible y si una completada con problemas dispara exito, falla o ambos.

- [ ] **BUS-027 - Correo de credenciales temporales.**
  - Cambio V18 no esta integrado en la matriz principal.
  - Cierre: regla sobre expiracion, `mustChangePassword`, confirmacion de entrega, reenvio invalida contraseña anterior y auditoria.

## Clientes, dominios, bases y licencias

- [x] **BUS-028 - ID externo de cliente opcional y unico si existe.**

- [ ] **BUS-029 - Cuando `externalId` sera obligatorio y quien lo asigna.**
  - Cierre: formato, longitud, normalizacion, inmutabilidad, migracion de clientes existentes.

- [ ] **BUS-030 - Ambiente de base respecto al dominio.**
  - Estado: ambos tienen ambiente independiente; no se define si pueden diferir.
  - Cierre: permitir con caso de uso documentado o exigir igualdad/mostrar advertencia.

- [ ] **BUS-031 - Unicidad de base por conexion.**
  - Regla actual ignora password y compara servidor+catalogo+usuario.
  - Cierre: documentar explicitamente; SQL debe usar la misma huella.

- [ ] **BUS-032 - Estado de licencias inactivas ya asignadas.**
  - Falta decidir si bloquean nueva programacion, si aparecen en reportes y si se pueden retirar retroactivamente.

- [ ] **BUS-033 - `licenseModuleNames` snapshot.**
  - Fuente primaria son IDs; el snapshot puede quedar obsoleto al renombrar modulo.
  - Cierre: eliminar como fuente operativa o definir sincronizacion/historia.

- [ ] **BUS-034 - Asignaciones avanzadas ocultas.**
  - Backend conserva dominio/base y reporte historicamente puede considerarlas.
  - Cierre: confirmar que toda logica actual las ignora o migrarlas como datos inactivos sin efecto.

- [ ] **BUS-035 - Cascade delete transaccional.**
  - Hoy mezcla soft delete de maestros con hard delete de schedules, cancelacion de tareas y `catch` que continua.
  - Cierre: operacion atomica o saga compensable; resultado detallado; retry idempotente; nunca estado medio silencioso.

- [ ] **BUS-036 - Ciclo de vida de secretos al eliminar base.**
  - Soft delete conserva secreto; no hay politica de retencion/purga/restauracion.
  - Cierre: periodo de retencion, recuperacion, purge autorizado y auditoria.

## Roles y alcance de datos

- [ ] **BUS-037 - Definir visibilidad, no solo capacidad de mutar.**
  - Actualmente muchos GET permiten a cualquier usuario activo leer todo; la matriz solo define gestion.
  - Cierre: tabla por rol para clientes, dominios, bases, tareas, conexiones, auditoria, licencias y reportes.

- [ ] **BUS-038 - Viewer.**
  - Definir si es global, por cliente o por modulo; que datos tecnicos puede ver.

- [ ] **BUS-039 - Client manager.**
  - Hoy parece global. Para escalar usuarios se necesita scope por cliente/portfolio y delegacion.

- [ ] **BUS-040 - Actualizadores.**
  - Definir si pueden ver maestros completos o solo tareas/entidades asignadas; acceso a credenciales debe seguir la misma regla.

## Reportes, auditoria y operacion

- [x] **BUS-041 - Reporte maestro excluye secretos y solo incluye activos/licencias activas.**

- [ ] **BUS-042 - Snapshot historico del reporte.**
  - Solo se audita envio; no se define si debe conservarse contenido/hash para demostrar que se envio.

- [ ] **BUS-043 - Auditoria append-only y retencion.**
  - Regla “no borrar” esta documentada, pero no hay test de cascada ni control contra update/delete directo.

- [ ] **BUS-044 - Correlation ID y trazabilidad de procesos.**
  - Generacion, correos y cascadas no comparten un ID de ejecucion consistente.

- [ ] **BUS-045 - Reconciliacion y bandeja de anomalías.**
  - Hoy se ocultan/cancelan tareas obsoletas, pero no hay vista para datos huerfanos, scopes invalidos o correos fallidos.

- [ ] **BUS-046 - Paginacion real.**
  - Clientes, dominios, bases, usuarios y licencias suelen leer todos los documentos y paginar en memoria.
  - Cierre: paginacion server-side estable, orden definido y filtros indexables; SQL debe mantener contrato.

- [ ] **BUS-047 - Control de concurrencia.**
  - No hay ETag/rowversion; dos administradores pueden sobrescribir cambios.
  - Cierre: optimistic concurrency y conflicto 409 con UX de recarga.

## Brechas de documentacion y pruebas

- [ ] **BUS-048 - Actualizar `BUSINESS_RULES_TEST_MATRIX.md` con V18 y cambios posteriores.**
  - Faltan reenvio de credenciales, busqueda/filtro del detalle de tareas y filtro de alertas vencidas por schedule activo.

- [ ] **BUS-049 - Corregir `BR-MAIL-05`.**
  - No puede permanecer “Cubierta” hasta decidir BUS-001.

- [ ] **BUS-050 - Pruebas HTTP de cascadas y auditoria.**
  - La matriz reconoce que no existe prueba especifica de “audit logs nunca se borran”.

- [ ] **BUS-051 - Pruebas de timers contra schedules inactivos/huerfanos.**
  - Overdue ya tiene regresion; faltan scheduled reminders y blocked reminders.

- [ ] **BUS-052 - Pruebas de multiples fuentes.**
  - Deben cubrir visibilidad, cancelacion, destinatarios, responsables y cierre de once.

- [ ] **BUS-053 - Pruebas de integridad cliente-dominio-base.**
  - Incluir creacion/edicion cruzada y reparacion de datos preexistentes.

## Criterio de salida del checkpoint

Antes de cambiar a SQL, BUS-001 a BUS-005 deben tener decision aprobada, la matriz de transiciones/visibilidad por rol debe estar cerrada y los timers deben compartir una unica regla de elegibilidad e idempotencia.
