[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$vaultName = 'erpupdsch4645-guide-kv'
$secretName = 'PortalSAGWeb-GuideSqlRuntime-Password'
$vaultResource = 'https://vault.azure.net'
$secretUri = "https://$vaultName.vault.azure.net/secrets/$secretName`?api-version=7.4"

function Clear-PlainText {
  param([ref]$Value)

  if ($null -ne $Value.Value) {
    $Value.Value = $null
  }
}

Write-Host ''
Write-Host 'Portal SAG Web - EPHEMERAL GUIDE BUILDER SQL RUNTIME SECRET' -ForegroundColor Cyan
Write-Host 'Enter the existing SAGWebDev SQL runtime password.'
Write-Host 'The password remains only in this process memory and is sent directly to the Guide-only Azure Key Vault.'
Write-Host 'It is never printed, written locally, committed, or passed on a child-process command line.'
Write-Host ''

$securePassword = Read-Host 'SAGWebDev SQL runtime password' -AsSecureString
$bstr = [IntPtr]::Zero
$plainPassword = $null
$requestBody = $null
$accessToken = $null

try {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)

  if ([string]::IsNullOrWhiteSpace($plainPassword)) {
    throw 'The supplied SQL runtime password is empty.'
  }

  $accessToken = (& az account get-access-token `
      --resource $vaultResource `
      --query accessToken `
      --output tsv 2>$null)

  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($accessToken)) {
    throw 'Azure CLI could not obtain a Key Vault access token. Run az login and try again.'
  }

  $requestBody = @{
    value = $plainPassword
    contentType = 'Portal SAG Web Guide Builder SQL runtime credential'
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
  Write-Host 'Guide Builder SQL runtime secret stored successfully in the isolated Azure Key Vault.' -ForegroundColor Green
}
finally {
  if ($bstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
  Clear-PlainText ([ref]$plainPassword)
  Clear-PlainText ([ref]$requestBody)
  Clear-PlainText ([ref]$accessToken)
  $securePassword.Dispose()
}
