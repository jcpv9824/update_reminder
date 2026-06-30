# Rate limiting, lockout y proteccion contra abuso

Fecha de implementacion: 2026-06-30
Control: SEC-005 (P1)

## Objetivo

Reducir fuerza bruta, enumeracion automatizada, spam de correo, consumo indebido y denegacion de servicio en endpoints sensibles. El control vive en backend y no depende de que el frontend o el cliente respeten la interfaz.

## Arquitectura

- Middleware: `api/src/lib/rateLimit.ts`.
- Almacen distribuido: Cosmos DB, contenedor `securityRateLimits`, partition key `/id`.
- Expiracion: TTL habilitado en el contenedor; cada registro define su propio `ttl`.
- Concurrencia: reemplazo condicional por `_etag`, con reintentos ante conflictos `409/412`.
- Identificadores: HMAC-SHA256 con `RATE_LIMIT_HASH_SECRET`; si no existe, usa `JWT_SECRET` como respaldo.
- Respuesta de bloqueo: HTTP `429`, cuerpo generico y header `Retry-After`.
- Falla del control: si Cosmos no permite evaluar el limite, los endpoints protegidos fallan cerrados con `503`.

No se guardan en los contadores:

- IP en claro.
- Correo en claro.
- Token de restablecimiento.
- Contraseña.
- JWT.
- Destinatario en claro.

## Politicas

| Flujo | Limite | Ventana | Bloqueo | Claves |
|---|---:|---:|---:|---|
| Solicitudes de login | 10 | 5 minutos | 15 minutos | IP + correo normalizado |
| Fallos de login | 5 | 15 minutos | 15 minutos, desde el quinto fallo | IP + correo normalizado |
| Olvide mi contraseña | 5 | 1 hora | 1 hora | IP + correo normalizado |
| Restablecer contraseña | 10 | 1 hora | 1 hora | IP + token seudonimizado |
| Setup inicial/cambio admin | 5 | 1 hora | 1 hora | IP + identidad solicitada |
| Correo de prueba | 10 | 10 minutos | 30 minutos | IP + usuario/destinatario |
| Recordatorio administrativo de prueba | 10 | 10 minutos | 30 minutos | IP + administrador |
| Reporte maestro | 5 | 1 hora | 1 hora | IP + usuario |
| Bienvenida/reset/reenvio de credenciales | 10 | 1 hora | 1 hora | IP + administrador/usuario objetivo |

Una autenticacion valida elimina el contador de fallos de la cuenta. No elimina el contador de la IP: esto evita que una credencial valida permita reiniciar un ataque distribuido desde el mismo origen.

## Auditoria, metricas y alertas

Cada bloqueo escribe, sin identificadores originales:

- Log estructurado: `event=rate_limit_exceeded`.
- Accion de auditoria: `rate_limit_exceeded` o `account_lockout_triggered`.
- Metadata: alcance, tipo de clave y segundos restantes.

Alerta operativa recomendada en Application Insights/Azure Monitor:

```kusto
traces
| where message has '"event":"rate_limit_exceeded"'
| summarize bloqueos=count() by bin(timestamp, 5m)
| where bloqueos >= 10
```

Crear una alerta adicional para `account_lockout_triggered` y revisar diariamente Auditoria. Los umbrales de infraestructura deben ajustarse con trafico real, sin relajar los controles del backend.

## Aprovisionamiento

El contenedor debe existir antes de desplegar el backend:

```powershell
az cosmosdb sql container create `
  --account-name erpupdsch4645-cosmos `
  --resource-group rg-erp-update-scheduler-prod `
  --database-name erp-update-scheduler `
  --name securityRateLimits `
  --partition-key-path /id `
  --ttl -1
```

Generar el secreto sin escribirlo en documentacion ni Git:

```powershell
$rateLimitHashSecret = [Guid]::NewGuid().ToString("N") + [Guid]::NewGuid().ToString("N")
az functionapp config appsettings set `
  --resource-group rg-erp-update-scheduler-prod `
  --name erpupdsch4645-api `
  --settings "RATE_LIMIT_HASH_SECRET=$rateLimitHashSecret" `
  --output none
Remove-Variable rateLimitHashSecret
```

## Migracion a SQL Server

`securityRateLimits` contiene estado tecnico efimero, no datos maestros ni trazabilidad historica. No se exporta ni migra al SQL relacional. Al cambiar de proveedor se debe sustituir por un almacen distribuido con expiracion y operaciones atomicas, preferiblemente Azure Cache for Redis o una tabla SQL dedicada con limpieza automatica. Durante el cutover, iniciar contadores vacios es aceptable.

## Pruebas

```powershell
Set-Location api
npx vitest run src/tests/rateLimit.test.ts
npm test
npm run build
```

Casos cubiertos:

- Permite hasta el umbral.
- Bloquea en el intento correcto.
- Devuelve `429` y `Retry-After`.
- Mantiene el lockout durante el periodo configurado.
- Libera el bloqueo al vencer.
- Separa IP e identidad.
- Permite reset explicito tras login correcto.
- No contiene IP, correo ni token en el ID persistido.
- No confia en el primer valor antepuesto de `X-Forwarded-For`.

## Defensa en profundidad

El middleware protege la regla de cuenta/identidad y funciona entre instancias de Azure Functions. Para absorber volumen antes de consumir Functions/Cosmos, agregar una segunda capa en Azure API Management o Azure Front Door WAF con limites por IP y alertas de Azure Monitor.
