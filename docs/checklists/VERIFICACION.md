# Verificación — Checklists de implementación

Estado: **preparación y comienzo de fase 1; no desplegado**.
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
| CA-01…CA-38 y trazabilidad final | Pendiente; identificar las pruebas efectivamente ejecutadas después de cada fase |
| Builds y auditorías completas | Pendiente |
| DDL, manifiesto y ensayo SQL con reversión | Pendiente |
| Recorrido y comparación visual en navegador | Pendiente |
| Revisión independiente y CI del PR | Pendiente |
| Respaldo, migración, publicación API y fusión frontend | No ejecutados |

No se modificaron los datos ni la configuración de producción. Este informe
debe actualizarse con resultados y referencias concretas; los requisitos
pendientes no cuentan como aprobados.
