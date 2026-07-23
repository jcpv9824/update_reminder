[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)]
  [string]$FirstEvidence,
  [Parameter(Mandatory=$true)]
  [string]$SecondEvidence,
  [Parameter(Mandatory=$true)]
  [ValidateRange(1,10080)]
  [int]$ApprovedCutoverWindowMinutes
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Read-Evidence([string]$Path) {
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $report = Get-Content -LiteralPath $resolved -Raw | ConvertFrom-Json
  if ($report.version -ne 1 -or $report.success -ne $true) {
    throw "Invalid or unsuccessful rehearsal evidence: $resolved"
  }
  return $report
}

function Assert-CertifiedEvidence([object]$Report,[int]$RehearsalNumber) {
  if ($Report.rehearsalNumber -ne $RehearsalNumber) {
    throw "Expected certified rehearsal $RehearsalNumber evidence."
  }
  if ([string]$Report.schema.prepareSha256 -notmatch '^[a-f0-9]{64}$' -or
      [string]$Report.schema.manifestSha256 -notmatch '^[a-f0-9]{64}$') {
    throw "Certified rehearsal $RehearsalNumber has an invalid schema checksum contract."
  }
  if ($Report.target.engineMajorVersion -ne 15 -or
      $Report.target.compatibilityLevel -ne 150 -or
      $Report.target.collationName -ne 'Modern_Spanish_CI_AS' -or
      $Report.target.initialUserTableCount -ne 0) {
    throw "Certified rehearsal $RehearsalNumber did not start from the approved empty SQL Server 2019 target contract."
  }
  if ($Report.outcome.status -ne 'completed' -or
      $Report.outcome.sourceDocumentCount -ne 2987 -or
      $Report.outcome.warningCount -ne 464 -or
      $Report.outcome.criticalErrorCount -ne 0 -or
      $Report.outcome.failedReconciliationCount -ne 0 -or
      $Report.outcome.openCriticalCount -ne 0 -or
      $Report.outcome.verifiedFileCount -ne 39 -or
      $Report.outcome.untrustedConstraintCount -ne 0) {
    throw "Certified rehearsal $RehearsalNumber failed its aggregate Gate D outcome."
  }
}

$first = Read-Evidence $FirstEvidence
$second = Read-Evidence $SecondEvidence
Assert-CertifiedEvidence $first 1
Assert-CertifiedEvidence $second 2

if ($first.schema.prepareSha256 -cne $second.schema.prepareSha256 -or
    $first.schema.manifestSha256 -cne $second.schema.manifestSha256 -or
    $first.source.snapshotName -cne $second.source.snapshotName -or
    $first.source.sourceDocumentCount -ne $second.source.sourceDocumentCount -or
    $first.source.warningCount -ne $second.source.warningCount) {
  throw 'The two rehearsals did not use the same schema manifest and source contract.'
}

$approvedSeconds = $ApprovedCutoverWindowMinutes * 60.0
$secondSeconds = [double]$second.databasePhaseSeconds
$secondRunMarginPercent = [Math]::Round((1.0-($secondSeconds/$approvedSeconds))*100.0,2)
if ($secondRunMarginPercent -lt 30) {
  throw "The second rehearsal leaves only $secondRunMarginPercent% margin in the approved cutover window; at least 30% is required."
}

[pscustomobject]@{
  certified = $true
  prepareSha256 = $second.schema.prepareSha256
  manifestSha256 = $second.schema.manifestSha256
  sourceDocumentCount = $second.source.sourceDocumentCount
  firstRunMinutes = [Math]::Round(([double]$first.databasePhaseSeconds/60.0),2)
  secondRunMinutes = [Math]::Round(($secondSeconds/60.0),2)
  approvedCutoverWindowMinutes = $ApprovedCutoverWindowMinutes
  secondRunMarginPercent = $secondRunMarginPercent
  failedReconciliations = 0
  openCriticalErrors = 0
  verifiedPrivateFiles = 39
} | Format-List
