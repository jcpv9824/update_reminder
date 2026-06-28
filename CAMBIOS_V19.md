# CAMBIOS V19 - Endurecimiento de autenticacion

## SEC-001

- Se elimino la compatibilidad directa con `x-ms-client-principal` en la Function App.
- Produccion acepta exclusivamente el JWT emitido por el login correo/contrasena de la aplicacion.
- Los headers `x-dev-*` permanecen disponibles solo cuando `DEV_AUTH_ENABLED=true`.
- Se agregaron pruebas negativas que falsifican un principal con rol administrador y verifican rechazo `401`.

## Archivos principales

- `api/src/lib/auth.ts`
- `api/src/tests/authSecurity.test.ts`
- Documentacion de autenticacion y checklist de seguridad.
