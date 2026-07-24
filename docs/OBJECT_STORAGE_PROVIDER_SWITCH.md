# Switch de almacenamiento privado: MinIO/S3 y Azure Blob

Estado: **implementado en runtime; pendiente de configurar y ensayar en QA**.

Portal SAG Web admite dos proveedores privados simultáneamente:

- `s3`: MinIO o cualquier endpoint S3 compatible con TLS.
- `azure_blob`: Azure Blob Storage mediante identidad administrada.

`OBJECT_STORAGE_PROVIDER` selecciona únicamente el proveedor de **nuevas escrituras**. Las lecturas, URLs firmadas y limpiezas compensatorias usan el `storage_provider` guardado en `content.files`, por lo que los objetos históricos pueden permanecer en el proveedor donde fueron creados.

## Contrato de configuración

Configuración común:

```text
OBJECT_STORAGE_PROVIDER=s3
OBJECT_STORAGE_PREFIX=portal-sag/runtime
OBJECT_STORAGE_SIGNED_URL_SECONDS=300
```

El switch solo acepta `s3` o `azure_blob`. Si hay variables de un proveedor pero falta el switch, el runtime falla de forma cerrada.

### MinIO/S3

```text
OBJECT_STORAGE_ENDPOINT=https://<endpoint>
OBJECT_STORAGE_REGION=us-east-1
OBJECT_STORAGE_BUCKET=<bucket-privado>
OBJECT_STORAGE_FORCE_PATH_STYLE=true
OBJECT_STORAGE_ACCESS_KEY_ID=@Microsoft.KeyVault(SecretUri=<secret-uri>)
OBJECT_STORAGE_SECRET_ACCESS_KEY=@Microsoft.KeyVault(SecretUri=<secret-uri>)
```

Las credenciales deben limitarse al bucket/prefijo del portal y mantenerse en Key Vault. El endpoint debe ser HTTPS raíz, sin credenciales, path, query ni fragment.

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

## Semántica que no cambia

- `Descargas Públicas` genera `Content-Disposition: attachment`, incluso para videos.
- `Archivos Públicos` genera `Content-Disposition: inline` para PDF, imágenes y videos permitidos.
- Formatos de impresión conserva visualización inline y descarga forzada en endpoints separados.
- SQL conserva proveedor, locator, tamaño, MIME, SHA-256, ETag y versiones; nunca bytes Base64, credenciales ni URLs firmadas.

## Procedimiento seguro de cambio

1. Mantener configurados ambos proveedores mientras existan filas de ambos tipos en `content.files`.
2. Probar conectividad y permisos reversibles en QA.
3. Crear un archivo pequeño con el proveedor actual y verificar carga, lectura, disposición y SHA-256.
4. Cambiar solo `OBJECT_STORAGE_PROVIDER`.
5. Reiniciar el slot QA y repetir la prueba con el otro proveedor.
6. Confirmar que el archivo anterior todavía abre; esto prueba lectura multi-proveedor.
7. Ensayar rollback restaurando el valor anterior del switch.
8. Promover el mismo cambio mediante slot de producción y health gates; no editar filas SQL para cambiar el proveedor de nuevas escrituras.

Cambiar el switch no migra objetos existentes. Una transferencia entre proveedores es una operación independiente que exige copia, verificación byte count/SHA-256, actualización transaccional del locator SQL y rollback probado.

## Puertas antes de producción

- API tests y build correctos.
- Para MinIO/S3: migración `024` aplicada y constraints de `content.files` trusted. Azure Blob puede operar de forma compatible con el schema Azure legado mientras se pospone esa migración.
- Identidad/credenciales con mínimo alcance.
- TLS estricto y acceso público deshabilitado.
- Pruebas de attachment, inline y video Range en QA.
- Carga, lectura, reemplazo, compensación y rollback con ambos proveedores.
- Backup/restore SQL y restauración del switch probados.

Azure Blob conserva compatibilidad de lectura y escritura con el schema legado anterior a `024`. MinIO/S3 sigue bloqueado hasta que existan sus columnas provider-neutral; el switch nunca intenta guardar un locator S3 en columnas Azure.
