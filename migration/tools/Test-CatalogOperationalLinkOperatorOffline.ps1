# Only synthetic wire/grammar verification. This never invokes the real broker or a database.
[CmdletBinding()]
param([string]$ScriptDomPath)
$ErrorActionPreference='Stop'
if (!$ScriptDomPath) {
  $dll=Get-ChildItem -Path 'C:\Program Files\Microsoft SQL Server Management Studio*' -Filter 'Microsoft.SqlServer.TransactSql.ScriptDom.dll' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if (!$dll) { throw 'SQL Server 2019 ScriptDom is required.' }
  $ScriptDomPath=$dll.FullName
}
Add-Type -Path $ScriptDomPath
$parser=[Microsoft.SqlServer.TransactSql.ScriptDom.TSql150Parser]::new($true)
function Check-Sql([string]$Sql) {
  $reader=[IO.StringReader]::new($Sql)
  try {
    $errors=$null
    $null=$parser.Parse($reader,[ref]$errors)
    if (@($errors).Count) {
      throw ("SQL 2019 grammar rejected the fixture at line {0}, column {1}." -f $errors[0].Line,$errors[0].Column)
    }
  } finally { $reader.Dispose() }
}
function Require([bool]$Condition,[string]$Message) { if (!$Condition) { throw $Message } }

$temp=[IO.Directory]::CreateTempSubdirectory('portal-catalog-042-offline-')
$tools=$temp.CreateSubdirectory('tools')
$conn=$temp.CreateSubdirectory('connect-sql-server')
$session=$temp.CreateSubdirectory('session')
$name='Register-PortalSAGWeb-CatalogOperationalLink'
$scriptPath=Join-Path $tools.FullName "$name.ps1"
$sqlPath=Join-Path $tools.FullName "$name.sql"
$stubPath=Join-Path $conn.FullName 'Invoke-PortalSAGWeb-EphemeralRequest.ps1'
$descriptor=Join-Path $session.FullName 'active.json'
$captured=Join-Path $session.FullName 'captured.sql'
try {
  [IO.File]::Copy((Join-Path $PSScriptRoot "$name.ps1"),$scriptPath)
  [IO.File]::Copy((Join-Path $PSScriptRoot "$name.sql"),$sqlPath)
  [IO.File]::WriteAllText($descriptor,'{"environment":"qa","database":"PortalSAGWeb-TEST","fullControl":true,"accessLevel":"full-control","sessionAuthorized":true,"approvalMode":"session"}')
  [IO.File]::WriteAllText($stubPath,@'
param($SessionDirectory,$Sql,$Mode,$TimeoutSeconds,$MaxRows)
if ($Mode -cne 'write' -or $TimeoutSeconds -ne 20 -or $MaxRows -ne 1) { throw 'Wrong fake wire contract.' }
[IO.File]::WriteAllText((Join-Path $SessionDirectory 'captured.sql'),$Sql)
$apply=$Sql -match 'DECLARE @bind_apply bit=1;'
$status=if ($apply) {'registered'} else {'dry-run'}
$id=if ($apply) {'60000000-0000-0000-0000-000000000099'} else {$null}
$ambiguous=[IO.File]::Exists((Join-Path $SessionDirectory 'ambiguous'))
@{success=$true;resultSets=@(@{columns=@('status','linkId');totalRows=1+[int]$ambiguous;truncated=$ambiguous;
  rows=@(@{status=$status;linkId=$id})})} | ConvertTo-Json -Depth 8 -Compress
'@)
  $tokens=$null
  $scriptErrors=$null
  $null=[Management.Automation.Language.Parser]::ParseFile($scriptPath,[ref]$tokens,[ref]$scriptErrors)
  Require (@($scriptErrors).Count -eq 0) 'PowerShell grammar rejected the operator command.'
  $body=[IO.File]::ReadAllText($sqlPath)
  Check-Sql $body
  # Static equivalence to the installed consumer's ERP ambiguity veto. This
  # checks predicate drift, not SQL execution or trigger effects.
  $migration056=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '../sql/056_catalog_sag_target_link_proof.sql'))
  $prefix='AND NOT EXISTS\s*\(SELECT 1 FROM core\.catalog_customer_revision_rows competing'
  $consumer=[regex]::Match($migration056,"(?s)$prefix.+?(?=\s+AND NOT EXISTS\s*\(SELECT 1 FROM core\.catalog_customer_revision_rows unresolved)")
  $writer=[regex]::Match($body,"(?s)$prefix.+?(?=;\s+IF @customer IS NULL)")
  $consumerAliases=$consumer.Value.Replace('erp_revision.revision_key','r.revision_key').Replace('erp_record.','rr.')
  $normalizedConsumer=$consumerAliases.Replace('own.catalog_customer_key','rr.catalog_customer_key') -replace '\s',''
  Require ($consumer.Success -and $writer.Success -and $normalizedConsumer -ceq ($writer.Value -replace '\s','') -and
    $body.Contains('rr.issuer IS NOT NULL AND rr.document_type IS NOT NULL AND rr.document_number_token IS NOT NULL')) 'ERP identity gate diverges from 056.'

  $pins=@{
    SessionDirectory=$session.FullName; Environment='qa'; ActorId="fixture'actor";
    TargetKind='database'; LinkEnvironment='test'; ClientId='fixture-client'; DomainId='fixture-domain'; DatabaseId='fixture-db';
    PhysicalLinkId='60000000-0000-0000-0000-000000000001'; PhysicalTargetId='60000000-0000-0000-0000-000000000002';
    PhysicalProofId='60000000-0000-0000-0000-000000000003'; CatalogOwnerId='60000000-0000-0000-0000-000000000004';
    ErpSourceId='60000000-0000-0000-0000-000000000005'; PhysicalLinkVersion='1111111111111111';
    PhysicalTargetVersion='2222222222222222'; OperationalProfileVersion='3333333333333333'; BindingVersion='4444444444444444';
    ErpProfileVersion='5555555555555555'; ErpRecordId='-2147483648'; ErpRevisionId='9223372036854775807';
    ApprovalReference='QA-TICKET-042'
  }
  $result=(& $scriptPath @pins) | ConvertFrom-Json
  $wire=[IO.File]::ReadAllText($captured)
  Require ($result.status -ceq 'dry-run' -and $null -eq $result.linkId -and $wire.Contains('DECLARE @bind_apply bit=0;')) 'Default did not simulate.'
  Require (!$wire.Contains($pins.ActorId) -and !$wire.Contains($pins.DatabaseId) -and !$wire.Contains($pins.ApprovalReference)) 'Raw identifiers reached the SQL text.'
  Require ($wire.Contains('EXEC sys.sp_executesql') -and $wire.Contains('DECLARE @bind_erpRevisionId bigint=9223372036854775807;')) 'Pinned values were not bound.'
  Check-Sql $wire

  $again=(& $scriptPath @pins -Apply -Confirm:$false) | ConvertFrom-Json
  $applyWire=[IO.File]::ReadAllText($captured)
  Require ($again.status -ceq 'registered' -and $again.linkId -ceq '60000000-0000-0000-0000-000000000099' -and
    $applyWire.Replace('DECLARE @bind_apply bit=1;','DECLARE @bind_apply bit=0;') -ceq $wire) 'Apply changed more than the explicit mode.'
  $changed=$pins.Clone(); $changed.PhysicalProofId='60000000-0000-0000-0000-000000000010'
  $null=& $scriptPath @changed
  $changedWire=[IO.File]::ReadAllText($captured)
  $receiptPattern='DECLARE @bind_approvalReference varchar\(80\)=([^\r\n]+);'
  Require ([regex]::Match($wire,$receiptPattern).Success -and [regex]::Match($changedWire,$receiptPattern).Success -and
    [regex]::Match($wire,$receiptPattern).Groups[1].Value -cne [regex]::Match($changedWire,$receiptPattern).Groups[1].Value) 'Changing the physical proof reused the earlier approval scope.'

  [IO.File]::Delete($captured)
  $bad=$pins.Clone(); $bad.ErpRevisionId='9223372036854775808'
  $rejected=$false
  try { $null=& $scriptPath @bad } catch { $rejected=$_.Exception.Message -ceq 'Invalid ERP record or revision pin.' }
  Require ($rejected -and ![IO.File]::Exists($captured)) 'Out-of-range revision reached the fake transport.'
  $cross=$pins.Clone(); $cross.Environment='production'
  try { $null=& $scriptPath @cross; $rejected=$false }
  catch { $rejected=$_.Exception.Message -ceq 'This operation requires the exact approved full-control Portal operator session.' }
  Require ($rejected -and ![IO.File]::Exists($captured)) 'Wrong environment reached the fake transport.'

  $domain=$pins.Clone(); $domain.TargetKind='domain'; $domain.Remove('DatabaseId'); $domain.Remove('OperationalProfileVersion')
  $null=& $scriptPath @domain
  $domainWire=[IO.File]::ReadAllText($captured)
  Require ($domainWire.Contains('DECLARE @bind_databaseId nvarchar(150)=NULL;') -and
    $domainWire.Contains('DECLARE @bind_operationalProfileVersion binary(8)=NULL;')) 'Domain simulation accepted database pins.'
  Check-Sql $domainWire
  $ambiguousFile=Join-Path $session.FullName 'ambiguous'
  try {
    [IO.File]::WriteAllText($ambiguousFile,'synthetic')
    try { $null=& $scriptPath @pins; $rejected=$false }
    catch { $rejected=$_.Exception.Message -ceq 'Operational link was not confirmed by the Portal session.' }
    Require $rejected 'A truncated broker result masqueraded as a verified link.'
  } finally { [IO.File]::Delete($ambiguousFile) }
  [ordered]@{ status='PASS'; mode='offline'; executedPortalSql=$false } | ConvertTo-Json -Compress
} finally {
  foreach ($path in @($captured,$descriptor,$stubPath,$sqlPath,$scriptPath)) { [IO.File]::Delete($path) }
  foreach ($directory in @($tools,$conn,$session,$temp)) { $directory.Delete() }
}
