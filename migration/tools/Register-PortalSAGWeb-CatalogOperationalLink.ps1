# Requires PowerShell 7 and an independently authorized Portal ephemeral SQL session.
# Before -Apply, obtain external approval for this exact scope, verify the actual
# operator and approved Portal actor, and use only that operator's authorized session.
# ActorId and ApprovalReference are supplied audit bindings. The caller's ticket
# and its hash are not authentication, authority, or proof of ticket approval.
# Default validates and rolls back without writes. It does not rehearse INSERT triggers.
[CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='High')]
param(
  [Parameter(Mandatory)][string]$SessionDirectory,
  [Parameter(Mandatory)][ValidateSet('qa','production')][string]$Environment,
  [Parameter(Mandatory)][string]$ActorId,
  [Parameter(Mandatory)][ValidateSet('database','domain')][string]$TargetKind,
  [Parameter(Mandatory)][ValidateSet('production','test','demo')][string]$LinkEnvironment,
  [Parameter(Mandatory)][string]$ClientId,
  [Parameter(Mandatory)][string]$DomainId,
  [string]$DatabaseId,
  [Parameter(Mandatory)][guid]$PhysicalLinkId,
  [Parameter(Mandatory)][guid]$PhysicalTargetId,
  [Parameter(Mandatory)][guid]$PhysicalProofId,
  [Parameter(Mandatory)][string]$PhysicalLinkVersion,
  [Parameter(Mandatory)][string]$PhysicalTargetVersion,
  [string]$OperationalProfileVersion,
  [Parameter(Mandatory)][guid]$CatalogOwnerId,
  [Parameter(Mandatory)][guid]$ErpSourceId,
  [Parameter(Mandatory)][string]$ErpRecordId,
  [Parameter(Mandatory)][string]$ErpRevisionId,
  [Parameter(Mandatory)][string]$BindingVersion,
  [Parameter(Mandatory)][string]$ErpProfileVersion,
  [Parameter(Mandatory)][string]$ApprovalReference,
  [switch]$Apply
)

$ErrorActionPreference='Stop'
function Assert-Id([string]$Value) {
  if (!$Value -or $Value.Length -gt 150 -or $Value -cne $Value.Trim() -or $Value -match '\p{C}') {
    throw 'Invalid exact operator or local identity.'
  }
}
function Assert-RowVersion([string]$Value) {
  if ($Value -cnotmatch '\A[0-9a-fA-F]{16}\z' -or $Value -ceq '0000000000000000') { throw 'Invalid rowversion pin.' }
}
if ($Environment -cnotin @('qa','production') -or $TargetKind -cnotin @('domain','database') -or
    $LinkEnvironment -cnotin @('production','test','demo')) { throw 'Invalid exact environment or target kind.' }
Assert-Id $ActorId
Assert-Id $ClientId
Assert-Id $DomainId
if ($TargetKind -ceq 'database') {
  Assert-Id $DatabaseId
  Assert-RowVersion $OperationalProfileVersion
} elseif ($PSBoundParameters.ContainsKey('DatabaseId') -or $PSBoundParameters.ContainsKey('OperationalProfileVersion')) {
  throw 'Domain requests cannot include database pins.'
}
foreach ($version in @($PhysicalLinkVersion,$PhysicalTargetVersion,$BindingVersion,$ErpProfileVersion)) { Assert-RowVersion $version }
if ([guid]::Empty -in @($PhysicalLinkId,$PhysicalTargetId,$PhysicalProofId,$CatalogOwnerId,$ErpSourceId)) {
  throw 'Invalid opaque identity pin.'
}
if ($ApprovalReference -cnotmatch '\A[A-Za-z0-9][A-Za-z0-9._-]{0,35}\z') { throw 'An exact independent approval reference is required.' }
$record=0
$revision=0L
if ($ErpRecordId -cnotmatch '\A(?:0|-?[1-9][0-9]{0,9})\z' -or ![int]::TryParse($ErpRecordId,[ref]$record) -or
    $ErpRevisionId -cnotmatch '\A[1-9][0-9]{0,18}\z' -or ![long]::TryParse($ErpRevisionId,[ref]$revision)) {
  throw 'Invalid ERP record or revision pin.'
}

# The request broker supports only SQL text. Scalar text crosses it encoded as
# Unicode hex (not quoted SQL input); typed sp_executesql parameters hold all values.
function Sql-Unicode([string]$Value) {
  return 'CONVERT(nvarchar(max),0x'+[Convert]::ToHexString([Text.Encoding]::Unicode.GetBytes($Value))+')'
}
$databaseText=if ($TargetKind -ceq 'database') { $DatabaseId } else { $null }
$operationalVersion=if ($TargetKind -ceq 'database') { $OperationalProfileVersion.ToLowerInvariant() } else { $null }
$pins=[ordered]@{
  environment=$Environment; actorId=$ActorId; targetKind=$TargetKind; linkEnvironment=$LinkEnvironment;
  clientId=$ClientId; domainId=$DomainId; databaseId=$databaseText; physicalLinkId=$PhysicalLinkId.ToString('D');
  physicalTargetId=$PhysicalTargetId.ToString('D'); physicalProofId=$PhysicalProofId.ToString('D');
  physicalLinkVersion=$PhysicalLinkVersion.ToLowerInvariant(); physicalTargetVersion=$PhysicalTargetVersion.ToLowerInvariant();
  operationalProfileVersion=$operationalVersion; catalogOwnerId=$CatalogOwnerId.ToString('D');
  erpSourceId=$ErpSourceId.ToString('D'); erpRecordId=$ErpRecordId; erpRevisionId=$ErpRevisionId;
  bindingVersion=$BindingVersion.ToLowerInvariant(); erpProfileVersion=$ErpProfileVersion.ToLowerInvariant();
  approvalReferenceBase=$ApprovalReference
}
# The exact 042 reference column preserves the ticket prefix and full scope digest.
# Changing pins for the same ticket is not treated as an idempotent retry.
$digest=[Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($pins | ConvertTo-Json -Compress)))
$receipt=[Convert]::ToBase64String($digest).TrimEnd('=').Replace('+','-').Replace('/','_')
$pins.approvalReference=$ApprovalReference+'.'+$receipt

try {
  $session=(Resolve-Path -LiteralPath $SessionDirectory).Path
  $descriptor=Get-Content -Raw -LiteralPath (Join-Path $session 'active.json') | ConvertFrom-Json
} catch { throw 'No approved Portal operator session is available.' }
$database=if ($Environment -ceq 'qa') { 'PortalSAGWeb-TEST' } else { 'PortalSAGWeb' }
if ($descriptor.environment -cne $Environment -or $descriptor.database -cne $database -or
    $descriptor.fullControl -isnot [bool] -or !$descriptor.fullControl -or $descriptor.accessLevel -cne 'full-control' -or
    $descriptor.sessionAuthorized -isnot [bool] -or !$descriptor.sessionAuthorized -or $descriptor.approvalMode -cne 'session') {
  throw 'This operation requires the exact approved full-control Portal operator session.'
}
if ($Apply -and !$PSCmdlet.ShouldProcess($Environment,'Commit exactly one independently approved operational link')) { return }
if (!$Apply -and $WhatIfPreference) { return }

$typeMap=[ordered]@{
  environment='varchar(10)'; actorId='nvarchar(150)'; targetKind='varchar(20)'; linkEnvironment='varchar(20)';
  clientId='nvarchar(150)'; domainId='nvarchar(150)'; databaseId='nvarchar(150)'; physicalLinkId='uniqueidentifier';
  physicalTargetId='uniqueidentifier'; physicalProofId='uniqueidentifier'; physicalLinkVersion='binary(8)';
  physicalTargetVersion='binary(8)'; operationalProfileVersion='binary(8)'; catalogOwnerId='uniqueidentifier';
  erpSourceId='uniqueidentifier'; erpRecordId='int'; erpRevisionId='bigint'; bindingVersion='binary(8)';
  erpProfileVersion='binary(8)'; approvalReferenceBase='varchar(36)'; approvalReference='varchar(80)'; apply='bit'
}
$values=$typeMap.Keys | ForEach-Object {
  $key=$_
  $value=$pins[$key]
  $literal=switch ($typeMap[$key]) {
    'bit' { [int][bool]$Apply }
    'int' { $record.ToString([Globalization.CultureInfo]::InvariantCulture) }
    'bigint' { $revision.ToString([Globalization.CultureInfo]::InvariantCulture) }
    'binary(8)' { if ($null -eq $value) { 'NULL' } else { '0x'+$value } }
    default { if ($null -eq $value) { 'NULL' } else { Sql-Unicode $value } }
  }
  "DECLARE @bind_$key $($typeMap[$key])=$literal;"
}
$signature=($typeMap.Keys | ForEach-Object { "@$_ $($typeMap[$_])" }) -join ','
$argsSql=($typeMap.Keys | ForEach-Object { "@$_=@bind_$_" }) -join ','
$body=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Register-PortalSAGWeb-CatalogOperationalLink.sql')).Replace("'","''")
$sql=($values -join "`n")+"`nEXEC sys.sp_executesql N'$body',N'$signature',$argsSql;"
$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
try {
  # The broker classifies transaction batches as write even for a rollback-only preview.
  $response=(& $invoke -SessionDirectory $session -Sql $sql -Mode write -TimeoutSeconds 20 -MaxRows 1) | ConvertFrom-Json -Depth 12
} catch { throw 'Operational link was not confirmed by the Portal session.' }
if ($response.success -isnot [bool] -or !$response.success -or @($response.resultSets).Count -ne 1) {
  throw 'Operational link was not confirmed by the Portal session.'
}
$set=$response.resultSets[0]
if ($set.totalRows -ne 1 -or $set.truncated -isnot [bool] -or $set.truncated -or
    @($set.columns).Count -ne 2 -or $set.columns[0] -cne 'status' -or $set.columns[1] -cne 'linkId' -or @($set.rows).Count -ne 1) {
  throw 'Operational link was not confirmed by the Portal session.'
}
$row=$set.rows[0]
$link=$row.linkId
if (($Apply -and $row.status -cnotin @('registered','existing')) -or (!$Apply -and $row.status -cne 'dry-run') -or
    ($Apply -and $null -eq $link) -or ($null -ne $link -and
      ($link -cnotmatch '\A[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\z' -or $link -ceq '00000000-0000-0000-0000-000000000000'))) {
  throw 'Operational link was not confirmed by the Portal session.'
}
[ordered]@{ status=$row.status; linkId=$link } | ConvertTo-Json -Compress
