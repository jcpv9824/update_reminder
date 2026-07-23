const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "portal-sag-rehearsal-evidence-"));
const compareScript = path.join(__dirname, "Compare-PortalSAGWeb-RehearsalEvidence.ps1");

function report(number, seconds = 3000, manifest = "a".repeat(64)) {
  return {
    version: 1,
    success: true,
    rehearsalNumber: number,
    databasePhaseSeconds: seconds,
    target: {
      engineMajorVersion: 15,
      compatibilityLevel: 150,
      collationName: "Modern_Spanish_CI_AS",
      initialUserTableCount: 0,
    },
    source: {
      snapshotName: "cosmos-export-prod-20260722-155753",
      sourceDocumentCount: 2987,
      warningCount: 464,
    },
    schema: {
      prepareSha256: "c".repeat(64),
      manifestSha256: manifest,
    },
    outcome: {
      status: "completed",
      sourceDocumentCount: 2987,
      warningCount: 464,
      criticalErrorCount: 0,
      failedReconciliationCount: 0,
      openCriticalCount: 0,
      verifiedFileCount: 39,
      untrustedConstraintCount: 0,
    },
  };
}

function write(name, value) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
  return file;
}

function compare(first, second, minutes = 100) {
  return spawnSync("pwsh", [
    "-NoProfile",
    "-ExecutionPolicy",
    "RemoteSigned",
    "-File",
    compareScript,
    "-FirstEvidence",
    first,
    "-SecondEvidence",
    second,
    "-ApprovedCutoverWindowMinutes",
    String(minutes),
  ], { encoding: "utf8" });
}

try {
  const first = write("first.json", report(1, 3100));
  const second = write("second.json", report(2, 3000));
  const success = compare(first, second);
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /certified\s*:\s*True/i);
  assert.match(success.stdout, /secondRunMarginPercent\s*:\s*50/i);

  const slow = write("slow.json", report(2, 4500));
  const insufficientMargin = compare(first, slow);
  assert.notEqual(insufficientMargin.status, 0);
  assert.match(
    `${insufficientMargin.stdout}\n${insufficientMargin.stderr}`,
    /at least 30% is required/i,
  );

  const mismatch = write("mismatch.json", report(2, 3000, "b".repeat(64)));
  const mismatchedContract = compare(first, mismatch);
  assert.notEqual(mismatchedContract.status, 0);
  assert.match(
    `${mismatchedContract.stdout}\n${mismatchedContract.stderr}`,
    /same schema manifest and source contract/i,
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

process.stdout.write("PASS rehearsal evidence comparison behavior.\n");
