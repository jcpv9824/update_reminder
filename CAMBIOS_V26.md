# Cambios V26 - SEC-008 seguridad HTML en correos

Fecha: 2026-07-03

- Plantilla corporativa central para recordatorios de tareas bloqueadas sin resolver.
- Escape HTML obligatorio para cliente, dominio, tipo, objetivo, motivo, conteos y URL.
- Enlaces de correos inmediatos de bloqueo/error y finalizacion tambien se escapan.
- Texto plano conservado como fallback sin interpretar HTML.
- Pruebas contra `script`, imagenes con handlers, SVG, links `javascript:`, atributos, comillas y caracteres especiales.
