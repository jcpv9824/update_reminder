# CAMBIOS V18 - Copia de contrasenas y correos de credenciales

## Resumen

Esta ronda completa dos ajustes operativos:

- Correccion de copia/visualizacion de contrasenas de bases de datos desde la vista **Tareas**.
- Correos de credenciales para usuarios nuevos y accion **Reenviar contraseña** en **Usuarios y roles**.

## Tareas - contrasenas de bases de datos

- El boton **Ver** ahora alterna correctamente entre **Ver** y **Ocultar**.
- La contraseña revelada se oculta automaticamente despues de 30 segundos.
- El boton **Copiar** usa copia robusta:
  - Intenta `navigator.clipboard.writeText`.
  - Si el navegador bloquea la copia despues de una llamada de red, usa un respaldo con `textarea` temporal.
  - Si tampoco puede copiar, muestra la contraseña para copia manual y avisa al usuario.
- No se precarga la contraseña; se sigue consultando de forma explicita al endpoint seguro.

## Usuarios y roles - credenciales

- Al crear un usuario, el backend envia correo de bienvenida con:
  - Correo de acceso.
  - Contraseña temporal.
  - Roles traducidos al español.
  - Enlace de inicio de sesion.
- Se agrego accion **Reenviar contraseña**.
- Reenviar contraseña genera una contraseña temporal nueva, porque las contrasenas existentes estan hasheadas y no se pueden recuperar.
- La contraseña temporal se genera con aleatoriedad criptografica (`crypto.randomInt`), se guarda como hash y se envia por correo.
- Las plantillas usan el layout corporativo responsivo existente.
- Se audita el reenvio con `user_credentials_resent` y las notificaciones como `password_notification_sent` / `password_notification_failed`.

## Pruebas

- Backend:
  - Plantilla de bienvenida incluye usuario, contraseña, rol y login.
  - Plantilla de reenvio indica nueva contraseña temporal.
  - Traduccion de roles.
  - Generacion de contraseña temporal fuerte y legible.
- Frontend:
  - Tareas permite Ver -> Ocultar contraseña.
  - Copiar contraseña usa endpoint seguro y portapapeles.
  - Usuarios muestra accion Reenviar contraseña, abre modal y llama endpoint.

