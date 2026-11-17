# Plan — Almacenamiento de archivos y logo directo en la base, avisos visibles y página de inicio

**Fecha:** 2026-11-17 · **Versión:** 2 (ajustada con la retroalimentación de Juan Camilo)
**Estado:** esperando aprobación para construir.
**Documentación del paso a paso:** en pausa hasta cerrar estos cambios.

---

## 0. Qué encontramos sobre el logo que no carga (sin conectarse a ninguna compañía)

- Los formatos (`A_format_SAG_WEB 2026-09-15.sql`, tabla `fuentes_formatos_html`) pintan el logo
  con `<img src="{{urlLogo}}">`, y `urlLogo` sale de
  `(SELECT TOP 1 LogoEmpresa FROM parametros_web)`. Dos formatos usan como respaldo
  `parametros.ss_ruta_logo` (la ruta del logo de SAG Clásico).
- `LogoEmpresa` guarda la URL completa del almacenamiento, igual a como la deja SAG Web.
- Esa URL **no abre sin llaves**: una consulta anónima a un logo que subió el propio SAG Web
  responde **403** (bucket privado). Para mostrarla, SAG Web tiene que leerla con los datos
  del almacenamiento de `parametros_web` (`MinioEndpoint`, `MinioBucketName`, llaves, etc.).
- Conclusión: el logo depende de **dos cosas en la base de la compañía**: que `LogoEmpresa`
  tenga la URL nueva, y que el almacenamiento esté configurado y coincida con esa URL (mismo
  bucket y misma carpeta = nombre de la base). Hoy el portal no escribe ninguna de las dos;
  solo descarga un SQL. Eso es lo que corrige este cambio.

## 1. Pantalla «Almacenamiento de archivos y logo»

Mantiene la regla: el aviso de éxito o error siempre se ve (sección 2).

### Sección 1 — Almacenamiento de objetos
| Fila | Campos |
|---|---|
| 1 | **Bucket** (mitad izquierda) · **Access key** (mitad derecha) |
| 2 | **Secret key** (fila completa) |

- Texto bajo la sección: «Los datos del almacenamiento de cada compañía están en la hoja de
  almacenamiento» con el enlace (pestaña nueva).
- **Probar conexión**.
- Desplegable cerrado: **«Configurar parámetros adicionales (opcional)»** con servidor
  (`storcube.sagweb.co`), puerto (`8333`), SSL (sí), ruta base (`Archivos/`) y región (`us-east-1`).
- **No** lleva el nombre de la base: la carpeta se toma de la sección 2.

### Sección 2 — Acceso a la base de datos de la compañía
- **Servidor y puerto** (un solo campo, como en SSMS: `servidor,puerto` o `IP,puerto`).
- **Nombre de la base de datos** (también es la carpeta del almacenamiento).
- **Usuario de SQL** · **Contraseña**.
- **Probar conexión**: entra, confirma que existe `parametros_web` y que el usuario puede
  actualizarla. No escribe nada.
- Sin lista de servidores permitidos: se escribe el servidor que sea (decisión de Juan Camilo).

### Sección 3 — Logo (opcional)
- Adjuntar imagen, máximo 2 MB, con vista previa.

### Botones
| Botón | Se habilita con | Qué escribe en `parametros_web` |
|---|---|---|
| **Configurar almacenamiento de archivos** | Secciones 1 y 2 completas | Los 8 campos del almacenamiento (los mismos de `GenerarSQLAlmacenamiento.exe`; `MinioPublicBaseUrl` no se toca) |
| **Configurar almacenamiento de archivos y subir nuevo logo** | Secciones 1 y 2 completas + imagen | Sube la imagen y escribe los 8 campos **y** `LogoEmpresa`, en una sola transacción |

- Antes de escribir: si ya hay logo o el almacenamiento tiene otros valores, se pide
  confirmación mostrando qué cambia (sin mostrar llaves).
- Después de escribir: se vuelve a leer `parametros_web` y se confirma que quedó lo enviado.

### Validación de todos los campos
- **Trim** a todos.
- **Sin espacios:** bucket, access key, secret key, servidor y puerto, nombre de la base,
  usuario de SQL. La contraseña sí puede tener espacios por dentro (solo se le quitan los de
  los extremos).
- Mensajes en español que dicen qué está mal y cómo corregirlo.

## 2. Avisos siempre visibles
- El resultado aparece **anclado arriba de la ventana visible**, aunque se haya bajado con el scroll.
- El éxito se oculta solo; el error se queda hasta que se cierre. Queda copia arriba del formulario.

## 3. Página de inicio según permisos (cambio pequeño)
Al iniciar sesión:
1. Si tiene acceso a **Tareas**, entra a Tareas (como hoy).
2. Si no, y tiene **una sola opción**, entra directo a esa opción
   (ej.: quien solo tiene «Agregar logo» entra ahí).
3. Si tiene varias, ve la **bienvenida**: logo de SAG + «PORTAL SAG WEB» como en el menú
   lateral, y el texto «Bienvenido al Portal SAG Web». Nada más.

Esto reemplaza el «No tiene permiso para ver esto» que ve hoy quien no tiene Tareas.
La pantalla de iniciar sesión lleva la misma marca.

## 4. Seguridad
- Llaves, usuario y contraseña de SQL no se guardan en el portal: solo en memoria durante la
  solicitud. No van a logs, auditoría ni respuestas (`Cache-Control: no-store`).
- Las llaves sí quedan en `parametros_web` del cliente, donde SAG Web las necesita.
- Solo consultas fijas y parametrizadas; nunca SQL escrito por la persona.
- Conexión SQL cifrada, confiando en el certificado del servidor (como la casilla «Trust server
  certificate» de SSMS), con tiempo límite. Límite de intentos por usuario.
- Auditoría: quién, cuándo, en qué base y qué acción. Nada más.
- Permiso propio para escribir en la base del cliente.

## 5. Riesgo a validar primero
El API corre en Azure: hay que confirmar que desde ahí se llega a los servidores SQL de los
clientes (firewall). Si no se llega, se mantiene «Descargar SQL» como respaldo.

## 6. Orden de trabajo
1. API: conexión SQL temporal, configurar almacenamiento, logo, validaciones, pruebas.
2. Pantalla: tres secciones, parámetros adicionales, avisos anclados, pruebas.
3. Inicio por permisos + bienvenida + marca en el login, pruebas.
4. Prueba local de punta a punta contra una base de pruebas; migración de permisos (029).
5. Prompt para que Codex despliegue.
6. Retomar el plan de documentación del paso a paso con el flujo nuevo.
