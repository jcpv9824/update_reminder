# Script de aprovisionamiento de recursos en Azure.
# Ejecutar en PowerShell 7. Requiere Azure CLI y haber iniciado sesión con `az login`.

param(
  [string]$Location       = "eastus2",
  [string]$ResourceGroup  = "rg-erp-update-scheduler-prod",
  [string]$AppPrefix      = $("erpupdsch" + (Get-Random -Maximum 9999)),
  [string]$SqlServerHost  = "data14.sagerp.co,54103",
  [string]$SqlDatabase    = "PortalSAGWeb",
  [string]$SqlUsername    = "SAGWebDev",
  [string]$SqlPasswordSecretName = "portal-sag-sql-runtime-password",
  [Parameter(Mandatory=$true)][string]$ObjectStorageEndpoint,
  [Parameter(Mandatory=$true)][string]$ObjectStorageBucket,
  [string]$ObjectStorageRegion = "us-east-1",
  [string]$ObjectStorageAccessKeySecretName = "portal-sag-object-storage-access-key",
  [string]$ObjectStorageSecretKeySecretName = "portal-sag-object-storage-secret-key"
)

$ErrorActionPreference = "Stop"

$keyVaultName   = "$AppPrefix-kv"
$storageAccount = ($AppPrefix -replace "-","").ToLower() + "stg"
$functionApp    = "$AppPrefix-api"
$staticWebApp   = "$AppPrefix-web"

Write-Host "==> Creando grupo de recursos $ResourceGroup..."
az group create --name $ResourceGroup --location $Location | Out-Null

Write-Host "==> Creando Key Vault $keyVaultName..."
az keyvault create --name $keyVaultName --resource-group $ResourceGroup --location $Location --enable-rbac-authorization true | Out-Null
$keyVaultId = az keyvault show --name $keyVaultName --resource-group $ResourceGroup --query id --output tsv
$currentUserId = az ad signed-in-user show --query id --output tsv
az role assignment create --assignee $currentUserId --role "Key Vault Secrets Officer" --scope $keyVaultId | Out-Null

Write-Host "Cree en Key Vault el secreto '$SqlPasswordSecretName' con la contraseña SQL de runtime."
Write-Host "La contraseña no debe escribirse como parámetro ni guardarse en este script."
Read-Host "Presione Enter cuando el secreto exista" | Out-Null
$sqlSecretUri = az keyvault secret show --vault-name $keyVaultName --name $SqlPasswordSecretName --query id --output tsv
if (-not $sqlSecretUri) {
  throw "Cree primero el secreto '$SqlPasswordSecretName' en Key Vault con la contraseña del login SQL de runtime."
}
Write-Host "Cree también en Key Vault los secretos '$ObjectStorageAccessKeySecretName' y '$ObjectStorageSecretKeySecretName'."
Read-Host "Presione Enter cuando ambos secretos S3/MinIO existan" | Out-Null
$objectAccessKeyUri = az keyvault secret show --vault-name $keyVaultName --name $ObjectStorageAccessKeySecretName --query id --output tsv
$objectSecretKeyUri = az keyvault secret show --vault-name $keyVaultName --name $ObjectStorageSecretKeySecretName --query id --output tsv
if (-not $objectAccessKeyUri -or -not $objectSecretKeyUri) {
  throw "Cree primero ambos secretos S3/MinIO en Key Vault."
}

Write-Host "==> Creando cuenta de almacenamiento $storageAccount..."
az storage account create --name $storageAccount --resource-group $ResourceGroup --location $Location --sku Standard_LRS | Out-Null

Write-Host "==> Creando Function App $functionApp..."
az functionapp create --resource-group $ResourceGroup --consumption-plan-location $Location `
  --runtime node --runtime-version 20 --functions-version 4 `
  --name $functionApp --storage-account $storageAccount | Out-Null

Write-Host "==> Habilitando identidad administrada..."
az functionapp identity assign --name $functionApp --resource-group $ResourceGroup | Out-Null
$functionAppId = az functionapp show --name $functionApp --resource-group $ResourceGroup --query id --output tsv
az resource update --ids $functionAppId --set properties.httpsOnly=true --output none
az functionapp config set --name $functionApp --resource-group $ResourceGroup --ftps-state Disabled --min-tls-version 1.2 --output none
$functionPrincipalId = az functionapp identity show --name $functionApp --resource-group $ResourceGroup --query principalId --output tsv
$keyVaultId          = az keyvault show --name $keyVaultName --resource-group $ResourceGroup --query id --output tsv

Write-Host "==> Asignando rol Key Vault Secrets Officer..."
az role assignment create --assignee $functionPrincipalId --role "Key Vault Secrets Officer" --scope $keyVaultId | Out-Null
Write-Host "==> Configurando variables de entorno..."
$setupSecret = [Guid]::NewGuid().ToString("N")
$rateLimitHashSecret = [Guid]::NewGuid().ToString("N") + [Guid]::NewGuid().ToString("N")
$jwtSecret = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
az functionapp config appsettings set --name $functionApp --resource-group $ResourceGroup --settings `
  "DATA_BACKEND=sql" `
  "SQL_SECURITY_RUNTIME_ENABLED=true" `
  "PORTAL_MAINTENANCE_MODE=false" `
  "SQL_SERVER_HOST=$SqlServerHost" `
  "SQL_DATABASE=$SqlDatabase" `
  "SQL_USERNAME=$SqlUsername" `
  "SQL_PASSWORD=@Microsoft.KeyVault(SecretUri=$sqlSecretUri)" `
  "KEY_VAULT_URL=https://$keyVaultName.vault.azure.net/" `
  "OBJECT_STORAGE_ENDPOINT=$ObjectStorageEndpoint" `
  "OBJECT_STORAGE_REGION=$ObjectStorageRegion" `
  "OBJECT_STORAGE_BUCKET=$ObjectStorageBucket" `
  "OBJECT_STORAGE_PREFIX=portal-sag/runtime" `
  "OBJECT_STORAGE_FORCE_PATH_STYLE=true" `
  "OBJECT_STORAGE_SIGNED_URL_SECONDS=300" `
  "OBJECT_STORAGE_ACCESS_KEY_ID=@Microsoft.KeyVault(SecretUri=$objectAccessKeyUri)" `
  "OBJECT_STORAGE_SECRET_ACCESS_KEY=@Microsoft.KeyVault(SecretUri=$objectSecretKeyUri)" `
  "APP_TIMEZONE=America/Bogota" `
  "DEV_AUTH_ENABLED=false" `
  "RATE_LIMIT_HASH_SECRET=$rateLimitHashSecret" `
  "BCRYPT_COST=12" `
  "PASSWORD_MAX_AGE_DAYS=180" `
  "PWNED_PASSWORDS_ENABLED=true" `
  "PWNED_PASSWORDS_FAIL_CLOSED=true" `
  "JWT_SECRET=$jwtSecret" `
  "JWT_ACCESS_EXPIRES_IN=10m" `
  "JWT_ISSUER=erp-update-scheduler-api" `
  "JWT_AUDIENCE=erp-update-scheduler-web" `
  "REFRESH_TOKEN_DAYS=30" `
  "AUTH_COOKIE_SECURE=true" `
  "SETUP_SECRET=$setupSecret" | Out-Null

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "Recursos creados correctamente" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host "Resource group  : $ResourceGroup"
Write-Host "SQL Server      : $SqlServerHost / $SqlDatabase"
Write-Host "Key Vault       : $keyVaultName"
Write-Host "Function App    : $functionApp"
Write-Host "Static Web App  : créelo desde el portal con nombre '$staticWebApp'"
Write-Host "URL del API     : https://$functionApp.azurewebsites.net/api"
Write-Host "SETUP_SECRET    : $setupSecret"
Write-Host ""
Write-Host "Siguientes pasos:"
Write-Host "  1) cd ..\api && npm install && npm run build && func azure functionapp publish $functionApp"
Write-Host "  2) Crear Static Web App en el portal apuntando al repo (ver DESPLIEGUE.md)."
Write-Host "  3) Crear primer admin con POST /api/setup/first-admin (usar el SETUP_SECRET de arriba)."
