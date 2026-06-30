# Cambios V22 - SEC-005 proteccion contra abuso

Fecha: 2026-06-30

## Implementado

- Rate limiting distribuido en Cosmos DB para login, recuperacion/restablecimiento de contraseña, setup y endpoints manuales de correo.
- Limites simultaneos por IP e identidad; los filtros del frontend no intervienen en la decision.
- Lockout temporal desde el quinto fallo de login dentro de 15 minutos.
- Respuesta uniforme HTTP `429` con `Retry-After`.
- Contenedor `securityRateLimits` con partition key `/id`, TTL y reemplazos condicionales por `_etag`.
- HMAC para no persistir ni registrar IP, correo, token o destinatario en claro.
- Eventos estructurados y auditoria `rate_limit_exceeded` / `account_lockout_triggered`.
- Falla cerrada con `503` si el almacen distribuido no permite evaluar el control.

## Pruebas

- Umbral de solicitudes y respuesta `429`.
- Lockout en el intento configurado.
- Expiracion y apertura de nueva ventana.
- Contadores independientes por IP e identidad.
- Limpieza del contador de cuenta tras autenticacion valida.
- Seudonimizacion de identificadores.
- Seleccion defensiva del origen desde `X-Forwarded-For`.

## Operacion

- `SECURITY_RATE_LIMITING.md` documenta politicas, aprovisionamiento, alerta de Azure Monitor y estrategia para SQL.
- `securityRateLimits` es efimero y no se incluye en la migracion de datos de negocio a SQL Server.
- Se recomienda Azure API Management o Front Door WAF como segunda capa perimetral.
