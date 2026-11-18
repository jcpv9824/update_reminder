const assert = require("node:assert/strict");
const test = require("node:test");
const { createHash } = require("node:crypto");
const { checkLogo } = require("./verify-public-seaweedfs-recovery.cjs");

const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const hash = createHash("sha256").update(bytes).digest("hex");
const reader = (body, headers = {}) => async () =>
  new Response(body, { headers: { "Content-Type": "image/png", ...headers } });

test("accepts a direct PNG whose bytes match even when Azure omits Content-Length", async () => {
  assert.deepEqual(await checkLogo("login", hash, reader(bytes)), { endpoint: 200, result: "pass" });
});

test("does not weaken byte, size, or redirect verification", async () => {
  assert.equal((await checkLogo("login", "0".repeat(64), reader(bytes))).result, "checksum");
  assert.equal((await checkLogo("login", hash, reader(bytes, { "Content-Length": "9" }))).result, "checksum");
  assert.equal((await checkLogo("login", hash, reader(bytes, { "Content-Length": "0" }))).result, "image_response");
  assert.equal((await checkLogo("login", hash, reader(bytes, { Location: "/unexpected" }))).result, "image_response");
  assert.equal((await checkLogo("login", hash, reader(new Uint8Array(524289)))).result, "checksum");
});
