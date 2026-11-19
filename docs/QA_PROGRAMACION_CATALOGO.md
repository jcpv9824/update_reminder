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

La primera compilación de 053 en SQL Server 2019 rechazó la comparación entre
la clave de `OPENJSON` y la lista esperada por collation binaria distinta.
El rollback conservó 052 y no dejó procedimientos, rol ni historia de 053.
Tras fijar explícitamente la collation, el artefacto con SHA-256
`0f1d24f0df57953a016d1ac3dbd30f7f318decf0dd18bc6d1d1cb0df43feeeab`
se aplicó dos veces dentro de un ensayo con rollback. Se verificaron tres
grants EXECUTE y ausencia de miembros para el rol dedicado; no se instaló
053 de forma permanente. Aún faltan las pruebas funcionales de autorización,
transición, auditoría y confirmación.

El primer ensayo funcional de 053 falló con una transacción no confirmable.
La siguiente consulta de sólo lectura también falló: la conexión efímera
seguía en el contexto de un principal sintético. No se debe reutilizar esa
sesión para escribir. El reensayo exige una sesión nueva de QA, comprobar
el contexto y la ausencia de objetos de prueba, y validar la limpieza ante
errores antes de repetir toda la matriz. No se efectuó un cambio en
producción.

Con la nueva sesión de QA se comprobó el contexto original, cero
transacciones abiertas y la ausencia de principales y objetos de ensayo.
El fixture de 053 pasó arranque (1/1), permisos (10/10) y la matriz completa
(46/46, 6,785 s), con rollback y cero filas de prueba. Después se aplicó 053
por el ejecutor. Esto aún no certifica el COMMIT de una publicación real
bajo un principal de trabajador dedicado.

La comprobación directa de los dos perfiles oficiales de origen devolvió
`verified` para ERP y SAG Admin: las cuentas de sólo lectura completaron la
verificación por SNAPSHOT sin imprimir credenciales ni filas de clientes.
Esto no sustituye el ensayo de publicación contra PortalSAGWeb-TEST.

El adaptador de API para 053 exige un pool dedicado y no está conectado al
trabajador. No se debe habilitar v2 cambiando sólo el valor de una fila: la
activación, el reclamo de cola, la prueba de licencias, los maestros y las
reglas de corte aún verifican el contrato v1. La transición debe probar que
un fallo del publicador v2 no reemplaza la última revisión válida ni amplía
la selección de una tarea o programación. No se usa la cuenta general del
Portal como respaldo del publicador dedicado.

El ciclo del temporizador ya distingue el reclamo de la ruta que debe
procesarlo. Para un trabajo marcado v2, un resultado confirmado lo cierra
en SQL; un resultado ambiguo, una excepción o una configuración no disponible
lo difiere. En ningún caso se usa el cierre genérico v1. Un trabajo v2
aplazado no bloquea las fuentes ERP. El selector SQL ya fija la ruta bajo el
mismo bloqueo y versión del vínculo. La validación del envelope rechaza
también rutas conocidas con un claim incompleto o de otro ambiente.
El lote real exportado por el API pasó **7/7** en PortalSAGWeb-TEST (283 ms)
con rollback: encolado y reclamo con v2 apagado/encendido, ERP heredado
independiente, cierre genérico negado y concesión v2 vigente conservada al
apagar la admisión. Quedaron cero filas de prueba. Pasaron 58 pruebas locales,
TypeScript y el build del API. No se activó v2 ni se escribió en producción.

El temporizador prepara el pool dedicado sólo con el interruptor explícito,
el mapa positivo de emisores y la configuración completa. Mientras no esté
listo, encola y reclama ERP sin admitir v2; el HTTP sólo conoce la
configuración y puede dejar solicitudes autorizadas pendientes en SQL. El
reclamo v2 reutiliza la misma conexión comprobada, vuelve a cotejar ambiente,
fuente, vínculo y versión del perfil, y no cae al publicador heredado. Un
cambio de configuración no cierra el pool que utiliza otra ejecución. Se
comprobó también en QA que el SELECT de preparación rechaza la cuenta de
migración. Aún no se certificó el inicio de sesión ni un COMMIT con la
cuenta publicadora real. Pasaron 83 pruebas enfocadas y TypeScript. Los
publicadores anteriores rechazan un vínculo v2 antes de resolver secretos o
abrir el publicador heredado. No se habilitó la bandera ni se modificó Azure.

Conexiones puede preparar nuevos borradores SAG v2 sólo por configuración
del servidor. No cambia contratos de fuentes existentes ni retira la
fuente activa. La verificación v2 completa Customers y Companies en una
lectura SNAPSHOT; la activación vuelve a exigir un publicador dedicado listo,
autorización del operador después de la lectura y versiones exactas en SQL.
SQL vuelve a confirmar que el operador sigue activo, pero no vuelve a
resolver sus permisos de rol dentro de esa transacción.

Pasaron 54 pruebas enfocadas, TypeScript y el build. El servicio compilado de
verificación leyó SAG Admin con el perfil oficial de solo lectura: **86
clientes, 122 asociaciones, cero llamadas a los caminos de escritura o v1**.
El SQL exacto de activación pasó tres casos con rollback en PortalSAGWeb-TEST:
actor ausente rechazado, contrato ambiguo rechazado y versión exacta aceptada.
Quedaron cero fixtures y cero transacciones. No se creó ni activó un vínculo
real ni se cambió producción.

Los lectores de licenciamiento admiten evidencia positiva de un SAG v2
sellado, con el conteo de Companies de 052 y las versiones exactas del vínculo,
perfil y cabecera. Una licencia vacía o un cliente sin coincidencia no prueba
ausencia en v2. La cobertura de población y las reglas de cierre/corte no se
ampliaron. El registro de una ejecución conserva los requisitos de destino y
de aprobación de cada módulo para las versiones actuales. En QA, el
predicado exacto pasó 10 casos en el motor SQL Server 2019. Pasaron también
82 pruebas enfocadas de lectores y cercas.

En una comprobación de sólo lectura, SAG Admin presentó 25 códigos
reconocidos. QA tiene 20 módulos activos, ninguno con un código normalizado
de una sola letra, y cero correspondencias antiguas o aprobaciones
versionadas. No se infiere ninguna equivalencia. Además, el trigger de 041
aún restringe las nuevas aprobaciones al vínculo v1; se necesita una ruta
aditiva de aprobación v2 y una correspondencia oficial antes de autorizar
tareas por licenciamiento.

El lector interno de destinos usa un contrato fijo separado y conserva la
proyección v2 anterior. Lee clientes, asociaciones y observaciones en una
sola transacción SNAPSHOT, con los conteos, el orden y el fin de ambas
paginaciones verificados. Convierte inmediatamente cada candidato en una
huella HMAC ligada a ambiente, fuente, versión de clave y Company. Un
destino no interpretable conserva su Company sin huella. Dicha huella
no acredita identidad física ni sustituye la aprobación de una conexión.

El lector compilado pasó contra SAG Admin de sólo lectura en 2,259 s:
86 clientes, 122 asociaciones, 98 candidatos y 24 no verificados, cada
observación alineada con una única fila de Company. Sólo se imprimieron
conteos. Pasaron 105 pruebas enfocadas y el build; tras añadir la regresión
de aislamiento por clave/versión/ambiente/fuente, la suite de descubrimiento
pasó 20/20. Falta el sellado atómico del almacenamiento y su integración con
el publicador; esta prueba no escribe ni certifica destinos en QA.

La 055 prepara dos tablas inmutables de observaciones y sellos por revisión,
y un procedimiento dedicado que llama al publicador existente en la misma
transacción. Sólo el resultado publicado adjunta su propio conjunto de
Company; un resultado superado no modifica la revisión ganadora. Se
comprobaron la sintaxis SQL 2019 del lote y sus cuatro módulos, y la
aplicación/reaplicación con rollback en PortalSAGWeb-TEST: cuatro permisos
EXECUTE en el rol dedicado, 16 denegaciones directas, tres triggers activos,
y cero objetos nuevos después del rollback. El manifiesto conserva el hash
del artefacto. Ese ensayo inicial no incluyó el ejecutor de despliegue ni
la publicación con una identidad dedicada.

El adaptador para el nuevo RPC exige exactamente el mismo conjunto de
Company en orden ascendente, un máximo de 24 MiB de observaciones y huellas
canónicas o nulas según el estado. Ante una respuesta no confirmada no
recurre al publicador anterior. Pasaron 10 pruebas del adaptador y TypeScript.

El trabajador ya lee destinos y catálogo en la misma transacción SNAPSHOT y
publica exclusivamente con el cuarto RPC. El pool dedicado verifica los cuatro
permisos EXECUTE y rechaza acceso directo a las dos tablas de custodia.
La verificación de la fuente usa el mismo lector de destinos, sin usar la
clave de cotejo ni el publicador. El verificador obtuvo `verified` contra la
fuente real SAG Admin con su cuenta de sólo lectura.

El ejecutor con `-Environment qa -IncludeCatalog` aplicó 055 y verificó 25
migraciones (031–055). Una consulta independiente confirmó el hash de 055
(`e3d04cd088f3c25f071a8163a91fe6194c2c8cc16c741f938f76c4af1cfcd49c`)
y cero transacciones abiertas, miembros del rol publicador, observaciones
y sellos. Pasaron 131 pruebas enfocadas en siete archivos y el build del
API. Falta demostrar una publicación confirmada de extremo a extremo en QA
con la identidad SQL dedicada; no se activó ninguna fuente ni se desplegó
en producción.

En PortalSAGWeb-TEST, un principal sintético sin login, limitado al rol
publicador durante una transacción, pudo ejecutar el cuarto RPC pero no
leer directamente ninguna de las dos tablas (SQL 229). El RPC rechazó la
transacción ambiental (SQL 55309). El rollback quitó el principal y su
membresía, sin transacciones abiertas. La prueba no demuestra el COMMIT
independiente de una publicación válida.

La 056 define una comprobación SQL interna de una base concreta. Une el
vínculo ERP vigente, la identidad documental del Customer padre exacto, el
perfil físico activo y versionado, y la huella Company sellada en 055. No
confunde registros ERP distintos del mismo cliente con identidades
contradictorias. No concede acceso directo, no devuelve huellas y, para el
reporte, no sustituye la aprobación del perfil de conteo.

En PortalSAGWeb-TEST (SQL Server 2019, nivel 150) se ensayó instalar la 056
dentro de una transacción. El módulo compiló, devolvió NULL para un destino
inexistente y rechazó la ejecución directa como miembro ordinario de
`portal_runtime`. Se revirtió todo: cero módulos, usuarios temporales o
transacciones residuales. El ensayo reproducible
`migration/tools/Test-CatalogSagTargetLinkProofQa.ps1` pasó 13/13 en QA
con cero datos de prueba residuales. Incluye el vínculo exacto con NIT
agrupado, el vencimiento mínimo y los rechazos por revisión sin sello,
huella, ambiente, perfil o instancia de reporte incorrectos.

El mismo ensayo con `-RuntimeGate` pasó 16 comprobaciones adicionales de
la 057 con roles sintéticos en SQL Server 2019: acceso acotado del Portal,
negación de la 056 directa y de las tablas de custodia, separación del
publicador, candidatos exactos, vínculo físico ajeno e instancia de reporte.
El rollback dejó cero datos o usuarios de prueba. Después del ensayo, el
ejecutor con `-Environment qa -IncludeCatalog` instaló 056 y 057, con
`PASS` en ambas, y verificó las 27 migraciones del catálogo (031–057).
Una consulta independiente confirmó ambos hashes y cero observaciones,
fuentes activas, miembros del rol publicador o transacciones abiertas.
No se instaló ninguna migración en producción.

Cuando SAG v2 está habilitado, la programación de bases requiere una prueba
vigente de la 057 para cada vínculo autorizado y conserva el menor
vencimiento hasta el commit. No se altera la resolución de dominios.
El reporte comprueba la misma prueba y el perfil de conteo independiente
antes de abrir una conexión remota y después del conteo. Una prueba no
disponible no se presenta como borrado ni como cero usuarios. Falta el
ensayo de los flujos completos con perfiles reales y medir el tiempo y
los bloqueos SQL en programaciones amplias antes de habilitar en producción.

El runtime `7086a89` pasó la suite completa del API (1.790/1.790,
174 archivos) y el control SQL-only. Una lectura de QA encontró cero
destinos físicos de base, cero identidades de instancia 054 y cero perfiles
activos de conteo; no hay aún un flujo real que se pueda certificar allí con
esas configuraciones. En Azure sólo se observó la Function App del Portal
de producción y ningún slot para esa aplicación; no se creó ni cambió
ningún recurso.

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

Se añadió `resolveCatalogSqlInstanceRoute`, un resolvedor que no realiza
consultas de red. Admite exclusivamente configuración del servidor con
rutas explícitas `(ambiente, host DNS, puerto)` e identificador de instancia
opaco. Un duplicado o una fila inválida invalida la configuración; no se
admiten IP literales, comodines, puertos implícitos ni alias deducidos de DNS.
El resultado sólo permite intentar una verificación de identidad: el
fingerprint de la base debe coincidir con el destino aprobado. Falta guardar
la asociación del namespace y conectar el flujo de certificación. No se
creó configuración ni se habilitó ruta pública.

La certificación interna usa ahora esa configuración mediante
`PORTAL_CATALOG_SQL_INSTANCE_ROUTES`, no un UUID de instancia ingresado por
el llamador. Una ruta no aprobada detiene el flujo antes de acceder a Key
Vault. Si cambia durante el conteo, no se registra el perfil. El lector aún
contrasta el fingerprint de la base con el destino ya verificado. Pasaron
45 pruebas enfocadas, incluida la inyección de un UUID por el llamador y el
retiro de una ruta después del conteo. Falta persistir la identidad aprobada
del destino y exponer un alta administrativa autorizada.

La 054 prepara una relación inmutable de destino SQL → instancia, con clave
de prueba única y fecha asignada por SQL. El ensayo directo en
`PortalSAGWeb-TEST` pasó siete casos con rollback, sin instalar la migración:
aplicar/reaplicar sin backfill, estampar la fecha, permitir dos destinos de la
misma instancia, rechazar UPDATE y DELETE, rechazar ambiente incorrecto,
UUID cero y reutilización de prueba. Se conserva el DENY de escritura directa
para el rol general. Falta implementar y verificar el escritor autorizado;
la tabla, por sí sola, no acredita ningún destino.

La certificación, el registro y la lectura del reporte exigen ahora que la
instancia coincida con esa relación de 054. El conteo vuelve a comprobar la
ruta configurada antes de acceder al secreto, después de ese acceso y antes
de devolver un resultado. Una relación ausente o discordante no se interpreta
como cero usuarios. La matriz local registró ocho fallos antes del cambio y
luego pasó 41 casos en seis archivos. La prueba adicional de dos destinos
pasó en la corrida de maestros (9/9): se conserva el conteo del inscrito
cuando falta el perfil del otro. La consulta real del repositorio también
se ejecutó en QA contra 054 con un ID sintético y devolvió cero filas, como
corresponde. Los perfiles aún requieren registro y verificación de extremo
a extremo; no se habilitó el conteo en Azure.

La primera proyección de destinos legados pasó la revisión de sintaxis, pero
el SELECT de 61 filas sintéticas en SAG Admin agotó 8 s y luego 15 s, bajo la
cuenta de solo lectura y SNAPSHOT. No se integró en las páginas del catálogo
(presupuesto por página: 4 s). Este resultado no es una verificación de
destinos ni indica que se hayan contactado sus servidores.

La versión optimizada corrigió cuatro aceptaciones indebidas detectadas por
SQL Server y aprobó **78/78** casos sintéticos en **272 ms** sobre engine 15,
compatibilidad 130. El SELECT real devolvió sólo agregados en **203 ms**:
122 asociaciones, 98 candidatas y 24 no verificadas. No se devolvieron
direcciones, bases ni cadenas; no se contactaron esos destinos. La proyección
todavía no está conectada al lector de catálogo ni autoriza conexiones.

El ejecutor y el manifiesto ya incluyen 053 y 054. Se comprobó el SHA-256 de
ambos archivos y el analizador TSql150 aprobó los scripts hasta 054. En QA se
aplicaron ambos dentro de una transacción de ensayo y se ejecutó el SELECT
real de posverificación: 31 tablas, 41 triggers y ambos bloques de esquema y
permisos aprobados. El historial permaneció en 22 migraciones de catálogo
(031–052) porque el ensayo no escribió entradas. El rollback eliminó el
rol y los objetos nuevos. No es un PASS de aplicación permanente ni del
COMMIT del publicador.

En la ejecución autónoma de 054, SQL devolvió `-999` al adquirir el bloqueo:
faltaba abrir la transacción propia. Se reprodujo con `@@TRANCOUNT=0`, se
añadió la apertura condicional y se renovó el SHA-256 del manifiesto a
`f55689d6161c01fe150e131d0e1231b0ff85c8608660aa6440a91c22994284b5`.
El diagnóstico corregido obtuvo bloqueo `0`, una transacción al adquirirlo
y cero tras rollback; el analizador TSql150 pasó. El ejecutor aplicó 054 y
verificó 031–054. Una consulta independiente confirmó 24 migraciones de
catálogo, 2/2 hashes exactos, cero miembros en el rol publicador, cero
instancias inscritas y cero fuentes activas en QA. No se ejecutó en
producción ni se activó el trabajador.

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
