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
