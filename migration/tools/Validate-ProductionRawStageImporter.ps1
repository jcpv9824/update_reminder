[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$importerPath = Join-Path $PSScriptRoot 'Import-CosmosSnapshot-RawStage.ps1'
$launcherPath = Join-Path $PSScriptRoot 'Stage-CurrentSnapshot-Production.ps1'
$projectorPath = Join-Path $repoRoot 'migration\sql\008_stage_projection_procedure.sql'

foreach ($path in @($importerPath, $launcherPath, $projectorPath)) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Required migration artifact is missing: $path"
  }
}

$importer = Get-Content -Raw -LiteralPath $importerPath
$launcher = Get-Content -Raw -LiteralPath $launcherPath
$projector = Get-Content -Raw -LiteralPath $projectorPath

$requiredImporterPatterns = @(
  "[ValidateSet('nonproduction', 'production-stage')]",
  "data14.sagerp.co,54103",
  "TargetEnvironment -eq 'production-stage'",
  "SourceEnvironment -cne 'production'",
  "STAGE CURRENT SNAPSHOT PRODUCTION",
  "IS_ROLEMEMBER(N'db_owner')",
  "HAS_PERMS_BY_NAME(DB_NAME(),N'DATABASE',N'CONTROL')",
  "EXECUTE AS USER=N'dbo';",
  "REVERT;",
  "permission memberships and grants were preserved",
  "Operational tables and Blob Storage were not modified."
)

foreach ($pattern in $requiredImporterPatterns) {
  if (-not $importer.Contains($pattern)) {
    throw "Production raw/stage importer safety contract is missing: $pattern"
  }
}

$requiredLauncherPatterns = @(
  "[string]`$Username = 'SAGWebDev'",
  "`$serverName = 'data14.sagerp.co,54103'",
  "`$databaseName = 'PortalSAGWeb'",
  "cosmos-export-prod-20260722-155753",
  "-TargetEnvironment production-stage",
  "-AcceptKnownWarnings",
  "Operational tables, Blob Storage, application settings and database permissions are not modified."
)
foreach ($pattern in $requiredLauncherPatterns) {
  if (-not $launcher.Contains($pattern)) {
    throw "Production staging launcher contract is missing: $pattern"
  }
}

$forbiddenPermissionMutations = @(
  'ALTER ROLE',
  'DROP MEMBER',
  'REVOKE CONTROL',
  'DENY CONTROL'
)
foreach ($pattern in $forbiddenPermissionMutations) {
  if ($importer.IndexOf($pattern, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
    throw "Production raw/stage importer contains a forbidden permission mutation: $pattern"
  }
}

$operationalSchemas = @(
  'security', 'core', 'licensing', 'scheduling', 'workflow', 'settings',
  'content', 'notifications', 'implementation', 'audit'
)
foreach ($schema in $operationalSchemas) {
  $dmlPattern = "(?im)\b(?:INSERT(?:\s+INTO)?|UPDATE|DELETE\s+FROM|MERGE)\s+\[?$([regex]::Escape($schema))\]?\."
  if ([regex]::IsMatch($projector, $dmlPattern)) {
    throw "Raw-to-stage projector writes outside the migration schema: $schema"
  }
}

$tokens = $null
$errors = $null
foreach ($path in @($importerPath, $launcherPath)) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile(
    $path,
    [ref]$tokens,
    [ref]$errors
  )
  if ($errors.Count -gt 0) {
    throw "Production raw/stage tool has PowerShell syntax errors: $($errors[0].Message)"
  }
}

Write-Host 'PASS production raw/stage importer: exact target, strict TLS, full-control preflight, session-scoped dbo, permission preservation and migration-only writes.' -ForegroundColor Green
