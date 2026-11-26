import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpRequest } from "@azure/functions";
import { createChecklistEvidenceHandlers, parseChecklistEvidenceMultipart, withChecklistEvidenceTransfer } from "../functions/checklistEvidence";
const id = "11111111-1111-4111-8111-111111111111", pointId = "22222222-2222-4222-8222-222222222222";
const actor = { id: "owner", email: "owner@example.invalid", canView: true, canCreate: false, isSuperAdmin: false };
const service = { preflight: vi.fn(), createBinary: vi.fn(), createJson: vi.fn(), content: vi.fn() };
const request = (method: string, input?: unknown) => new HttpRequest({ method, url: "https://qa.invalid/api/implementation/checklists", params: { id, pointId },
  ...(input === undefined ? {} : { headers: { "content-type": "application/json" }, body: { string: JSON.stringify(input) } }) });
const handlers = (current: typeof actor | null = actor) => createChecklistEvidenceHandlers({ authenticate: async () => current, service });
describe("API-09/10 · transporte con servicio simulado, sin objetos reales", () => {
  beforeEach(() => Object.values(service).forEach((fn) => fn.mockReset()));
  it("RN-45 exige sesión y view antes de consumir la carga o abrir almacenamiento", async () => {
    expect((await handlers(null).create(request("POST", { kind: "text", text: "x" }))).status).toBe(401);
    expect((await handlers({ ...actor, canView: false }).content(request("GET"))).status).toBe(403);
    expect(service.preflight).not.toHaveBeenCalled(); expect(service.content).not.toHaveBeenCalled();
  });
  it("API-09 admite JSON enlace/texto, 201 y preflight antes de guardar", async () => {
    service.createJson.mockResolvedValue({ id, pointId, kind: "text", status: "pending", text: "Nota" });
    const result = await handlers().create(request("POST", { kind: "text", text: "Nota" }));
    expect(result.status).toBe(201); expect(result.jsonBody).toMatchObject({ status: "pending" });
    expect(service.preflight).toHaveBeenCalledWith(actor, id, pointId);
    expect(service.createJson).toHaveBeenCalledWith(actor, id, pointId, { kind: "text", text: "Nota" });
  });
  it("CA-16/19 parsea multipart real y rechaza duplicados/campos extra", async () => {
    const form = new FormData(); form.set("kind", "image"); form.set("file", new Blob([readFileSync(resolve(process.cwd(), "../frontend/public/brand/sag-two-tone-icon.png"))], { type: "image/png" }), "captura.png");
    const req = () => new Request("https://qa.invalid", { method: "POST", body: form }) as unknown as HttpRequest;
    expect(await parseChecklistEvidenceMultipart(req())).toMatchObject({ kind: "image", name: "captura.png" });
    form.append("kind", "file"); await expect(parseChecklistEvidenceMultipart(req())).rejects.toMatchObject({ status: 400 });
  });
  it("CA-17 archivos/videos son attachment y solo raster validado puede ir inline; no URLs firmadas", async () => {
    service.content.mockResolvedValue({ bytes: Buffer.from("bytes"), fileName: "archivo.html", contentType: "application/octet-stream", disposition: "attachment" });
    const result = await handlers().content(request("GET"));
    expect(result.status).toBe(200); expect(result.headers).toMatchObject({ "Content-Type": "application/octet-stream", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" });
    expect((result.headers as Record<string, string>)["Content-Disposition"]).toMatch(/^attachment;/);
    expect(result.jsonBody).toBeUndefined(); expect(result.body).toEqual(Buffer.from("bytes"));
  });
  it("CA-18 rechaza el tamaño declarado por encima del cuerpo máximo sin leer bytes", async () => {
    const req = new HttpRequest({ method: "POST", url: "https://qa.invalid", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": "100065537" } });
    await expect(parseChecklistEvidenceMultipart(req)).rejects.toMatchObject({ status: 413 });
  });
  it("acota transferencias privadas concurrentes y libera el cupo tras error", async () => {
    let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; });
    const first = withChecklistEvidenceTransfer(() => wait);
    await expect(withChecklistEvidenceTransfer(async () => "other")).rejects.toMatchObject({ status: 503 });
    release(); await first;
    await expect(withChecklistEvidenceTransfer(async () => { throw new Error("falló"); })).rejects.toThrow("falló");
    expect(await withChecklistEvidenceTransfer(async () => "libre")).toBe("libre");
  });
});
