# CAMBIOS V28 - Acceso de un solo paso

Fecha: 2026-07-06

- Se retiro MFA/TOTP del login, renovacion de sesiones y acciones sensibles por decision de producto.
- El acceso usa correo y contrasena en un solo paso para todos los roles.
- Se retiro `otplib`, la UI de enrolamiento, los codigos de recuperacion y la columna MFA de usuarios.
- Se mantienen contrasenas robustas, HIBP, rate limiting, lockout, sesiones rotatorias, revocacion, autorizacion por objeto y auditoria.
- Los campos MFA heredados quedan inertes y ocultos; no se migraran al SQL operativo.
- SEC-007 queda documentado como parcial por el riesgo residual aceptado al no usar segundo factor.
