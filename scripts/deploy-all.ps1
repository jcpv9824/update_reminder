param(
  [string]$SubscriptionId = "edbbf624-b155-4c51-ac57-d02424a7234d",
  [string]$ResourceGroup = "rg-erp-update-scheduler-prod",
  [string]$FunctionApp = "erpupdsch4645-api",
  [string]$ApiBaseUrl = "https://erpupdsch4645-api.azurewebsites.net/api",
  [string]$CommitMessage = "Despliegue cambios programador actualizaciones",
  [switch]$SkipTests,
  [switch]$SkipGit,
  [switch]$NoPush
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..")
$apiDir = Join-Path $repoRoot "api"
$frontendDir = Join-Path $repoRoot "frontend"
$zipPath = Join-Path $apiDir "api-deploy-full.zip"

function Step($message) {
  Write-Host ""
  Write-Host "============================================================" -ForegroundColor Cyan
  Write-Host $message -ForegroundColor Cyan
  Write-Host "============================================================" -ForegroundColor Cyan
}

function Run($command, $workingDirectory) {
  Push-Location $workingDirectory
  try {
    Write-Host "> $command" -ForegroundColor DarkGray
    Invoke-Expression $command
  } finally {
    Pop-Location
  }
}

Step "Validando Azure CLI"
az account set --subscription $SubscriptionId
az account show --query "{name:name,id:id,tenantId:tenantId}" --output table

Step "BACKEND - instalar dependencias"
Run "npm install" $apiDir

if (-not $SkipTests) {
  Step "BACKEND - ejecutar pruebas"
  Run "npm test" $apiDir
}

Step "BACKEND - compilar"
Run "npm run build" $apiDir

Step "BACKEND - crear ZIP completo con dist + node_modules"
if (Test-Path $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
Run "tar -a -c -f api-deploy-full.zip host.json package.json package-lock.json dist node_modules" $apiDir

Step "BACKEND - desplegar ZIP en Azure Functions"
az functionapp deployment source config-zip `
  --resource-group $ResourceGroup `
  --name $FunctionApp `
  --src $zipPath

Step "BACKEND - reiniciar Function App"
az functionapp restart `
  --name $FunctionApp `
  --resource-group $ResourceGroup

Step "BACKEND - listar funciones publicadas"
az functionapp function list `
  --name $FunctionApp `
  --resource-group $ResourceGroup `
  --output table

Step "FRONTEND - configurar API de producción"
"VITE_API_BASE_URL=$ApiBaseUrl" | Out-File -FilePath (Join-Path $frontendDir ".env.production") -Encoding utf8

Step "FRONTEND - instalar dependencias"
Run "npm install" $frontendDir

if (-not $SkipTests) {
  Step "FRONTEND - ejecutar pruebas"
  Run "npm test" $frontendDir
}

Step "FRONTEND - compilar"
Run "npm run build" $frontendDir

if (-not $SkipGit) {
  Step "GIT - preparar commit para activar GitHub Actions del frontend"
  Push-Location $repoRoot
  try {
    git status
    git add .
    $changes = git diff --cached --name-only
    if ($changes) {
      git commit -m $CommitMessage
      if (-not $NoPush) {
        git push
      } else {
        Write-Host "NoPush activo: commit creado, pero no se ejecutó git push." -ForegroundColor Yellow
      }
    } else {
      Write-Host "No hay cambios para commitear." -ForegroundColor Yellow
    }
  } finally {
    Pop-Location
  }
} else {
  Step "GIT - omitido por parámetro SkipGit"
}

Step "Despliegue finalizado"
Write-Host "Backend API: $ApiBaseUrl"
Write-Host "Frontend producción: https://agreeable-wave-07469d50f.7.azurestaticapps.net"
Write-Host "GitHub Actions: https://github.com/jcpv9824/update_reminder/actions"
