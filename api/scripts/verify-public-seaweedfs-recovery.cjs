// Read-only production smoke test. Never prints object paths, signatures, or content.
// node scripts/verify-public-seaweedfs-recovery.cjs <protected MANIFIESTO.json>
const fs = require("node:fs");
const { createHash } = require("node:crypto");

const api = "https://erpupdsch4645-api.azurewebsites.net/api";
const gateway = "https://storcube.sagweb.co:8333";
const logos = {
  login: "b04ea5e25b94ea73508101053f7d7aacb38bff0ec9adba3b41d32c9d537ebc5a",
  sidebar: "c172ae65f1ac2c2c1c1b0bb74baf0483650f5e80c2c7e5102af00adeb0f8f625",
};
const makeOptions = (extra = {}) => ({ signal: AbortSignal.timeout(45000), redirect: "manual", ...extra });

async function verifyBytes(response, expectedSize, expectedHash, maximumBytes = expectedSize) {
  if (!response.body) return false;
  let seen = 0;
  const digest = createHash("sha256");
  for await (const chunk of response.body) {
    seen += chunk.length;
    if (seen > maximumBytes) return false;
    digest.update(chunk);
  }
  return seen > 0 && (expectedSize === undefined || seen === expectedSize) &&
    digest.digest("hex") === expectedHash;
}

async function checkFile(route, expectedBytes, expectedHash) {
  const slug = encodeURIComponent(route.entry);
  const endpoint = route.kind === "file" ? `/public/files/${slug}` : `/public/downloads/${slug}`;
  const response = await fetch(api + endpoint, makeOptions());
  await response.body?.cancel();
  const destination = response.headers.get("Location");
  if (response.status !== 302 || !destination) return { endpoint: response.status, result: "no_redirect" };
  const url = new URL(destination);
  if (url.origin !== gateway || !url.searchParams.has("X-Amz-Signature") ||
      !response.headers.get("Cache-Control")?.includes("no-store")) {
    return { endpoint: response.status, result: "wrong_provider_or_cache" };
  }
  const read = await fetch(url, makeOptions());
  const disposition = route.kind === "file" ? "inline" : "attachment";
  const goodDisposition = read.headers.get("Content-Disposition")?.startsWith(disposition + ";") ?? false;
  if (read.status !== 200 || !goodDisposition) {
    await read.body?.cancel();
    return { endpoint: response.status, object: read.status, result: "object_or_disposition" };
  }
  if (!await verifyBytes(read, expectedBytes, expectedHash)) {
    return { endpoint: response.status, object: read.status, result: "checksum" };
  }
  const ranged = await fetch(url, makeOptions({ headers: { Range: "bytes=0-0" } }));
  const goodRange = ranged.status === 206 && ranged.headers.get("Content-Range") === `bytes 0-0/${expectedBytes}`;
  if (goodRange) {
    const oneByte = await ranged.arrayBuffer();
    return { endpoint: response.status, object: read.status, range: ranged.status, result: oneByte.byteLength === 1 ? "pass" : "range" };
  }
  await ranged.body?.cancel();
  return { endpoint: response.status, object: read.status, range: ranged.status, result: "range" };
}

async function checkLogo(name, expectedHash, read = fetch) {
  const r = await read(api + "/public/brand/" + name, makeOptions());
  const lengthHeader = r.headers.get("Content-Length");
  const length = lengthHeader === null ? undefined : Number(lengthHeader);
  const logoLimit = 524288;
  if (r.status !== 200 || r.headers.get("Content-Type")?.split(";")[0] !== "image/png" ||
      r.headers.has("Location") || (length !== undefined &&
        (!/^[0-9]+$/.test(lengthHeader) || !Number.isSafeInteger(length) || length < 1 || length > logoLimit))) {
    await r.body?.cancel();
    return { endpoint: r.status, result: "image_response" };
  }
  return { endpoint: r.status, result: await verifyBytes(r, length, expectedHash, logoLimit) ? "pass" : "checksum" };
}

async function main() {
  const [manifestFile] = process.argv.slice(2);
  if (!manifestFile || fs.statSync(manifestFile).size > 1000000) throw Error();
  const records = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const files = records.filter(row => row.environment === "PortalSAGWeb").flatMap(row => row.routes
    .filter(route => ["download", "file"].includes(route.kind))
    .map(route => ({ route, hash: row.sha256, size: row.bytes })));
  if (!files.length || files.some(r => typeof r.route.entry !== "string" || !r.route.entry ||
      !/^[a-f0-9]{64}$/.test(r.hash) || !Number.isSafeInteger(r.size) || r.size < 1 || r.size > 256000000)) throw Error();
  const seen = new Set();
  for (const { route } of files) {
    const id = route.kind + ":" + route.entry;
    if (seen.has(id)) throw Error();
    seen.add(id);
  }
  let passed = 0;
  let index = 0;
  for (const { route, hash, size } of files) {
    let outcome;
    try { outcome = await checkFile(route, size, hash); } catch { outcome = { result: "request_failed" }; }
    if (outcome.result === "pass") passed++;
    console.log(JSON.stringify({ family: route.kind, sample: ++index, ...outcome }));
  }
  for (const [logo, hash] of Object.entries(logos)) {
    let outcome;
    try { outcome = await checkLogo(logo, hash); } catch { outcome = { result: "request_failed" }; }
    if (outcome.result === "pass") passed++;
    console.log(JSON.stringify({ family: "logo", logo, ...outcome }));
  }
  const total = files.length + Object.keys(logos).length;
  console.log(JSON.stringify({ passed, total }));
  process.exitCode = passed === total ? 0 : 1;
}

module.exports = { checkLogo };
if (require.main === module) {
  main().catch(() => { console.error("Recovery smoke input or setup failed; details withheld."); process.exitCode = 1; });
}
