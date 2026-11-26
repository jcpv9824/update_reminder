import { HttpRequest } from "@azure/functions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChecklistHandlers } from "../functions/implementationChecklists";
import { ChecklistError } from "../lib/checklistDomain";

const id = "10000000-0000-4000-8000-000000000001";
const actor = { id: "tester", email: "tester@example.invalid", canView: true, canCreate: true, isSuperAdmin: false };
const io = { authenticate: vi.fn(), list: vi.fn(), read: vi.fn(), create: vi.fn(), save: vi.fn(), status: vi.fn(), search: vi.fn() };
const handles = createChecklistHandlers(io);
function request(method: string, body?: unknown, query = "") {
  return new HttpRequest({
    method, url: "https://qa.invalid/api/implementation/checklists" + query, params: { id },
    ...(body === undefined ? {} : { body: { string: JSON.stringify(body) } }),
  });
}
const proposal = { clientId: id, templateId: id };
const write = { rowVersion: "AAAAAAAAAAE=", points: [{ pointId: id, checked: true, notes: null }], evidence: { add: [], remove: [] } };

describe("Checklists API-01 a 08 · frontera HTTP", () => {
  beforeEach(() => {
    for (const fn of Object.values(io)) fn.mockReset();
    io.authenticate.mockResolvedValue(actor);
  });
  it("CA-10 sin sesión ninguna ruta llega al repositorio", async () => {
    io.authenticate.mockResolvedValue(null);
    for (const handle of Object.values(handles)) expect(await handle(request("POST", write))).toMatchObject({
      status: 401, headers: { "Cache-Control": "private, no-store" },
    });
    const { authenticate: _, ...data } = io;
    for (const fn of Object.values(data)) expect(fn).not.toHaveBeenCalled();
  });
  it("CA-10 conserva 403 de dueño y no acepta autoridad desde el cuerpo", async () => {
    for (const errorSource of [io.save, io.status]) errorSource.mockRejectedValue(new ChecklistError(403, "forbidden", "Sin permiso."));
    const checks = [
      [handles.save, request("PUT", write)], [handles.complete, request("POST", write)],
      [handles.remove, request("DELETE")], [handles.reopen, request("POST")],
    ] as const;
    for (const [handle, req] of checks) expect(await handle(req)).toMatchObject({ status: 403, jsonBody: { error: "forbidden" } });
    expect(await handles.save(request("PUT", { ...write, ownerId: "tester", isSuperAdmin: true }))).toMatchObject({ status: 400 });
    expect(io.save).toHaveBeenCalledTimes(2);
  });
  it("CA-03 rechaza un nombre no seleccionado y distingue permiso de crear de permiso de lectura", async () => {
    expect(await handles.create(request("POST", { client: "Solo texto", templateId: id }))).toMatchObject({ status: 400 });
    expect(io.create).not.toHaveBeenCalled();
    io.authenticate.mockResolvedValue({ ...actor, canView: false });
    expect(await handles.list(request("GET"))).toMatchObject({ status: 403 });
    io.create.mockResolvedValue({ id });
    expect(await handles.create(request("POST", proposal))).toMatchObject({ status: 201, jsonBody: { id } });
    expect(await handles.search(request("GET", undefined, "?q=abc"))).toMatchObject({ status: 200 });
    expect(io.search).toHaveBeenCalledWith(expect.objectContaining({ canView: false }), { q: "abc" });
  });
  it("CA-06 conserva conflicto de combinación y oculta errores internos", async () => {
    const existing = { id, ownerName: "QA", createdAt: "2026-11-26T10:00:00Z", completedAt: null };
    io.create.mockRejectedValueOnce(new ChecklistError(409, "duplicate_in_progress", "Ya está en progreso.", { existing }));
    expect(await handles.create(request("POST", proposal))).toMatchObject({
      status: 409, jsonBody: { error: "duplicate_in_progress", details: { existing } },
    });
    io.create.mockRejectedValueOnce(new Error("PRIVATE_INTERNAL_DETAIL"));
    const result = await handles.create(request("POST", proposal));
    expect(result.status).toBe(500);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_INTERNAL_DETAIL");
  });
  it("CA-34 entrega conflicto obsoleto sin reintentar el guardado", async () => {
    io.save.mockRejectedValue(new ChecklistError(409, "stale", "El checklist cambió."));
    expect(await handles.save(request("PUT", write))).toMatchObject({ status: 409, jsonBody: { error: "stale" } });
    expect(io.save).toHaveBeenCalledExactlyOnceWith(actor, id, write, false);
  });
});
