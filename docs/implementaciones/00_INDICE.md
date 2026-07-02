# Especificación del módulo "Implementaciones" — Índice y metodología

> Documentación **spec-driven** del módulo que gestionará los tres procesos de implementación de SAG Web dentro del Programador de Actualizaciones ERP. Antes de escribir código, aquí se especifica QUÉ se construye, POR QUÉ (justificación anclada a los procesos reales) y CÓMO se verifica que la especificación es fiel a los procesos.

## Metodología

1. **Requisitos primero** (`01`): cada requisito tiene un ID, su enunciado, la **fuente** en la documentación de procesos (`Step-by-step/Documentación maestra (Claude)/01–05`) y su **justificación**.
2. **Especificaciones por módulo** (`02`–`07`): cada módulo del software se especifica en detalle (comportamiento, datos, reglas, criterios de aceptación). Cada elemento de la especificación **referencia los requisitos** que satisface.
3. **Verificación** (`08`): matriz de trazabilidad requisito ↔ especificación ↔ fuente, más el resultado del **cotejo espec-vs-proceso**: qué se confirmó, qué discrepancias se encontraron al comparar y cómo se resolvieron.

**Convenciones de identificadores:**

| Prefijo | Significado | Ejemplo |
|---|---|---|
| `RF-` | Requisito funcional | RF-03 |
| `RN-` | Regla de negocio (viene del proceso, no es negociable en código) | RN-07 |
| `RNF-` | Requisito no funcional (seguridad, datos, rendimiento) | RNF-02 |
| `CA-` | Criterio de aceptación (por módulo) | CA-M4-2 |

**Fuentes** (abreviadas en todo el documento):

| Abreviatura | Documento fuente |
|---|---|
| `[CTX]` | `01_contexto_y_glosario.md` — sistema SAG, modelo SaaS, jerarquía, reglas |
| `[PROC]` | `02_procesos_implementacion.md` — los 3 casos, backbone, fail-fast |
| `[SQL]` | `03_scripts_web.md` — scripts web y cuáles correr por caso |
| `[VEN]` | `04_ventas_entregables_y_correos.md` — filtro, entregables, correos |
| `[DEC]` | `05_decisiones_y_pendientes.md` — decisiones resueltas y pendientes |
| `[SYS]` | El sistema existente (código del Programador de Actualizaciones) |

## Árbol de la especificación

```
docs/implementaciones/
├── 00_INDICE.md                  ← estás aquí (metodología y mapa)
├── 01_REQUISITOS.md              ← catálogo de requisitos (RF / RN / RNF) con fuente y justificación
├── 02_ESPEC_ROLES_Y_PERMISOS.md  ← Módulo M1: actores, roles nuevos, matriz rol×etapa
├── 03_ESPEC_MODELO_DATOS.md      ← Módulo M2: entidades, campos, particiones, mapeo a SQL Server
├── 04_ESPEC_MOTOR_PROCESOS.md    ← Módulo M3: máquina de estados + las 3 plantillas de proceso COMPLETAS
├── 05_ESPEC_CORREOS.md           ← Módulo M4: la cadena de correos, builders, reglas de contenido
├── 06_ESPEC_API.md               ← Módulo M5: endpoints, contratos, validaciones, auditoría
├── 07_ESPEC_UI.md                ← Módulo M6: pantallas, comportamiento por rol
└── 08_MATRIZ_TRAZABILIDAD.md     ← verificación: trazabilidad + cotejo espec-vs-proceso + hallazgos
```

## Los seis módulos del software

| Módulo | Nombre | Qué resuelve |
|---|---|---|
| **M1** | Roles y permisos | Que cada interesado entre con su usuario y solo pueda hacer lo que su rol y la etapa permiten |
| **M2** | Modelo de datos | Dónde y cómo se guarda todo (entregables, avance, historia) de forma trazable y migrable a SQL |
| **M3** | Motor de procesos | El backbone común + las diferencias de los 3 casos como plantillas; transiciones válidas; fail-fast |
| **M4** | Correos | Generar y enviar los correos del flujo desde el sistema con las plantillas responsivas existentes |
| **M5** | API | Los endpoints que exponen M1–M4 con autorización en el backend |
| **M6** | UI | Bandeja, asistente de creación y detalle (Avance / Datos / Historia) |

## Alcance de la Fase 1 (lo que esta especificación cubre)

- Captura de información estructurada por caso, selección de caso, checklist técnico con evidencia, trazabilidad completa y envío de los correos del flujo desde el sistema.
- **Fuera de alcance en Fase 1** (documentado como fase futura en `docs/DISENO_MODULO_IMPLEMENTACIONES.md` §10): ejecución automática de scripts SQL/Plesk/SAG Admin, respuesta de Elasticserver dentro del sistema, digitalización del checklist `Opciones Disponibles 2026.xlsx`, acceso del cliente final, adjuntos.
