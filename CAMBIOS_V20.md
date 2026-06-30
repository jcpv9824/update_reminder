# Cambios V20 - Autorizacion de objeto y minimizacion

Fecha: 2026-06-30

## Seguridad

- Corregido SEC-002 (P0): bases, tareas, clientes y dominios aplican alcance obligatorio por rol/asignacion en backend.
- Los actualizadores ya no pueden consultar tareas u objetos ajenos cambiando IDs o parametros de URL.
- Los DTOs generales de bases solo incluyen `initialCatalog`; omiten servidor, usuario SQL y `passwordSecretName`.
- Los DTOs de tareas omiten buckets, dedupe, fuentes internas y marcas de idempotencia de correo.
- Corregido SEC-003: `access-info`, `copy-access-part` y `reveal-password` comparten autorizacion de objeto; la contraseña mantiene permiso mas restrictivo.
- La UI obtiene servidor/usuario únicamente al abrir **Ver acceso**.

## Pruebas

- `api/src/tests/objectAuthorization.test.ts`: matriz BOLA/IDOR para admin, client_manager, viewer, domain_updater, database_updater y roles desconocidos.
- `api/src/tests/publicDtos.test.ts`: ausencia estructural de referencias Key Vault y metadata interna.
- Pruebas frontend de dominios actualizadas para exigir carga explicita de acceso.
