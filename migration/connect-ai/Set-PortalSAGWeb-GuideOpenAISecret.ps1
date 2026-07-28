[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$vaultName = 'erpupdsch4645-guide-kv'
$secretName = 'PortalSAGWeb-GuideOpenAI-ApiKey'
$vaultResource = 'https://vault.azure.net'
$secretUri = "https://$vaultName.vault.azure.net/secrets/$secretName`?api-version=7.4"

function Clear-PlainText {
  param([ref]$Value)

  if ($null -ne $Value.Value) {
    $Value.Value = $null
  }
}

Write-Host ''
Write-Host 'Portal SAG Web - EPHEMERAL GUIDE BUILDER OPENAI SECRET' -ForegroundColor Cyan
Write-Host 'The API key remains only in this process memory and is sent directly to the Guide-only Azure Key Vault.'
Write-Host 'It is never printed, written locally, committed, or passed on a child-process command line.'
Write-Host ''

$secureKey = Read-Host 'OpenAI API key' -AsSecureString
$bstr = [IntPtr]::Zero
$plainKey = $null
$requestBody = $null
$accessToken = $null

try {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)

  if ([string]::IsNullOrWhiteSpace($plainKey) -or $plainKey.Length -lt 20) {
    throw 'The supplied OpenAI API key is empty or unexpectedly short.'
  }

  $accessToken = (& az account get-access-token `
      --resource $vaultResource `
      --query accessToken `
      --output tsv 2>$null)

  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($accessToken)) {
    throw 'Azure CLI could not obtain a Key Vault access token. Run az login and try again.'
  }

  $requestBody = @{
    value = $plainKey
    contentType = 'Portal SAG Web Guide Builder OpenAI credential'
    attributes = @{
      enabled = $true
    }
  } | ConvertTo-Json -Depth 4 -Compress

  $null = Invoke-RestMethod `
    -Method Put `
    -Uri $secretUri `
    -Headers @{ Authorization = "Bearer $accessToken" } `
    -ContentType 'application/json' `
    -Body $requestBody

  Write-Host ''
  Write-Host 'Guide Builder OpenAI secret stored successfully in the isolated Azure Key Vault.' -ForegroundColor Green
}
finally {
  if ($bstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
  Clear-PlainText ([ref]$plainKey)
  Clear-PlainText ([ref]$requestBody)
  Clear-PlainText ([ref]$accessToken)
  $secureKey.Dispose()
}
