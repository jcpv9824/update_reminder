# Seguridad de transporte y red de Azure Functions (SEC-010)

Fecha de cierre: 2026-07-03

## Configuracion productiva verificada

- `httpsOnly=true`; HTTP responde 301 hacia HTTPS.
- TLS minimo 1.2 tanto para la aplicacion como para SCM/Kudu.
- HTTP/2 habilitado.
- `ftpsState=Disabled`; no se permite FTP ni FTPS para despliegue.
- Managed Identity del sistema activa.
- CORS contiene un unico origen: `https://agreeable-wave-07469d50f.7.azurestaticapps.net`.
- `localhost`, `127.0.0.1` y el placeholder de Static Web Apps fueron eliminados.

La configuracion se aplica y verifica con:

```powershell
.\scripts\harden-function-transport.ps1
```

## Por que `supportCredentials=true`

El frontend productivo y la Function App son origenes HTTPS distintos. SEC-006 guarda el refresh token en una cookie `HttpOnly; Secure; SameSite=None`, por lo que el navegador exige CORS con credenciales para `/auth/refresh` y `/auth/logout`.

Desactivar `supportCredentials` con la arquitectura actual impediria restaurar y cerrar sesiones correctamente. No se usa `*`: solo se autoriza el origen productivo exacto. El access token permanece en memoria y los endpoints de mutacion de sesion exigen `X-Requested-With`.

La forma futura de pasar a `supportCredentials=false` es servir frontend y API bajo el mismo origen mediante un BFF/reverse proxy, y cambiar la cookie a same-site antes de retirar CORS con credenciales.

## Private Endpoint/VNet

La app usa Azure Functions Consumption clasico, SKU `Y1`/`Dynamic`. Ese plan no admite Private Endpoint entrante ni VNet Integration. Private Endpoint esta disponible para Flex Consumption, Elastic Premium y Dedicated.

Por ahora `publicNetworkAccess=Enabled` es necesario para que Azure Static Web Apps alcance el API. El acceso publico se limita con HTTPS, CORS exacto, JWT/sesiones, autorizacion de objeto, rate limiting y Key Vault.

Antes de manejar un volumen mayor de datos delicados o del cutover SQL se debe evaluar:

1. Migrar Functions a Flex Consumption o Elastic Premium.
2. Crear VNet, subredes y DNS privado.
3. Crear Private Endpoint para Functions y para SQL/Key Vault cuando aplique.
4. Ubicar un frontend/BFF/APIM/Front Door capaz de alcanzar el endpoint privado.
5. Deshabilitar `publicNetworkAccess` solo despues de probar despliegue, timers, login y rollback desde la red autorizada.

Referencias oficiales:

- Azure Functions networking options: https://learn.microsoft.com/azure/azure-functions/functions-networking-options
- App Service Private Endpoints: https://learn.microsoft.com/azure/app-service/overview-private-endpoint
