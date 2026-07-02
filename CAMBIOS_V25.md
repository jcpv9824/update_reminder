# Cambios V25 - SEC-007 contrasenas y MFA

Fecha: 2026-07-02

- Politica de contrasenas de minimo 14 caracteres, passphrases y bcrypt costo 12.
- Rechazo de contrasenas comunes, comprometidas o derivadas del nombre/correo.
- Cambio obligatorio de credenciales temporales y expiracion configurable a 180 dias.
- MFA TOTP obligatorio para admin, client_manager y database_updater.
- Secretos MFA en Key Vault, anti-replay y codigos de recuperacion de un solo uso.
- MFA adicional para revelar passwords de bases y cambiar password SMTP.
- Login en espanol para cambio obligatorio, enrolamiento, verificacion y recuperacion.
