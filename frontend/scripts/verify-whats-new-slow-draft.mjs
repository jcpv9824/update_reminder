// Browser QA fixture. Serve a regular build made with VITE_WHATS_NEW_ENABLED=true,
// VITE_WHATS_NEW_PROTOTYPE=false and VITE_API_BASE_URL=/api. No live services or
// credentials are used. Stop the server to discard the synthetic draft.
// Usage: node scripts/verify-whats-new-slow-draft.mjs [dist-directory] [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { deflateSync } from "node:zlib";

const root = resolve(process.argv[2] ?? "dist");
const port = Number(process.argv[3] ?? 4176);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Port must be 1024–65535");
const html = await readFile(resolve(root, "index.html"));
const entryId = "11111111-1111-4111-8111-111111111111";
const fileId = "22222222-2222-4222-8222-222222222222";
const user = { id: "fixture-dev", displayName: "Desarrollador QA sintético", email: "fixture@example.test", roles: ["super_admin"], active: true };
const editorPath = `/actualizaciones/que-hay-de-nuevo/${entryId}/editar`;
const entryPath = `/api/whats-new/entries/${entryId}`;
let version = 1;
let activeWrites = 0;
let maxActiveWrites = 0;
let conflictNext = false;
const requests = [];
const reads = { me: 0, entry: 0, requiredActions: 0, supportUsers: 0, image: 0 };
let draft = {
  id: entryId, number: "QA-NOVEDADES-01", type: "mejora", system: "sag_web", status: "borrador", developer: user,
  clientName: null, routes: [{ via: "barra_lateral", submenus: ["Pedidos"], option: "Consultar" }],
  whatChanged: { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "Texto original de QA." }] },
    { type: "image", attrs: { fileId, alt: "Imagen sintética QA" } },
    { type: "paragraph" },
  ] },
  requiredActions: [], attachments: [], etag: '"v1"',
};

function pngChunk(name, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(name), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((~crc) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

function makeFixtureImage() {
  const width = 1280, height = 720, stride = width * 3 + 1;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const data = Buffer.alloc(stride * height);
  // Non-sensitive mock screenshot: sidebar, three filters, and a table.
  function rect(x, y, w, h, rgb) {
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      const offset = row * stride + 1 + col * 3;
      data[offset] = rgb[0]; data[offset + 1] = rgb[1]; data[offset + 2] = rgb[2];
    }
  }
  const navy = [27, 49, 85], white = [255, 255, 255], slate = [123, 145, 171], border = [215, 225, 235];
  rect(0, 0, width, height, [241, 245, 249]);
  rect(0, 0, 225, height, navy);
  rect(22, 26, 32, 32, [78, 149, 222]);
  rect(66, 32, 108, 8, white); rect(66, 47, 83, 6, slate);
  for (let i = 0; i < 6; i++) {
    const y = 115 + i * 66;
    if (i === 1) rect(0, y - 15, 225, 46, [47, 80, 126]);
    rect(23, y, 13, 13, [99, 164, 221]); rect(50, y + 3, 81 + i * 7, 7, white);
    rect(50, y + 17, 57 + i * 4, 4, slate);
  }
  rect(250, 33, 315, 23, navy); rect(250, 73, 491, 8, slate);
  rect(1100, 30, 151, 40, [35, 105, 172]); rect(1120, 47, 111, 7, white);
  for (const x of [250, 503, 756]) {
    rect(x, 115, 235, 38, border); rect(x + 1, 116, 233, 36, white);
    rect(x + 13, 131, 124, 6, slate);
  }
  rect(250, 185, 1001, 445, border); rect(251, 186, 999, 443, white);
  rect(251, 186, 999, 46, [224, 235, 246]);
  for (const x of [271, 503, 760, 1032]) rect(x, 205, 83, 7, navy);
  for (let i = 0; i < 8; i++) {
    const y = 247 + i * 47;
    rect(253, y + 28, 996, 1, border);
    for (const x of [271, 503, 760]) {
      rect(x, y, 68 + (i * 37 + x) % 110, 6, navy); rect(x, y + 12, 42 + (i * 17 + x) % 63, 4, slate);
    }
    rect(1027, y - 4, 95, 22, i % 3 ? [208, 235, 220] : [251, 231, 183]);
    rect(1040, y + 4, 67, 5, i % 3 ? [48, 113, 85] : [153, 109, 46]);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(data)), pngChunk("IEND", Buffer.alloc(0))]);
}
const image = makeFixtureImage();
const json = (res, data, status = 200) => res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(data));
const mime = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };

async function handle(req, res) {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  const method = req.method;
  if (path === "/__qa/draft-status" && method === "GET") return json(res, { version, activeWrites, maxActiveWrites, reads, requests, draft });
  if (path === "/__qa/conflict-next" && method === "POST") { conflictNext = true; return json(res, { conflictNext }); }
  if (path === "/api/auth/refresh" && method === "POST") return json(res, { token: "loopback-browser-qa-fixture" });
  if (path === "/api/me" && method === "GET") return json(res, { authenticated: true, registered: true, active: true, user });
  if (path === "/api/roles" && method === "GET") return json(res, []);
  if (path === "/api/whats-new/me" && method === "GET") {
    reads.me++;
    return json(res, { user, areas: ["desarrollo"], permissions: ["updates.whats_new.view", "updates.whats_new.author"], views: ["desarrollador"], defaultView: "desarrollador", storageAvailable: true, clientCatalogAvailable: false });
  }
  if (path === "/api/whats-new/lookups/required-actions" && method === "GET") { reads.requiredActions++; return json(res, []); }
  if (path === "/api/whats-new/lookups/support-users" && method === "GET") { reads.supportUsers++; return json(res, []); }
  if (path === entryPath && method === "GET") { reads.entry++; return json(res, draft); }
  if (path === `/api/whats-new/files/${fileId}` && method === "GET") {
    reads.image++;
    return res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" }).end(image);
  }
  if (path === `${entryPath}/draft` && method === "PUT") {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 512_000) return json(res, { code: "fixture_payload_too_large" }, 413);
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const record = { ifMatch: req.headers["if-match"], start: Date.now(), status: null };
    requests.push(record);
    activeWrites++;
    maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
    try {
      await new Promise(resolve => setTimeout(resolve, 6_000));
      if (conflictNext || record.ifMatch !== draft.etag) {
        conflictNext = false; record.status = 409;
        return json(res, { code: "version_desactualizada", message: "Conflicto simulado de QA." }, 409);
      }
      record.status = 200;
      draft = { ...draft, ...body, etag: `"v${++version}"` };
      return json(res, draft);
    } finally { record.end = Date.now(); activeWrites--; }
  }
  if (path.startsWith("/api/") || path.startsWith("/__qa/") || method !== "GET") return json(res, { code: "fixture_route_not_found" }, 404);
  if (!extname(path)) return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
  const file = resolve(root, `.${decodeURIComponent(path)}`);
  if (!file.startsWith(root + sep)) return json(res, { code: "fixture_asset_not_found" }, 404);
  try { const bytes = await readFile(file); return res.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream" }).end(bytes); }
  catch { return json(res, { code: "fixture_asset_not_found" }, 404); }
}

createServer((req, res) => {
  if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return json(res, { code: "fixture_loopback_only" }, 403);
  void handle(req, res).catch(() => { if (!res.headersSent) json(res, { code: "fixture_error" }, 500); else res.end(); });
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`QA fixture (6s per PUT): http://127.0.0.1:${port}${editorPath}\n`);
  process.stdout.write(`Synthetic persistence/status: http://127.0.0.1:${port}/__qa/draft-status\n`);
});
