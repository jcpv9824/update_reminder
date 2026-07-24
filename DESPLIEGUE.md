# Despliegue de Portal SAG Web

Portal SAG Web usa SQL Server como única base operacional, un bucket privado S3 compatible con MinIO para archivos y Azure Key Vault para secretos. El runtime no requiere ni aprovisiona una base documental.

## Componentes

- Frontend React en Azure Static Web Apps.
- API Node.js 20 en Azure Functions.
- SQL Server 2019 `PortalSAGWeb`.
- Bucket privado S3/MinIO del proveedor de infraestructura para documentos, videos y PDF.
- Azure Key Vault para la contraseña SQL, SMTP y accesos técnicos de las bases administradas.

## Requisitos

- PowerShell 7.
- Node.js 20.19 o superior.
- Azure CLI con sesión iniciada.
- Azure Functions Core Tools v4.
- Esquema SQL al día y login de runtime con el rol `portal_runtime`.
- Identidad administrada de la Function App con acceso de lectura a los secretos requeridos en Key Vault.
- Endpoint S3/MinIO HTTPS, región, bucket privado y credenciales limitadas al prefijo `portal-sag/runtime/`.

## Validación obligatoria

```powershell
cd api
npm ci
npm run check:no-cosmos-runtime
npm run build
npm test
npm run security:audit:prod

cd ..\frontend
npm ci
npm run build
npm test
```

`check:no-cosmos-runtime` falla si el paquete vuelve a incluir el SDK, variables o adaptadores del backend retirado.

## Configuración de la Function App

Use referencias de Key Vault. No escriba contraseñas en archivos, comandos compartidos ni App Settings.

```text
DATA_BACKEND=sql
SQL_SECURITY_RUNTIME_ENABLED=true
PORTAL_MAINTENANCE_MODE=false
SQL_SERVER_HOST=data14.sagerp.co,54103
SQL_DATABASE=PortalSAGWeb
SQL_USERNAME=<login-runtime>
SQL_PASSWORD=@Microsoft.KeyVault(SecretUri=<uri-versionada-o-sin-version-del-secreto>)
KEY_VAULT_URL=https://<vault>.vault.azure.net/
OBJECT_STORAGE_PROVIDER=s3
OBJECT_STORAGE_ENDPOINT=https://<endpoint-minio>
OBJECT_STORAGE_REGION=us-east-1
OBJECT_STORAGE_BUCKET=<bucket>
OBJECT_STORAGE_PREFIX=portal-sag/runtime
OBJECT_STORAGE_FORCE_PATH_STYLE=true
OBJECT_STORAGE_SIGNED_URL_SECONDS=300
OBJECT_STORAGE_ACCESS_KEY_ID=@Microsoft.KeyVault(SecretUri=<secreto-access-key>)
OBJECT_STORAGE_SECRET_ACCESS_KEY=@Microsoft.KeyVault(SecretUri=<secreto-secret-key>)
APP_TIMEZONE=America/Bogota
DEV_AUTH_ENABLED=false
```

Para usar Azure Blob como destino de nuevas escrituras, conserve las variables S3 si aún existen objetos S3 y cambie:

```text
OBJECT_STORAGE_PROVIDER=azure_blob
AZURE_BLOB_STORAGE_ACCOUNT_URL=https://<cuenta>.blob.core.windows.net
AZURE_BLOB_STORAGE_CONTAINER=<container-privado>
```

La identidad administrada requiere `Storage Blob Data Contributor` en el container y `Storage Blob Delegator` en la cuenta. El switch no mueve archivos existentes; consulte [docs/OBJECT_STORAGE_PROVIDER_SWITCH.md](docs/OBJECT_STORAGE_PROVIDER_SWITCH.md).

También son obligatorios `JWT_SECRET`, `RATE_LIMIT_HASH_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE`, `AUTH_COOKIE_SECURE=true` y la configuración del proveedor de correo aplicable.

No deben existir variables `COSMOS_CONNECTION_STRING` ni `COSMOS_DATABASE_NAME` en el despliegue SQL-only.

## Publicación de la API

```powershell
$resourceGroup = "rg-erp-update-scheduler-prod"
$functionApp = "erpupdsch4645-api"

cd api
npm ci
npm run check:no-cosmos-runtime
npm run build
func azure functionapp publish $functionApp
```

Para un aprovisionamiento nuevo puede usar `scripts/desplegar-azure.ps1`. El script requiere una base SQL existente y pausa para que la contraseña SQL se cree directamente en Key Vault.

## Publicación del frontend

El workflow de Static Web Apps debe ejecutar las pruebas y el build antes de publicar. La variable `VITE_API_BASE_URL` debe apuntar a la Function App productiva.

## Comprobaciones posteriores

1. `GET /api/health` devuelve `200` con:
   - `backend = sql`
   - `sqlConnected = true`
   - `sqlSecurityEnabled = true`
   - `maintenanceMode = false`
2. Las seis funciones temporizadas están habilitadas.
3. Login, refresh y logout funcionan.
4. CRUD de clientes, dominios, bases, licencias y programaciones funciona.
5. La generación manual y automática de tareas es idempotente.
6. Cambios de estado de tareas generan auditoría y mensajes en el outbox.
7. Correo de prueba, reporte maestro y recordatorios se procesan desde el outbox SQL.
8. Descargas, videos y PDF se sirven desde el bucket privado S3/MinIO mediante URLs firmadas de corta duración.
9. Rutas protegidas sin sesión devuelven `401`.
10. Application Insights no muestra `5xx`, excepciones ni errores de SQL/S3.

## Rollback

El rollback vigente restaura una versión anterior del paquete SQL-only y los App Settings previamente exportados. La recuperación de datos se hace mediante backup/restore de SQL Server y versionado/retención del bucket S3/MinIO.

No use una base documental retirada como mecanismo de rollback.

La transferencia del almacenamiento legado al bucket del proveedor se ejecuta con las puertas de [docs/S3_MINIO_OBJECT_STORAGE_CUTOVER.md](docs/S3_MINIO_OBJECT_STORAGE_CUTOVER.md).

## Backups

- SQL Server: backup completo, diferenciales/log según el RPO/RTO acordado y restauración probada en QA.
- S3/MinIO: versionado, política de retención y restauración de una versión probada.
- Key Vault: soft delete y purge protection.
- Los snapshots históricos de migración se conservan cifrados e inmutables durante la retención aprobada; no son una fuente operacional.

## Retiro del servicio anterior

El procedimiento y sus puertas de seguridad están en [docs/COSMOS_RETIREMENT_RUNBOOK.md](docs/COSMOS_RETIREMENT_RUNBOOK.md). La eliminación de la cuenta es una operación separada: solo se ejecuta después de la ventana de cero actividad, el canary sin variables heredadas y las restauraciones verificadas.
