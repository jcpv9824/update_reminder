# Cambios V27 - SEC-010 transporte y red

Fecha: 2026-07-03

- HTTPS only activado en Azure Functions.
- FTPS completamente deshabilitado.
- TLS minimo 1.2 para aplicacion y SCM; HTTP/2 activo.
- CORS reducido al unico origen productivo de Static Web Apps.
- `supportCredentials=true` conservado y documentado por la cookie refresh HttpOnly cross-origin.
- Script idempotente `scripts/harden-function-transport.ps1` para aplicar y verificar la postura.
- Private Endpoint documentado como no soportado por el plan Consumption `Y1`; requiere migracion a Flex/Premium/Dedicated.
