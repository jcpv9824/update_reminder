# Switch de almacenamiento privado: SeaweedFS S3 y Azure Blob

Estado: **implementado en runtime; pendiente de configurar y ensayar en QA**.

Portal SAG Web admite dos proveedores privados simultáneamente:

- `seaweedfs`: nuevas escrituras mediante el gateway S3 de SeaweedFS con TLS.
- `azure_blob`: Azure Blob Storage mediante identidad administrada.

`OBJECT_STORAGE_PROVIDER` selecciona únicamente el proveedor de **nuevas escrituras**. Las lecturas, URLs firmadas y limpiezas compensatorias usan el `storage_provider` guardado en `content.files`, por lo que los objetos históricos pueden permanecer en el proveedor donde fueron creados.

El valor runtime `seaweedfs` es deliberadamente distinto del locator SQL
`storage_provider='s3'`. El primero selecciona la implementación actual de
escritura; el segundo conserva el contrato relacional compatible con objetos
S3 históricos.

## Contrato de configuración

Configuración común:

```text
OBJECT_STORAGE_PROVIDER=seaweedfs
OBJECT_STORAGE_PREFIX=portal-sag/runtime
OBJECT_STORAGE_SIGNED_URL_SECONDS=300
```

El switch solo acepta `seaweedfs` o `azure_blob`. Si hay variables de un proveedor pero falta el switch, el runtime falla de forma cerrada. El valor legado `s3` ya no se acepta como selector de escritura.

### SeaweedFS mediante gateway S3

```text
SEAWEEDFS_ENDPOINT=https://<endpoint-raiz-del-gateway-s3-seaweedfs>
SEAWEEDFS_REGION=us-east-1
SEAWEEDFS_BUCKET=<bucket-privado>
SEAWEEDFS_FORCE_PATH_STYLE=true
SEAWEEDFS_ACCESS_KEY_ID=@Microsoft.KeyVault(SecretUri=<secret-uri>)
SEAWEEDFS_SECRET_ACCESS_KEY=@Microsoft.KeyVault(SecretUri=<secret-uri>)
```

Las credenciales deben limitarse al bucket/prefijo del portal y mantenerse en Key Vault. El endpoint es el gateway S3 de SeaweedFS, no el endpoint Filer ni el Master; debe ser una raíz HTTPS sin credenciales, path, query ni fragment. `SEAWEEDFS_FORCE_PATH_STYLE=true` es parte del contrato y la región usada para firmar debe coincidir con la entregada por infraestructura.

La opción protegida `Configuración → Conexiones` permite ingresar y validar
esta configuración sin exponer los secretos. La validación ejecuta el mismo
probe reversible y solo guarda después de una prueba satisfactoria. Guardar el
perfil no cambia `OBJECT_STORAGE_PROVIDER`, no modifica Function App settings
y no habilita SeaweedFS en producción; esos pasos siguen siendo un gate de
despliegue separado.

La comprobación local segura se inicia con:

```text
migration\connect-object-storage\Connect-PortalSAGWeb-SeaweedFS.cmd
```

El launcher solicita endpoint, puerto, bucket, región y credenciales en memoria. El probe reversible de escritura crea, verifica por tamaño/SHA-256, lee y elimina un objeto aleatorio bajo `portal-sag/runtime/connection-tests`; nunca muestra nombres ni valores existentes. `HeadBucket`, listado limitado y consulta de versionado se reportan como diagnósticos opcionales: su ausencia no bloquea porque la cuenta runtime puede estar restringida a objetos/prefijos. El modo de solo lectura no puede demostrar acceso a un objeto sin recibir un locator conocido; para certificar permisos use el probe reversible.

El gateway y su proxy TLS deben permitir las operaciones S3 que usa el portal:
firma SigV4, `ListBucket` limitado al prefijo, `PUT`, `HEAD`, `GET`, `DELETE`,
metadata `x-amz-meta-sha256`, URLs prefirmadas y lectura `Range`. La
compatibilidad se demuestra contra la versión exacta administrada por
infraestructura; no se presupone por el rótulo “S3 compatible”.

### Azure Blob

```text
AZURE_BLOB_STORAGE_ACCOUNT_URL=https://<cuenta>.blob.core.windows.net
AZURE_BLOB_STORAGE_CONTAINER=<container-privado>
```

Durante la actualización se aceptan los aliases históricos `PUBLIC_DOWNLOADS_STORAGE_ACCOUNT_URL` y `PUBLIC_DOWNLOADS_STORAGE_CONTAINER`. Si se configuran alias y nombres nuevos a la vez, sus valores deben coincidir; después del ensayo conviene conservar solo los nombres nuevos.

No se configura una clave de cuenta. La Function App usa `DefaultAzureCredential` y su identidad administrada requiere:

- `Storage Blob Data Contributor` sobre el container para crear, leer y borrar objetos.
- `Storage Blob Delegator` sobre la cuenta para generar SAS de delegación de corta duración.

El container debe tener acceso público deshabilitado.

### Paridad entre API y worker de guías

La Function App y el Container Apps Job del Constructor de guías son dos hosts
independientes. Antes de cambiar `OBJECT_STORAGE_PROVIDER` ambos deben recibir:

- configuración Azure Blob mientras existan locators Blob;
- las seis variables `SEAWEEDFS_*`;
- referencias independientes a los mismos secretos SeaweedFS en Key Vault;
- el mismo prefijo y tiempo de URL firmada.

No se cambia el selector si solo uno de los dos hosts puede leer ambos
proveedores. El worker necesita leer el video fuente y escribir evidencia,
borradores y artefactos; una configuración incompleta deja trabajos durables
en cola pero no procesables.

Para upload directo desde navegador, CORS del gateway SeaweedFS/proxy debe
aceptar únicamente los orígenes exactos de producción y QA, los métodos
`PUT`, `GET` y `HEAD`, y los headers firmados requeridos (`Content-Type`,
`Range` y los `x-amz-*` usados por metadata/checksum). No usar `*` con
credenciales ni abrir el bucket al público.

## Semántica que no cambia

- `Descargas Públicas` genera `Content-Disposition: attachment`, incluso para videos.
- `Archivos Públicos` genera `Content-Disposition: inline` para PDF, imágenes y videos permitidos.
- Formatos de impresión conserva visualización inline y descarga forzada en endpoints separados.
- SQL conserva proveedor, locator, tamaño, MIME, SHA-256, ETag y versiones; nunca bytes Base64, credenciales ni URLs firmadas.

## Procedimiento seguro de cambio

1. Mantener configurados SeaweedFS y Azure Blob mientras existan filas de ambos tipos en `content.files`.
2. Probar conectividad y permisos reversibles en QA.
3. Crear un archivo pequeño con el proveedor actual y verificar carga, lectura, disposición y SHA-256.
4. Cambiar solo `OBJECT_STORAGE_PROVIDER`.
5. Reiniciar el slot QA y repetir la prueba con el otro proveedor.
6. Confirmar que el archivo anterior todavía abre; esto prueba lectura multi-proveedor.
7. Ensayar rollback restaurando el valor anterior del switch.
8. Promover el mismo cambio mediante slot de producción y health gates; no editar filas SQL para cambiar el proveedor de nuevas escrituras.

Cambiar el switch no migra objetos existentes. Una transferencia entre proveedores es una operación independiente que exige inventario, copia, verificación de conteo/bytes/SHA-256, actualización transaccional del locator SQL y rollback probado.

En un rollback del Guide Builder, restaurar
`objectStorageProvider=azure_blob` no autoriza desactivar
`configureSeaweedFS`. Debe permanecer `true` mientras existan uploads o
artefactos con `storage_provider='s3'`, porque el worker todavía necesita la
configuración y los secretos SeaweedFS para leerlos.

## Retiro futuro de Azure Blob

La adopción de SeaweedFS no autoriza deshabilitar o eliminar Azure Blob. Blob
debe permanecer configurado y accesible mientras una fila SQL conserve
`storage_provider='azure_blob'`.

El retiro requiere una operación posterior y explícita:

1. congelar reemplazos y cargas durante la ventana de transferencia;
2. inventariar todas las versiones Blob referenciadas por SQL;
3. copiar cada objeto a SeaweedFS conservando MIME, tamaño y SHA-256;
4. verificar `HEAD` y lectura byte a byte antes de cambiar SQL;
5. cambiar los locators reconciliados en una transacción versionada;
6. demostrar lectura histórica, `Range`, inline, attachment y rollback;
7. observar una ventana aprobada de cero lecturas Blob;
8. retirar App Settings/RBAC y después el servicio Blob como acciones separadas.

Nunca se elimina el container Blob como efecto automático de
`OBJECT_STORAGE_PROVIDER=seaweedfs`.

## Puertas antes de producción

- API tests y build correctos.
- Para SeaweedFS S3: migración `024` aplicada y constraints de `content.files` trusted. Azure Blob puede operar de forma compatible con el schema Azure legado mientras se pospone esa migración.
- Identidad/credenciales con mínimo alcance.
- TLS estricto y acceso público deshabilitado.
- Function App y Guide Builder worker configurados y probados con ambos proveedores.
- CORS de upload/lectura firmado limitado a los orígenes exactos de producción y QA.
- Pruebas de attachment, inline y video Range en QA.
- Carga, lectura, reemplazo, compensación y rollback con ambos proveedores.
- Backup/restore SQL y restauración del switch probados.

Azure Blob conserva compatibilidad de lectura y escritura con el schema legado anterior a `024`. SeaweedFS S3 sigue bloqueado hasta que existan sus columnas provider-neutral; el switch nunca intenta guardar un locator S3 en columnas Azure.
