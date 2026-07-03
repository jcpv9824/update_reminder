param(
  [string]$SubscriptionId = "edbbf624-b155-4c51-ac57-d02424a7234d",
  [string]$ResourceGroup = "rg-erp-update-scheduler-prod",
  [string]$FunctionApp = "erpupdsch4645-api",
  [string]$FrontendOrigin = "https://agreeable-wave-07469d50f.7.azurestaticapps.net"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-LastExitCode([string]$message) {
  if ($LASTEXITCODE -ne 0) { throw $message }
}

az account set --subscription $SubscriptionId
Assert-LastExitCode "No se pudo seleccionar la suscripcion Azure."

$appId = az functionapp show --resource-group $ResourceGroup --name $FunctionApp --query id --output tsv
Assert-LastExitCode "No se encontro la Function App."

# El API publico nunca debe aceptar HTTP sin redireccion a HTTPS.
az resource update --ids $appId --set properties.httpsOnly=true --output none
Assert-LastExitCode "No se pudo activar HTTPS only."

# PATCH conserva el resto de siteConfig y fija transporte/CORS de forma atomica.
# supportCredentials=true es necesario mientras SWA y Functions sean origenes
# distintos y el refresh token se transporte en cookie HttpOnly.
$configUrl = "https://management.azure.com$appId/config/web?api-version=2023-12-01"
$body = @{
  properties = @{
    ftpsState = "Disabled"
    minTlsVersion = "1.2"
    scmMinTlsVersion = "1.2"
    http20Enabled = $true
    cors = @{
      allowedOrigins = @($FrontendOrigin)
      supportCredentials = $true
    }
  }
} | ConvertTo-Json -Depth 6 -Compress
$bodyPath = [IO.Path]::GetTempFileName()
try {
  [IO.File]::WriteAllText($bodyPath, $body, [Text.UTF8Encoding]::new($false))
  az rest --method PATCH --url $configUrl --headers "Content-Type=application/json" --body "@$bodyPath" --output none
  Assert-LastExitCode "No se pudo endurecer siteConfig/CORS."
} finally {
  Remove-Item -LiteralPath $bodyPath -Force -ErrorAction SilentlyContinue
}

$app = az functionapp show --resource-group $ResourceGroup --name $FunctionApp | ConvertFrom-Json
$config = az functionapp config show --resource-group $ResourceGroup --name $FunctionApp | ConvertFrom-Json
$cors = az functionapp cors show --resource-group $ResourceGroup --name $FunctionApp | ConvertFrom-Json

if ($app.httpsOnly -ne $true) { throw "HTTPS only no quedo activo." }
if ($config.ftpsState -ne "Disabled") { throw "FTPS no quedo deshabilitado." }
if ($config.minTlsVersion -ne "1.2" -or $config.scmMinTlsVersion -ne "1.2") { throw "TLS minimo no es 1.2 en app/SCM." }
if ($cors.supportCredentials -ne $true) { throw "CORS credentials debe permanecer activo para la cookie HttpOnly cross-origin." }
if (@($cors.allowedOrigins).Count -ne 1 -or $cors.allowedOrigins[0] -ne $FrontendOrigin) { throw "CORS contiene origenes no autorizados." }

$httpUrl = "http://$FunctionApp.azurewebsites.net/api/auth/login"
$httpsUrl = "https://$FunctionApp.azurewebsites.net/api/auth/login"
$httpHandler = [Net.Http.HttpClientHandler]::new()
$httpHandler.AllowAutoRedirect = $false
$httpClient = [Net.Http.HttpClient]::new($httpHandler)
try {
  $httpProbe = $httpClient.GetAsync($httpUrl).GetAwaiter().GetResult()
  if ([int]$httpProbe.StatusCode -ne 301 -or -not $httpProbe.Headers.Location -or -not $httpProbe.Headers.Location.AbsoluteUri.StartsWith("https://")) {
    throw "HTTP no redirige correctamente a HTTPS."
  }
} finally {
  $httpClient.Dispose()
  $httpHandler.Dispose()
}

$preflightHeaders = @{
  Origin = $FrontendOrigin
  "Access-Control-Request-Method" = "POST"
  "Access-Control-Request-Headers" = "content-type,x-requested-with"
}
$allowedProbe = Invoke-WebRequest -Uri $httpsUrl -Method Options -Headers $preflightHeaders -SkipHttpErrorCheck
if ($allowedProbe.StatusCode -ne 200 -or [string]$allowedProbe.Headers["Access-Control-Allow-Origin"] -ne $FrontendOrigin -or [string]$allowedProbe.Headers["Access-Control-Allow-Credentials"] -ne "true") {
  throw "El preflight del frontend productivo no cumple CORS con credenciales."
}

$preflightHeaders.Origin = "http://localhost:5173"
$deniedProbe = Invoke-WebRequest -Uri $httpsUrl -Method Options -Headers $preflightHeaders -SkipHttpErrorCheck
if ($deniedProbe.StatusCode -ne 400 -or $deniedProbe.Headers["Access-Control-Allow-Origin"]) {
  throw "Un origen no autorizado fue aceptado por CORS."
}

[pscustomobject]@{
  HttpsOnly = $app.httpsOnly
  FtpsState = $config.ftpsState
  MinTlsVersion = $config.minTlsVersion
  ScmMinTlsVersion = $config.scmMinTlsVersion
  CorsOrigin = $cors.allowedOrigins[0]
  CorsCredentials = $cors.supportCredentials
  HttpRedirectStatus = [int]$httpProbe.StatusCode
  AllowedPreflightStatus = $allowedProbe.StatusCode
  DeniedPreflightStatus = $deniedProbe.StatusCode
}
