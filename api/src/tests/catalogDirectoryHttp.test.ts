import type { HttpRequest } from "@azure/functions";
import { describe, expect, it, vi } from "vitest";
import type { CatalogDirectoryInput } from "../lib/catalogCustomerDirectory";
import { createCatalogDirectoryHttp, parseCatalogDirectoryQuery } from "../lib/catalogDirectoryHttp";

const visibleSource = "00000000-0000-4000-8000-000000000001";
const hiddenSource = "00000000-0000-4000-8000-000000000002";
const visibleCustomer = "00000000-0000-4000-8000-000000000003";
const hiddenCustomer = "00000000-0000-4000-8000-000000000004";
const visibleDocument = { issuer: "CO", type: "NIT", number: "opaque-validation-key-1" };
const hiddenDocument = { issuer: "US", type: "TIN", number: "opaque-validation-key-2" };
const revisionAt = "2026-11-17T15:00:00.000Z";
const request = (query = "", id?: string) =>
  ({ query: new URLSearchParams(query), params: id ? { id } : {} }) as HttpRequest;

const fixture: CatalogDirectoryInput = {
  allowedSourceIds: new Set([visibleSource, hiddenSource]),
  erp: [
    { sourceId: visibleSource, label: "ERP visible", priority: 1, state: "verified", verifiedAt: revisionAt,
      customers: [{ sourceCustomerId: "internal-1", customerId: visibleCustomer, document: visibleDocument,
        officialName: "Cliente de ejemplo", activeCode: "S" }] },
    { sourceId: hiddenSource, label: "ERP oculto", priority: 2, state: "verified", verifiedAt: revisionAt,
      customers: [{ sourceCustomerId: "internal-2", customerId: hiddenCustomer, document: hiddenDocument,
        officialName: "No visible", activeCode: "S" }] },
  ],
  sag: { state: "verified", verifiedAt: revisionAt, documents: [visibleDocument, hiddenDocument],
    completeScopes: [{ issuer: "CO", type: "NIT" }, { issuer: "US", type: "TIN" }] },
};

function dependencies() {
  return {
    enabled: vi.fn(() => true),
    authorize: vi.fn(async (): Promise<{ actorId: string } | { status: 401 | 403 }> => ({ actorId: "authenticated-actor" })),
    readAllowedSourceIds: vi.fn(async () => new Set([visibleSource]) as ReadonlySet<string>),
    readPublishedDirectory: vi.fn(async () => fixture),
  };
}

describe("catalog directory HTTP contract", () => {
  it("parses independent filters and rejects duplicate, out-of-range and foreign query parameters", () => {
    expect(parseCatalogDirectoryQuery(new URLSearchParams("sourceId=" + visibleSource + "&state=inactive&web=all&page=2")))
      .toMatchObject({ sourceIds: [visibleSource], state: "inactive", web: "all", page: 2 });
    for (const query of ["environment=production", "pageSize=101", "state=active&state=inactive", "sourceId=not-a-uuid"]) {
      expect(() => parseCatalogDirectoryQuery(new URLSearchParams(query))).toThrow("Filtro de catálogo inválido.");
    }
  });

  it("does not touch SQL for disabled, anonymous or unauthorized requests", async () => {
    const deps = dependencies();
    const handle = createCatalogDirectoryHttp(deps);
    deps.enabled.mockReturnValueOnce(false);
    expect((await handle(request(), "list")).status).toBe(404);
    deps.authorize.mockResolvedValueOnce({ status: 401 }).mockResolvedValueOnce({ status: 403 });
    expect((await handle(request(), "list")).status).toBe(401);
    expect((await handle(request(), "list")).status).toBe(403);
    expect(deps.readAllowedSourceIds).not.toHaveBeenCalled();
    expect(deps.readPublishedDirectory).not.toHaveBeenCalled();
  });

  it("enforces actor-derived authorization independently of loaded data and prevents caching", async () => {
    const deps = dependencies();
    const handle = createCatalogDirectoryHttp(deps);
    const result = await handle(request(), "list");
    expect(result.status).toBe(200);
    expect(result.headers).toEqual({ "Cache-Control": "no-store" });
    expect(deps.readAllowedSourceIds).toHaveBeenCalledWith("authenticated-actor");
    expect(deps.readPublishedDirectory).toHaveBeenCalledWith(new Set([visibleSource]), "authenticated-actor");
    expect(result.jsonBody).toMatchObject({ total: 1, items: [{ id: visibleCustomer, name: "Cliente de ejemplo" }] });
    expect(JSON.stringify(result.jsonBody)).not.toMatch(/No visible|ERP oculto|opaque-validation|internal-/);
    expect((await handle(request("", hiddenCustomer), "detail")).status).toBe(404);
  });

  it("strips SAG-only rows unless enabled by trusted runtime policy and never accepts caller enablement", async () => {
    const orphan = { customerId: "00000000-0000-4000-8000-000000000009", name: "SAG aislado" };
    const deps = dependencies();
    deps.readPublishedDirectory.mockResolvedValue({ ...fixture, sagOnlyCustomers: [orphan] });
    const disabled = await createCatalogDirectoryHttp(deps)(request("state=unverified"), "list");
    expect(disabled.jsonBody).toMatchObject({ items: [] });
    expect((await createCatalogDirectoryHttp(deps)(request("includeSagDirectory=true"), "list")).status).toBe(400);
    const enabled = await createCatalogDirectoryHttp({ ...deps, includeSagDirectory: () => true })(request("state=unverified"), "list");
    expect(enabled.jsonBody).toMatchObject({ items: [{ id: orphan.customerId, sagOnly: true }] });
  });

  it("does not load a published revision for a selection outside the actor's scope", async () => {
    const deps = dependencies();
    expect((await createCatalogDirectoryHttp(deps)(request("sourceId=" + hiddenSource), "list")).status).toBe(400);
    expect(deps.readPublishedDirectory).not.toHaveBeenCalled();
  });

  it("accepts a document in an authenticated, no-store POST body without exposing the hidden source", async () => {
    const deps = dependencies();
    const createSearch = (body: string, query = "state=active_or_unverified&web=all") => ({
      ...request(query), headers: new Headers(),
      body: new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); },
      }),
    }) as HttpRequest;
    const readDisplayDocuments = vi.fn(async (input: CatalogDirectoryInput) => ({
      ...input, showDocuments: true, erp: input.erp.map(source => ({
        ...source, customers: source.customers.map(row => ({ ...row, displayDocument: "0007-DOCUMENT" })),
      })),
    }));
    const handle = createCatalogDirectoryHttp({ ...deps, includeSagDirectory: () => true, readDisplayDocuments });
    const body = JSON.stringify({ search: "0007-DOCUMENT" });
    deps.authorize.mockResolvedValueOnce({ status: 401 });
    expect((await handle(createSearch(body), "search")).status).toBe(401);
    expect(readDisplayDocuments).not.toHaveBeenCalled();
    const result = await handle(createSearch(body), "search");
    expect(result).toMatchObject({ status: 200, headers: { "Cache-Control": "no-store" },
      jsonBody: { total: 1, items: [{ displayDocument: "0007-DOCUMENT", name: "Cliente de ejemplo" }] } });
    expect(JSON.stringify(result.jsonBody)).not.toMatch(/No visible|opaque-validation|internal-/);
    expect((await handle(createSearch(body, "sourceId=" + hiddenSource), "search")).status).toBe(400);
  });

  it("stops reading an oversized streamed document search before source access", async () => {
    const dept = dependencies();
    const stop = vi.fn();
    const streamer = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(2050)); },
      cancel: stop,
    });
    const handle = createCatalogDirectoryHttp({ ...dept, includeSagDirectory: () => true });
    const result = await handle({ ...request(), body: streamer, headers: new Headers() } as HttpRequest, "search");
    expect(result.status).toBe(400);
    expect(stop).toHaveBeenCalledOnce();
    expect(dept.readAllowedSourceIds).not.toHaveBeenCalled();
  });

  it("returns a safe service error instead of SQL details or an empty result", async () => {
    const deps = dependencies();
    deps.readPublishedDirectory.mockRejectedValueOnce(new Error("protected driver details"));
    const result = await createCatalogDirectoryHttp(deps)(request(), "list");
    expect(result.status).toBe(503);
    expect(result.jsonBody).toEqual({ error: "El catálogo de clientes no está disponible." });
  });
});
