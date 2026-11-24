# Qué hay de nuevo · Documentación de diseño

Opción nueva del Portal SAG Web: **Actualizaciones › Qué hay de nuevo**. Tiene tres visiones (Desarrollador, Asesor y Cliente) y una configuración propia.
Estado: **implementación local en curso**, retomada por autorización del propietario. El frontend existente es un prototipo simulado; su integración real y el backend están en construcción y no se han desplegado.
Rama: `design/que-hay-de-nuevo`, cortada de `main` en `11887e5`.

| Documento | Contenido | Autor |
|---|---|---|
| [01_DISENO_FUNCIONAL.md](01_DISENO_FUNCIONAL.md) | Visiones, formulario, ciclo de pruebas, reportes, página del cliente y configuración | Orquestador |
| [02_HUECOS_DE_LOGICA.md](02_HUECOS_DE_LOGICA.md) | Huecos encontrados y la decisión propuesta para cada uno | Orquestador |
| [03_MODELO_DE_DATOS.md](03_MODELO_DE_DATOS.md) | Tablas SQL Server 2019, máquina de estados y migraciones | Desarrollador |
| [04_CONTRATO_API.md](04_CONTRATO_API.md) | Endpoints, DTO, validación, idempotencia y errores | Desarrollador |
| [05_ALMACENAMIENTO_Y_EDITOR.md](05_ALMACENAMIENTO_Y_EDITOR.md) | SeaweedFS, carga de archivos y esquema del texto enriquecido | Desarrollador |
| [06_PERMISOS_Y_SEGURIDAD.md](06_PERMISOS_Y_SEGURIDAD.md) | Permisos, área, reglas por objeto y modelo de amenazas | Desarrollador |
| [07_FRONTEND.md](07_FRONTEND.md) | Pantallas, componentes, estados, editor y cómo correr el prototipo | Desarrollador |
| [08_PLAN_DE_PRUEBAS.md](08_PLAN_DE_PRUEBAS.md) | Criterios de aceptación, matriz de casos y hallazgos de QA sobre el diseño | QA |
| [09_PLAN_DE_ENTREGA.md](09_PLAN_DE_ENTREGA.md) | Hitos, orden de agentes y puertas de autorización | Orquestador |
| [10_ARQUITECTURA.md](10_ARQUITECTURA.md) | Tecnologías, flujo, carpetas en SeaweedFS, reporte HTML y página pública | Orquestador |
| [11_CONTRATO_IMPLEMENTACION.md](11_CONTRATO_IMPLEMENTACION.md) | Contrato vigente de API, límites, seguridad, versiones y fronteras pendientes | Desarrollador |
| [12_INTEGRACION_PARALELA.md](12_INTEGRACION_PARALELA.md) | Aislamiento del catálogo, reserva de migraciones y puertas de entrega | Orquestador |

## Decisiones del propietario (2026-11-18)

- **Qué cambió** usa un editor enriquecido pequeño, con barra de formato, imágenes y adjuntos, de unas 5 filas. Cada acción requerida tiene su propio editor compacto de 1 o 2 filas.
- Solo crean entradas las personas con la marca **Desarrollo**, y solo prueban las que tienen la marca **Soporte**.
- **Pestañas del asesor:** Sin probar, En pruebas y Probadas. Fallidas es un filtro dentro de Probadas, junto a Sin errores y Ambas.
- **Soltar** reinicia la prueba.
- **Reportes:**
  - solo desde Probadas, con Todas, Solo aprobadas o Solo fallidas;
  - HTML, sin PDF ni procesamiento de Excel;
  - destinatarios activos del portal elegidos con casillas; el enlace requiere sesión activa.
- **Almacenamiento:** solo SeaweedFS, sin Azure Blob.
- **Página del cliente:**
  - **enlace abierto sin inicio de sesión**, como Formatos de impresión, y sin barra lateral;
  - muestra opciones nuevas y mejoras, y las reglas de negocio van dentro de Mejoras;
  - no tiene «marcar todo como leído»; solo Ver detalle.
- El **selector de cliente** queda abierto, sin fuente, por ahora.
- **Desarrollador:** siempre el creador, no reasignable; todos los asesores y rondas quedan en el historial.
- **Rutas:** siempre manuales salvo el selector inicial Barra lateral/Barra de navegación; sin árbol de menú de referencia.
- La conexión SeaweedFS y el catálogo real de clientes pueden quedar pendientes. No se simula éxito en el modo real cuando una operación requiere esas conexiones.

> Las decisiones finales del relevo y el contrato `11` prevalecen sobre propuestas antiguas de los documentos `03`–`06`. `12` define cómo integrarlo sin interferir con el otro desarrollo.
