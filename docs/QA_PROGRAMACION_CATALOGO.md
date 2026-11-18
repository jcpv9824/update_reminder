# Plan de QA previo a la activación de la programación del catálogo

**Estado:** diseñado; no constituye un resultado de ejecución. La certificación
debe hacerse sobre el candidato exacto, con un API no productivo y SQL Server
2019 de QA, y antes de aprobar el corte. Las pruebas deben usar datos
sintéticos autorizados y terminar con verificación de cero residuos.

| Caso | Resultado esperado |
| --- | --- |
| Manual → temporizador y temporizador → manual: mismo vínculo lógico, destino físico, operación y responsables | Una tarea y un evento de creación. Los dos orígenes quedan registrados una vez. Dos reintentos simultáneos no duplican tarea, intención ni orígenes. Invertir el orden de los identificadores no cambia el representante. |
| Tarea ya completada | Se puede comprobar un origen compatible antes del corte, sin reabrir la tarea, alterar el estado, cambiar responsables ni emitir otro evento de creación. |
| Vínculos distintos (incluido otro cliente o ambiente) con el mismo destino físico | Si ambos son verificables al crear, deduplicar y conservar ambas relaciones. Si el segundo llega tarde, acreditar su procedencia sin ampliar la selección operativa, reemplazar al representante ni conceder acceso a su conexión; hasta que exista esa capacidad, informar la retención y no dar el caso por aprobado. Probar ambos órdenes, incluso un vínculo inicialmente retenido, y agregar un destino independiente para observar el impacto del fallo. |
| Destino compartido con otra operación, otro rol o distinto conjunto exacto de usuarios | No reutilizar ni cambiar el trabajo existente ni anotar un origen incompatible. Verificar el conflicto y que no queden escrituras parciales. |
| Origen principal desactivado, secundario compatible activo | La tarea puede seguir operativa por el origen activo según la regla existente; no cambia la asignación, el cliente mostrado ni el vínculo autorizado para revelar credenciales. Si toda evidencia falla, no debe aparecer operativa. La historia se conserva. |
| Intención manual y seguridad | Sin sesión o sin `updates.schedules.generate_tasks` no se escribe. Actor, ambiente y corte los deriva el servidor. Rechazar versión antigua, aprobación retirada, fecha inválida/pasada y llegada al corte. El reintento no altera el primer actor. |
| Vigencia y atomicidad | Probar igualdad con el corte, expiración antes del commit, cambio de inventario, de versión, de asignación y de aprobación. Un fallo no debe confirmar escrituras provisionales. |
| Despacho y aislamiento | Cubrir temporizador, `tasks/generate`, `tasks/refresh` y refresco posterior a un cambio de programación. En modo catálogo, una lectura incompleta, retención, corte o error nunca debe ejecutar el generador heredado. Probar convivencia con tareas heredadas sin adoptarlas silenciosamente. |

Para aprobar, ejecutar los dos órdenes por los puntos de entrada reales,
probar con y sin permiso las acciones de abrir/revelar/copiar la conexión, y
verificar conteos de tareas, vínculos, orígenes, intenciones y eventos antes y
después. Hacer un ensayo con dos sesiones SQL para observar las carreras de
la misma fecha. Conservar evidencias sin datos de cliente ni credenciales.
Una prueba unitaria, la compilación o una migración exitosa no sustituyen
estas comprobaciones de comportamiento.
