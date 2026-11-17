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

Orden (`companyStorageSetup.ts`):

1. Validar todo (imagen incluida) y que el servidor del almacenamiento sea aprobado y público.
2. Abrir la base y revisar que sea la pedida, que exista `parametros_web` con esas columnas y
   **exactamente una fila**, y que el usuario pueda actualizarla.
3. **Probar el almacenamiento de verdad:** escribir, leer (comparando SHA-256) y borrar un
   archivo de prueba en `{base}/{ruta base}.portal-sag-web/`. Listar no basta.
4. **Confirmación ligada a lo que se vio:** si ya había otros valores, un logo o imágenes en la
   carpeta, responde **409** con la lista de cambios (sin llaves), `hasLogo` (nunca la URL
   guardada: podría traer un enlace firmado) y `confirmationToken` = huella SHA-256 de la
   configuración actual (`configurationFingerprint`; las llaves entran solo como su SHA-256). El
   reintento debe traer ese token; si la configuración cambió, otro 409 con `stale: true` y los
   valores nuevos.
5. Subir el logo (si hay).
6. **Una transacción:** `SELECT … WITH (UPDLOCK, HOLDLOCK)`, comprobar que la huella sigue
   siendo la revisada, `UPDATE` (exactamente una fila), releer y verificar **antes** del
   `COMMIT`. Cualquier diferencia revierte todo.

**Semántica de fallos:** todo error trae `databaseChanged: false` y `stage`
(`validation`, `database`, `storage`, `confirmation`, `logo`). La base solo cambia en el
`COMMIT`, que es el último paso; después ya no hay nada que pueda fallar en el módulo. Si el
logo se subió y la base no se actualizó, se borra el logo recién subido
(`uploadedLogoRemoved`). **COMMIT incierto** (se envió y no llegó respuesta): no se borra
nada y se revisa el estado con una conexión nueva; si quedó guardado, es un éxito; si no, se
limpia como en cualquier fallo; si no se puede revisar, responde 502 con
`databaseChanged: "unknown"` y `uploadedLogoKept: true`, y pide revisar con «Probar conexión»
antes de reintentar. Auditoría: `company_storage_configuration_requested` se registra
**antes** y es obligatoria (si falla: 503 y no se toca nada); luego
`company_storage_configured` o `company_storage_configuration_failed`. Si el registro final
falla, la respuesta dice `auditRecorded: false` (el cambio sí se aplicó) y la pantalla lo avisa.
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
- **TLS antes de las credenciales (TDS 7.x, SQL Server 2019):** Tedious 20 continúa al LOGIN7
  sin TLS si el servidor responde en PRELOGIN que no soporta cifrado. El conector envuelve el
  socket con un inspector (`guardTdsSocket`): solo deja pasar paquetes PRELOGIN (0x12, que
  también envuelven el saludo TLS) y registros TLS (0x14–0x17); cualquier otra cosa —en
  particular LOGIN7 (0x10)— corta la conexión antes de escribir un byte. No se usa
  `encrypt: 'strict'` porque exige TDS 8.0 (SQL Server 2022). Prueba de regresión con un
  servidor TDS falso: `api/src/tests/sqlTlsGuard.test.ts`.
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
| POST | `/api/implementation/company-logo/storage/check` | `storage{bucket,accessKey,secretKey,options?}`, `databaseName?` | `{ folder, existing[] }` (con base: también escribe, lee y borra un archivo de prueba) |
| POST | `/api/implementation/company-logo/database/check` | `database{server,databaseName,username,password}` | `{ databaseName, current{hasLogo, bucket, folder, endpoint, port, useSsl, basePath, keysConfigured} }` (sin llaves ni URL) |
| POST | `/api/implementation/company-logo/apply` | `storage`, `database`, `logo?{imageBase64,imageName}`, `confirmationToken?` | `{ databaseName, storageConfigured, databaseChanged, logoUpdated, logoUrl, previousLogoCount, changes, keysChanged, auditRecorded }`; 409 con `requiresConfirmation`, `confirmationToken`, `stale`, `changes`, `hasLogo`; todo error trae `databaseChanged: false` y `stage` |
| POST | `/api/implementation/company-logo/check` y `/upload` | contrato anterior | **Compatibilidad temporal** (`companyLogoLegacy.ts`): solo sube el logo y devuelve el SQL, como antes. Retirar en el despliegue siguiente. |

Permisos: `implementation.company_logo.view` (ver) e `implementation.company_logo.upload`
(«Configurar Almacenamiento y Subir Logo»). Las claves no cambiaron: la migración 029 solo
renombra etiquetas. **Ampliación de alcance:** el mismo permiso `upload`, que antes solo subía el
logo y generaba un SQL, ahora también escribe en la base de la compañía. Antes de publicar hay
que revisar qué roles lo tienen y confirmar que esa ampliación es intencional.

## Página de inicio

Al iniciar sesión (`InicioPage`): Tareas si la persona tiene acceso; si no, la única opción
que tenga; si tiene varias, la bienvenida con la marca del portal («Bienvenido al Portal SAG
Web»). El menú vive en `frontend/src/menu.ts` y lo comparten la barra lateral y el inicio.

## Despliegue, transición y reversión

Antes de publicar:
- `npm run build` y `node scripts/check-company-sql-tls.mjs` (en `api/`) contra una base de
  **pruebas** de SAG Web en SQL Server 2019: por nombre debe pasar TLS + inicio de sesión +
  revisión de `parametros_web` (solo lectura); por IP debe rechazarse por certificado. Solo
  sale con 0 si las dos dan PASS. Lo ejecuta una persona en una terminal interactiva: la
  contraseña se lee en modo crudo, sin eco, y no se guarda; sin terminal interactiva no corre.
- Revisar en `security.role_permissions` qué roles tienen `implementation.company_logo.upload`.

Orden:
1. Migración `029_company_storage_labels.sql` con el ejecutor
   `migration/tools/Apply-PortalSAGWeb-PendingMigrationsThroughSession.ps1` (verifica 13
   migraciones y las etiquetas nuevas). Respaldo antes en producción.
2. Publicar el API (el push a `main` no lo despliega). Sirve las rutas nuevas **y** las
   anteriores (`/check`, `/upload`), así que el frontend publicado sigue funcionando.
3. Push a `main` para el frontend.

Reversión:
- Si falla Actions o el frontend nuevo: no hace falta tocar el API (sigue sirviendo las rutas
  anteriores); se deja o se vuelve a publicar el frontend anterior.
- Si falla el API: volver a publicar el paquete anterior del API **solo si el frontend nuevo
  no se publicó**; si ya se publicó, revertir primero el frontend (el anterior no conoce las
  rutas nuevas) y luego el API.
- La 029 solo cambia etiquetas: no requiere reversión.
- Retirar las rutas `/check` y `/upload` en el despliegue siguiente, con el frontend nuevo ya
  verificado en producción.
