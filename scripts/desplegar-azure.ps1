# Script de aprovisionamiento de recursos en Azure.
# Ejecutar en PowerShell 7. Requiere Azure CLI y haber iniciado sesión con `az login`.

param(
  [string]$Location       = "eastus2",
  [string]$ResourceGroup  = "rg-erp-update-scheduler-prod",
  [string]$AppPrefix      = $("erpupdsch" + (Get-Random -Maximum 9999))
)

$ErrorActionPreference = "Stop"

$cosmosAccount  = "$AppPrefix-cosmos"
$cosmosDatabase = "erp-update-scheduler"
$keyVaultName   = "$AppPrefix-kv"
$storageAccount = ($AppPrefix -replace "-","").ToLower() + "stg"
$functionApp    = "$AppPrefix-api"
$staticWebApp   = "$AppPrefix-web"

Write-Host "==> Creando grupo de recursos $ResourceGroup..."
az group create --name $ResourceGroup --location $Location | Out-Null

Write-Host "==> Creando Cosmos DB $cosmosAccount (serverless)..."
az cosmosdb create --name $cosmosAccount --resource-group $ResourceGroup `
  --locations regionName=$Location --capabilities EnableServerless | Out-Null

Write-Host "==> Creando base de datos y contenedores..."
az cosmosdb sql database create --account-name $cosmosAccount --resource-group $ResourceGroup --name $cosmosDatabase | Out-Null
$contenedores = @(
  @{ Name = "users";          Pk = "/id" },
  @{ Name = "clients";        Pk = "/id" },
  @{ Name = "domains";        Pk = "/clientId" },
  @{ Name = "databases";      Pk = "/clientId" },
  @{ Name = "updateSchedules"; Pk = "/clientId" },
  @{ Name = "updateTasks";    Pk = "/taskBucket" },
  @{ Name = "auditLogs";      Pk = "/clientId" },
  @{ Name = "emailNotifications"; Pk = "/id" },
  @{ Name = "licenseModules"; Pk = "/id" },
  @{ Name = "licenseAssignments"; Pk = "/clientId" },
  @{ Name = "securityRateLimits"; Pk = "/id"; Ttl = -1 }
)
foreach ($c in $contenedores) {
  if ($null -ne $c.Ttl) {
    az cosmosdb sql container create --account-name $cosmosAccount --resource-group $ResourceGroup `
      --database-name $cosmosDatabase --name $c.Name --partition-key-path $c.Pk --ttl $c.Ttl | Out-Null
  } else {
    az cosmosdb sql container create --account-name $cosmosAccount --resource-group $ResourceGroup `
      --database-name $cosmosDatabase --name $c.Name --partition-key-path $c.Pk | Out-Null
  }
}

Write-Host "==> Creando Key Vault $keyVaultName..."
az keyvault create --name $keyVaultName --resource-group $ResourceGroup --location $Location --enable-rbac-authorization true | Out-Null

Write-Host "==> Creando cuenta de almacenamiento $storageAccount..."
az storage account create --name $storageAccount --resource-group $ResourceGroup --location $Location --sku Standard_LRS | Out-Null

Write-Host "==> Creando Function App $functionApp..."
az functionapp create --resource-group $ResourceGroup --consumption-plan-location $Location `
  --runtime node --runtime-version 20 --functions-version 4 `
  --name $functionApp --storage-account $storageAccount | Out-Null

Write-Host "==> Habilitando identidad administrada..."
az functionapp identity assign --name $functionApp --resource-group $ResourceGroup | Out-Null
$functionPrincipalId = az functionapp identity show --name $functionApp --resource-group $ResourceGroup --query principalId --output tsv
$keyVaultId          = az keyvault show --name $keyVaultName --resource-group $ResourceGroup --query id --output tsv

Write-Host "==> Asignando rol Key Vault Secrets Officer..."
az role assignment create --assignee $functionPrincipalId --role "Key Vault Secrets Officer" --scope $keyVaultId | Out-Null

Write-Host "==> Configurando variables de entorno..."
$cosmosConnectionString = az cosmosdb keys list --name $cosmosAccount --resource-group $ResourceGroup `
  --type connection-strings --query "connectionStrings[0].connectionString" --output tsv

$setupSecret = [Guid]::NewGuid().ToString("N")
$rateLimitHashSecret = [Guid]::NewGuid().ToString("N") + [Guid]::NewGuid().ToString("N")
az functionapp config appsettings set --name $functionApp --resource-group $ResourceGroup --settings `
  "COSMOS_CONNECTION_STRING=$cosmosConnectionString" `
  "COSMOS_DATABASE_NAME=$cosmosDatabase" `
  "KEY_VAULT_URL=https://$keyVaultName.vault.azure.net/" `
  "APP_TIMEZONE=America/Bogota" `
  "DEV_AUTH_ENABLED=false" `
  "RATE_LIMIT_HASH_SECRET=$rateLimitHashSecret" `
  "SETUP_SECRET=$setupSecret" | Out-Null

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "Recursos creados correctamente" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host "Resource group  : $ResourceGroup"
Write-Host "Cosmos DB       : $cosmosAccount"
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
