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

No se modificaron los datos ni la configuración de producción. Este informe
debe actualizarse con resultados y referencias concretas; los requisitos
pendientes no cuentan como aprobados.
