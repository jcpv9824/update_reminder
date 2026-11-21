# Preview is read-only. Apply only after an independent human reviews the exact
# proposal/state and selects the operation identifier to authorize.
[CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='High')]
param(
  [Parameter(Mandatory)][string]$SessionDirectory,
  [Parameter(Mandatory)][ValidateSet('qa','production')][string]$Environment,
  [Parameter(Mandatory)][guid]$ProposalId,
  [Parameter(Mandatory)][string]$ProposalSha256,
  [string]$ReviewedStateSha256,
  [Parameter(Mandatory)][string]$ReviewerSourceId,
  [Parameter(Mandatory)][string]$OperationId,
  [switch]$Apply
)
$ErrorActionPreference='Stop'
if ($ProposalId -eq [guid]::Empty -or $ProposalSha256 -cnotmatch '\A[0-9a-fA-F]{64}\z' -or
    (($Apply -or $PSBoundParameters.ContainsKey('ReviewedStateSha256')) -and $ReviewedStateSha256 -cnotmatch '\A[0-9a-fA-F]{64}\z') -or
    $OperationId -cnotmatch '\A[A-Za-z0-9][A-Za-z0-9._:-]{0,199}\z' -or
    !$ReviewerSourceId -or $ReviewerSourceId.Length -gt 150 -or
    $ReviewerSourceId -cne $ReviewerSourceId.Trim() -or $ReviewerSourceId -match '\p{C}') {
  throw 'Expected the exact proposal, hashes, reviewer and reviewed operation.'
}
$database=if ($Environment -ceq 'qa') {'PortalSAGWeb-TEST'} elseif ($Environment -ceq 'production') {'PortalSAGWeb'} else {
  throw 'Expected an exact Portal environment.'
}
$session=(Resolve-Path -LiteralPath $SessionDirectory).Path
$descriptor=Get-Content -Raw -LiteralPath (Join-Path $session 'active.json') | ConvertFrom-Json
if ($descriptor.environment -cne $Environment -or $descriptor.database -cne $database -or
    $descriptor.fullControl -isnot [bool] -or !$descriptor.fullControl -or $descriptor.accessLevel -cne 'full-control' -or
    $descriptor.sessionAuthorized -isnot [bool] -or !$descriptor.sessionAuthorized) {
  throw 'Expected an independently authorized Portal operator session.'
}
if ($Apply -and !$PSCmdlet.ShouldProcess($Environment,'Record one expiring review receipt for the exact draft')) { return }
if (!$Apply -and $WhatIfPreference) { return }

$reviewId=[guid]::NewGuid().ToString('D')
$proposal=$ProposalId.ToString('D')
$digest=$ProposalSha256.ToLowerInvariant()
$state=if ($ReviewedStateSha256) {'0x'+$ReviewedStateSha256.ToLowerInvariant()} else {'NULL'}
$reviewerHex=[Convert]::ToHexString([Text.Encoding]::Unicode.GetBytes($ReviewerSourceId))
# Both interpolated strings are closed ASCII allowlists; reviewer is exact hex.
$body=@"
SET NOCOUNT ON;
DECLARE @env varchar(10)='$Environment',@proposal uniqueidentifier='$proposal',@review uniqueidentifier='$reviewId';
DECLARE @digest binary(32)=0x$digest,@expectedState binary(32)=$state,@actualState binary(32);
DECLARE @reviewer nvarchar(150)=CONVERT(nvarchar(150),0x$reviewerHex),@reviewerKey bigint;
DECLARE @operation nvarchar(200)=N'$OperationId',@now datetime2(3)=SYSUTCDATETIME();
IF NOT ((DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb-TEST' AND @env='qa')
     OR (DB_NAME() COLLATE Latin1_General_100_BIN2=N'PortalSAGWeb' AND @env='production'))
  OR ISNULL(IS_ROLEMEMBER(N'portal_runtime'),0)<>0 OR ISNULL(IS_ROLEMEMBER(N'portal_catalog_v2_publisher'),0)<>0
  THROW 57910,N'Expected the independent operator on the exact Portal database.',1;
SELECT @reviewerKey=r.user_key,@actualState=proof.reviewed_state_sha256
FROM scheduling.catalog_schedule_draft_proposals p
JOIN migration.v_catalog_schedule_draft_review_state proof ON proof.proposal_id=p.proposal_id
JOIN security.users r ON r.source_id COLLATE Latin1_General_100_BIN2=@reviewer AND r.active=1
  AND DATALENGTH(r.source_id)=DATALENGTH(@reviewer)
JOIN security.users requester ON requester.source_id COLLATE Latin1_General_100_BIN2=p.requester_source_id
  AND DATALENGTH(requester.source_id)=DATALENGTH(p.requester_source_id) AND requester.user_key<>r.user_key AND requester.active=1
JOIN security.user_roles m ON m.user_key=r.user_key AND m.role_id=N'super_admin'
JOIN security.roles rr ON rr.role_id=m.role_id AND rr.active=1 AND rr.system_role=1 AND rr.protected_role=1
WHERE p.proposal_id=@proposal AND p.portal_environment=@env AND p.proposal_sha256=@digest
  AND p.created_at<=@now AND p.requested_date>=CONVERT(date,DATEADD(hour,-5,@now));
IF @reviewerKey IS NULL OR @actualState IS NULL OR (@expectedState IS NOT NULL AND @expectedState<>@actualState)
  THROW 57911,N'The exact draft cannot be independently reviewed.',1;
"@
if ($Apply) {
  $sql="SET XACT_ABORT ON; SET TRANSACTION ISOLATION LEVEL SERIALIZABLE; BEGIN TRANSACTION; BEGIN TRY;`n"+$body+@"

INSERT migration.catalog_schedule_draft_review_receipts
  (review_id,proposal_id,proposal_sha256,reviewed_state_sha256,operation_id,reviewer_key)
VALUES (@review,@proposal,@digest,@expectedState,@operation,@reviewerKey);
DECLARE @expires datetime2(3)=(SELECT expires_at FROM migration.catalog_schedule_draft_review_receipts WHERE review_id=@review);
IF @expires IS NULL THROW 57912,N'The receipt could not be verified.',1;
COMMIT TRANSACTION;
SELECT 'review_recorded' AS status,LOWER(CONVERT(char(36),@review)) AS reviewId,
  CONVERT(varchar(23),@expires,126)+'Z' AS expiresAt,LOWER(CONVERT(char(64),@actualState,2)) AS reviewedStateSha256;
END TRY BEGIN CATCH IF XACT_STATE()<>0 ROLLBACK TRANSACTION; THROW; END CATCH;
"@
  $mode='write'
} else {
  $sql=$body+"`nSELECT 'eligible_read_only' AS status,CAST(NULL AS varchar(36)) AS reviewId,CAST(NULL AS varchar(24)) AS expiresAt,LOWER(CONVERT(char(64),@actualState,2)) AS reviewedStateSha256;"
  $mode='read'
}
$invoke=Join-Path $PSScriptRoot '../connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1'
try {
  $response=(& $invoke -SessionDirectory $session -Sql $sql -Mode $mode -TimeoutSeconds 20 -MaxRows 1) | ConvertFrom-Json -Depth 12
} catch { throw 'The Portal session did not confirm the independent draft review.' }
if ($response.success -isnot [bool] -or !$response.success -or @($response.resultSets).Count -ne 1 -or
    @($response.resultSets[0].rows).Count -ne 1 -or $response.resultSets[0].truncated) {
  throw 'The Portal session did not confirm the independent draft review.'
}
$row=$response.resultSets[0].rows[0]
if (($Apply -and ($row.status -cne 'review_recorded' -or $row.reviewId -cne $reviewId -or
       $row.expiresAt -cnotmatch '\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\z')) -or
    (!$Apply -and ($row.status -cne 'eligible_read_only' -or $null -ne $row.reviewId)) -or
    $row.reviewedStateSha256 -cnotmatch '\A[0-9a-f]{64}\z') {
  throw 'The Portal session returned an unexpected draft review result.'
}
[ordered]@{status=$row.status;reviewId=$row.reviewId;expiresAt=$row.expiresAt;reviewedStateSha256=$row.reviewedStateSha256} | ConvertTo-Json -Compress
