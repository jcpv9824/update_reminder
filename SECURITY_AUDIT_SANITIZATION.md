# Sanitizacion y clasificacion de auditoria

Fecha de implementacion: 2026-06-30
Control: SEC-009 (P1)

## Principio

La auditoria registra quien hizo que, sobre cual entidad y cuando. No es una copia de solicitudes HTTP, respuestas, modelos completos ni errores de proveedores.

`api/src/lib/audit.ts` es el unico constructor autorizado de documentos `auditLogs`.

## Contrato allowlist

- `before` y `after`: esquema explicito por `entityType`.
- `metadata`: esquema explicito por `action`.
- Objetos anidados: esquema propio para alcance de programaciones, licenciamiento, recordatorios y fuentes de tareas.
- Tipo o accion desconocidos: se conservan encabezados de trazabilidad, pero se omiten snapshots y metadata.
- Arrays: maximo 200 elementos; strings: maximo 1.000 caracteres.

Se conservan principalmente:

- IDs y relaciones.
- Nombre operativo de entidades.
- Estado anterior/nuevo.
- Fechas y actores.
- Roles/asignaciones.
- Alcance estructurado de programaciones.
- Conteos y codigos de razon controlados.

## Clasificacion

| Clase | Ejemplos | Tratamiento |
|---|---|---|
| Operacional | IDs, nombres, estados, fechas, roles, conteos | Permitido por allowlist |
| Personal | Correo del actor | Permitido solo para trazabilidad; acceso restringido |
| Restringido | Servidor, usuario SQL, destinatarios, errores externos, texto libre | Omitido de snapshots/metadata |
| Secreto | Password, hashes, JWT, refresh/reset token, cookie, authorization, API key, connection string, private key | Nunca persistido |

## Defensa por contenido

Incluso un campo permitido se reemplaza por `[REDACTED]` si contiene:

- `Authorization: Bearer`.
- Estructura JWT.
- Private key PEM.
- Password/secret/token/API key/cookie asignado.
- Componentes de connection string.
- SAS o token en query string.
- Credenciales embebidas en URL.

Esto protege casos donde un secreto llega bajo una clave aparentemente legitima como `reason`.

## Prohibiciones

Nunca pasar a `writeAuditLog`:

- `HttpRequest`, `Request` o `Response`.
- Body HTTP completo.
- Headers.
- Cookies.
- Authorization.
- Objetos de error completos o stack traces.
- Configuracion completa de proveedor.
- Registro de base con `dbAccess` sin DTO.

Aunque un handler incumpla esta regla, la allowlist descarta las claves no aprobadas.

## Saneamiento historico

Compilar primero:

```powershell
Set-Location api
npm run build
```

Simulacion, sin escrituras:

```powershell
npm run security:sanitize-audit
```

Aplicacion:

```powershell
npm run security:sanitize-audit -- --apply
```

El script:

- No imprime documentos ni valores.
- Reporta solo modo, cantidad revisada y cantidad modificada.
- Conserva `id`, `performedAt`, `clientId` y demas encabezados aprobados.
- Reemplaza el mismo documento; no elimina trazabilidad.
- Registra `audit_logs_sanitized` con conteos al terminar.
- Es idempotente: una nueva simulacion debe producir `updated: 0`.

Las variables Cosmos se suministran desde un canal seguro y se eliminan del proceso al terminar. Nunca escribir la connection string en comandos versionados, logs o documentos.

Ejecucion productiva del 2026-06-30:

- Simulacion inicial: 2.027 revisados, 1.431 por sanear.
- Aplicacion: 2.027 revisados, 1.431 saneados.
- Verificacion posterior: 2.028 revisados, 0 pendientes (incluye el evento resumen de saneamiento).

## Migracion SQL

- Sanear antes del snapshot/export.
- El importador SQL debe reconstruir columnas desde el DTO clasificado, no almacenar el JSON historico sin validacion.
- `before`/`after` pueden conservarse como JSON controlado solo si vuelven a validarse con el mismo contrato.
- No crear una columna generica para body HTTP o headers.
- Restringir lectura de auditoria a roles autorizados y auditar exportaciones.

## Pruebas

`api/src/tests/auditLog.test.ts` cubre:

- Generacion de ID/fecha.
- Allowlists por entidad y accion.
- Objetos anidados autorizados.
- Tipos/eventos desconocidos.
- Password, secret, token, JWT, authorization, cookie, API key y connection string.
- Secretos bajo claves genericas y campos permitidos.
- Body/headers anidados.
- Conservacion de identidad/fecha/particion al sanear historico.
