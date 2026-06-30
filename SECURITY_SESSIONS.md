# Sesiones JWT endurecidas

Fecha de implementacion: 2026-06-30
Control: SEC-006 (P1)

## Arquitectura

La sesion usa dos credenciales con responsabilidades separadas:

1. **Access token JWT**: dura 10 minutos por defecto, vive solo en memoria del frontend y se envia en `Authorization: Bearer`.
2. **Refresh token opaco**: contiene 256 bits aleatorios, dura 30 dias por defecto y se entrega en cookie `HttpOnly; Secure; SameSite=None`. Cosmos almacena unicamente SHA-256 del token.

El contenedor `authSessions` usa partition key `/id`, TTL y conserva:

- ID de sesion.
- Usuario.
- Hash del refresh token.
- `tokenVersion`.
- Creacion, ultimo uso y expiracion.
- Revocacion, motivo y sesion sucesora.

No guarda el refresh token en claro.

## JWT

Configuracion obligatoria:

- Algoritmo permitido: `HS256` exclusivamente.
- `JWT_SECRET`: minimo 32 bytes.
- `JWT_ACCESS_EXPIRES_IN`: `10m` recomendado.
- `JWT_ISSUER`: `erp-update-scheduler-api`.
- `JWT_AUDIENCE`: `erp-update-scheduler-web`.

Claims verificados:

- `sub`: ID de usuario.
- `iss`: emisor esperado.
- `aud`: audiencia esperada.
- `jti`: identificador unico del access token.
- `sid`: sesion persistida.
- `ver`: version de tokens del usuario.
- `email` y `roles`: contexto firmado; los permisos efectivos se vuelven a leer del usuario persistido.

Cada llamada autenticada verifica firma, algoritmo, emisor, audiencia, expiracion, sesion activa, usuario activo y coincidencia de `tokenVersion`.

## Rotacion y revocacion

- Login crea una sesion y una cookie refresh nueva.
- `POST /api/auth/refresh` revoca el refresh usado y emite uno nuevo.
- Reutilizar un refresh ya rotado se considera replay y revoca la sesion descendiente.
- `POST /api/auth/logout` revoca la sesion y elimina la cookie.
- Reset publico, reset administrativo, reenvio de credenciales y setup incrementan `tokenVersion` y revocan todas las sesiones.
- Desactivar un usuario por PUT o accion dedicada incrementa `tokenVersion` y revoca todas sus sesiones.
- Cambiar roles se refleja inmediatamente porque el backend usa roles persistidos en cada solicitud.

## Frontend y CSRF

- `frontend/src/api/client.ts` elimina cualquier `erp_update_token` legado de `localStorage`.
- El access token solo existe en una variable de modulo y desaparece al cerrar/refrescar la pestaña.
- Al iniciar la app se usa la cookie refresh para recuperar una sesion.
- Ante un `401`, una unica operacion de refresh rota la cookie y reintenta la solicitud una vez.
- Todas las solicitudes incluyen `credentials: include`.
- Refresh y logout requieren `X-Requested-With: XMLHttpRequest`; un sitio externo no puede añadirlo sin un preflight CORS aprobado.

La cookie usa `SameSite=None` porque frontend y API productivos tienen dominios distintos. A largo plazo se recomienda un dominio comun o BFF para evitar dependencia de politicas de cookies de terceros.

## Configuracion

```text
JWT_SECRET=<secreto aleatorio de al menos 32 bytes>
JWT_ACCESS_EXPIRES_IN=10m
JWT_ISSUER=erp-update-scheduler-api
JWT_AUDIENCE=erp-update-scheduler-web
REFRESH_TOKEN_DAYS=30
AUTH_COOKIE_SECURE=true
```

Para desarrollo HTTP local, usar `AUTH_COOKIE_SECURE=false`; nunca usarlo en produccion.

## Aprovisionamiento

```powershell
az cosmosdb sql container create `
  --account-name erpupdsch4645-cosmos `
  --resource-group rg-erp-update-scheduler-prod `
  --database-name erp-update-scheduler `
  --name authSessions `
  --partition-key-path /id `
  --ttl -1
```

No rote `JWT_SECRET` durante un despliegue ordinario. Rotarlo invalida todos los access tokens; las cookies refresh pueden emitir access tokens nuevos si sus sesiones siguen vigentes, pero se recomienda revocar todas las sesiones cuando la rotacion sea respuesta a un incidente.

## Migracion a SQL Server

`authSessions` es estado de seguridad temporal, no maestro historico. No se migran sesiones activas desde Cosmos durante el cutover. La migracion debe cerrar sesiones existentes y recrear el almacenamiento en SQL o Redis con:

- PK unica por sesion.
- Indice por `user_id` para revocacion masiva.
- Expiracion automatica o job de limpieza.
- Actualizacion condicional para rotacion atomica.
- Hash del refresh token; nunca valor en claro.

## Pruebas

- `api/src/tests/jwt.test.ts`.
- `api/src/tests/authSessions.test.ts`.
- `api/src/tests/authSecurity.test.ts`.
- `frontend/src/tests/ApiClient.test.ts`.

Los casos incluyen algoritmo, claims, secreto minimo, expiracion corta, rotacion, replay, revocacion, version, cookie, anti-CSRF, eliminacion del JWT legado y reintento tras `401`.

## Efecto del primer despliegue

Los JWT emitidos antes de SEC-006 no contienen `sid`, `ver`, `iss`, `aud` ni `jti` y son rechazados. Los usuarios deberan iniciar sesion una vez despues del despliegue para crear la nueva sesion segura.
