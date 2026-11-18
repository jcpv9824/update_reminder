import { HttpRequest } from "@azure/functions";
import { describe, expect, it, vi } from "vitest";
import { createCatalogMasterInventoryHttp } from "../lib/catalogMasterInventoryHttp";

const request = (query = "") => new HttpRequest({ method: "GET", url: `https://qa.invalid/api/catalog/inventory/databases${query}` });
const allowed = new Set(["00000000-0000-0000-0000-000000000001"]);
function fixture() {
  const authorize = vi.fn().mockResolvedValue({ actorId: "user" });
  const readSources = vi.fn().mockResolvedValue(allowed);
  const read = vi.fn().mockResolvedValue({ state: "partial", total: 7, items: [
    { id: "logical-db", customerName: "Nombre ERP", name: "Base aprobada", environment: "test", connection: "not a DTO field" },
  ] });
  return { authorize, readSources, read, handler: createCatalogMasterInventoryHttp({ enabled: () => true, authorize, readSources, read }) };
}
describe("standalone catalogue inventory", () => {
  it("checks the exact option, uses server-derived source IDs, and returns an allowlisted page", async () => {
    const { handler, authorize, readSources, read } = fixture();
    const req = request("?page=2&pageSize=5");
    const res = await handler(req, "databases");
    expect(authorize).toHaveBeenCalledExactlyOnceWith(req, "databases");
    expect(readSources).toHaveBeenCalledExactlyOnceWith("user");
    expect(read).toHaveBeenCalledExactlyOnceWith({ allowedSourceIds: allowed, page: 2, pageSize: 5, actorId: "user", view: "databases" });
    expect(res).toEqual({ status: 200, headers: { "Cache-Control": "no-store" }, jsonBody: {
      items: [{ id: "logical-db", customerName: "Nombre ERP", name: "Base aprobada", environment: "test" }],
      state: "partial", total: 7, page: 2, pageSize: 5,
    } });
  });
  it.each([401, 403])("returns %s before loading permissions/data", async status => {
    const { handler, authorize, readSources, read } = fixture();
    authorize.mockResolvedValue({ status });
    expect((await handler(request(), "licenses")).status).toBe(status);
    expect(readSources).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["?sourceId=other", "?page=3&page=1", "?pageSize=0", "?page=1e2"])("rejects unexpected selectors or noncanonical paging %s", async query => {
    const { handler, read } = fixture();
    expect((await handler(request(query), "domains")).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });
  it("returns unavailable without reading broad inventory when no source is authorized", async () => {
    const { handler, readSources, read } = fixture();
    readSources.mockResolvedValue(new Set());
    expect((await handler(request(), "domains")).jsonBody).toMatchObject({ state: "unavailable", total: 0, items: [] });
    expect(read).not.toHaveBeenCalled();
  });
  it("never substitutes legacy data after failure", async () => {
    const { handler, read } = fixture();
    read.mockRejectedValue(new Error("sensitive driver message"));
    const res = await handler(request(), "domains");
    expect(res.status).toBe(503);
    expect(JSON.stringify(res)).not.toContain("sensitive");
  });
});
