# Implementación → Almacenamiento de archivos y logo

Configura el almacenamiento de archivos de una compañía de SAG Web **directamente en su
`parametros_web`** y, si se adjunta, sube el logo y lo deja activo. Se puede repetir las
veces que haga falta. (Antes se llamaba «Agregar logo a la compañía» y solo generaba un SQL.)

## Por qué escribe en la base

Los formatos de impresión pintan el logo con `<img src="{{urlLogo}}">`, y `urlLogo` sale de
`(SELECT TOP 1 LogoEmpresa FROM parametros_web)` (dos formatos usan como respaldo
`parametros.ss_ruta_logo`). La URL apunta a un bucket **privado** (una lectura anónima
responde 403), así que SAG Web solo puede mostrarla con los datos del almacenamiento de
`parametros_web`. El logo funciona cuando `LogoEmpresa` tiene la URL nueva **y** el
almacenamiento está configurado con el mismo bucket y carpeta. Esta opción escribe las dos
cosas en una sola transacción.

## Pantalla (`/implementacion/logo-compania`)

1. **Almacenamiento de objetos:** Bucket y Access key (misma fila), Secret key (fila completa),
   enlace a la hoja de almacenamiento (pestaña nueva) y «Probar conexión».
   Desplegable **«Configurar parámetros adicionales (opcional)»**: servidor
   (`storcube.sagweb.co`), puerto (`8333`), ruta base (`Archivos/`) y región
   (`us-east-1`), con «Restaurar valores por defecto». El cifrado no se puede quitar:
   siempre HTTPS (`MinioUseSSL = 'S'`).
2. **Acceso a la base de datos de la compañía:** servidor y puerto (`servidor,puerto`, como
   SSMS; sin puerto usa 1433; no se admiten instancias con nombre), nombre de la base de datos (también es la carpeta del
   almacenamiento), usuario de SQL, contraseña y «Probar conexión» (no escribe nada).
3. **Logo (opcional):** imagen de máximo 2 MB con vista previa.

Botones: **«Configurar almacenamiento de archivos»** (secciones 1 y 2) y **«Configurar
almacenamiento de archivos y subir nuevo logo»** (secciones 1 y 2 + imagen).

Todos los campos llevan *trim*. No admiten espacios: bucket, access key, secret key,
servidor y puerto, nombre de la base y usuario de SQL. La contraseña solo pierde los espacios
de los extremos.

**Avisos:** el resultado aparece anclado arriba de la ventana visible (`AvisoFlotante`,
`position: fixed`), aunque se haya bajado con el scroll. Éxito e información se ocultan a los
8 segundos; el error se queda hasta cerrarlo. Queda copia del último resultado arriba del
formulario.

## Qué escribe

`UPDATE parametros_web` (debe afectar exactamente una fila; si no, se revierte):
`MinioNameEnterprise` (= nombre de la base), `MinioBucketName`, `MinioAccessKey`,
`MinioSecretKey`, `MinioEndpoint`, `MinioPort`, `MinioUseSSL` (siempre `S`), `MinioBasePath` y,
con logo, `LogoEmpresa`. `MinioPublicBaseUrl` no se toca.

Antes de escribir revisa que la base sea la pedida, que exista `parametros_web` con esas
columnas y **exactamente una fila** (con varias, no escribe nada), y que el usuario pueda
actualizarla. Si ya había otros valores, un logo
o imágenes en la carpeta, responde **409** con la lista de cambios (sin llaves) y la pantalla
pide confirmación («Sí, reemplazar»). Después de escribir vuelve a leer y confirma.
**Las imágenes anteriores no se borran.**

Ruta del logo: `{bucket}/{base}/{ruta base}Imagenes/LogoEmpresa/{uuid}.{png|jpg|gif|webp|svg}`.
El nombre del bucket va en la URL por diseño (rutas `servidor/bucket/objeto`).

## Reglas de seguridad

- El portal **no guarda** bucket, llaves, servidor, usuario ni contraseña de SQL, URL ni
  imagen: viven solo en memoria durante la solicitud. No van a logs, auditoría ni respuestas
  (`Cache-Control: no-store`). Las llaves sí quedan en `parametros_web` del cliente, donde
  SAG Web las necesita.
- Solo consultas fijas y parametrizadas (`companyDatabase.ts`); nunca SQL de la persona.
- SQL cifrado **con certificado validado** (`trustServerCertificate: false`): se comprueba la
  identidad del servidor antes de enviar la contraseña. Si el servidor no presenta un
  certificado válido para ese nombre, la pantalla pide usar el nombre del certificado (no la
  IP) o instalar uno válido. Tiempos límite de 15 s; pool de una conexión que se cierra al
  terminar.
- Servidores SQL sin lista de permitidos (decisión de negocio), pero el nombre debe resolver
  **solo a direcciones públicas** (`outboundGuard.ts`): se rechazan loopback, redes privadas,
  CGNAT, link-local (incluye metadatos de Azure `169.254.169.254`), multicast y equivalentes
  IPv6. El filtro se aplica **en la conexión real**: tedious usa un conector propio
  (`createGuardedSqlConnector`) y el cliente S3 un agente HTTPS con `lookup` filtrado
  (`createGuardedLookup`), así que el transporte solo se conecta a direcciones validadas en ese
  momento (también si el servidor SQL redirige). El certificado se valida con el nombre
  original. Las instancias con nombre se rechazan porque su búsqueda por UDP no pasaría por el
  filtro.
- Almacenamiento: **siempre HTTPS** y solo servidores aprobados. La lista se configura en el
  API con `COMPANY_STORAGE_ALLOWED_HOSTS` (separada por comas, admite `*.dominio`); por defecto
  `storcube.sagweb.co,*.sagweb.co`. Además debe resolver solo a direcciones públicas.
- Errores de SQL Server y del almacenamiento traducidos a mensajes controlados en español.
- Auditoría `company_storage_configured`: quién, cuándo, en qué base (`companyName`) y
  `logoUpdated`, `assetKind`, `bytes`, `previousLogoCount`, `changedFieldCount`,
  `keysChanged`. Nada más.
- Límite: 20 solicitudes cada 10 minutos por usuario e IP.

### SVG: limpieza estructural (`api/src/lib/svgSanitizer.ts`)

El SVG se analiza como XML (`@xmldom/xmldom`) y se **reconstruye** con una lista blanca; se
sube el resultado, nunca el original. Se rechaza con código, eventos, DTD, animaciones,
`feImage`, referencias externas o CSS peligroso; se descartan en silencio los metadatos de
editores. RAW de cámara: se rechaza pidiendo exportarlo como imagen.

### Detalle técnico: firma S3

El nginx de storcube reenvía el `Host` **sin puerto**; la firma SigV4 se calcula igual
(middleware antes de `httpSigningMiddleware`).

## Contrato del API

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| POST | `/api/implementation/company-logo/storage/check` | `storage{bucket,accessKey,secretKey,options?}`, `databaseName?` | `{ folder, existing[] }` |
| POST | `/api/implementation/company-logo/database/check` | `database{server,databaseName,username,password}` | `{ databaseName, current{…sin llaves} }` |
| POST | `/api/implementation/company-logo/apply` | `storage`, `database`, `logo?{imageBase64,imageName}`, `confirmed` | `{ databaseName, storageConfigured, logoUpdated, logoUrl, previousLogoCount, changes, keysChanged }` o 409 con `requiresConfirmation` |

Permisos: `implementation.company_logo.view` (ver) e `implementation.company_logo.upload`
(«Configurar Almacenamiento y Subir Logo»). Las claves no cambiaron: la migración 029 solo
renombra etiquetas, así que los roles que ya tenían la opción la conservan.

## Página de inicio

Al iniciar sesión (`InicioPage`): Tareas si la persona tiene acceso; si no, la única opción
que tenga; si tiene varias, la bienvenida con la marca del portal («Bienvenido al Portal SAG
Web»). El menú vive en `frontend/src/menu.ts` y lo comparten la barra lateral y el inicio.

## Despliegue

1. Migración `029_company_storage_labels.sql` con el ejecutor
   `migration/tools/Apply-PortalSAGWeb-PendingMigrationsThroughSession.ps1` (verifica 13
   migraciones y las etiquetas nuevas). Respaldo antes en producción.
2. Publicar el API (el push a `main` no lo despliega).
3. Push a `main` para el frontend (después de 1 y 2).
