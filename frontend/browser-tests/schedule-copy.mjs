// A real Chromium browser with a synthetic loopback-only API. Never points at QA or production.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PORTAL_TEST_PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
process.env.VITE_API_BASE_URL = "/api";
process.env.VITE_PORTAL_CATALOG_SCHEDULE_UI_ENABLED = "true";
process.env.VITE_PORTAL_CATALOG_COPY_PROPOSALS_ENABLED = "true";
process.env.VITE_PORTAL_CATALOG_DRAFT_PREVIEW_ENABLED = "true";
process.env.VITE_PORTAL_CATALOG_DRAFT_PROPOSALS_ENABLED = "true";
process.env.VITE_PORTAL_CATALOG_DRAFT_MATERIALIZATION_ENABLED = "true";
const server = await createServer({ root, configFile: false, envDir: false, plugins: [react()],
  server: { host: "127.0.0.1", port: 21791, strictPort: true, hmr: false } });
const proposalId = "7a9b6b25-aaf9-4dd3-ac93-43c4dd899a95";
const reviewId = "05d95fc4-21c3-4adc-8c8d-d23716fe679c";
const copyId = `catalog-copy-${proposalId}`;
const draftId = "8e81193e-312a-41b1-8fdd-69b22017802f";
const draftName = "Programación QA local";
const original = { id: "schedule-original", name: "Original QA local", clientId: "client-fake", clientName: "Cliente QA ficticio",
  targetType: "domain", targetIds: ["domain-original"], frequencyType: "once", startDate: new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date()), timezone: "America/Bogota", assignedRole: "domain_updater", origin: "special", active: true };
const copyName = "Copia QA local";
const eligibleDomain = "a".repeat(64), eligibleDb = "b".repeat(64), conflictingDomain = "c".repeat(64);
const preview = { previewId: "synthetic-loopback-only-preview", coverage: "verified", groups: [
  { kind: "domain", label: "Dominio libre", physicalTargetId: "free-host", links: [{ id: eligibleDomain, label: "Dominio libre", verified: true }] },
  { kind: "database", label: "Base libre", physicalTargetId: "free-db", links: [{ id: eligibleDb, label: "Base libre", verified: true }] },
  { kind: "domain", label: "Dominio ocupado", physicalTargetId: "busy-host", conflict: { id: "conflict", reason: "Otra operación reservada." },
    links: [{ id: conflictingDomain, label: "No seleccionar conflicto", verified: true }] },
] };
let browser;
let sourceExists = true;
let stage = null;
let draftStage = "pending_approval";
const mutations = [];
const unhandled = [];
try {
  await server.listen();
  const origin = "http://127.0.0.1:21791";
  browser = await chromium.launch({ headless: true, ...(process.env.PORTAL_TEST_EDGE_PATH && { executablePath: process.env.PORTAL_TEST_EDGE_PATH }) });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.route("**/*", async route => {
    const req = route.request(), url = new URL(req.url()), method = req.method();
    if (url.origin !== origin) { unhandled.push("non-loopback request"); return route.abort(); }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const api = url.pathname.slice(4);
    const json = (body, status = 200) => route.fulfill({ status, json: body, headers: { "Cache-Control": "no-store" } });
    if (method !== "GET") mutations.push({ method, api, body: req.postDataJSON() });
    if (method === "GET") {
      if (api === "/schedules") {
        const items = [...(sourceExists ? [original] : []), ...(stage === "active" ? [{ ...original, id: copyId, name: copyName }] : [])];
        return json({ items, page: 1, pageSize: 10, total: items.length });
      }
      if (api === "/schedules/schedule-original/catalog-copy-preview") return json(preview);
      if (api === "/schedules/schedule-original/catalog-copy-proposals") {
        return json({ items: stage ? [{ id: proposalId, name: copyName, date: original.startDate, status: stage }] : [] });
      }
      if (api === "/schedules/catalog-draft-proposals") {
        return json({ items: [{ id: draftId, name: draftName, date: original.startDate, status: draftStage }] });
      }
      if (api === "/settings/email-alerts") return json({ remindersEnabled: true });
      if (["/clients", "/domains", "/databases", "/users", "/roles", "/license-modules"].includes(api)) return json([]);
    }
    if (method === "POST" && api === "/schedules/schedule-original/catalog-copy-proposals") {
      stage = "pending_approval";
      return json({ proposalId, status: stage }, 202);
    }
    if (method === "POST" && api === `/schedules/catalog-copy-proposals/${proposalId}/activate`) {
      stage = "active";
      return json({ id: copyId, status: "created" }, 201);
    }
    if (method === "POST" && api === `/schedules/catalog-draft-proposals/${draftId}/activate`) {
      draftStage = "active";
      return json({ id: `catalog-draft-${draftId}`, status: "created" }, 201);
    }
    if (method === "DELETE" && api === "/schedules/schedule-original") {
      sourceExists = false;
      return route.fulfill({ status: 204 });
    }
    unhandled.push(`${method} ${api}`);
    return json({ error: "unsupported loopback fixture request" }, 404);
  });

  await page.goto(`${origin}/browser-tests/schedule-copy.html`);
  const originalRow = page.getByRole("row").filter({ hasText: original.name });
  await originalRow.getByRole("button", { name: "Duplicar" }).click();
  const dialog = page.locator(".modal").filter({ has: page.getByRole("heading", { name: "Duplicar actualización programada" }) });
  await dialog.getByRole("button", { name: "Trabajar con las restantes" }).click();
  assert.equal(await dialog.getByRole("checkbox", { name: "Dominio libre" }).isChecked(), true);
  assert.equal(await dialog.getByRole("checkbox", { name: "Base libre" }).isChecked(), true);
  assert.equal(await dialog.getByRole("checkbox", { name: "No seleccionar conflicto" }).count(), 0);
  await dialog.getByRole("checkbox", { name: "Dominio libre" }).uncheck();
  await dialog.getByText("1 de 2 destinos seleccionados", { exact: true }).waitFor();
  await dialog.getByRole("textbox", { name: "Nombre de la copia" }).fill(copyName);
  await dialog.getByRole("button", { name: "Solicitar copia" }).click();
  await dialog.getByText(/Solicitud guardada, pendiente/).waitFor();
  assert.deepEqual(mutations[0], { method: "POST", api: "/schedules/schedule-original/catalog-copy-proposals",
    body: { date: original.startDate, name: copyName, previewId: preview.previewId, linkIds: [eligibleDb] } });
  assert.equal(await page.getByRole("row").filter({ hasText: copyName }).count(), 0);
  console.log("PASS browser: first click selects only verified, non-conflicting destinations; request stores the edited subset");

  // Reload, rather than relying on React state from the just-completed request.
  await page.reload();
  await originalRow.getByRole("button", { name: "Duplicar" }).click();
  const saved = dialog.getByRole("article", { name: copyName });
  const field = saved.getByLabel("Recibo de revisión");
  await field.fill("not-a-receipt");
  await saved.getByRole("button", { name: "Confirmar copia revisada" }).click();
  await saved.getByText(/identificador completo/).waitFor();
  assert.equal(mutations.length, 1);
  await field.fill(reviewId);
  await saved.getByRole("button", { name: "Confirmar copia revisada" }).click();
  await saved.getByText(/Copia confirmada/).waitFor();
  await saved.getByText(/Fecha: .* Activada/).waitFor();
  assert.equal(await field.count(), 0);
  assert.ok(!page.url().includes(reviewId));
  assert.equal(await page.evaluate(() => Object.values(localStorage).length + Object.values(sessionStorage).length), 0);
  assert.deepEqual(mutations[1], { method: "POST", api: `/schedules/catalog-copy-proposals/${proposalId}/activate`, body: { reviewId } });
  console.log("PASS browser: saved request resumes after reload; invalid receipt stays local; valid one is sent only in the body");

  await dialog.getByRole("button", { name: "Cerrar" }).click();
  await originalRow.getByRole("button", { name: "Eliminar" }).click();
  await page.locator(".modal").filter({ has: page.getByRole("heading", { name: "Eliminar actualización programada" }) })
    .getByRole("button", { name: "Eliminar" }).click();
  await page.getByText("Actualización programada eliminada.", { exact: true }).waitFor();
  await page.getByRole("row").filter({ hasText: copyName }).waitFor();
  assert.equal(await originalRow.count(), 0);
  assert.deepEqual(mutations[2], { method: "DELETE", api: "/schedules/schedule-original", body: null });
  assert.equal(mutations.length, 3);
  assert.deepEqual(unhandled, []);
  console.log("PASS browser: deletion targets only the original and the independently confirmed copy remains visible (synthetic API)");

  await page.reload();
  await page.getByRole("button", { name: "Mis solicitudes", exact: true }).click();
  const draft = page.getByRole("article", { name: draftName });
  await draft.getByLabel("Recibo de revisión").fill(reviewId);
  await draft.getByRole("button", { name: "Confirmar programación revisada" }).click();
  await draft.getByText(/Fecha: .* Activada/).waitFor();
  assert.equal(await draft.getByLabel("Recibo de revisión").count(), 0);
  assert.ok(!page.url().includes(reviewId));
  assert.equal(await page.evaluate(() => Object.values(localStorage).length + Object.values(sessionStorage).length), 0);
  assert.deepEqual(mutations[3], { method: "POST", api: `/schedules/catalog-draft-proposals/${draftId}/activate`, body: { reviewId } });
  assert.equal(mutations.length, 4);
  assert.deepEqual(unhandled, []);
  console.log("PASS browser: new schedule receipt only in the request body and active state confirmed via refreshed list (synthetic API)");
} finally {
  await browser?.close();
  await server.close();
}
