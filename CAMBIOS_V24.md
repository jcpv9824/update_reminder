# Cambios V24 - SEC-009 auditoria segura

Fecha: 2026-06-30

## Implementado

- Sustitucion de denylist por allowlist de snapshots por entidad.
- Metadata permitida por accion de auditoria.
- Esquemas anidados para programaciones, licenciamiento y tareas.
- Omision garantizada de bodies, headers, cookies, authorization, API keys, cadenas de conexion, errores externos y texto libre.
- Deteccion por contenido de bearer, JWT, private keys, credenciales y tokens en URL.
- Clasificacion operacional, personal, restringida y secreta.
- Saneamiento historico idempotente sin imprimir documentos.
- Produccion saneada: 2.027 documentos revisados, 1.431 modificados; verificacion posterior con 0 pendientes.

## Pruebas

- Variantes sensibles por nombre de clave.
- Secretos bajo claves genericas y campos permitidos.
- Tipos y acciones sin contrato.
- Alcance anidado permitido.
- Conservacion de ID, fecha y particion en historico.
