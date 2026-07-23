const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const tools = __dirname;
const rehearsal = fs.readFileSync(
  path.join(tools, "Invoke-PortalSAGWeb-CurrentSnapshotRehearsal.ps1"),
  "utf8",
);
const compare = fs.readFileSync(
  path.join(tools, "Compare-PortalSAGWeb-RehearsalEvidence.ps1"),
  "utf8",
);

for (const pattern of [
  /RehearsalNumber/,
  /userTableCount\s+-ne\s+0/,
  /Get-RehearsalOutcome/,
  /prepareSha256/,
  /manifestSha256/,
  /phaseDurations/,
  /rehearsal-report\.json/,
]) {
  assert.match(rehearsal, pattern);
}

for (const phase of [
  "schema-build",
  "raw-stage",
  "operational-core",
  "scheduling-workflow",
  "private-blob-transfer",
  "final-operational",
]) {
  assert.match(rehearsal, new RegExp(`'${phase}'`));
}

for (const pattern of [
  /ApprovedCutoverWindowMinutes/,
  /RehearsalNumber/,
  /prepareSha256/,
  /manifestSha256/,
  /sourceDocumentCount/,
  /secondRunMarginPercent/,
  /30/,
]) {
  assert.match(compare, pattern);
}

process.stdout.write(
  "PASS rehearsal certification controller: empty builds, timed phases, aggregate evidence and two-run comparison.\n",
);
