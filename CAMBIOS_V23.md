# Cambios V23 - SEC-006 sesiones JWT

Fecha: 2026-06-30

## Implementado

- JWT HS256 con secreto minimo de 32 bytes y access token de 10 minutos.
- Claims obligatorios `issuer`, `audience`, `jti`, `sid` y `tokenVersion`.
- Refresh token opaco, hasheado, rotatorio y almacenado en `authSessions` con TTL.
- Cookie refresh `HttpOnly`, `Secure`, `SameSite=None`.
- Deteccion de reutilizacion de refresh token.
- Logout real con revocacion.
- Invalidacion por reset/cambio de contraseña, reenvio de credenciales y desactivacion.
- Frontend sin JWT en `localStorage`; access token solo en memoria.
- Refresh/logout protegidos con encabezado anti-CSRF.

## Compatibilidad

Los JWT antiguos se invalidan por carecer de claims de sesion. Tras desplegar, cada usuario debe iniciar sesion una vez.

## Pruebas

- Claims y algoritmo JWT.
- Rechazo de issuer/audience/algoritmo incorrectos.
- Secreto menor de 32 bytes rechazado.
- Rotacion, replay y revocacion de sesiones.
- `tokenVersion` invalida access tokens.
- Cookie segura y encabezado anti-CSRF.
- Eliminacion de token legado en `localStorage`.
- Refresh y reintento automatico tras `401`.
