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
  [ValidateSet("azure_blob", "seaweedfs")]
  [string]$ObjectStorageProvider = "azure_blob",
  [Parameter(Mandatory=$true)][string]$SeaweedFSEndpoint,
  [Parameter(Mandatory=$true)][string]$SeaweedFSBucket,
  [string]$SeaweedFSRegion = "us-east-1",
  [string]$SeaweedFSAccessKeySecretName = "portal-sag-seaweedfs-access-key",
  [string]$SeaweedFSSecretKeySecretName = "portal-sag-seaweedfs-secret-key",
  [string]$AzureBlobContainer = "portal-sag-content"
)

$ErrorActionPreference = "Stop"

$seaweedFSUri = [Uri]$SeaweedFSEndpoint
if (
  $seaweedFSUri.Scheme -cne "https" -or
  $seaweedFSUri.UserInfo -or
  $seaweedFSUri.Query -or
  $seaweedFSUri.Fragment -or
  $seaweedFSUri.AbsolutePath -ne "/"
) {
  throw "SeaweedFSEndpoint debe ser una raíz HTTPS sin credenciales, ruta, query ni fragment."
}
if ($SeaweedFSBucket -notmatch '^(?!.*\.\.)(?!-)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$') {
  throw "SeaweedFSBucket no es un nombre de bucket S3 válido."
}
if ($SeaweedFSRegion -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$') {
  throw "SeaweedFSRegion no es válido."
}
if ($AzureBlobContainer -notmatch '^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$') {
  throw "AzureBlobContainer no es un nombre de container válido."
}
$SeaweedFSEndpoint = $seaweedFSUri.AbsoluteUri.TrimEnd("/")

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
Write-Host "Cree también en Key Vault los secretos '$SeaweedFSAccessKeySecretName' y '$SeaweedFSSecretKeySecretName'."
Read-Host "Presione Enter cuando ambos secretos del gateway S3 de SeaweedFS existan" | Out-Null
$seaweedFSAccessKeyUri = az keyvault secret show --vault-name $keyVaultName --name $SeaweedFSAccessKeySecretName --query id --output tsv
$seaweedFSSecretKeyUri = az keyvault secret show --vault-name $keyVaultName --name $SeaweedFSSecretKeySecretName --query id --output tsv
if (-not $seaweedFSAccessKeyUri -or -not $seaweedFSSecretKeyUri) {
  throw "Cree primero ambos secretos del gateway S3 de SeaweedFS en Key Vault."
}

Write-Host "==> Creando cuenta de almacenamiento $storageAccount..."
az storage account create --name $storageAccount --resource-group $ResourceGroup --location $Location --sku Standard_LRS | Out-Null
Write-Host "==> Creando container Blob privado $AzureBlobContainer..."
az storage container create --account-name $storageAccount --name $AzureBlobContainer --auth-mode key --public-access off | Out-Null

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
$storageAccountId    = az storage account show --name $storageAccount --resource-group $ResourceGroup --query id --output tsv
$blobContainerScope  = "$storageAccountId/blobServices/default/containers/$AzureBlobContainer"

Write-Host "==> Asignando rol Key Vault Secrets Officer..."
az role assignment create --assignee $functionPrincipalId --role "Key Vault Secrets Officer" --scope $keyVaultId | Out-Null
Write-Host "==> Asignando acceso Blob de mínimo alcance..."
az role assignment create --assignee $functionPrincipalId --role "Storage Blob Data Contributor" --scope $blobContainerScope | Out-Null
az role assignment create --assignee $functionPrincipalId --role "Storage Blob Delegator" --scope $storageAccountId | Out-Null
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
  "OBJECT_STORAGE_PROVIDER=$ObjectStorageProvider" `
  "OBJECT_STORAGE_PREFIX=portal-sag/runtime" `
  "OBJECT_STORAGE_SIGNED_URL_SECONDS=300" `
  "SEAWEEDFS_ENDPOINT=$SeaweedFSEndpoint" `
  "SEAWEEDFS_REGION=$SeaweedFSRegion" `
  "SEAWEEDFS_BUCKET=$SeaweedFSBucket" `
  "SEAWEEDFS_FORCE_PATH_STYLE=true" `
  "SEAWEEDFS_ACCESS_KEY_ID=@Microsoft.KeyVault(SecretUri=$seaweedFSAccessKeyUri)" `
  "SEAWEEDFS_SECRET_ACCESS_KEY=@Microsoft.KeyVault(SecretUri=$seaweedFSSecretKeyUri)" `
  "AZURE_BLOB_STORAGE_ACCOUNT_URL=https://$storageAccount.blob.core.windows.net" `
  "AZURE_BLOB_STORAGE_CONTAINER=$AzureBlobContainer" `
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
