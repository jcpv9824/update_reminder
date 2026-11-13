# Implementación → Agregar logo a la compañía

Sube el logo de una compañía de SAG Web a su almacenamiento S3 (storcube) y
genera el SQL que lo activa (`UPDATE parametros_web SET LogoEmpresa = N'<url>'`).
Se puede repetir las veces que haga falta.

## Reglas de seguridad (no negociables)

- El portal **no guarda** bucket, llaves, URL ni la imagen: no hay tablas, ni
  Key Vault, ni logs de esos datos. Viven solo en memoria durante la solicitud.
- La auditoría registra `company_logo_uploaded`: quién, cuándo y para qué
  compañía (`companyName` = nombre de la base de datos), más `assetKind`,
  `bytes` y `previousLogoCount` (allowlist en `api/src/lib/audit.ts`).
- Servidor, puerto, SSL y ruta base son **fijos** en el API
  (`COMPANY_LOGO_STORAGE`), iguales a `GenerarSQLAlmacenamiento`. El esquema es
  `.strict()`: un endpoint enviado por el cliente se rechaza (sin SSRF).
- Los errores del proveedor se traducen a mensajes controlados; nunca se
  devuelve el detalle técnico. Respuestas con `Cache-Control: no-store`.
- En la pantalla, las llaves se muestran en claro (decisión de negocio: quien
  hace el proceso debe poder leerlas) y se borran al terminar la subida.

## Ruta del logo

`{bucket}/{base de datos}/Archivos/Imagenes/LogoEmpresa/{uuid}.{png|jpg}`

URL resultante: `https://storcube.sagweb.co:8333/{bucket}/{base}/Archivos/Imagenes/LogoEmpresa/{uuid}.png`

## Reemplazo de un logo existente

Si la carpeta ya tiene imágenes, la pantalla las lista y pide confirmación
(«Sí, reemplazar»). Sin confirmación el API responde `409`. **Las imágenes
anteriores no se borran** (igual que SAG Web): el logo vigente sigue
funcionando hasta que se ejecute el SQL nuevo en la base del cliente.

## Detalle técnico: firma S3

El nginx de storcube reenvía el `Host` **sin puerto**. La firma SigV4 se
calcula con el host sin puerto (middleware antes de `httpSigningMiddleware` en
`createCompanyLogoS3Client`); de lo contrario el servidor responde 403
`SignatureDoesNotMatch`.

## Contrato del API

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| POST | `/api/implementation/company-logo/check` | `bucket, accessKey, secretKey, databaseName` | `{ folder, existing: [{ name, bytes, lastModified }] }` |
| POST | `/api/implementation/company-logo/upload` | lo anterior + `imageBase64, imageName, replaceConfirmed` | `{ url, fileName, bytes, replacedCount, sql, sqlFileName }` |

Permisos: `implementation.company_logo.view` (ver la opción) y
`implementation.company_logo.upload` (probar conexión y subir). Límite:
20 solicitudes cada 10 minutos por usuario e IP. Imagen: máximo 2 MB; el tipo
se detecta por el contenido (no por el nombre): PNG, JPG/JPEG, GIF, WEBP y
SVG. El SVG se rechaza si trae scripts, eventos, entidades, contenido
incrustado o enlaces externos. Los RAW de cámara se rechazan con un mensaje
que pide exportarlos como imagen, porque ni el navegador ni SAG Web pueden
mostrarlos. La pantalla no nombra formatos; solo indica el máximo de 2 MB.

## Pantalla

`/implementacion/logo-compania`. Cinco datos: bucket, nombre de la base de
datos de la compañía, llave de acceso, llave secreta e imagen. El botón
«Subir logo y generar SQL» se habilita solo con los cinco. Al terminar, el
`.sql` se descarga automáticamente y queda «Descargar el SQL de nuevo».
Incluye el enlace a la hoja de almacenamiento de las compañías (pestaña nueva).

## Verificación hecha (2026-11-13)

- API: ver el último commit para el conteo de pruebas, `npm run build`, `check:no-cosmos-runtime`.
- Frontend: 228 pruebas, `npm run build`.
- Migración 028: analizador SQL Server 2019 (TSql150) PASS.
- Prueba real del código compilado contra storcube (bucket de pruebas): probar
  conexión, subir con carpeta vacía, bloqueo 409 sin confirmar, subir
  confirmando (la imagen vieja se conserva), SQL generado, llaves ausentes de
  la respuesta, mensaje controlado con llave errada. Las imágenes de prueba se
  borraron al final.
- Pantalla revisada en local con una sesión simulada.

## Pendiente para desplegar (requiere autorización explícita)

1. Aplicar `migration/sql/028_company_logo_permissions.sql` en producción
   (después de un respaldo), igual que la 027.
2. Publicar el API (el push a `main` **no** despliega el API).
3. Push a `main` para desplegar el frontend (después de 1 y 2, para que la
   opción no aparezca sin backend).
4. Asignar `implementation.company_logo.*` a los roles que lo usen
   (`super_admin` lo recibe en la migración).
