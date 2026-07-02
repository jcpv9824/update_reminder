# Seguridad de contrasenas y MFA (SEC-007)

Fecha: 2026-07-02

## Politica de contrasenas

- Minimo: 14 caracteres. Se recomiendan frases de contrasena.
- Maximo: 72 bytes UTF-8, para evitar truncamiento silencioso de bcrypt.
- Bcrypt: costo 12 en runtime. En tests se permite costo reducido para no ralentizar la suite.
- Se rechazan espacios al inicio/final, contrasenas comunes y valores derivados del nombre o correo.
- Las contrasenas elegidas por una persona se consultan en HIBP Pwned Passwords con k-anonymity. Solo se envia el prefijo SHA-1 de cinco caracteres; nunca sale la contrasena ni el hash completo.
- Las credenciales creadas, restablecidas o reenviadas por un administrador son temporales y tienen `mustChangePassword=true`.
- Una contrasena definitiva expira cada 180 dias por defecto (`PASSWORD_MAX_AGE_DAYS`).
- Cambios, resets y desactivaciones incrementan `tokenVersion` y revocan sesiones existentes.

## MFA

MFA TOTP es obligatorio para:

- Administrador (`admin`).
- Administrador de clientes (`client_manager`).
- Actualizador de bases (`database_updater`), porque puede acceder a credenciales tecnicas cuando tiene asignacion autorizada.

En el primer login valido de un rol sensible, la app muestra una clave TOTP y un enlace `otpauth://`. Tras verificar el primer codigo, entrega diez codigos de recuperacion de un solo uso. La app no crea sesion hasta finalizar el enrolamiento y volver a verificar MFA.

El secreto TOTP se guarda en Azure Key Vault. Cosmos guarda `mfaSecretName`, `mfaEnabled`, `mfaEnrolledAt`, `mfaLastTimeStep` y hashes HMAC de codigos de recuperacion. Nunca se guardan codigos de recuperacion en texto plano.

La sesion guarda `mfaVerifiedAt`; el JWT incluye `amr=[pwd,otp]`. La rotacion del refresh conserva este estado. Si un usuario adquiere un rol sensible, una sesion anterior sin MFA deja de ser aceptada.

## Acciones de paso elevado

Ademas de rol, asignacion y autorizacion de objeto, exigen MFA verificada:

- Copiar o revelar la contrasena de una base de datos.
- Cambiar la contrasena SMTP en Alertas y correos.

## Variables productivas

```text
BCRYPT_COST=12
PASSWORD_MAX_AGE_DAYS=180
PWNED_PASSWORDS_ENABLED=true
PWNED_PASSWORDS_FAIL_CLOSED=true
MFA_ISSUER=Programador de Actualizaciones ERP
MFA_RECOVERY_PEPPER=<secreto aleatorio de al menos 32 bytes>
```

`MFA_RECOVERY_PEPPER` es secreto operativo: no se documenta su valor, no se imprime y no debe reutilizarse fuera de esta aplicacion. Rotarlo invalida los codigos de recuperacion existentes, no los TOTP.

## Recuperacion de cuenta

Si un usuario pierde autenticador y codigos:

1. Un administrador valida su identidad por un canal corporativo externo.
2. Se revocan todas sus sesiones.
3. Se restablece de forma administrativa el estado MFA y se elimina el secreto TOTP de Key Vault mediante un procedimiento auditado. Esta operacion de autoservicio no esta expuesta en la UI actual.
4. En el siguiente login el usuario vuelve a enrolar MFA.

Pendiente operacional: crear un endpoint/UI dedicado para reset MFA con doble control administrativo. Hasta entonces, la recuperacion requiere intervencion tecnica controlada.

## Pruebas

- Backend: `password.test.ts`, `mfa.test.ts`, `authSecurity.test.ts`, `authSessions.test.ts`, `jwt.test.ts`.
- Frontend: `LoginPage.test.tsx`, `UsuariosPage.test.tsx`.
- Siempre ejecutar `npm test`, `npm run build` y auditorias npm antes de desplegar.
