# Default is a read-only eligibility check. -Apply requires independent review
# of the exact proposal/hash and an already authorized Portal SQL session.
[CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='High')]
param(
  [Parameter(Mandatory)][string]$SessionDirectory,
  [Parameter(Mandatory)][ValidateSet('qa','production')][string]$Environment,
  [Parameter(Mandatory)][guid]$ProposalId,
  [Parameter(Mandatory)][string]$ReviewedSha256,
  [string]$ReviewedStateSha256,
  [Parameter(Mandatory)][string]$ReviewerSourceId,
  [switch]$Apply
)
$ErrorActionPreference='Stop'
if ($ProposalId -eq [guid]::Empty -or $ReviewedSha256 -cnotmatch '\A[0-9a-fA-F]{64}\z' -or
    !$ReviewerSourceId -or $ReviewerSourceId.Length -gt 150 -or
    $ReviewerSourceId -cne $ReviewerSourceId.Trim() -or $ReviewerSourceId -match '\p{C}' -or
    (($Apply -or $PSBoundParameters.ContainsKey('ReviewedStateSha256')) -and $ReviewedStateSha256 -cnotmatch '\A[0-9a-fA-F]{64}\z')) {
  throw 'Expected the exact reviewed proposal, SHA-256 and reviewer identity.'
}
$session=(Resolve-Path -LiteralPath $SessionDirectory).Path
$descriptor=Get-Content -Raw -LiteralPath (Join-Path $session 'active.json') | ConvertFrom-Json
$database=if ($Environment -ceq 'qa') { 'PortalSAGWeb-TEST' } elseif ($Environment -ceq 'production') { 'PortalSAGWeb' } else {
  throw 'Expected an exact Portal environment.'
}
if ($descriptor.environment -cne $Environment -or $descriptor.database -cne $database -or
    $descriptor.fullControl -isnot [bool] -or !$descriptor.fullControl -or $descriptor.accessLevel -cne 'full-control' -or
    $descriptor.sessionAuthorized -isnot [bool] -or !$descriptor.sessionAuthorized) {
  throw 'Expected an independently authorized Portal operator session.'
}
if ($Apply -and !$PSCmdlet.ShouldProcess($Environment,'Record one expiring review receipt for the reviewed copy proposal')) { return }
if (!$Apply -and $WhatIfPreference) { return }

$reviewId=[guid]::NewGuid().ToString('D')
$reviewerHex=[Convert]::ToHexString([Text.Encoding]::Unicode.GetBytes($ReviewerSourceId))
$proposal=$ProposalId.ToString('D')
$digest=$ReviewedSha256.ToLowerInvariant()
$state=if ($ReviewedStateSha256) { '0x'+$ReviewedStateSha256.ToLowerInvariant() } else { 'NULL' }
# Only exact-width hex/UUIDs and a validated environment enter this batch.
$body=@"
SET NOCOUNT ON;
DECLARE @env varchar(10)='$Environment',@proposal uniqueidentifier='$proposal',@review uniqueidentifier='$reviewId';
DECLARE @expected binary(32)=0x$digest,@reviewer nvarchar(150)=CONVERT(nvarchar(150),0x$reviewerHex);
DECLARE @expectedState binary(32)=$state,@currentState binary(32)=NULL;
DECLARE @now datetime2(3)=SYSUTCDATETIME(),@reviewerKey bigint=NULL;
IF NOT ((DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb-TEST' AND @env='qa')
     OR (DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb' AND @env='production'))
  OR ISNULL(IS_ROLEMEMBER(N'portal_runtime'),0)<>0
  OR ISNULL(IS_ROLEMEMBER(N'portal_catalog_v2_publisher'),0)<>0
  THROW 57610,N'Expected the independent operator on the exact Portal database.',1;
SELECT @reviewerKey=reviewer.user_key,@currentState=proof.reviewed_state_sha256
FROM scheduling.catalog_schedule_copy_proposals p
JOIN migration.v_catalog_schedule_copy_review_state proof ON proof.proposal_id=p.proposal_id
JOIN security.users reviewer ON reviewer.source_id=@reviewer COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(reviewer.source_id)=DATALENGTH(@reviewer) AND reviewer.active=1
JOIN security.user_roles membership ON membership.user_key=reviewer.user_key AND membership.role_id=N'super_admin'
JOIN security.roles role_row ON role_row.role_id=membership.role_id AND role_row.active=1 AND role_row.system_role=1 AND role_row.protected_role=1
JOIN scheduling.update_schedules original ON original.schedule_key=p.original_schedule_key
  AND original.row_version=p.original_definition_version AND original.active=1 AND original.deleted_at IS NULL
JOIN scheduling.catalog_schedule_operation_approvals operation
  ON operation.schedule_key=original.schedule_key AND operation.schedule_version=p.original_definition_version
  AND operation.portal_environment=p.portal_environment AND operation.operation_id=p.operation_id
  AND operation.retired_at IS NULL AND operation.approved_at<=@now
WHERE p.proposal_id=@proposal AND p.portal_environment=@env AND p.request_sha256=@expected
  AND p.requester_source_id<>@reviewer COLLATE Latin1_General_100_BIN2
  AND p.requested_date>=CONVERT(date,DATEADD(hour,-5,@now))
  AND NOT EXISTS(SELECT 1 FROM scheduling.catalog_schedule_copy_intents consumed WHERE consumed.intent_id=p.proposal_id)
  AND EXISTS(SELECT 1 FROM scheduling.catalog_schedule_copy_proposal_links pins WHERE pins.proposal_id=p.proposal_id);
IF @reviewerKey IS NULL THROW 57611,N'The exact proposal cannot be independently reviewed.',1;
IF @expectedState IS NOT NULL AND @currentState<>@expectedState THROW 57613,N'The reviewed copy state changed.',1;
"@
if ($Apply) {
  $sql="SET XACT_ABORT ON; SET TRANSACTION ISOLATION LEVEL SERIALIZABLE; BEGIN TRANSACTION; BEGIN TRY;`n"+$body+@"

INSERT migration.catalog_schedule_copy_review_receipts(review_id,proposal_id,request_sha256,reviewed_state_sha256,reviewer_key)
VALUES (@review,@proposal,@expected,@expectedState,@reviewerKey);
DECLARE @expires datetime2(3)=(SELECT expires_at FROM migration.catalog_schedule_copy_review_receipts WHERE review_id=@review);
IF @expires IS NULL THROW 57612,N'The copy review receipt was not confirmed.',1;
COMMIT TRANSACTION;
SELECT 'review_recorded' AS status,LOWER(CONVERT(char(36),@review)) AS reviewId,
  CONVERT(varchar(23),@expires,126)+'Z' AS expiresAt,LOWER(CONVERT(char(64),@currentState,2)) AS reviewedStateSha256;
END TRY BEGIN CATCH IF XACT_STATE()<>0 ROLLBACK TRANSACTION; THROW; END CATCH;
"@
  $mode='write'
} else {
  $sql=$body+"`nSELECT 'eligible_read_only' AS status,CAST(NULL AS varchar(36)) AS reviewId,CAST(NULL AS varchar(24)) AS expiresAt,LOWER(CONVERT(char(64),@currentState,2)) AS reviewedStateSha256;"
  $mode='read'
}
$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
try {
  $response=(& $invoke -SessionDirectory $session -Sql $sql -Mode $mode -TimeoutSeconds 20 -MaxRows 1) | ConvertFrom-Json -Depth 12
} catch { throw 'The Portal session did not confirm the review.' }
if ($response.success -isnot [bool] -or !$response.success -or @($response.resultSets).Count -ne 1 -or
    @($response.resultSets[0].rows).Count -ne 1 -or $response.resultSets[0].truncated) {
  throw 'The Portal session did not confirm the review.'
}
$row=$response.resultSets[0].rows[0]
if (($Apply -and ($row.status -cne 'review_recorded' -or $row.reviewId -cne $reviewId -or
       $row.expiresAt -cnotmatch '\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\z')) -or
    (!$Apply -and ($row.status -cne 'eligible_read_only' -or $null -ne $row.reviewId)) -or
    $row.reviewedStateSha256 -cnotmatch '\A[0-9a-f]{64}\z') {
  throw 'The Portal session returned an unexpected review result.'
}
[ordered]@{status=$row.status;reviewId=$row.reviewId;expiresAt=$row.expiresAt;reviewedStateSha256=$row.reviewedStateSha256} | ConvertTo-Json -Compress
