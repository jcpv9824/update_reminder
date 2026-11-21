import type { HttpRequest } from "@azure/functions";
import { describe, expect, it, vi } from "vitest";
import { createCatalogObservedInventoryV2Http } from "../lib/catalogObservedInventoryV2Http";

const source = "12345678-1111-4111-8111-111111111111";
const req = (query: string) => ({ query: new URLSearchParams(query) }) as HttpRequest;
function fixture() {
  const authorize = vi.fn<() => Promise<{ actorId: string; canReadCustomerDocuments?: boolean } | { status: 401 | 403 }>>()
    .mockResolvedValue({ actorId: "fixture" });
  const readSources = vi.fn().mockResolvedValue(new Set([source]));
  const row = { id: "row", customerId: "customer", customerName: "Client", name: "Domain", environment: "test" as const,
    detail: "detail", code: "D", licenses: ["Inventario"], document: "restricted", token: "restricted" };
  const read = vi.fn().mockResolvedValue({ state: "verified", total: 1, items: [row], sources: [{ id: source, label: "ERP", private: "restricted" }] });
  return { authorize, readSources, read, handler: createCatalogObservedInventoryV2Http({ authorize, readSources, read }) };
}

describe("observed catalog v2 transport", () => {
  it("leaves the license code and name intact and never looks up documents for the list of modules", async () => {
    const h = fixture();
    h.authorize.mockResolvedValue({ actorId: "fixture", canReadCustomerDocuments: true });
    const readDocuments = vi.fn();
    const handler = createCatalogObservedInventoryV2Http({ ...h, readDocuments });
    const response = await handler(req("v=2&tab=available"), "licenses");
    expect(response.jsonBody).toMatchObject({ items: [{ id: "row", code: "D", name: "Domain" }] });
    expect(JSON.stringify(response)).not.toContain("displayDocument");
    expect(readDocuments).not.toHaveBeenCalled();
  });

  it.each(["domains", "databases", "licenses"] as const)("adds only authorized display documents to %s without caching", async (view) => {
    const h = fixture();
    const readDocuments = vi.fn().mockResolvedValue(new Map([["customer", "00071-6"], ["unrelated", "unrelated-private"]]));
    const handler = createCatalogObservedInventoryV2Http({ ...h, readDocuments });
    const query = req(view === "licenses" ? "v=2&tab=licenseCustomers&code=D&sourceId=" + source : "v=2");

    expect((await handler(query, view)).jsonBody).toMatchObject({ items: [{ displayDocument: null }] });
    expect(readDocuments).not.toHaveBeenCalled();

    h.authorize.mockResolvedValue({ actorId: "fixture", canReadCustomerDocuments: true });
    const response = await handler(query, view);
    expect(readDocuments).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "fixture", allowedSourceIds: new Set([source]),
      ...(view === "licenses" ? { sourceIds: [source] } : {}),
    }), ["customer"]);
    expect(response).toMatchObject({ status: 200, headers: { "Cache-Control": "no-store" },
      jsonBody: { items: [{ id: "row", displayDocument: "00071-6" }] } });
    expect(JSON.stringify(response)).not.toMatch(/unrelated-private|restricted/);
  });

  it("binds the authorized scope, cuts internal data from the response, and accepts a known environment", async () => {
    const h = fixture();
    const result = await h.handler(req("v=2&search=Client&environment=test&page=2&pageSize=5"), "domains");
    expect(h.read).toHaveBeenCalledWith(expect.objectContaining({ actorId: "fixture", allowedSourceIds: new Set([source]),
      page: 2, pageSize: 5, search: "Client", environmentFilter: "test", view: "domains" }));
    expect(result).toMatchObject({ status: 200, headers: { "Cache-Control": "no-store" }, jsonBody: {
      items: [{ id: "row", customerId: "customer", customerName: "Client", name: "Domain", environment: "test", detail: "detail" }],
      page: 2, pageSize: 5,
    } });
    expect(JSON.stringify(result)).not.toContain("restricted");
  });

  it.each([
    ["v=2&v=2", "domains"], ["v=2&environment=multiple", "databases"], ["v=2&environment=production&environment=test", "domains"],
    ["v=2&tab=licenseCustomers&code=S", "licenses"], ["v=2&tab=licenseCustomers&code=BI", "licenses"],
    ["v=2&tab=customers&sourceId=00000000-0000-0000-0000-000000000001", "licenses"],
  ] as const)("rejects unsupported input %s before reading inventory", async (query, view) => {
    const h = fixture();
    expect((await h.handler(req(query), view)).status).toBe(400);
    expect(h.read).not.toHaveBeenCalled();
  });

  it("returns only ID and name in the modal and denies unauthorized sessions before performing scope reads", async () => {
    const h = fixture();
    const query = req("v=2&tab=licenseCustomers&code=D&state=unverified&web=in_web");
    const result = await h.handler(query, "licenses");
    expect((result.jsonBody as { items: unknown[] }).items).toEqual([
      { id: "row", customerId: "customer", customerName: "Client", displayDocument: null },
    ]);
    h.readSources.mockClear();
    h.authorize.mockResolvedValue({ status: 403 });
    expect((await h.handler(query, "licenses")).status).toBe(403);
    expect(h.readSources).not.toHaveBeenCalled();
  });
});
