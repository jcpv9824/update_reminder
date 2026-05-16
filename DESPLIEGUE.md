# Guía de despliegue y ejecución en Azure — versión actualizada

Este documento recoge la guía original y las correcciones aprendidas durante el despliegue real de la aplicación **Programador de Actualizaciones del ERP**.

Está pensado para una persona que **no es experta en Azure** y prefiere trabajar con **PowerShell**.

---

## Estado actual probado

Durante el despliegue real se validó lo siguiente:

- El backend funciona como **Azure Functions**.
- La Function App usada fue `erpupdsch4645-api`.
- El Resource Group usado fue `rg-erp-update-scheduler-prod`.
- La región que funcionó fue `eastus2`.
- La API quedó disponible en:

```text
https://erpupdsch4645-api.azurewebsites.net/api
```

- El primer administrador creado fue:

```text
camilo.palacio@pya.com.co
```

- Para pruebas locales se habilitó:

```text
DEV_AUTH_ENABLED=true
```

- El frontend local funciona con Vite en:

```text
http://localhost:5173/
```

Nota funcional de la versión actual: la frecuencia normal se configura desde **Dominios** y se guarda como `origin = "domain_default"`. La vista **Programaciones especiales** muestra solo excepciones creadas con `origin = "special"` y no mezcla las frecuencias normales de dominios.

La versión actual también incluye:

- Paginación de 10 registros por defecto en maestros y auditoría.
- Búsqueda combinada con filtros en clientes, dominios, bases, licenciamiento, programaciones especiales y auditoría.
- Validaciones backend para duplicados de cliente, dominio, base de datos y módulo de licencia.
- Licencias asignadas al cliente completo mediante `clients.licenseModuleIds`; las asignaciones avanzadas por dominio/base quedan ocultas para fase futura.
- Programaciones especiales con dos modos: **Selección manual** y **Por licenciamiento**. El modo por licenciamiento siempre resuelve clientes, dominios, bases y módulos activos.
- Vista operativa de tareas: vencidas abiertas, hoy, próximas 4 días y completadas recientes.
- Deduplicación obligatoria de tareas por entidad y día mediante `dedupeKey`.

---

## 1. Software necesario

Instale:

1. **Node.js**  
   En Azure, Node 20 ya no fue aceptado durante nuestra prueba. Use preferiblemente Node 22 o el runtime soportado por Azure en el momento de desplegar.

2. **Azure CLI**

```powershell
winget install --id Microsoft.AzureCLI -e
```

3. **Azure Functions Core Tools v4**

```powershell
npm install -g azure-functions-core-tools@4 --unsafe-perm true
```

4. **PowerShell 7**

```powershell
winget install --id Microsoft.PowerShell -e
```

5. **Git** y **Visual Studio Code**, si va a subir el proyecto a GitHub o editar archivos.

### Verificar instalación

```powershell
node --version
npm --version
az --version
func --version
pwsh --version
```

Si `func` no aparece, instale Azure Functions Core Tools.  
Si `pwsh` no aparece, instale PowerShell 7.

---

## 2. Iniciar sesión en Azure

```powershell
az login
```

Azure mostrará las suscripciones disponibles.

Para listar suscripciones:

```powershell
az account list --output table
```

Para seleccionar la suscripción correcta:

```powershell
az account set --subscription "NOMBRE_DE_LA_SUSCRIPCION"
az account show --output table
```

> Recomendación: use la suscripción con créditos, por ejemplo `Patrocinio de Microsoft Azure`, si esa es la que tiene los beneficios anuales de Microsoft.

---

## 3. Variables recomendadas

Para repetir el despliegue con los mismos recursos usados en la prueba:

```powershell
$resourceGroup  = "rg-erp-update-scheduler-prod"
$location       = "eastus2"
$appPrefix      = "erpupdsch4645"
$cosmosAccount  = "erpupdsch4645-cosmos"
$cosmosDatabase = "erp-update-scheduler"
$keyVaultName   = "erpupdsch4645-kv"
$storageAccount = "erpupdsch4645stg"
$functionApp    = "erpupdsch4645-api"
$staticWebApp   = "erpupdsch4645-web"
```

Para un despliegue nuevo, cambie `$appPrefix`.

> Aprendizaje: `eastus` falló por alta demanda de Cosmos DB. `eastus2` funcionó.

---

## 4. Crear recursos en Azure

### 4.1 Crear grupo de recursos

```powershell
az group create --name $resourceGroup --location $location
```

### 4.2 Crear Cosmos DB en modo serverless

```powershell
az cosmosdb create `
  --name $cosmosAccount `
  --resource-group $resourceGroup `
  --locations regionName=$location `
  --capabilities EnableServerless
```

Si falla por alta demanda regional, elimine el resource group y cambie de región:

```powershell
az group delete --name $resourceGroup --yes --no-wait
```

Espere a que desaparezca:

```powershell
az group exists --name $resourceGroup
```

Debe devolver:

```text
false
```

Luego cambie `$location`, por ejemplo a:

```powershell
$location = "centralus"
```

### 4.3 Crear base de datos y contenedores

```powershell
az cosmosdb sql database create --account-name $cosmosAccount --resource-group $resourceGroup --name $cosmosDatabase

az cosmosdb sql container create --account-name $cosmosAccount --resource-group $resourceGroup --database-name $cosmosDatabase --name users          --partition-key-path "/id"
az cosmosdb sql container create --account-name $cosmosAccount --resource-group $resourceGroup --database-name $cosmosDatabase --name clients        --partition-key-path "/id"
az cosmosdb sql container create --account-name $cosmosAccount --resource-group $resourceGroup --database-name $cosmosDatabase --name domains        --partition-key-path "/clientId"
az cosmosdb sql container create --account-name $cosmosAccount --resource-group $resourceGroup --database-name $cosmosDatabase --name databases      --partition-key-path "/clientId"
az cosmosdb sql container create --account-name $cosmosAccount --resource-group $resourceGroup --database-name $cosmosDatabase --name updateSchedules --partition-key-path "/clientId"
az cosmosdb sql container create --account-name $cosmosAccount --resource-group $resourceGroup --database-name $cosmosDatabase --name updateTasks    --partition-key-path "/taskBucket"
az cosmosdb sql container create --account-name $cosmosAccount --resource-group $resourceGroup --database-name $cosmosDatabase --name auditLogs      --partition-key-path "/clientId"
az cosmosdb sql container create --account-name $cosmosAccount --resource-group $resourceGroup --database-name $cosmosDatabase --name emailNotifications --partition-key-path "/id"
az cosmosdb sql container create --account-name $cosmosAccount --resource-group $resourceGroup --database-name $cosmosDatabase --name licenseModules --partition-key-path "/id"
az cosmosdb sql container create --account-name $cosmosAccount --resource-group $resourceGroup --database-name $cosmosDatabase --name licenseAssignments --partition-key-path "/clientId"
```

`emailNotifications` se usa para idempotencia de recordatorios administrativos mensuales. `licenseModules` se usa para el maestro de **Licenciamiento** y `clients.licenseModuleIds` guarda las licencias compradas por cada cliente. `licenseAssignments` queda reservado para asignaciones avanzadas futuras y puede existir sin ser usado por la UI normal. Si un contenedor ya existe, su comando puede omitirse.

### 4.4 Crear Key Vault

```powershell
az keyvault create `
  --name $keyVaultName `
  --resource-group $resourceGroup `
  --location $location `
  --enable-rbac-authorization true
```

### 4.5 Crear Storage Account para Azure Functions

```powershell
az storage account create `
  --name $storageAccount `
  --resource-group $resourceGroup `
  --location $location `
  --sku Standard_LRS
```

### 4.6 Crear Function App

Durante la prueba, Azure rechazó Node 20. Cree la Function App con Node 22 o con la versión soportada por Azure al momento de desplegar:

```powershell
az functionapp create `
  --resource-group $resourceGroup `
  --consumption-plan-location $location `
  --runtime node `
  --runtime-version 22 `
  --functions-version 4 `
  --name $functionApp `
  --storage-account $storageAccount
```

Si Azure exige Node 24 en su suscripción, use:

```powershell
--runtime-version 24
```

pero configure después `WEBSITE_NODE_DEFAULT_VERSION=~22` si el runtime de Azure Functions funciona mejor con Node 22.

### 4.7 Habilitar identidad administrada y permisos de Key Vault

```powershell
az functionapp identity assign `
  --name $functionApp `
  --resource-group $resourceGroup

$functionPrincipalId = az functionapp identity show `
  --name $functionApp `
  --resource-group $resourceGroup `
  --query principalId `
  --output tsv

$keyVaultId = az keyvault show `
  --name $keyVaultName `
  --resource-group $resourceGroup `
  --query id `
  --output tsv

az role assignment create `
  --assignee $functionPrincipalId `
  --role "Key Vault Secrets Officer" `
  --scope $keyVaultId
```

---

## 5. Configurar variables de entorno del backend

```powershell
$cosmosConnectionString = az cosmosdb keys list `
  --name $cosmosAccount `
  --resource-group $resourceGroup `
  --type connection-strings `
  --query "connectionStrings[0].connectionString" `
  --output tsv

$setupSecret = [Guid]::NewGuid().ToString("N")

az functionapp config appsettings set `
  --name $functionApp `
  --resource-group $resourceGroup `
  --settings `
    "COSMOS_CONNECTION_STRING=$cosmosConnectionString" `
    "COSMOS_DATABASE_NAME=$cosmosDatabase" `
    "KEY_VAULT_URL=https://$keyVaultName.vault.azure.net/" `
    "APP_TIMEZONE=America/Bogota" `
    "DEV_AUTH_ENABLED=true" `
    "SETUP_SECRET=$setupSecret" `
    "FUNCTIONS_WORKER_RUNTIME=node" `
    "WEBSITE_NODE_DEFAULT_VERSION=~22" `
    "FUNCTIONS_EXTENSION_VERSION=~4" `
    "FUNCTIONS_NODE_BLOCK_ON_ENTRY_POINT_ERROR=true" `
    "AzureWebJobsFeatureFlags=EnableWorkerIndexing" `
    "SCM_DO_BUILD_DURING_DEPLOYMENT=false" `
    "ENABLE_ORYX_BUILD=false" `
    "WEBSITE_RUN_FROM_PACKAGE=1"
```

Mostrar el valor generado de `SETUP_SECRET`:

```powershell
$setupSecret
```

Guárdelo temporalmente. Se usa una sola vez para crear el primer administrador.

---

## 6. Corregir bug de Key Vault antes de desplegar

Durante la prueba encontramos este error al crear bases de datos:

```text
The request URI contains an invalid name: db-db_xxxxx-password
```

La causa es que Azure Key Vault no acepta `_` en nombres de secretos. El ID de base de datos tenía `_`, por ejemplo:

```text
db_f9fd2821-b88e-4b5e-88db-bcbb24cd26f7
```

y el sistema generaba:

```text
db-db_f9fd2821-b88e-4b5e-88db-bcbb24cd26f7-password
```

Debe corregirse en:

```text
src\lib\databaseService.ts
```

Ejecute desde la carpeta `api`:

```powershell
cd "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler\api"

$path = ".\src\lib\databaseService.ts"

$content = Get-Content $path -Raw

$helper = @'
function toKeyVaultSecretName(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

'@

if ($content -notmatch "function toKeyVaultSecretName") {
  $content = $helper + $content
}

$content = $content -replace 'const passwordSecretName = `db-\$\{id\}-password`;', 'const passwordSecretName = toKeyVaultSecretName(`db-${id}-password`);'

Set-Content -Path $path -Value $content -Encoding UTF8

type .\src\lib\databaseService.ts
```

Debe quedar una línea como esta:

```typescript
const passwordSecretName = toKeyVaultSecretName(`db-${id}-password`);
```

---

## 7. Desplegar backend con ZIP completo

El despliegue con:

```powershell
func azure functionapp publish $functionApp --typescript
```

puede subir un paquete demasiado pequeño y Azure puede detectar **cero funciones**.

La opción que funcionó fue crear un ZIP completo que incluye:

- `host.json`
- `package.json`
- `package-lock.json`
- `dist`
- `node_modules`

### 7.1 Ir a la carpeta API

```powershell
cd "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler\api"
```

### 7.2 Instalar y compilar

```powershell
npm install
npm run build
```

Si `npm run clean` falla porque `rimraf` no existe, no es grave. Ejecute `npm install` y luego `npm run build`.

### 7.3 Crear ZIP completo

`Compress-Archive` puede quedarse mucho tiempo con `node_modules`. Use `tar`, que fue más rápido:

```powershell
Remove-Item .\api-deploy-full.zip -ErrorAction SilentlyContinue

tar -a -c -f api-deploy-full.zip host.json package.json package-lock.json dist node_modules
```

Verifique que existe:

```powershell
dir api-deploy-full.zip
```

Debe pesar bastante más que 96 KB. En la prueba pesó aproximadamente 25 MB.

### 7.4 Subir ZIP a Azure

```powershell
az functionapp deployment source config-zip `
  --resource-group $resourceGroup `
  --name $functionApp `
  --src api-deploy-full.zip
```

### 7.5 Reiniciar Function App

```powershell
az functionapp restart `
  --name $functionApp `
  --resource-group $resourceGroup
```

### 7.6 Verificar funciones detectadas

```powershell
az functionapp function list `
  --name $functionApp `
  --resource-group $resourceGroup `
  --output table
```

Debe listar funciones como:

```text
setupFirstAdmin
clientsList
databasesCreate
tasksList
generateDailyUpdateTasksManual
```

Si no aparece nada, ejecute localmente:

```powershell
func start
```

Si localmente sí aparecen funciones, el problema es de despliegue/paquete. Si localmente tampoco aparecen, el problema es del código.

---

## 8. Crear primer administrador

Con el backend desplegado y las funciones detectadas:

```powershell
$apiUrl = "https://$functionApp.azurewebsites.net/api/setup/first-admin"

$cuerpo = @{
  setupSecret = $setupSecret
  id = "camilo.palacio@pya.com.co"
  email = "camilo.palacio@pya.com.co"
  displayName = "Camilo Palacio"
} | ConvertTo-Json

Invoke-RestMethod -Uri $apiUrl -Method Post -Body $cuerpo -ContentType "application/json"
```

Después de crearlo, deshabilite el setup secret:

```powershell
az functionapp config appsettings set `
  --name $functionApp `
  --resource-group $resourceGroup `
  --settings "SETUP_SECRET="
```

Para probar el API en modo desarrollo:

```powershell
Invoke-RestMethod `
  -Uri "https://$functionApp.azurewebsites.net/api/me" `
  -Headers @{
    "x-dev-user-id"="camilo.palacio@pya.com.co"
    "x-dev-user-roles"="admin"
  }
```

Debe responder algo similar a:

```text
authenticated = True
registered = True
```

---

## 9. Ejecutar frontend localmente

### 9.1 Abrir una nueva ventana de PowerShell

No cierre el backend si está probando localmente. Para el frontend use otra ventana.

### 9.2 Ir a la carpeta frontend

```powershell
cd "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler\frontend"
```

### 9.3 Instalar dependencias

```powershell
npm install
```

### 9.4 Crear archivo `.env.local`

```powershell
"VITE_API_BASE_URL=https://erpupdsch4645-api.azurewebsites.net/api" | Out-File -FilePath .env.local -Encoding utf8
```

Si su API tiene otro nombre, cambie la URL.

### 9.5 Ejecutar frontend

```powershell
npm run dev
```

Abra:

```text
http://localhost:5173/
```

### 9.6 Iniciar sesión en modo desarrollo

Use:

```text
Identificador: camilo.palacio@pya.com.co
Nombre: Camilo Palacio
Correo electrónico: camilo.palacio@pya.com.co
Rol: Administrador
```

---

## 10. Configurar CORS para frontend local

Para que el navegador pueda llamar la API desde `localhost:5173`:

```powershell
az functionapp cors add `
  --name $functionApp `
  --resource-group $resourceGroup `
  --allowed-origins "http://localhost:5173"

az functionapp cors add `
  --name $functionApp `
  --resource-group $resourceGroup `
  --allowed-origins "http://127.0.0.1:5173"
```

La app frontend usa `credentials: include`, por lo que Azure debe tener `supportCredentials=true`.

En algunas versiones de Azure CLI, este comando **no existe**:

```powershell
az webapp cors credentials
```

La solución que funcionó fue:

```powershell
$webAppId = az functionapp show `
  --name $functionApp `
  --resource-group $resourceGroup `
  --query id `
  --output tsv

az resource update `
  --ids "$webAppId/config/web" `
  --set properties.cors.supportCredentials=true
```

Verifique:

```powershell
az functionapp cors show `
  --name $functionApp `
  --resource-group $resourceGroup
```

Debe mostrar:

```json
"supportCredentials": true
```

Reinicie:

```powershell
az functionapp restart `
  --name $functionApp `
  --resource-group $resourceGroup
```

---

## 11. Probar creación de base de datos

Use esta cadena de prueba:

```text
data-ims.imsampedro.cloud,54101; Initial Catalog = SAMPEDRO; User ID=IMSAMPEDRO-IMS01-API; Password=Exo$254$Juq$123;
```

La contraseña anterior es de prueba. El parser debe separarla así:

```text
Servidor y puerto: data-ims.imsampedro.cloud,54101
Base de datos: SAMPEDRO
Usuario: IMSAMPEDRO-IMS01-API
Contraseña: detectada
```

La contraseña no debe guardarse en Cosmos DB como texto plano. Debe guardarse en Azure Key Vault y Cosmos debe guardar solo el nombre/referencia del secreto.

---

## 12. Desplegar frontend en Azure Static Web Apps

### Opción recomendada: Portal + GitHub

1. Suba el proyecto a un repositorio de GitHub.
2. Abra https://portal.azure.com.
3. Busque **Static Web Apps**.
4. Haga clic en **Crear**.
5. Seleccione la suscripción correcta.
6. Seleccione el resource group:

```text
rg-erp-update-scheduler-prod
```

7. Nombre sugerido:

```text
erpupdsch4645-web
```

8. Plan: **Free** para pruebas.
9. Origen: **GitHub**.
10. Seleccione el repositorio y rama.
11. Configure:

```text
App location: frontend
Api location: dejar vacío
Output location: dist
```

12. Cree el recurso.

### Configurar API URL del frontend

En Azure Static Web Apps:

1. Abra el recurso.
2. Vaya a **Configuration** o **Configuración**.
3. Agregue:

```text
VITE_API_BASE_URL = https://erpupdsch4645-api.azurewebsites.net/api
```

4. Vuelva a ejecutar el workflow de GitHub Actions o haga un nuevo push.

### Agregar CORS para Static Web App

Cuando Azure le entregue la URL del frontend, por ejemplo:

```text
https://happy-rock-123.azurestaticapps.net
```

ejecute:

```powershell
$staticWebAppUrl = "https://happy-rock-123.azurestaticapps.net"

az functionapp cors add `
  --name $functionApp `
  --resource-group $resourceGroup `
  --allowed-origins $staticWebAppUrl
```

Si la app desplegada usa credentials, asegure también:

```powershell
$webAppId = az functionapp show `
  --name $functionApp `
  --resource-group $resourceGroup `
  --query id `
  --output tsv

az resource update `
  --ids "$webAppId/config/web" `
  --set properties.cors.supportCredentials=true
```

---

## 13. Revisar logs

Activar logs:

```powershell
az webapp log config `
  --name $functionApp `
  --resource-group $resourceGroup `
  --application-logging filesystem `
  --level information
```

Ver logs en vivo:

```powershell
az webapp log tail `
  --name $functionApp `
  --resource-group $resourceGroup
```

---

## Notas V10

La ronda V10 mantiene el despliegue existente:

- Backend: ZIP completo con `dist` y `node_modules`.
- Frontend: Azure Static Web Apps vía GitHub Actions.
- `VITE_API_BASE_URL` debe apuntar a `https://erpupdsch4645-api.azurewebsites.net/api` durante el build.

Cambios funcionales incluidos:

- Reabrir tareas completadas y resolver bloqueos usan modales propios, sin `alert`, `confirm` ni `prompt` del navegador.
- Programaciones especiales permiten seleccionar múltiples dominios y bases mediante modales con checkboxes.
- Recordatorios a actualizadores usan configuración global por defecto cuando una frecuencia no tiene override.
- Alertas de bloqueo envían inmediato por defecto y pueden enviar recordatorios de bloqueos no resueltos.
- Recordatorios administrativos soportan reglas de envío, incluyendo último día hábil con viernes + lunes si el mes termina en fin de semana.
- El reporte maestro conserva licencias/módulos activos por cliente y exclusión de datos sensibles.

---

## 14. Errores comunes y soluciones reales

| Síntoma | Causa probable | Solución |
|---|---|---|
| Cosmos DB falla en `eastus` por alta demanda | La región no tiene capacidad temporal | Cambiar a `eastus2`, `centralus` o `southcentralus` y recrear recursos |
| Function App falla con Node 20 | Azure ya no acepta Node 20 en esa suscripción/región | Crear con Node 22 o 24; usar `WEBSITE_NODE_DEFAULT_VERSION=~22` |
| `func publish` sube 96 KB y Azure detecta cero funciones | El paquete no contiene dependencias / worker indexing no queda bien | Usar ZIP completo con `dist` + `node_modules` |
| `az functionapp function list` no muestra nada | Azure no detectó funciones | Probar `func start` local; si local funciona, redeploy con ZIP completo |
| `401 Unauthorized` en `/api/me` | `DEV_AUTH_ENABLED=false` | Para pruebas usar `DEV_AUTH_ENABLED=true`; en producción configurar Entra ID |
| `Failed to fetch` en frontend | CORS o credentials mal configurado | Agregar origen y activar `supportCredentials=true` con `az resource update` |
| `The request URI contains an invalid name: db-db_xxx-password` | Nombre de secreto de Key Vault tiene `_` | Sanitizar nombre en `src\lib\databaseService.ts` |
| `rimraf no se reconoce` | Dependencias dev faltantes tras `npm prune` o instalación parcial | Ejecutar `npm install`; luego `npm run build` |
| `Compress-Archive` parece congelado | ZIP grande con `node_modules` | Usar `tar -a -c -f api-deploy-full.zip ...` |
| PowerShell dice que una ruta no se reconoce | Se pegó la ruta sola, sin `cd`, y contiene espacios | Usar `cd "C:\ruta con espacios"` |

---

## 15. Endurecimiento antes de producción

Antes de usar con datos reales:

1. Desactivar modo desarrollo:

```powershell
az functionapp config appsettings set `
  --name $functionApp `
  --resource-group $resourceGroup `
  --settings "DEV_AUTH_ENABLED=false"
```

2. Configurar autenticación real con Microsoft Entra ID.
3. Revisar permisos del Key Vault. Para producción no siempre conviene `Key Vault Secrets Officer`; se puede separar lectura/escritura.
4. Revisar reglas de acceso al API.
5. Activar Application Insights.
6. Configurar alertas de costo.
7. Verificar backups/retención de Cosmos DB.
8. Revisar vulnerabilidades de npm antes de producción.
9. Documentar el procedimiento de actualización del ZIP cuando se modifique el backend.
10. No dejar contraseñas reales en capturas, logs, tickets ni documentación.

---

## 16. Redeploy después de cambios V6

Estos comandos sirven para publicar la ronda que simplifica **Alertas y correos**, agrega el reporte maestro por correo, hereda frecuencias desde dominio y agrega **Generar tareas ahora**.

### 16.1 Backend con ZIP

```powershell
$resourceGroup = "rg-erp-update-scheduler-prod"
$functionApp   = "erpupdsch4645-api"

cd "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler\api"
npm install
npm test
npm run build

Remove-Item .\api-deploy-full.zip -ErrorAction SilentlyContinue
tar -a -c -f api-deploy-full.zip host.json package.json package-lock.json dist node_modules

az functionapp deployment source config-zip `
  --resource-group $resourceGroup `
  --name $functionApp `
  --src api-deploy-full.zip

az functionapp restart `
  --name $functionApp `
  --resource-group $resourceGroup
```

Verifique que existen las funciones nuevas/actualizadas:

```powershell
az functionapp function list `
  --name $functionApp `
  --resource-group $resourceGroup `
  --output table
```

Debe incluir `mastersReportSendEmail` y `generateDailyUpdateTasksManual`.

### 16.2 Frontend

```powershell
cd "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler\frontend"
"VITE_API_BASE_URL=https://erpupdsch4645-api.azurewebsites.net/api" | Out-File -FilePath .env.production -Encoding utf8
npm install
npm test
npm run build
```

Si usa GitHub Actions de Static Web Apps, haga commit y push. Si despliega manualmente con SWA CLI, use el recurso Static Web Apps apuntando a `frontend/dist`.

El archivo `frontend/public/staticwebapp.config.json` debe seguir presente; Vite lo copia a `dist/staticwebapp.config.json` para evitar 404 al refrescar rutas como `/tareas`.

### 16.3 Configurar SMTP sin exponer contraseña

1. Inicie sesión como administrador.
2. Abra **Alertas y correos**.
3. Pulse **Usar configuración recomendada de P&A**.
4. Abra **Configuración avanzada SMTP**.
5. Pulse **Configurar/Cambiar contraseña SMTP** y escriba la contraseña de aplicación.
6. Guarde.

La contraseña se guarda en Key Vault. No se muestra, no vuelve al frontend y no se guarda en Cosmos DB como texto plano.

### 16.4 Pruebas manuales después de publicar

1. **Configuración P&A**: en **Alertas y correos**, pulse **Usar configuración recomendada de P&A** y confirme servidor `smtp.office365.com`, puerto `587`, remitente `info@pya.com.co`.
2. **Correo de prueba**: escriba un correo en **Correo de prueba** y pulse **Enviar correo de prueba**.
3. **Reporte manual**: en **Reporte de clientes/dominios/empresas**, escriba `correo1@empresa.com; correo2@empresa.com` y pulse **Enviar reporte**. El reporte no debe contener contraseñas, usuarios SQL, cadenas de conexión completas, secretos ni tokens.
4. **Generar tareas ahora**: en **Tareas**, como admin o administrador de clientes, pulse **Generar tareas ahora**. Debe aparecer el mensaje `Tareas generadas correctamente.` y refrescarse la lista.
5. **Frecuencia heredada**: cree un dominio con frecuencia activa. Cree una base de datos bajo ese dominio. El formulario debe mostrar que usará la frecuencia del dominio y no debe pedir frecuencia propia.

---

## 17. Redeploy después de ajustes finales de flujo

Estos pasos aplican a la ronda que agrega acciones rápidas de creación, edición de frecuencia en dominios, fecha de fin opcional, ventana de tareas visible y reorganización final de **Alertas y correos**.

### 17.1 Backend con ZIP

```powershell
$repo = "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler"
$resourceGroup = "rg-erp-update-scheduler-prod"
$functionApp = "erpupdsch4645-api"

Set-Location "$repo\api"
npm install
npm test
npm run build

Remove-Item .\api-deploy-full.zip -ErrorAction SilentlyContinue
tar -a -c -f api-deploy-full.zip host.json package.json package-lock.json dist node_modules

az functionapp deployment source config-zip `
  --resource-group $resourceGroup `
  --name $functionApp `
  --src api-deploy-full.zip

az functionapp restart `
  --resource-group $resourceGroup `
  --name $functionApp
```

### 17.2 Frontend

```powershell
$repo = "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler"
Set-Location "$repo\frontend"

"VITE_API_BASE_URL=https://erpupdsch4645-api.azurewebsites.net/api" | Out-File -FilePath .env.production -Encoding utf8
npm install
npm test
npm run build
```

Publique `frontend/dist` con el mecanismo actual de Static Web Apps. Si usa GitHub Actions, haga commit y push de los cambios.

La vista **Tareas** ahora muestra grupos resumidos por fecha, responsable, tipo y estado agregado. Después de publicar, verifique que el tablero principal no liste todos los dominios o bases individuales y que el detalle permita copiar y guardar cambios de estado inmediatamente.

En el detalle, los dominios solo deben mostrar **Copiar dominio para publicar** y **Completar**. Las bases deben mostrar servidor, base, usuario y contraseña como campos apilados; la contraseña se revela o copia bajo demanda con auditoría segura.

### 17.3 Git con PowerShell

```powershell
$repo = "C:\Users\jcami\Desktop\Actualizaciones automáticas\erp-update-scheduler"
Set-Location $repo

git status
git add README.md DESPLIEGUE.md CAMBIOS_V6.md INSTRUCCIONES_DESPLIEGUE_AJUSTES_FINALES_POWERSHELL.md
git add api/src frontend/src
git commit -m "Ajusta flujo de dominios, frecuencias, tareas y alertas"
git push
```
