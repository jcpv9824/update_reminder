import { HttpRequest } from "@azure/functions";
import { describe, expect, it, vi } from "vitest";
import { createCatalogRefreshHttp } from "../lib/catalogRefreshHttp";

const source = "ab51a754-337c-46c4-b131-85e1a79443db";
const config = { environment: "qa" as const, matchKeyVersion: 2, includeSag: true };
function setup() {
  const io = { enabled: vi.fn(() => true), configuration: vi.fn(() => config),
    authorize: vi.fn(() => Promise.resolve<{ actorId: string } | { status: 401 | 403 }>({ actorId: "real-actor" })),
    rateLimit: vi.fn().mockResolvedValue(null), enqueue: vi.fn().mockResolvedValue({ accepted: 3, coalesced: 1 }),
    status: vi.fn().mockResolvedValue({ pending: false, items: [] }) };
  return { io, handle: createCatalogRefreshHttp(io) };
}
const post = (json: unknown) => new HttpRequest({ method: "POST", url: "https://example.invalid/api/catalog/refresh",
  body: { string: JSON.stringify(json) } });
const get = (query = "") => new HttpRequest({ method: "GET", url: `https://example.invalid/api/catalog/refresh/status${query}` });

describe("catalog refresh HTTP boundary", () => {
  it("preserves omitted vs explicit empty scope and accepts only the loaded actor", async () => {
    const { io, handle } = setup();
    expect(await handle(post({}), "request")).toMatchObject({ status: 202, jsonBody: { accepted: 3, coalesced: 1 } });
    expect(io.enqueue).toHaveBeenLastCalledWith({ ...config, actorId: "real-actor", sourceIds: undefined });
    expect(await handle(post({ sourceIds: [] }), "request")).toMatchObject({ status: 202, jsonBody: { accepted: 0, coalesced: 0 } });
    expect(io.enqueue).toHaveBeenCalledTimes(1);
    for (const input of [{ actorId: "other" }, { server: "synthetic" }, { sourceIds: [source, source.toUpperCase()] },
      { sourceIds: ["invalid"] }, { sourceIds: Array(51).fill(source) }, null]) {
      expect((await handle(post(input), "request")).status).toBe(400);
    }
    expect(io.enqueue).toHaveBeenCalledTimes(1);
  });

  it("passes authorized status scope for revalidation, never enqueues on GET, and hides unauthorized requests", async () => {
    const { io, handle } = setup();
    io.status.mockResolvedValueOnce({ pending: true, items: [{ sourceId: source, status: "succeeded", updatedAt: "2026-11-18T00:00:00Z",
      leaseToken: "internal", actorId: "internal" }], hiddenSagSourceId: "internal" });
    const response = await handle(get(`?sourceIds=${source.toUpperCase()}`), "status");
    expect(response).toMatchObject({ status: 200, jsonBody: { pending: true, items: [{ sourceId: source, status: "succeeded" }] } });
    expect(JSON.stringify(response)).not.toContain("internal");
    expect(io.status).toHaveBeenLastCalledWith({ environment: "qa", includeSag: true, actorId: "real-actor", sourceIds: [source] });
    expect(io.enqueue).not.toHaveBeenCalled();
    io.status.mockResolvedValueOnce(null);
    expect((await handle(get(`?sourceIds=${source}`), "status")).status).toBe(403);
    io.authorize.mockResolvedValueOnce({ status: 401 });
    expect((await handle(get(), "status")).status).toBe(401);
    io.enqueue.mockResolvedValueOnce(null);
    expect((await handle(post({ sourceIds: [source] }), "request")).status).toBe(403);
  });

  it("returns controlled failures and does no authentication or repository IO while disabled", async () => {
    const { io, handle } = setup();
    io.enabled.mockReturnValueOnce(false);
    expect((await handle(get(), "status")).status).toBe(404);
    expect(io.authorize).not.toHaveBeenCalled();
    io.enqueue.mockRejectedValueOnce(new Error("restricted internal message"));
    const failed = await handle(post({}), "request");
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed)).not.toContain("restricted internal message");
    expect((await handle(get(`?sourceIds=${source}&sourceIds=${source}`), "status")).status).toBe(400);
  });
});
