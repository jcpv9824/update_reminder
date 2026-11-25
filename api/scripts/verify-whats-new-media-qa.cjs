// Private online QA: actual SQL Server 2019 + actual SeaweedFS, synthetic data.
// Refuses production before opening either service. Never prints identities or locators.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { randomUUID, createHash } = require("node:crypto");

if (process.env.PORTAL_SAG_ENVIRONMENT !== "qa" ||
    process.env.SQL_DATABASE !== "PortalSAGWeb-TEST" ||
    process.env.OBJECT_STORAGE_PROVIDER !== "seaweedfs" ||
    process.env.WHATS_NEW_MEDIA_ENABLED !== "true" ||
    !/^PortalSAGWeb-TEST\/Archivos\/pruebas-novedades-[a-f0-9]{8}$/.test(process.env.OBJECT_STORAGE_PREFIX ?? "") ||
    !process.env.WHATS_NEW_QA_ACTOR_EMAIL || !process.env.WHATS_NEW_QA_VIDEO_PATH) {
  console.error("QA guard: no requests sent; QA database, test prefix, actor and fixture are required.");
  process.exit(2);
}

const { getSqlPool, closeSqlPool } = require("../dist/src/lib/sql");
const { loadUserProfile } = require("../dist/src/lib/auth");
const { loadRoleDefinitions } = require("../dist/src/lib/roleDefinitionStore");
const { areasFor, query } = require("../dist/src/lib/whatsNewSqlRepository");
const { access, buildActor } = require("../dist/src/lib/whatsNewAccess");
const { mutate } = require("../dist/src/lib/whatsNewSqlWriteRepository");
const { getEntry, publicNews } = require("../dist/src/lib/whatsNewService");
const { inspectWhatsNewMedia, uploadWhatsNewMedia, readWhatsNewMedia } = require("../dist/src/lib/whatsNewMedia");

const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=", "base64");
function testPdf() {
  const stream = "BT /F1 14 Tf 20 75 Td (Novedades QA) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let text = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const position = text.length;
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return position;
  });
  const xref = text.length;
  return Buffer.from(text+`xref\n0 6\n0000000000 65535 f \n${offsets.map(p => `${String(p).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

let stage = "resolve QA actor";
(async () => {
  const pool = await getSqlPool();
  const [env] = await query(pool, "SELECT DB_NAME() db, CONVERT(int, SERVERPROPERTY('ProductMajorVersion')) major;");
  assert.equal(env.db, "PortalSAGWeb-TEST");
  assert.equal(env.major, 15);
  const email = process.env.WHATS_NEW_QA_ACTOR_EMAIL;
  const user = await loadUserProfile({ id: "qa-probe-lookup-only", email, displayName: "", roles: [] });
  assert.ok(user, "QA actor profile unavailable");
  const actor = buildActor(user, await loadRoleDefinitions(), await areasFor(user.id));
  // Only in this guarded SQL/SeaweedFS QA fixture, model a developer for
  // the existing QA super_admin without changing that account or its area.
  const imageLayout = process.env.WHATS_NEW_QA_IMAGE_LAYOUT === "true";
  if (imageLayout && access.superAdmin(actor) && !access.developer(actor)) actor.areas = new Set([...actor.areas, "desarrollo"]);
  assert.ok(access.developer(actor), "Existing QA account does not have developer authority");
  const off = async () => { const data = await publicNews({}); assert.equal(data.enabled, false); assert.equal(data.items.length, 0); };
  await off();
  stage = "create synthetic draft";
  const runId = randomUUID().slice(0, 8);
  const draft = { type: "nuevo", system: "sag_web", routes: [], whatChanged: { type: "doc", content: [{ type: "paragraph", content: [
    { type: "text", text: `Prueba sintética QA ${runId}`, marks: [{ type: "bold" }] },
  ] }] } };
  const created = (await mutate({ actor, operation: "create", id: null, body: draft, etag: null, idempotencyKey: randomUUID() })).detail;
  assert.equal(created.status, "borrador");

  stage = "upload and read private bytes";
  const fixtures = [
    { kind: "imagen", target: "que_cambio", name: "imagen-qa.png", bytes: png },
    { kind: "documento", target: "reglas_negocio", name: "regla-qa.pdf", bytes: testPdf() },
    { kind: "video", target: "video", name: "video-qa.mp4", bytes: fs.readFileSync(process.env.WHATS_NEW_QA_VIDEO_PATH) },
  ];
  const uploads = [];
  for (const fixture of fixtures) {
    const body = inspectWhatsNewMedia({ kind: fixture.kind, target: fixture.target }, fixture.name, fixture.bytes);
    const key = randomUUID();
    const file = await uploadWhatsNewMedia(actor, created.id, key, body);
    const replay = await uploadWhatsNewMedia(actor, created.id, key, body);
    assert.equal(replay.fileId, file.fileId);
    assert.equal(replay.replayed, true);
    const read = await readWhatsNewMedia(actor, file.fileId);
    assert.equal(checksum(read.bytes), checksum(fixture.bytes));
    uploads.push(file);
  }
  stage = "save and reopen draft";
  const [image, rule, video] = uploads;
  const privateImage = { type: "image", attrs: { fileId: image.fileId, alt: "QA", width: 416 } };
  const imageContent = imageLayout ? [{ type: "imageWithText", content: [privateImage, { type: "paragraph",
    content: [{ type: "text", text: "Texto junto a la captura", marks: [{ type: "italic" }] }] }] },
  { type: "paragraph", content: [{ type: "text", text: "Texto debajo de la captura" }] }] : [privateImage];
  const edited = { ...draft, attachments: [
    { group: "reglas_negocio", kind: "archivo", fileId: rule.fileId },
    { group: "video", kind: "archivo", fileId: video.fileId },
  ], whatChanged: { ...draft.whatChanged, content: [...draft.whatChanged.content, ...imageContent] } };
  await mutate({ actor, operation: "draft", id: created.id, body: edited, etag: created.etag, idempotencyKey: null });
  const reopened = await getEntry(actor, created.id);
  assert.equal(reopened.status, "borrador");
  assert.equal(reopened.attachments.length, 2);
  assert.match(JSON.stringify(reopened.whatChanged), /"type":"bold"/);
  assert.match(JSON.stringify(reopened.whatChanged), new RegExp(image.fileId, "i"));
  assert.doesNotMatch(JSON.stringify(reopened.whatChanged), /"src"|"href"|https?:\/\//);
  if (imageLayout) {
    assert.deepEqual(reopened.whatChanged.content.slice(1), imageContent);
    await assert.rejects(mutate({ actor, operation: "draft", id: created.id, body: { whatChanged: draft.whatChanged },
      etag: reopened.etag, idempotencyKey: null }), error => error.status === 409 && error.code === "editor_desactualizado");
  }
  for (const [i, file] of uploads.entries()) {
    assert.equal(checksum((await readWhatsNewMedia(actor, file.fileId)).bytes), checksum(fixtures[i].bytes));
  }
  stage = "reconcile QA prefix and isolation";
  const [counts] = await query(pool, `SELECT COUNT_BIG(*) hits, COUNT_BIG(CASE WHEN f.status='en_entrada' AND
    f.object_key LIKE @prefix + '/content/%' THEN 1 END) promoted
    FROM whats_new.entry_files f JOIN whats_new.entries e ON e.entry_key=f.entry_key WHERE e.source_id=@id;`,
    { id: created.id, prefix: process.env.OBJECT_STORAGE_PREFIX });
  assert.equal(Number(counts.hits), 3);
  assert.equal(Number(counts.promoted), 3);
  await off();
  console.log(JSON.stringify({ result: "PASS", qaDatabase: env.db, privateFilesReopened: 3, idempotentReplays: 3, persistedFormatting: true, imageLayout, publicEnabled: false, fixtureRemainsDraft: true }));
})().catch(error => {
  const name = typeof error?.code === "string" && /^[a-z0-9_]{1,45}$/i.test(error.code) ? error.code : undefined;
  console.error(JSON.stringify({ result: "FAIL", stage, code: name, sqlNumber: Number.isInteger(error?.number) ? error.number : undefined }));
  process.exitCode = 1;
}).finally(() => closeSqlPool?.());
