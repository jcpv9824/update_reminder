# Cambios V15 — ID de cliente, ambientes y disciplina de despliegue

## Clientes

- Se agregó el campo opcional **ID del cliente** (`externalId`) en creación y edición.
- El campo no es obligatorio por ahora para no bloquear datos existentes.
- Si se captura, backend valida que sea único entre clientes no eliminados.
- La tabla de clientes muestra la columna **ID cliente**.

## Ambientes

- Los ambientes operativos quedan limitados a:
  - `production` / Producción.
  - `test` / Pruebas.
  - `demo` / Demo.
- Se retiraron opciones visibles para `staging`, `development` u otros ambientes.
- Backend valida ambientes al crear/editar dominios y bases de datos.

## Handoff y despliegue

- `HANDOFF.md` documenta la regla operativa para agentes externos: probar, construir y commitear antes de desplegar.
- Si después del despliegue producción se ve igual, revisar GitHub Actions, caché de Static Web Apps, Ctrl+F5 y que el commit haya llegado a la rama correcta.

## Pruebas

- Backend: duplicado de `externalId` y lista cerrada de ambientes.
- Frontend: formulario de cliente permite `externalId`, lo envía al API y lo mantiene opcional.
