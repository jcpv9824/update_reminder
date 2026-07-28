# Cutover de archivos a SeaweedFS mediante gateway S3

> Este runbook cubre una transferencia física hacia SeaweedFS mediante su gateway S3. El contrato runtime vigente mantiene también Azure Blob y selecciona nuevas escrituras con `OBJECT_STORAGE_PROVIDER`; ver [OBJECT_STORAGE_PROVIDER_SWITCH.md](OBJECT_STORAGE_PROVIDER_SWITCH.md).

## Estado

El adaptador runtime y la migración SQL `024_s3_object_storage.sql` están preparados localmente. No deben desplegarse ni aplicarse en producción hasta recibir el contrato del proveedor, transferir todos los objetos y probar rollback. Azure Blob permanece operativo y no se modifica durante esta preparación.

## Datos que debe entregar infraestructura

- Endpoint raíz HTTPS, sin ruta ni credenciales.
- Confirmación de que el endpoint corresponde al gateway S3 de SeaweedFS, no al Filer ni al Master.
- Región S3 usada para firmar solicitudes; si infraestructura no define otra, `us-east-1`.
- Nombre exacto del bucket privado.
- Confirmación de acceso path-style; el portal usa `true` por defecto.
- Access key y secret key de una cuenta técnica exclusiva del portal.
- CA pública o cadena de certificados confiable desde Azure Functions.
- CORS del gateway/proxy para los orígenes exactos de producción y QA, sin acceso público al bucket.
- Versionado y política de retención del bucket.
- RPO/RTO, capacidad inicial, cuota y alertas.

Las credenciales se crean directamente en Key Vault. Nunca se copian al chat, Git, SQL, archivos locales ni salida de terminal.

## Permisos mínimos de la cuenta técnica

Limitarla al bucket y al prefijo `portal-sag/runtime/*`:

- listar el bucket únicamente bajo ese prefijo;
- leer y consultar metadata de objetos;
- crear objetos;
- borrar objetos;
- consultar ubicación/versionado del bucket si el proveedor lo requiere.

No otorgar creación/eliminación de buckets, cambios de política, administración de usuarios ni acceso a otros prefijos.

## Contrato runtime

```text
OBJECT_STORAGE_PROVIDER=seaweedfs
OBJECT_STORAGE_PREFIX=portal-sag/runtime
OBJECT_STORAGE_SIGNED_URL_SECONDS=300
SEAWEEDFS_ENDPOINT=https://<endpoint-gateway-s3-seaweedfs>
SEAWEEDFS_REGION=us-east-1
SEAWEEDFS_BUCKET=<bucket>
SEAWEEDFS_FORCE_PATH_STYLE=true
SEAWEEDFS_ACCESS_KEY_ID=@Microsoft.KeyVault(SecretUri=<secreto>)
SEAWEEDFS_SECRET_ACCESS_KEY=@Microsoft.KeyVault(SecretUri=<secreto>)
```

Cada objeto nuevo usa una clave derivada de SHA-256. El upload se valida mediante `HEAD`: tamaño y metadata `sha256` deben coincidir. SQL almacena proveedor, bucket, object key, ETag, tamaño, MIME y SHA-256; nunca bytes, credenciales ni URLs firmadas.

La Function App y el Container Apps Job del Constructor de guías deben recibir
la misma configuración SeaweedFS y mantener también la configuración Blob
mientras existan locators históricos. El cambio es `NO-GO` si uno de los dos
hosts no puede cargar, leer y verificar objetos con ambos proveedores.

El upload directo del navegador exige CORS restringido a los orígenes exactos
de producción y QA, métodos `PUT/GET/HEAD` y headers firmados de contenido,
metadata y `Range`. Las URLs prefirmadas son de corta duración; el bucket
permanece privado.

## Secuencia controlada

1. Crear restore point SQL y confirmar versionado/retención en ambos almacenamientos.
2. Entrar en mantenimiento y detener operaciones de carga/reemplazo de archivos.
3. Aplicar la migración 024 mediante el controlador versionado.
4. Inventariar `content.files` y verificar que cada fila tenga tamaño y SHA-256.
5. Leer cada objeto legado sin modificarlo y cargarlo al bucket SeaweedFS mediante S3 con su MIME y metadata `sha256`.
6. Verificar por `HEAD` los conteos, bytes, SHA-256 y claves; cualquier diferencia es `NO-GO`.
7. En una transacción SQL, cambiar cada fila reconciliada a `storage_provider='s3'` y registrar `storage_bucket`, `object_key` y `object_etag`. Conservar temporalmente los localizadores Azure legados.
8. Configurar los App Settings con referencias Key Vault y desplegar el runtime S3.
9. Probar todas las descargas públicas, videos, PDF inline, reemplazos, auditoría y borrado sin referencias.
10. Abrir el portal y observar errores, latencia y actividad de ambos proveedores.
11. Mantener Azure Blob durante el rollback y retirar su configuración, RBAC y servicio sólo mediante operaciones posteriores separadas, tras el periodo aprobado de cero lecturas.

## Reconciliación obligatoria

- mismo número de archivos SQL, objetos transferidos y objetos verificados;
- suma de bytes idéntica;
- SHA-256 idéntico por archivo;
- cero filas sin versión vigente;
- cero claves duplicadas;
- cero objetos huérfanos bajo el prefijo;
- todas las URLs firmadas expiran y el bucket no es público;
- reemplazo crea versión nueva y no rompe versiones históricas;
- borrado físico ocurre sólo cuando SQL confirma cero referencias.

## Rollback

Mientras se conserven objetos y localizadores legados:

1. activar mantenimiento;
2. restaurar el paquete anterior;
3. revertir en una transacción sólo las filas cambiadas durante el corte a `storage_provider='azure_blob'`;
4. restaurar los App Settings anteriores;
5. comprobar descargas y PDF antes de abrir el portal.

No borrar objetos de ningún proveedor durante la ventana de rollback.
