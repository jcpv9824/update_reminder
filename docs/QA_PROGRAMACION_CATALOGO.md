# Plan de QA previo a la activación de la programación del catálogo

**Estado:** diseñado; no constituye un resultado de ejecución. La certificación
debe hacerse sobre el candidato exacto, con un API no productivo y SQL Server
2019 de QA, y antes de aprobar el corte. Las pruebas deben usar datos
sintéticos autorizados y terminar con verificación de cero residuos.

## Evidencia de la cola 051 (2026-11-18)

Después del ensayo con reversión, se aplicó permanentemente 051 **sólo en
`PortalSAGWeb-TEST`** desde una exportación de `d674cd2`. Se comprobó el hash
`f2428de9520b288f09d91130f2da4a86dfbe779941e2888c3f3cbf2adea5b2f3` sobre
el archivo exportado. El ejecutor dio `PASS 051` y verificó 017–030 y
031–051. La lectura posterior encontró un registro exitoso de 051, cero
trabajos, cero intentos y cero fuentes QA activas. No se habilitó el
temporizador ni se desplegó el API. El ensayo que exige 051 ausente no debe
repetirse en esta base ya migrada.

`Test-CatalogRefreshQueueQa.ps1` usa sólo una sesión efímera de control completo
con destino exacto `PortalSAGWeb-TEST`, SQL Server 2019 y compatibilidad 150.
Requiere 050 instalada, 051 ausente, ninguna fuente QA activa y ninguna clave
QA inscrita. No lee claves reales ni abre conexiones externas. Crea metadatos
sintéticos dentro de una transacción que revierte; no suspende triggers.

Resultados observados: instalación y reejecución idempotente **1/1, 58 ms**;
ensayo completo **30/30, 855 ms**, más dos verificaciones de los conjuntos de
resultado reales de estado (ERP autorizado con dependencia SAG oculta y acceso
revocado sin metadatos). La lectura independiente posterior confirmó 051
ausente, 050 presente, cero usuarios/perfiles sintéticos y cero claves QA.

Casos: selección vacía, selección falsificada sin escritura parcial, todos los
ERP autorizados, coalescencia, límite de claim sin repetición activa, prueba
sintética exacta de clave y siete negativas de concesión/versiones/propietario,
reserva idempotente, perfil cambiado, publicación/cabecera/evento/finalización
con reversión conjunta, finalización repetida, intento posterior exitoso,
fallido o sin cabecera, vencimiento y recuperación, retiro por cambio de
vínculo, cinco intentos con espera y fallo terminal, aislamiento de otra fuente
y enfriamiento del temporizador. Los doce lotes compilados y la 051 pasaron
TSql150; el hash LF de la 051 coincide con el manifiesto.

Dos defectos del fixture se corrigieron antes de obtener el resultado: DECLARE
de variables TABLE separadas y cero scopes en la revisión ERP (los scopes de
cobertura son exclusivos de SAG Admin). No se relajaron restricciones de la
aplicación ni se conservaron datos sintéticos para hacer pasar el ensayo.

Límites: es una sesión SQL y ejecución directa de los lotes compilados. No
certifica una carrera real entre dos sesiones, la unidad transaccional completa
del servicio JavaScript con su escritor de auditoría, conexiones remotas ni el
flujo navegador→API→fuentes. Esos casos y la certificación de las cuentas reales
siguen pendientes antes de activar o publicar en producción. Los cuatro
interruptores de lectura/automatización API/frontend no se habilitaron por este
ensayo. El resultado no es aprobación global del refactor.

```powershell
pwsh -NoProfile -File migration/tools/Test-CatalogRefreshQueueQa.ps1 -SessionDirectory <sesion-qa> -ProbeStage bootstrap
pwsh -NoProfile -File migration/tools/Test-CatalogRefreshQueueQa.ps1 -SessionDirectory <sesion-qa> -ProbeStage all
```

## Evidencia de observaciones SAG 052 (2026-11-18)

`Test-CatalogSagCompanyEvidenceQa.ps1` pasó **34/34 casos, 2.411 ms**,
con transacciones revertidas y cero residuos. Probó el conjunto vacío v2,
la ausencia de evidencia v1, la conservación de padres no resueltos, los
límites y conteos exactos, la inmutabilidad y la publicación con evento 050.
No prueba carreras entre sesiones ni la escritura desde el publicador del API.

Luego se exportó `e11ab72` y se comprobó el SHA-256 del archivo 052:
`fc2c24becab9cfa7236ef8a8975c2610b9d9264d6ada849f585f6b44b1ec8066`.
El ejecutor aplicó 052 y verificó 017–030 y 031–052 en `PortalSAGWeb-TEST`.
Una lectura posterior confirmó una aplicación exitosa, cero filas de evidencia
Company y cero fuentes activas. No se aplicó 052 a producción ni se activó v2.
El ensayo que exige ausencia de 052 requiere otra base QA o una restauración
controlada; no debe ejecutarse en esta base ya migrada.

La revisión del lector congelado `0922e25` pasó 62 pruebas independientes y
la suite total pasó **1.535/1.535 en 161 archivos (199,91 s)** con
`npm test -- --maxWorkers=2`. También pasaron `check:no-cosmos-runtime` y
ambas auditorías de dependencias en el mismo código. Estas pruebas no
incluyen las operaciones SQL del publicador v2 de la 053.

Para 053, las operaciones públicas serán dueñas de su transacción de
publicación; no existe un modo especial de confirmación para pruebas. Los
ensayos con rollback en QA pueden verificar transiciones internas y negar
la ejecución al rol general. Una prueba positiva de `COMMIT` con el principal
dedicado requiere una base desechable autorizada en SQL Server 2019. La
instancia instalada localmente usa la versión 17; no acredita esa prueba.

## Verificación de preparación del reporte (2026-11-18)

El conjunto enfocado de conteo, perfiles, permisos de destinatarios y outbox
pasó **61/61, 9 archivos, 10,94 s** en `8e741fa`:

```powershell
cd api
npm test -- --maxWorkers=2 catalogActiveUser catalogMastersActiveUsers catalogReportRecipients catalogReportingProfile mastersReportSqlData emailOutboxLease
```

Una consulta de metadatos en `PortalSAGWeb-TEST` encontró cero destinos SQL
físicos y cero perfiles de conteo activos. La función interna
`certifyCatalogReportingProfile` no tiene un consumidor operativo fuera de
pruebas. Para acreditar el flujo real hacen falta el registro auditado,
una cuenta de conteo de solo lectura dedicada, y un ensayo de entrega sin
usar credenciales de tareas. Las pruebas anteriores no sustituyen ese ensayo.

El registro del perfil vuelve a verificar al `super_admin` activo y protegido
dentro de la transacción, antes de consultar el destino y antes de retirar o
insertar perfiles. Una pérdida de autoridad devuelve `authority-changed` sin
auditar éxito. La prueba del SQL real en QA pasó cuatro casos: administrador
exacto que llegó al control de vigencia, usuario sin rol, ID con espacio final
e ID inexistente. No se escribieron perfiles ni se mostraron identificadores.
Las pruebas locales relacionadas pasaron 39/39. Esto no certifica el alta
operativa: el registro de destino todavía debe conservar el namespace de SQL
verificado; no se puede derivar de un nombre ni revertir su hash.

La consulta de recursos de Azure no encontró slots en la Function App de
producción y encontró una sola Static Web App en el grupo productivo. No se
crearon recursos, slots ni se usó producción como ambiente de prueba.

## Matriz pendiente de certificación integral

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
