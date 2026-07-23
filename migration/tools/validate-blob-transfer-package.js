const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildTransferPlan, prepareTransferPackage } = require("./prepare-blob-transfer-package");

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "portal-sag-blob-package-"));
try {
  const snapshot = path.join(root, "snapshot");
  const output = path.join(root, "package");
  fs.mkdirSync(snapshot);
  writeJson(path.join(snapshot, "manifest.json"), { containers: {} });
  const pdf = Buffer.from("%PDF-1.7\nsynthetic-test-only\n", "ascii");
  const text = Buffer.from("synthetic public file\n", "utf8");
  writeJson(path.join(snapshot, "formatosImpresion.json"), [{
    id: "synthetic-format", pdfBase64: pdf.toString("base64"),
    pdfNombreOriginal: "synthetic.pdf", pdfMimeType: "application/pdf",
  }]);
  writeJson(path.join(snapshot, "publicDownloads.json"), [{
    id: "synthetic-document", type: "document", archivoBase64: text.toString("base64"),
    archivoNombreOriginal: "synthetic.txt", archivoMimeType: "text/plain", archivoBytes: text.length,
  }]);

  const plan = buildTransferPlan(snapshot);
  assert.equal(plan.fileCount, 2);
  assert.equal(plan.totalBytes, pdf.length + text.length);
  assert.equal(new Set(plan.entries.map((entry) => entry.blobName)).size, 2);
  assert.ok(plan.entries.every((entry) => !entry.blobName.includes(entry.sourceId)));

  const created = prepareTransferPackage(plan, output);
  assert.equal(created.reused, false);
  const reused = prepareTransferPackage(plan, output);
  assert.equal(reused.reused, true);

  const firstFile = path.join(output, ...plan.entries[0].localRelativePath.split("/"));
  fs.appendFileSync(firstFile, "tamper");
  assert.throws(() => prepareTransferPackage(plan, output), /hash verification/);

  process.stdout.write("PASS private-Blob package validation, idempotency, opaque naming and tamper detection.\n");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
