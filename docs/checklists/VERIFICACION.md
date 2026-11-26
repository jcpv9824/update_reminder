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

## Evidencia y puertas

| Verificación | Resultado observado |
|---|---|
| Instalación limpia del API | `npm ci`: 214 paquetes instalados, 0 vulnerabilidades reportadas por el instalador |
| Instalación limpia del frontend | `npm ci`: 201 paquetes instalados, 0 vulnerabilidades reportadas por el instalador |
| Línea base del selector ERP y menú existentes | `npm test -- --maxWorkers=1 ErpClientCombobox AppLayout`: 14/14, 2 archivos; no es aún una prueba de Checklists |
| Primer incremento API: reglas puras, esquemas Zod y catálogo de permisos | Dos suites nuevas: 22/22 fallaron en rojo antes de la lógica y pasan tras implementarla. La regresión del catálogo también falló por ausencia de claves antes de integrarlas. Corrida conjunta: 33/33 en 3 archivos. No certifica endpoints ni SQL. |
| CA-01…CA-38 y trazabilidad final | Pendiente; identificar las pruebas efectivamente ejecutadas después de cada fase |
| Guard del API y auditorías de dependencias | SQL-only y las cuatro auditorías pasaron, sin hallazgos moderados o superiores, antes del candidato completo |
| API, pruebas enfocadas de plantillas, núcleo, permisos y auditoría | 114/114 en 12 archivos, compilación correcta; antes de la integración de evidencias |
| API, fronteras HTTP y regresión de evidencia inline | 17/17 en 2 archivos, incluidos 401, 403, cuerpo estricto, 409 y CA-20: imagen verificada, imagen de otro punto y binario aún no verificado |
| Builds de ambos paquetes y suites completas | Pendiente para el candidato final |
| DDL 085 y manifiesto | SQL Server 2019 ScriptDom TSql150: PASS; SHA-256 del archivo: `39e66d7d0aa3483e23e57b799c7c10a07921a5876a7fe30972adc071e5689d62` |
| Ensayo SQL de la 085 con reversión | `PortalSAGWeb-TEST`, motor 15, compatibilidad 150. Solicitud `ecb34e60aa9d`: PASS, sin tablas/permisos de la migración y con 0 transacciones abiertas tras rollback |
| Aplicación e idempotencia en QA | Dos ejecuciones de `-Environment qa -ChecklistsOnly`: «PortalSAGWeb-TEST migration 085 is applied and verified.» La prueba sintética inicial `86431d63b5df` y la ampliada `e63ccdd761e0` devolvieron `checklists_fixture_rolled_back=true`. La ampliada comprueba que SQL rechaza promover binarios no verificados y que no concede una reserva de limpieza a una evidencia guardada. No certifica concurrencia de dos sesiones. |
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
| RNF-03 | Paginación y conteos de `api/src/lib/checklistSqlRepository.ts` | Medir con 1000 filas, endpoint y latencia real de QA: pendiente |
| RNF-07 | `migration/sql/085_checklists.sql`, manifiesto, validador y ejecutor aislado | Análisis, hash, ensayo con rollback y dos ejecuciones de QA: PASS |

No se modificaron los datos ni la configuración de producción. Este informe
debe actualizarse con resultados y referencias concretas; los requisitos
pendientes no cuentan como aprobados.
