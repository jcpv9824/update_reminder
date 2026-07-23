/*
 * Creates a restricted, idempotent transfer package for private Azure Blob
 * upload. Default mode validates only. --prepare writes decoded files and a
 * sensitive manifest under migration/work/ (ignored by Git). No connection is
 * opened and no source ID, filename, hash, or document value is printed.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { decodeStrictBase64 } = require("./plan-operational-transform");

const PUBLIC_EXTENSIONS = new Set([
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".vsd",
  ".vsdx", ".html", ".htm", ".md", ".txt", ".csv", ".url",
  ".mp4", ".m4v", ".mov", ".webm",
]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm"]);

function validVideoSignature(extension, bytes) {
  if (extension === ".webm") return bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp";
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function readArray(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.documents)) return parsed.documents;
  if (Array.isArray(parsed.items)) return parsed.items;
  throw new Error(`Expected an array export: ${path.basename(filePath)}`);
}

function cleanExtension(filename) {
  const extension = path.extname(String(filename || "").trim()).toLowerCase();
  return /^[.][a-z0-9]{1,8}$/.test(extension) ? extension : "";
}

function opaqueName(sourceContainer, sourceId, fileHash, extension) {
  const token = sha256(Buffer.from(`${sourceContainer}\0${sourceId}\0${fileHash}`, "utf8"));
  return `portal-sag-import/${sourceContainer === "formatosImpresion" ? "print-formats" : "public-downloads"}/${token}${extension}`;
}

function buildTransferPlan(snapshotDirectory) {
  const snapshotPath = path.resolve(snapshotDirectory);
  const printFormats = readArray(path.join(snapshotPath, "formatosImpresion.json"));
  const publicDownloads = readArray(path.join(snapshotPath, "publicDownloads.json"));
  const entries = [];

  for (const record of printFormats) {
    const bytes = decodeStrictBase64(record.pdfBase64);
    const extension = cleanExtension(record.pdfNombreOriginal);
    if (!record.id || !bytes || bytes.length < 1 || bytes.length > 1_500_000
        || bytes.subarray(0, 5).toString("ascii") !== "%PDF-"
        || record.pdfMimeType !== "application/pdf" || extension !== ".pdf") {
      throw new Error("A print-format file failed the certified PDF contract.");
    }
    const fileHash = sha256(bytes);
    const blobName = opaqueName("formatosImpresion", record.id, fileHash, extension);
    entries.push({
      sourceContainer: "formatosImpresion", sourceId: String(record.id), fileSlot: "pdf",
      originalName: String(record.pdfNombreOriginal), mimeType: "application/pdf",
      byteCount: bytes.length, sha256: fileHash, blobName,
      localRelativePath: path.posix.join("payload", path.posix.basename(blobName)), bytes,
    });
  }

  for (const record of publicDownloads.filter((item) => item.type === "document")) {
    const bytes = decodeStrictBase64(record.archivoBase64);
    const extension = cleanExtension(record.archivoNombreOriginal);
    const isVideo = VIDEO_EXTENSIONS.has(extension);
    if (!record.id || !bytes || bytes.length < 1 || bytes.length > (isVideo ? 100_000_000 : 8_000_000)
        || !PUBLIC_EXTENSIONS.has(extension) || !String(record.archivoMimeType || "").trim()
        || (isVideo && (!String(record.archivoMimeType).startsWith("video/") || !validVideoSignature(extension, bytes)))
        || Number(record.archivoBytes) !== bytes.length) {
      throw new Error("A public-download file failed the certified file contract.");
    }
    const fileHash = sha256(bytes);
    const blobName = opaqueName("publicDownloads", record.id, fileHash, extension);
    entries.push({
      sourceContainer: "publicDownloads", sourceId: String(record.id), fileSlot: "document",
      originalName: String(record.archivoNombreOriginal), mimeType: String(record.archivoMimeType),
      byteCount: bytes.length, sha256: fileHash, blobName,
      localRelativePath: path.posix.join("payload", path.posix.basename(blobName)), bytes,
    });
  }

  const names = new Set(entries.map((entry) => entry.blobName));
  if (names.size !== entries.length) throw new Error("Deterministic Blob names are not unique.");

  entries.sort((left, right) => left.blobName.localeCompare(right.blobName, "en"));
  return {
    snapshotPath,
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.byteCount, 0),
    entries,
  };
}

function sensitiveManifest(plan) {
  const manifestPath = path.join(plan.snapshotPath, "manifest.json");
  return {
    version: 1,
    snapshotName: path.basename(plan.snapshotPath),
    snapshotManifestSha256: sha256(fs.readFileSync(manifestPath)),
    fileCount: plan.fileCount,
    totalBytes: plan.totalBytes,
    entries: plan.entries.map(({ bytes, ...entry }) => entry),
  };
}

function secureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const identity = process.env.USERNAME;
    if (!identity) throw new Error("Cannot determine the Windows identity for restricted ACLs.");
    const result = spawnSync("icacls.exe", [directory, "/inheritance:r", "/grant:r", `${identity}:(OI)(CI)F`], {
      windowsHide: true, stdio: "ignore",
    });
    if (result.status !== 0) throw new Error("Could not restrict the transfer-package directory ACL.");
  } else {
    fs.chmodSync(directory, 0o700);
  }
}

function verifyExistingPackage(outputDirectory, manifest) {
  const manifestFile = path.join(outputDirectory, "transfer-manifest.json");
  if (!fs.existsSync(manifestFile)) return false;
  const existing = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (JSON.stringify(existing) !== JSON.stringify(manifest)) {
    throw new Error("The existing transfer package belongs to a different plan.");
  }
  for (const entry of manifest.entries) {
    const filePath = path.join(outputDirectory, ...entry.localRelativePath.split("/"));
    if (!fs.existsSync(filePath)) throw new Error("The existing transfer package is incomplete.");
    const bytes = fs.readFileSync(filePath);
    if (bytes.length !== entry.byteCount || sha256(bytes) !== entry.sha256) {
      throw new Error("The existing transfer package failed hash verification.");
    }
  }
  return true;
}

function prepareTransferPackage(plan, outputDirectory) {
  const outputPath = path.resolve(outputDirectory);
  const manifest = sensitiveManifest(plan);
  if (fs.existsSync(outputPath) && verifyExistingPackage(outputPath, manifest)) {
    return { outputPath, reused: true };
  }
  if (fs.existsSync(outputPath) && fs.readdirSync(outputPath).length > 0) {
    throw new Error("The output directory is not empty and cannot be replaced safely.");
  }

  secureDirectory(outputPath);
  fs.mkdirSync(path.join(outputPath, "payload"), { recursive: true, mode: 0o700 });
  for (const entry of plan.entries) {
    const filePath = path.join(outputPath, ...entry.localRelativePath.split("/"));
    fs.writeFileSync(filePath, entry.bytes, { flag: "wx", mode: 0o600 });
  }
  fs.writeFileSync(path.join(outputPath, "transfer-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx", mode: 0o600,
  });
  return { outputPath, reused: false };
}

function parseArguments(argv) {
  const positional = [];
  let prepare = false;
  for (const value of argv) {
    if (value === "--prepare") prepare = true;
    else positional.push(value);
  }
  if (!positional[0]) {
    throw new Error("Usage: node prepare-blob-transfer-package.js <snapshot-directory> [output-directory] [--prepare]");
  }
  const snapshot = path.resolve(positional[0]);
  const output = positional[1]
    ? path.resolve(positional[1])
    : path.resolve(__dirname, "..", "work", `blob-transfer-${path.basename(snapshot)}`);
  return { snapshot, output, prepare };
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const plan = buildTransferPlan(options.snapshot);
    process.stdout.write(`Private-Blob transfer plan: ${plan.fileCount} files; ${plan.totalBytes} bytes; 0 file-contract failures.\n`);
    process.stdout.write("No source IDs, filenames, hashes, document values, SQL connection, or Blob connection were emitted.\n");
    if (!options.prepare) {
      process.stdout.write("Validation-only mode. Add --prepare to create the restricted, Git-ignored payload package.\n");
      return;
    }
    const result = prepareTransferPackage(plan, options.output);
    process.stdout.write(`${result.reused ? "Verified existing" : "Created"} restricted transfer package: ${result.outputPath}\n`);
  } catch (error) {
    process.stderr.write(`Blob transfer preparation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { buildTransferPlan, prepareTransferPackage, sensitiveManifest };
