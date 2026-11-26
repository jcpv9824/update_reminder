# Plan independiente de QA — Checklists

Fuente: `ESPEC_CHECKLISTS_IMPLEMENTACION.md` 1.2 y `CONTRATO.md`.
Estado: planificación previa a implementación; **ninguna prueba de esta matriz se declara ejecutada**.
La lectura del HTML/CSS/JS del mockup no equivale a una revisión visual en navegador.

Cada prueba automática debe citar su identificador CA. La matriz se actualizará en
`VERIFICACION.md` con archivo, nombre exacto de prueba, resultado y SHA del candidato.
Las propuestas de la sección de ambigüedades no amplían el contrato aprobado.

## Fixtures y capas

- `U_OWNER`: usuario activo con `implementation.checklists.view` y `create`.
- `U_READER`: otro usuario activo, solo `implementation.checklists.view`.
- `U_CONFIG_A/B`: usuarios distintos con únicamente `configuration.checklist_templates.view`.
- `U_ADMIN`: rol `super_admin`; `U_NONE`: sin permisos; usuario inactivo y petición sin sesión.
- `ERP_A`: cliente autorizado con nombre acentuado; `ERP_B`: otro cliente autorizado;
  `ERP_DENIED`: fuente ERP no autorizada; `ADMIN_ONLY`: registro exclusivo de SAG Admin.
- `T_ENV`: plantilla que exige ambiente; `T_NOENV`: plantilla sin ambiente.
  Versiones con puntos diferentes, títulos, detalles, orden y UUID propios.
- `C_PROGRESS`, `C_COMPLETED`, `C_DELETED`: misma combinación cliente/plantilla/ambiente;
  combinaciones separadas para pruebas de creación y reapertura.
- Archivos sintéticos de cada formato, tamaños límite y límite + 1, PNG falso,
  nombres hostiles y documentos TipTap adversariales. Nunca documentos productivos.
- Reloj fijo y casos de cambio de día en Bogotá; versiones de fila diferentes para conflictos.

Capas: **FE** = Testing Library/cliente HTTP; **API** = dominio y frontera HTTP;
**SQL** = invariantes y transacciones en base QA autorizada; **VIS** = revisión visual/teclado.
Un mock de SQL no prueba restricciones reales, aislamiento ni carreras del motor.

## Matriz CA-01 a CA-38

| CA | Afirmaciones verificables | Capas | Fixtures |
|---|---|---|---|
| CA-01 | Dos letras no producen búsqueda; API-02 rechaza menos de tres con 400. | FE, API | ERP_A; espía de solicitudes |
| CA-02 | Tres letras buscan por substring, ignorando mayúsculas/tildes; solo ERP autorizado, máximo 20 resultados. Una respuesta antigua no reemplaza la búsqueda actual. | API, FE | ERP_A/B, ERP_DENIED, ADMIN_ONLY, 21 coincidencias |
| CA-03 | Texto no seleccionado no permite crear, aunque coincida con un nombre. UUID inexistente o no autorizado no crea datos; mensaje exacto de P-02. | FE, API | U_OWNER, ERP_A, ERP_DENIED |
| CA-04 | Plantilla y ambiente empiezan vacíos; al elegir T_ENV aparece ambiente obligatorio. API exige valor válido. | FE, API | T_ENV |
| CA-05 | T_NOENV oculta ambiente y lo guarda NULL; cambiar de plantilla no conserva un ambiente incompatible. | FE, API, SQL | T_ENV, T_NOENV |
| CA-06 | Repetido en progreso devuelve 409 `duplicate_in_progress`, datos mínimos y enlace. Dos creaciones simultáneas no dejan dos registros en progreso. | API, SQL, FE | C_PROGRESS, U_OWNER |
| CA-07 | Repetido completado devuelve conflicto para confirmar; cancelar no crea y confirmar sí crea. Se muestra enlace al completado y mensaje P-02. | API, FE | C_COMPLETED |
| CA-08 | Ambiente distinto permite otro checklist para el mismo cliente y plantilla. | API, SQL | C_PROGRESS en testing; creación production |
| CA-09 | Eliminados no bloquean creación ni cuentan como uso; se conserva su historia lógica. | API, SQL | C_DELETED |
| CA-10 | U_READER ve detalle ajeno en solo lectura. API-05/06/07/08/09 rechazan cada escritura ajena con 403 sin cambios. | API, FE | U_OWNER, U_READER, C_PROGRESS/C_COMPLETED |
| CA-11 | Superadministrador puede editar/eliminar ajenos; auditoría identifica al actor real sin cambiar responsable. | API, SQL, FE | U_ADMIN, C_PROGRESS |
| CA-12 | Marcar/escribir/quitar evidencia no autoguarda. Salir por ruta/volver/recargar/cerrar avisa. Al confirmar salida no se promueven pendientes ni se persisten cambios; limpieza solo de pendientes vencidos. | FE, API, SQL, VIS | C_PROGRESS; notas y evidencia guardada/pendiente |
| CA-13 | Finalizar incompleto devuelve 422 `missing_points` con IDs correctos; UI indica N y resalta puntos. No se guarda parcialmente texto, marcas, evidencias ni auditoría de finalización. | API, SQL, FE | Dos puntos pendientes |
| CA-14 | Todos marcados permiten finalizar sin notas/evidencias; estado/fecha/autor y auditoría son atómicos. | API, SQL, FE | C_PROGRESS sin notas/evidencias |
| CA-15 | Desmarcar oculta editor pero no pierde texto; remarcar lo recupera. Guardar y recargar conserva ese texto aunque el punto esté desmarcado. | FE, API | Punto con notas TipTap |
| CA-16 | Imagen real produce miniatura de máximo 48 px; abrirla exige autorización. No hay URL pública ni origen externo automático. | FE, API, VIS | Raster válido, U_OWNER/U_READER |
| CA-17 | Video/archivo/enlace se muestran compactos. Enlace HTTP(S) abre pestaña nueva segura; archivo se descarga con attachment/nosniff y nunca se ejecuta. | FE, API, VIS | Video, archivo HTML/SVG, enlace |
| CA-18 | Archivo de 30 MB se rechaza con mensaje exacto del límite de 25 MB; servidor también lo valida. Probar límite y límite + 1, sin evidencia válida residual. | FE, API | Binarios sintéticos |
| CA-19 | Extensión/MIME PNG con bytes falsos se rechaza; raster permitido se verifica por contenido, no por nombre. | API | PNG falso; PNG/JPG/GIF/WEBP válidos |
| CA-20 | Redimensionar imagen guarda ancho en JSON; al reabrir mantiene tamaño y autorización por punto. Rechaza ancho inválido y atributos/orígenes hostiles. | FE, API, VIS | Imagen inline verificada y notas TipTap |
| CA-21 | Checklist de versión anterior conserva puntos, detalles, orden, ambiente y versión al publicarse otra; puede terminar sin migración implícita. | API, SQL, FE | Checklist v1, vigente v2 |
| CA-22 | Si existe edición, API-24 devuelve 409 `editing_exists` y UI explica. Carrera de creación de versiones deja una sola edición. | API, SQL, FE | U_CONFIG_A/B; vigente v2, edición v3 |
| CA-23 | Publicación promueve edición y congela anterior en una transacción con auditoría. Nuevos checklists usan versión vigente completa; existentes no cambian. | API, SQL, FE | Vigente v2, edición v3; carrera crear/publicar |
| CA-24 | Congelada sin uso no se edita ni elimina: no hay controles y API devuelve 409, sin efectos. | API, FE | Versión congelada sin usos |
| CA-25 | Vigente sin uso se retira solo si es la de mayor número no eliminado; anterior pasa a vigente. **Si hay edición superior, la vigente ya no es la última y retirar devuelve 409.** Retirar v1 sin anterior deja plantilla sin vigente. | API, SQL, FE | Vigente v3/congelada v2; edición v4 opcional; plantilla v1 |
| CA-26 | Descartar edición es lógico; volver a crear reutiliza número, no identidad/historia del registro descartado. Los puntos copiados no aliasan puntos históricos. | API, SQL, FE | Edición v3 descartada |
| CA-27 | Publicar cero puntos devuelve 422 `no_points` y mensaje P-05; vigente anterior queda intacta. | API, FE | Edición vacía |
| CA-28 | Arrastre y alternativa subir/bajar conservan orden; guardar persiste posiciones 1..N sin huecos; nuevo checklist sigue ese orden. | FE, API, SQL, VIS | Versión con tres puntos |
| CA-29 | Detalle vacío/espacios se normaliza a NULL y no deja línea vacía en la vista del checklist. | API, FE | Punto sin detalle y otro con detalle |
| CA-30 | Usuario ordinario de configuración no tiene botón eliminar plantilla; API-23 devuelve 403, aunque usos sea cero. | API, FE | U_CONFIG_A; plantilla sin uso |
| CA-31 | Superadministrador no elimina plantilla con usos: 409 `in_use`, sin botón. Cuentan progreso/completados no eliminados; borrados lógicos no cuentan. | API, SQL, FE | U_ADMIN; versiones con usos de ambos estados |
| CA-32 | Quien tiene acceso a configuración puede crear/editar/publicar versiones de plantilla creada por otra persona; no existe autorización por creador. | API, FE | U_CONFIG_A/B |
| CA-33 | Nombre obligatorio y único tras trim y sin diferencias de mayúsculas/tildes; colisión devuelve 409 `name_taken`, incluso en carrera. Eliminada libera nombre. | API, SQL, FE | «migración»/«Migracion»; plantilla eliminada |
| CA-34 | Dos guardados con versión de fila antigua: segundo 409 `stale`, mensaje RN-21, borrador local conservado y cero cambios parciales. | API, SQL, FE | Dos sesiones de C_PROGRESS |
| CA-35 | Reabrir por dueño/admin limpia finalizado/autor, vuelve a progreso y audita. Si existe otro en progreso, 409 con enlace y ninguno cambia. Carrera reabrir/crear respeta unicidad. | API, SQL, FE | C_COMPLETED y C_PROGRESS de igual combinación |
| CA-36 | Fechas UTC distintas de creación/finalización se muestran correctamente en Bogotá en índice y cabecera; abierto muestra —. Incluir borde de medianoche. | API, FE | Reloj fijo, finalización día siguiente |
| CA-37 | Segundo guardado de versión editada devuelve 409 `stale` y mensaje RN-39. Publicación entre carga y guardado impide escribir. No sobrescribir datos remotos ni perder borrador local. | API, SQL, FE | U_CONFIG_A/B; dos rowVersion |
| CA-38 | Solo dos opciones nuevas al final de sus módulos. Vistas internas son rutas con Volver/migas, nunca entradas laterales. Permisos y ruta inicial por única opción funcionan. | FE, VIS | Roles de una, ambas o ninguna opción |

## Puerta de fase 1 — Plantillas

Cobertura prioritaria: CA-22…29, CA-30…33, CA-37 y parte de CA-38.
CA-21/23/25/28/31 necesitarán evidencia integrada con checklists en fases posteriores;
una fixture de uso puede probar la negativa de fase 1, pero no reemplaza ese recorrido.

1. Pruebas rojas antes de lógica para API-20…28 y P-04…06; conservar evidencia del fallo esperado.
2. Probar sin sesión/inactivo/sin permiso, roles personalizados de configuración y superadministrador.
   No exigir permiso de Implementación para administrar plantillas, ni dar permisos a roles ordinarios.
3. Plantilla + edición 1.0 + auditoría se confirman juntos; fallo intermedio revierte todo.
   Publicar/retirar/descartar respetan bloqueo de plantilla, estados e historia.
4. Límites: nombre 150/151; título vacío y 200/201; detalle 1000/1001;
   puntos 0/1/100/101; propiedades desconocidas, IDs duplicados o ajenos.
5. Editor de puntos sin autoguardado; detalle NULL, reordenamiento por teclado,
   versión publicada/congelada solo lectura; conflictos conservan trabajo local.
6. Migración nueva aditiva con siguiente número realmente libre, manifest/hash,
   runner y validador SQL Server 2019. No asumir el «031» histórico de la especificación.
7. Pruebas SQL autorizadas posteriores: instalación limpia, repetición, restricciones
   únicas filtradas, nombres sin tildes/case, posiciones e invariantes de versiones;
   rollback controlado y evidencia de no alteración ajena. **No ejecutadas en esta revisión.**
8. Verificación enfocada primero; después builds y suites completas de API y FE,
   secuenciales y coordinadas por el orquestador. Auditorías de dependencias según protocolo.
9. Revisión independiente de autorización, SQL parametrizado, datos históricos y auditoría
   sin contenido de notas, archivos, secretos o URLs firmadas.
10. Comparación visual P-04/P-05/P-06 con capturas, 1280 px/tablet, teclado/foco/modal,
    candado/estado, 260 px de sidebar, colores del portal, migas y Volver.

## Ambigüedades del contrato — no son extensiones aprobadas

- API-27/28 no incluyen rowVersion: definir explícitamente qué sucede si otra persona
  cambia la edición tras abrir la confirmación de publicar/descartar. La exigencia
  aprobada de conflicto en API-26 permanece; no agregar transporte nuevo sin acuerdo.
- POST de crear plantilla/versión/checklist/evidencia no define replay tras respuesta
  perdida. Acordar estrategia de reintentos antes de afirmar idempotencia. Una propuesta
  de clave/fingerprint no equivale a un requisito ya aprobado.
- API-05/06: el contrato fija que points es el estado completo y que los IDs deben
  ser exactos, únicos y propios. Verificar además forma y tamaño de notes.
- Fijar mapeo imagen inline ↔ Evidence.id/fileId, referencias pendientes/guardadas,
  ruta autorizada de lectura y adaptación del saneador compartido de Novedades.
- Precisar pageSize y relación entre búsqueda, total y contadores; API-20 no tiene
  búsqueda explícita aunque P-04 sí la muestra. Determinar cuál completado se presenta
  si hay varios para confirmar duplicado.
- Crear pide create, pero abrir detalle pide view: acordar experiencia de un rol con
  create sin view; no asignar permisos implícitos a roles ordinarios.
- P-06 no autoguarda; precisar alcance de aviso al salir de esa edición.
- Concretar unidad de MB y límites configurables; estado de eliminación/lectura de
  evidencia pending, carreras entre promoción/limpieza y manejo de objeto almacenado
  cuando una escritura SQL falla. Limpiar nunca debe retirar evidencia guardada.

## Preparación para lanzamiento — separada de los hallazgos

- Matriz CA completa con resultados reales y trazabilidad RN/API/P → código → prueba,
  SHA exacto y revisión independiente. No declarar aprobado un caso no ejecutado.
- SQL real y carreras en QA autorizada; static SQL y mocks no certifican motor.
- Pruebas de seguridad del editor compartido sin regresiones de Novedades; contenido
  real de imagen, pertenencia de evidencia, descarga segura y limpieza verificadas.
- Lista de 1000 checklists en menos de 1 s: medición reproducible con entorno y
  muestra declarados; no inferir rendimiento desde una prueba con mocks.
- Recorrido visual completo de las cuatro fases, solo lectura de otro usuario,
  imágenes redimensionadas, cinco evidencias, fechas y advertencias de salida.
- CI/auditorías/builds verdes; respaldo y procedimiento de migración/despliegue
  comprobados por el responsable con autorización de alcance. Esta revisión no
  ejecuta SQL, navegador, red, despliegue ni acciones sobre otros worktrees.

El mockup es referencia visual, no implementación de reglas: su JavaScript pierde
texto al desmarcar y permite un nombre escrito sin selección. Esas conductas no deben
copiarse; prevalecen CA-15 y CA-03. Su CDN externo, `execCommand` y `innerHTML` tampoco
definen tecnologías o controles permitidos para la implementación real.
