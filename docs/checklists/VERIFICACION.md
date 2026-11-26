# Verificación — Checklists de implementación

Estado: **migración comprobada y aplicada en QA; no desplegado en producción**.
Este informe no acredita una fase hasta registrar las pruebas del candidato.

## Base y alcance

- Worktree independiente `portal-checklists-implementacion`, rama
  `feature/checklists-implementacion`, creada desde
  `8c62330adad9961fbbe764761ffecb5427ae5d8d` de `origin/main`.
- Primer commit `9a37725`: especificación v1.2, mockup de referencia y
  procedimiento con API antes de la fusión a `main`.
- [Contrato técnico](CONTRATO.md) fija las fronteras entre API, UI y SQL.
- El selector se titula «Clientes». A diferencia del texto «Cliente» del
  mockup, este nombre es la decisión posterior aprobada. La referencia local
  se inspeccionó en su HTML; el navegador integrado bloqueó `file://`. No
  hay validación visual ni capturas en esta etapa.
- La vista previa del PR apunta al API de producción por diseño del workflow;
  no debe usarse para las pruebas de escritura de QA. El recorrido de QA usa
  exclusivamente la aplicación y el API separados de QA.
- La publicación aprobada usa un ZIP completo con conservación del paquete
  activo anterior. Se promueve exactamente el ZIP certificado en QA. Después
  de CI: respaldo, migración 085, publicación y verificación del API, y solo
  entonces fusión a `main` para desplegar el frontend. Si la copia de
  recuperación o el aislamiento de los otros módulos no se comprueban, se
  suspende antes de publicar.

## Evidencia y puertas

| Verificación | Resultado observado |
|---|---|
| Instalación limpia del API | `npm ci`: 214 paquetes instalados, 0 vulnerabilidades reportadas por el instalador |
| Instalación limpia del frontend | `npm ci`: 201 paquetes instalados, 0 vulnerabilidades reportadas por el instalador |
| Línea base del selector ERP y menú existentes | `npm test -- --maxWorkers=1 ErpClientCombobox AppLayout`: 14/14, 2 archivos; no es aún una prueba de Checklists |
| Primer incremento API: reglas puras, esquemas Zod y catálogo de permisos | Dos suites nuevas: 22/22 fallaron en rojo antes de la lógica y pasan tras implementarla. La regresión del catálogo también falló por ausencia de claves antes de integrarlas. Corrida conjunta: 33/33 en 3 archivos. No certifica endpoints ni SQL. |
| CA-01…CA-38 y trazabilidad final | Los 38 identificadores tienen pruebas por nombre; véase el índice. Pendiente validar todos en la corrida del candidato congelado |
| Guard del API y auditorías de dependencias | SQL-only aprobado en el incremento inicial. Las cuatro auditorías de `api` y `frontend` pasaron con Node 20.19.0/npm 10.8.2, sin hallazgos moderados o superiores; se repetirán en la puerta del commit candidato |
| API, pruebas enfocadas de plantillas, núcleo, permisos y auditoría | 114/114 en 12 archivos, compilación correcta; antes de la integración de evidencias |
| API, fronteras HTTP y regresión de evidencia inline | 17/17 en 2 archivos, incluidos 401, 403, cuerpo estricto, 409 y CA-20: imagen verificada, imagen de otro punto y binario aún no verificado |
| Evidencias en API, pruebas enfocadas | 56/56 en 7 archivos, incluidas 16 regresiones de almacenamiento; TypeScript pasó en esa revisión. Se añadió después un caso de límites de texto/enlace. |
| Frontend, regresión y build | 68/68 en 11 archivos antes de incorporar navegación de teclado al menú de evidencias; 11/11 de evidencias con el ajuste, TypeScript y Vite en verde en el frontend congelado. Suite completa pendiente. |
| API, build y suite completa | Build del núcleo aprobado antes de integrar evidencias; suite completa y build del candidato pendientes. |
| DDL 085 y manifiesto | SQL Server 2019 ScriptDom TSql150: PASS; SHA-256 del archivo: `39e66d7d0aa3483e23e57b799c7c10a07921a5876a7fe30972adc071e5689d62` |
| Ensayo SQL de la 085 con reversión | `PortalSAGWeb-TEST`, motor 15, compatibilidad 150. Solicitud `ecb34e60aa9d`: PASS, sin tablas/permisos de la migración y con 0 transacciones abiertas tras rollback |
| Aplicación e idempotencia en QA | Dos ejecuciones de `-Environment qa -ChecklistsOnly`: «PortalSAGWeb-TEST migration 085 is applied and verified.» La prueba sintética inicial `86431d63b5df` y la ampliada `e63ccdd761e0` devolvieron `checklists_fixture_rolled_back=true`. La ampliada comprueba que SQL rechaza promover binarios no verificados y que no concede una reserva de limpieza a una evidencia guardada. No certifica concurrencia de dos sesiones. |
| Consulta paginada con 1.000 checklists en QA | Solicitud `3a1ffb2e9e35`: batch exacto de API-01 con 1.000 filas sintéticas, 1.000 coincidencias, 25 devueltas y 55,999 ms medidos en SQL. Se revirtió la transacción. No mide red, autenticación ni tiempo total de HTTP. |
| Batch de guardado y finalización en QA | Solicitud `24eeade411a4`: se ejecutó el SQL exacto de API-05/06 con puntos, nota y evidencia sintéticos. Confirmó puntos, nota, promoción de evidencia, responsable/fecha de finalización y cambio de versión de fila; todo se revirtió. |
| Estado del entorno alojado de QA antes de publicar | API y frontend separados de producción; SQL conectado y seguro, seis timers operativos deshabilitados, trabajador de catálogo desactivado. SQL confirma una fuente ERP activa con una revisión. No hay selector de proveedor privado configurado para las evidencias; no se modificaron ajustes. |
| Versión de Node | El workflow fija 20.19.0; la instalación local advierte que algunas dependencias ya presentes en la base piden ≥22. Los dos API alojados están configurados con `~22`. Checklists no modifica paquetes ni configuración del runtime. |
| Recorrido y comparación visual en navegador | Pendiente |
| Revisión independiente y CI del PR | Pendiente |
| Respaldo, migración, publicación API y fusión frontend | No ejecutados |

## Trazabilidad de código y pruebas

Rutas relativas a la raíz del repositorio. Las referencias a casos apuntan a
los escenarios descritos en [PLAN_QA](PLAN_QA.md); el resultado de una corrida
no sustituye las capas SQL, HTTP, visual o de concurrencia aún pendientes.

| Requisito | Código | Prueba o evidencia |
|---|---|---|
| RN-01…05, P-02, API-02/03 | `frontend/src/pages/checklists/NewChecklistPage.tsx`; `api/src/lib/checklistErpClients.ts`, `checklistRequestSchemas.ts`, `checklistSqlWriteRepository.ts` | CA-01…05: `NewChecklistPage.test.tsx`, `checklistErpClients.test.ts`, `checklistRequestSchemas.test.ts` |
| RN-06…08, API-03 | `checklistDomain.ts`, `checklistSqlWriteRepository.ts`; 085, índice `UX_implementation_checklists_active_progress` | CA-06…09: `checklistDomain.test.ts`, `implementationChecklistsHttp.test.ts`, `NewChecklistPage.test.tsx`, `qa_checklists_rollback_smoke.sql`; dos sesiones pendiente |
| RN-09…11, RN-18/19, RNF-04, API-04…08 | `api/src/functions/implementationChecklists.ts`, `checklistSqlRepository.ts`, `checklistSqlWriteRepository.ts`; `ChecklistPage.tsx` | CA-09…11/35: `implementationChecklistsHttp.test.ts`, `checklistWriteBoundaries.test.ts`, `ChecklistPage.test.tsx`, fixture SQL |
| RN-12, P-03, API-04 | FK compuesta de la 085; `checklistSqlRepository.ts`, `ChecklistPage.tsx` | CA-21: `checklistWriteBoundaries.test.ts`, `ChecklistPage.test.tsx`, fixture SQL |
| RN-13…16, RN-21, API-05/06 | `checklistDomain.ts`, `checklistSqlWriteRepository.ts`, `ChecklistPage.tsx` | CA-12…15/34: `checklistDomain.test.ts`, `checklistWriteBoundaries.test.ts`, `ChecklistPage.test.tsx`; recarga/cierre en navegador pendiente |
| RN-20/20a, P-01, API-01 | `ChecklistsPage.tsx`, `ChecklistPage.tsx`, `checklistSqlRepository.ts` | CA-36: `ChecklistsPage.test.tsx`, `ChecklistPage.test.tsx` |
| RN-17, RN-40…45, RNF-05, API-09/10 | Evidencias privadas del módulo; escritura/lectura y limpieza de pendientes | CA-16…19: validación y servicio de evidencias; integración/UI y descargas desde navegador pendientes |
| RN-50…52, P-03, API-05 | `EditorEnriquecido.tsx`, `whatsNewRichText.ts`, `checklistSqlWriteRepository.ts` | CA-20: `checklistWriteBoundaries.test.ts`; insertar, redimensionar y recargar desde navegador pendiente |
| RN-30…35, P-04, API-20…23 | `checklistTemplates.ts`, `checklistTemplateService.ts`, `checklistTemplateSqlWriteRepository.ts`; `ChecklistTemplatesPage.tsx` y `ChecklistTemplatePage.tsx` | CA-30…33: `checklistTemplateHttp.test.ts`, `checklistTemplateService.test.ts`, `ChecklistTemplatePage.test.tsx`, fixture SQL |
| RN-22…29, RN-36…39, P-05/06, API-24…28 | `checklistTemplateDomain.ts`, `checklistTemplateSqlWriteRepository.ts`, `ChecklistVersionPage.tsx` | CA-22…29/32/37: `checklistTemplateDomain.test.ts`, `checklistTemplateSqlWriteRepository.test.ts`, `ChecklistVersionPage.test.tsx`, fixture SQL |
| P-01…06: navegación y permisos | `frontend/src/App.tsx`, `frontend/src/menu.ts`, ambos catálogos de permisos | CA-38: `ChecklistNavigation.test.tsx`, `permissionModel.test.ts`; menú real con sesión pendiente |
| RNF-01/02/06 | Controles y estilos de `frontend/src/pages/checklists/` | Pruebas de interacción más recorrido visual y accesibilidad a varios tamaños; pendiente en navegador |
| RNF-03 | Paginación y conteos de `api/src/lib/checklistSqlRepository.ts` | SQL con 1.000 filas, 25 por página: PASS en QA (55,999 ms). Medición HTTP de extremo a extremo pendiente |
| RNF-07 | `migration/sql/085_checklists.sql`, manifiesto, validador y ejecutor aislado | Análisis, hash, ensayo con rollback y dos ejecuciones de QA: PASS |

Variables opcionales de RN-40: `CHECKLIST_EVIDENCE_{IMAGE,VIDEO,FILE}_MAX_BYTES` y
`CHECKLIST_EVIDENCE_{LINK,TEXT}_MAX_CHARS`. Solo admiten positivos hasta el
valor predeterminado de cada tipo; no amplían el límite del host ni de SQL.
No se configuró ninguna de estas variables en Azure.

### Índice de pruebas automáticas CA-01…CA-38

Cada fila referencia una prueba identificada en el código. Los nombres se
contrastaron contra el código; el índice no sustituye el reporte de una
corrida integrada y no da por aprobado el recorrido en navegador.

| Caso | Suite | Nombre de la prueba |
|---|---|---|
| CA-01 | [NewChecklistPage.test.tsx](../../frontend/src/tests/NewChecklistPage.test.tsx) | CA-01 CA-03 CA-04 menos de tres letras no busca, escribir no selecciona y no preselecciona plantilla |
| CA-02 | [NewChecklistPage.test.tsx](../../frontend/src/tests/NewChecklistPage.test.tsx) | CA-02 CA-03 teclear después de elegir invalida la identidad seleccionada |
| CA-03 | [implementationChecklistsHttp.test.ts](../../api/src/tests/implementationChecklistsHttp.test.ts) | CA-03 rechaza un nombre no seleccionado y distingue permiso de crear de permiso de lectura |
| CA-04 | [NewChecklistPage.test.tsx](../../frontend/src/tests/NewChecklistPage.test.tsx) | CA-04 CA-05 cambiar a plantilla sin ambiente lo oculta y no lo conserva al volver |
| CA-05 | [NewChecklistPage.test.tsx](../../frontend/src/tests/NewChecklistPage.test.tsx) | CA-05 CA-08 CA-09 creación permitida respeta el ambiente elegido y abre su snapshot |
| CA-06 | [NewChecklistPage.test.tsx](../../frontend/src/tests/NewChecklistPage.test.tsx) | CA-06 bloqueo de repetido en progreso incluye enlace y no reintenta automáticamente |
| CA-07 | [NewChecklistPage.test.tsx](../../frontend/src/tests/NewChecklistPage.test.tsx) | CA-07 cancelar repetido completado no crea; confirmar agrega confirmDuplicate sin autor |
| CA-08 | [checklistDomain.test.ts](../../api/src/tests/checklistDomain.test.ts) | CA-08 CA-09 permite ambientes distintos e ignora borrados |
| CA-09 | [NewChecklistPage.test.tsx](../../frontend/src/tests/NewChecklistPage.test.tsx) | CA-05 CA-08 CA-09 creación permitida respeta el ambiente elegido y abre su snapshot |
| CA-10 | [ChecklistsPage.test.tsx](../../frontend/src/tests/ChecklistsPage.test.tsx) | CA-10 CA-36 lista fechas Bogotá, capacidad por fila y contadores; filtros se envían al servidor |
| CA-11 | [checklistWriteBoundaries.test.ts](../../api/src/tests/checklistWriteBoundaries.test.ts) | CA-11 al administrador sí le permite guardar y deja actor de auditoría |
| CA-12 | [ChecklistPage.test.tsx](../../frontend/src/tests/ChecklistPage.test.tsx) | CA-12 no autoguarda y pide confirmación al salir y recargar |
| CA-13 | [checklistWriteBoundaries.test.ts](../../api/src/tests/checklistWriteBoundaries.test.ts) | CA-13 no confirma cambios parciales de una finalización incompleta |
| CA-14 | [checklistDomain.test.ts](../../api/src/tests/checklistDomain.test.ts) | CA-14 permite finalizar con todos marcados, sin texto ni evidencias |
| CA-15 | [checklistRequestSchemas.test.ts](../../api/src/tests/checklistRequestSchemas.test.ts) | CA-15 conserva notas al desmarcar un punto y rechaza HTML como documento |
| CA-16 | [checklistEvidenceService.test.ts](../../api/src/tests/checklistEvidenceService.test.ts) | CA-16 reserva antes de escribir, verifica después y devuelve solo metadatos públicos |
| CA-17 | [checklistEvidenceHttp.test.ts](../../api/src/tests/checklistEvidenceHttp.test.ts) | CA-17 archivos/videos son attachment y solo raster validado puede ir inline; no URLs firmadas |
| CA-18 | [checklistEvidenceHttp.test.ts](../../api/src/tests/checklistEvidenceHttp.test.ts) | CA-18 rechaza el tamaño declarado por encima del cuerpo máximo sin leer bytes |
| CA-19 | [checklistEvidenceValidation.test.ts](../../api/src/tests/checklistEvidenceValidation.test.ts) | CA-19 rechaza HTML/SVG/archivo disfrazado y PNG truncado aunque declare image/png |
| CA-20 | [ChecklistEvidence.test.tsx](../../frontend/src/tests/ChecklistEvidence.test.tsx) | CA-20 editor privado inyectado usa API10, conserva ancho y no consulta Novedades |
| CA-21 | [checklistWriteBoundaries.test.ts](../../api/src/tests/checklistWriteBoundaries.test.ts) | CA-21 la creación fija versión y copia de nombre recuperadas en su transacción |
| CA-22 | [ChecklistTemplatePage.test.tsx](../../frontend/src/tests/ChecklistTemplatePage.test.tsx) | CA-22 impide crear si existe edición y explica la regla |
| CA-23 | [ChecklistTemplatePage.test.tsx](../../frontend/src/tests/ChecklistTemplatePage.test.tsx) | CA-23 CA-27 publicación pide confirmación y muestra no_points sin fingir éxito |
| CA-24 | [ChecklistVersionPage.test.tsx](../../frontend/src/tests/ChecklistVersionPage.test.tsx) | CA-24 vigente y congelada son solo lectura sin controles de edición |
| CA-25 | [ChecklistTemplatePage.test.tsx](../../frontend/src/tests/ChecklistTemplatePage.test.tsx) | CA-25 retirar la primera vigente sin usos deja la plantilla sin vigente |
| CA-26 | [ChecklistTemplatePage.test.tsx](../../frontend/src/tests/ChecklistTemplatePage.test.tsx) | CA-26 CA-32 una persona de configuración crea versión ajena sin permiso de Implementación |
| CA-27 | [checklistTemplateDomain.test.ts](../../api/src/tests/checklistTemplateDomain.test.ts) | CA-27 exige al menos un punto para publicar, sin cambiar el estado |
| CA-28 | [ChecklistVersionPage.test.tsx](../../frontend/src/tests/ChecklistVersionPage.test.tsx) | CA-28 CA-29 guarda orden y NULL explícitamente, nunca autoguarda al editar |
| CA-29 | [ChecklistVersionPage.test.tsx](../../frontend/src/tests/ChecklistVersionPage.test.tsx) | CA-28 CA-29 guarda orden y NULL explícitamente, nunca autoguarda al editar |
| CA-30 | [checklistTemplateHttp.test.ts](../../api/src/tests/checklistTemplateHttp.test.ts) | CA-30 solo permite API-23 a superadministradores |
| CA-31 | [checklistTemplateSqlWriteRepository.test.ts](../../api/src/tests/checklistTemplateSqlWriteRepository.test.ts) | CA-31 una plantilla usada no se elimina ni se audita |
| CA-32 | [checklistTemplateHttp.test.ts](../../api/src/tests/checklistTemplateHttp.test.ts) | CA-32 deriva permisos del perfil persistido actual, no de roles anteriores del token |
| CA-33 | [checklistTemplateHttp.test.ts](../../api/src/tests/checklistTemplateHttp.test.ts) | CA-33 API-21 devuelve 201 y nombre recortado sin aceptar propietario o estado |
| CA-34 | [implementationChecklistsHttp.test.ts](../../api/src/tests/implementationChecklistsHttp.test.ts) | CA-34 entrega conflicto obsoleto sin reintentar el guardado |
| CA-35 | [checklistWriteBoundaries.test.ts](../../api/src/tests/checklistWriteBoundaries.test.ts) | CA-35 reapertura con otra instancia en progreso no modifica ninguna |
| CA-36 | [ChecklistsPage.test.tsx](../../frontend/src/tests/ChecklistsPage.test.tsx) | CA-10 CA-36 lista fechas Bogotá, capacidad por fila y contadores; filtros se envían al servidor |
| CA-37 | [ChecklistVersionPage.test.tsx](../../frontend/src/tests/ChecklistVersionPage.test.tsx) | CA-37 conserva el borrador local y rowVersion original tras stale |
| CA-38 | [ChecklistNavigation.test.tsx](../../frontend/src/tests/ChecklistNavigation.test.tsx) | CA-38 añade solo Checklists al final de Configuración e Implementación; puntos/versiones no son opciones laterales |

No se modificaron los datos ni la configuración de producción. Este informe
debe actualizarse con resultados y referencias concretas; los requisitos
pendientes no cuentan como aprobados.
