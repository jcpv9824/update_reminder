# Seguridad de contrasenas y acceso (SEC-007)

Fecha de decision: 2026-07-06

## Experiencia de acceso

La aplicacion autentica en un solo paso con correo y contrasena. No solicita MFA, TOTP, aplicacion autenticadora ni codigos de recuperacion. Esta es una decision explicita de producto para reducir friccion de acceso.

## Politica de contrasenas

- Minimo: 14 caracteres; se recomiendan frases de contrasena.
- Maximo: 72 bytes UTF-8 para evitar truncamiento silencioso de bcrypt.
- Bcrypt: costo 12 en runtime.
- Se rechazan espacios al inicio/final, contrasenas comunes y valores derivados del nombre o correo.
- HIBP Pwned Passwords se consulta con k-anonymity; solo se envia el prefijo SHA-1 de cinco caracteres.
- Las credenciales creadas, restablecidas o reenviadas por un administrador son temporales y exigen cambio en el primer acceso.
- Las contrasenas definitivas expiran cada 180 dias por defecto.
- Cambios, resets, reenvios y desactivaciones incrementan `tokenVersion` y revocan sesiones existentes.

## Controles compensatorios

- Rate limiting distribuido y bloqueo temporal por IP y cuenta.
- Access JWT de corta duracion con issuer, audience, jti, sid y version.
- Refresh token HttpOnly rotatorio, hasheado y con deteccion de reutilizacion.
- Autorizacion backend por rol, cliente, asignacion y objeto.
- Auditoria de acciones sensibles y acceso explicito a secretos.
- Passwords de bases y SMTP permanecen en Azure Key Vault.

## Riesgo residual aceptado

Sin segundo factor, el compromiso de una contrasena y su sesion puede permitir acciones del rol afectado. La politica reforzada y los controles compensatorios reducen el riesgo, pero no equivalen a MFA. Por eso SEC-007 queda en estado parcial y la decision debe revisarse si aumenta la exposicion, el numero de usuarios o la sensibilidad regulatoria.

## Datos heredados

Los campos MFA que ya existan en documentos Cosmos quedan inertes y no se exponen en API. No se migran al modelo SQL operativo; solo pueden permanecer temporalmente dentro del snapshot bruto cifrado. Los secretos TOTP heredados en Key Vault deben retirarse mediante inventario y borrado controlado, nunca durante un despliegue automatico.

## Variables productivas

```text
BCRYPT_COST=12
PASSWORD_MAX_AGE_DAYS=180
PWNED_PASSWORDS_ENABLED=true
PWNED_PASSWORDS_FAIL_CLOSED=true
```

`MFA_ISSUER` y `MFA_RECOVERY_PEPPER` son obsoletas y deben eliminarse de la Function App despues de desplegar esta version.

## Pruebas

- Backend: `password.test.ts`, `authSecurity.test.ts`, `authSessions.test.ts`, `jwt.test.ts`.
- Frontend: `LoginPage.test.tsx`, `UsuariosPage.test.tsx`.
- Antes de desplegar: `npm test`, `npm run build` y `npm audit` en backend y frontend.
