# Plan de QA previo a la activación de la programación del catálogo

**Estado:** diseñado; no constituye un resultado de ejecución. La certificación
debe hacerse sobre el candidato exacto, con un API no productivo y SQL Server
2019 de QA, y antes de aprobar el corte. Las pruebas deben usar datos
sintéticos autorizados y terminar con verificación de cero residuos.

| Caso | Resultado esperado |
| --- | --- |
| Manual → temporizador y temporizador → manual: mismo vínculo lógico, destino físico, operación y responsables | Una tarea y un evento de creación. Los dos orígenes quedan registrados una vez. Dos reintentos simultáneos no duplican tarea, intención ni orígenes. Invertir el orden de los identificadores no cambia el representante. |
| Tarea ya completada | Se puede comprobar un origen compatible antes del corte, sin reabrir la tarea, alterar el estado, cambiar responsables ni emitir otro evento de creación. |
| Vínculos distintos (incluido otro cliente o ambiente) con el mismo destino físico | Si ambos son verificables al crear, deduplicar y conservar ambas relaciones. Si el segundo llega tarde, acreditar su procedencia con un recibo, nunca con un vínculo de tarea ni un origen que amplíe la selección operativa, reemplace al representante o conceda acceso a su conexión. Probar ambos órdenes, incluso un vínculo inicialmente retenido, y agregar un destino independiente para observar el impacto del fallo. Las pruebas del recibo aislado no sustituyen ese ensayo por los puntos de entrada reales. |
| Destino compartido con otra operación, otro rol o distinto conjunto exacto de usuarios | No reutilizar ni cambiar el trabajo existente ni anotar un origen incompatible. Verificar el conflicto y que no queden escrituras parciales. |
| Origen principal desactivado, secundario compatible activo | La tarea puede seguir operativa por el origen activo según la regla existente; no cambia la asignación, el cliente mostrado ni el vínculo autorizado para revelar credenciales. Si toda evidencia falla, no debe aparecer operativa. La historia se conserva. |
| Intención manual y seguridad | Sin sesión o sin `updates.schedules.generate_tasks` no se escribe. Actor, ambiente y corte los deriva el servidor. Rechazar versión antigua, aprobación retirada, fecha inválida/pasada y llegada al corte. El reintento no altera el primer actor. |
| Vigencia y atomicidad | Probar igualdad con el corte, expiración antes del commit, cambio de inventario, de versión, de asignación y de aprobación. Un fallo no debe confirmar escrituras provisionales. |
| Despacho y aislamiento | Cubrir temporizador, `tasks/generate`, `tasks/refresh` y refresco posterior a un cambio de programación. En modo catálogo, una lectura incompleta, retención, corte o error nunca debe ejecutar el generador heredado. Probar convivencia con tareas heredadas sin adoptarlas silenciosamente. |
| Respuesta de procedencia | Distinguir una tarea creada o utilizable de un recibo contable. Con el representante original oculto o al haberse completado, un recibo no debe producir un mensaje de tarea ejecutable ni autorizar abrir, revelar o copiar conexiones del vínculo tardío. |
| Paridad de calendario y finalización | Comprobar la visibilidad de las próximas tareas y la promesa de la interfaz de desactivar una programación única tras completarse. El generador heredado usa una ventana de siete días en ambas direcciones y desactiva las únicas elegibles; el modo catálogo no debe generar trabajo vencido, ni perder la vista de próximas tareas ni declarar completadas programaciones con trabajo retenido. Antes de activar, confirmar y probar cuándo se habilitan las acciones de conexión y mutación de una tarea futura; que sea visible no resuelve esa decisión. |

Para aprobar, ejecutar los dos órdenes por los puntos de entrada reales,
probar con y sin permiso las acciones de abrir/revelar/copiar la conexión, y
verificar conteos de tareas, vínculos, orígenes, intenciones y eventos antes y
después. Hacer un ensayo con dos sesiones SQL para observar las carreras de
la misma fecha. Conservar evidencias sin datos de cliente ni credenciales.
Una prueba unitaria, la compilación o una migración exitosa no sustituyen
estas comprobaciones de comportamiento.

## Ampliación del plan antes de desarrollar paridad

- Probar hoy a hoy +7 en Bogotá, incluidos medianoche y cambio de mes, con
  una transacción y resultado por fecha. Nunca generar días pasados. Una
  fecha no verificable no escribe ni llama al motor anterior y no invalida
  resultados ya confirmados para otras fechas. No generar intenciones manuales
  nuevas en una carga de calendario ni ampliar la vista actual de +4 de Tareas
  sin una decisión de producto.
- El selector actual de conexión de catálogo no verifica la fecha de inicio
  de una tarea futura. Certificar por separado quién la ve y desde qué instante
  puede abrir/revelar/copiar conexiones o mutarla. Incluir un cambio de
  evidencia de no verificada a verificada antes del corte propio de esa fecha.
- No reutilizar el cierre heredado de programaciones únicas: considera
  terminales las canceladas y no compara versión y fecha en la escritura.
  Exigir una prueba no vacía de los pares exactos programación/vínculo →
  ejecución que se esperaba completar, ligada a ambiente, fecha y versión.
  Si el cierre puede ocurrir después del corte, conservar esa prueba antes del
  corte; el barrido actual no evalúa ejecuciones completadas.
- Cerrar y auditar en una transacción que compruebe la versión de la
  programación y todos los pares previstos. Cero tareas, un subconjunto,
  evidencia retenida o no comprobada, cancelaciones y recibos sin ejecución
  exacta comprobada no cierran nada. Probar que dos cierres concurrentes
  producen una sola actualización y auditoría, y que un fallo de auditoría
  o una edición concurrente no dejan efectos parciales.

## Cierre durable de programaciones únicas (050)

Contrato previo a la implementación y a su ensayo:

- La observación conserva las fuentes exactas que justificaron la población.
  El historial de cabeceras distingue el último intento anterior al corte de
  la última revisión exitosa. Un fallo previo al corte no se omite; un refresco
  posterior no borra la prueba histórica. Una observación antigua sin testigos
  no obtiene evidencia retroactiva al instalar la migración.
- Cubrir cierre manual y por licenciamiento, con `any`, `all`, exclusiones,
  correspondencias de módulos y ambiente/dominio exactos. Rechazar códigos
  desconocidos, ambigüedad y aprobaciones posteriores al corte.
- Conservar versión, operación, población, pares completos y éxito explícito
  más reciente. Cancelación, problemas o reapertura pendiente no son éxito.
  Después de un cierre, reabrir una tarea conserva la programación inactiva,
  como en el comportamiento actual; no regenera trabajo automáticamente.
- El trabajador recorre candidatos en lotes acotados con un cursor por
  ambiente. Los candidatos bloqueados no deben monopolizar cada ejecución.
  Probar vuelta al inicio, recuperación tras interrupción, dos trabajadores,
  idempotencia y ausencia de llamada al motor heredado.

El ensayo de cierres pasados puede usar un **fixture histórico de propietario**
en `PortalSAGWeb-TEST`, dentro de una única transacción revertida. Durante la
preparación exclusivamente sintética se permite suspender sólo los triggers
`INSTEAD OF INSERT` que fijan la fecha de registro o aprobación; deben estar
habilitados inicialmente y volver a habilitarse **antes** de ejecutar el SQL de
cierre. Los triggers de inmutabilidad de actualización/borrado permanecen
habilitados. Al revertir se comprueban cero residuos y todos los triggers
habilitados. Esto prueba el cierre sobre un estado histórico construido; no
demuestra que el publicador normal pueda registrar datos retroactivamente ni
sustituye un ensayo de concurrencia real. No se permite esta excepción en
producción ni en una fuente externa.

## Siguiente integración: actualización de fuentes y corte oportuno

El código actual sólo conecta la publicación real al POST de un super_admin.
`runCatalogCustomerRefresh` no está conectado al runtime y recibe un único
publicador, aunque el publicador SQL real pertenece a una sola fuente: no se
puede reutilizar el mismo publicador para un lote de fuentes distintas. Las
aperturas, búsquedas y el botón de actualización consultan las revisiones
existentes. El temporizador diario tampoco renueva sus 30 minutos de frescura.

Contrato y matriz previos a implementar ese ciclo:

- Un POST autorizado solicita una actualización de las fuentes que el actor
  puede consultar; las aperturas y búsquedas pueden solicitar trabajo
  coalescido. Los GET siguen siendo de lectura. Una selección vacía no se
  convierte en todas y el navegador no envía destinos, SQL ni secretos. El
  estado y los resultados vuelven a comprobar el acceso al consultarlos.
- Un trabajo por fuente usa cola durable, reserva, intento, plazo y reintento
  acotados. Probar superposición, interrupción y recuperación; fuentes distintas
  siguen independientes con concurrencia limitada. Un fallo no equivale a
  inactividad ni a borrado, y no debe reemplazar el resultado de un intento
  posterior.
- Separar el publicador de servicio del operador humano: no usar el ID de un
  administrador para simular que realizó la actualización. En cada transacción
  de reserva, publicación y fallo, comprobar el trabajo exacto y su concesión,
  las versiones certificadas de fuente/perfil y la inscripción de la clave.
  Mantener sin cambios la autorización del publicador manual.
- Una fuente retirada, borrador o con perfil distinto no se abre ni se reactiva.
  Medir límites de filas, conexiones, reintentos y tiempo. La auditoría usa
  identidad de servicio y metadatos mínimos, sin credenciales ni URLs.
- Actualizar las fuentes oportunamente y registrar la observación del día antes
  del corte, sin repetir la ventana completa de ocho días en cada tick ni crear
  intenciones manuales. Probar medianoche de Bogotá, vencimiento antes del
  commit y funcionamiento con interruptores desactivados, sin ampliar la
  frescura artificialmente.
- El barrido de tareas ya se adaptó al historial 050 para el corte pasado,
  conservando la cabecera actual antes de ese instante. El ensayo SQL pasó
  16 casos, incluidos refrescos posteriores que conservan tareas y fallos
  anteriores que impiden acreditar presencia. Al conectar el trabajador
  automático se debe mantener y volver a probar ese comportamiento, sin
  fabricar historia anterior a la instalación.
