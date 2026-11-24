import { describe, expect, it, vi } from "vitest";
import type { HttpRequest } from "@azure/functions";
import { app } from "@azure/functions";
vi.mock("@azure/functions", () => ({ app: { http: vi.fn() } }));
import { httpBoundary, whatsNewRateLimit, type WhatsNewHttpDependencies } from "../functions/whatsNew";
import { WhatsNewError } from "../lib/whatsNewModel";
const actor = { id: "sales", email: "sales@example.invalid", displayName: "Ventas", permissions: new Set<string>(), areas: new Set<never>() };
const req = {} as HttpRequest;
const deps = (): WhatsNewHttpDependencies => ({ enabled: () => true, authenticate: vi.fn(async () => actor), limit: vi.fn(async () => null) });

describe("Qué hay de nuevo HTTP boundary", () => {
  it.each([
    ["whatsNewEntry_draft", "PUT"], ["whatsNewEntry_client_text", "PUT"],
    ["whatsNewRound_checklist", "PATCH"], ["whatsNewRound_note_draft", "PUT"],
    ["whatsNewEntries", "POST"], ["whatsNewEntry_take", "POST"],
  ])("registers the actual %s transport as %s", (name, method) => {
    const registration = vi.mocked(app.http).mock.calls.find((call) => call[0] === name);
    expect(registration?.[1].methods).toContain(method);
  });
  it.each([
    ["GET", "/whats-new/me", true, "whats_new_read", 120],
    ["POST", "/whats-new/entries", true, "whats_new_write", 30],
    ["POST", "/whats-new/reports/preview", true, "whats_new_preview", 10],
    ["GET", "/public/novedades", false, "whats_new_public", 120],
  ])("selects actor-bounded limits for %s %s", (method, url, authenticated, scope, limit) => {
    expect(whatsNewRateLimit(method as string, url as string, authenticated as boolean)).toEqual({ scope, policy: { maxAttempts: limit, windowSeconds: 60, blockSeconds: 60 } });
  });
  it("is disabled by default before authentication or database operations", async () => {
    const d = deps(); d.enabled = () => false; const handler = vi.fn();
    const response = await httpBoundary(handler, false, d)(req);
    expect(response.status).toBe(404); expect(d.authenticate).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled();
    expect(d.limit).not.toHaveBeenCalled();
  });
  it("report read permits active authenticated users without option, area or recipient ACL", async () => {
    const d = deps(); const handler = vi.fn(async (_r, a) => ({ viewerId: a!.id }));
    const response = await httpBoundary(handler, false, d)(req);
    expect(response.status).toBe(200); expect(response.jsonBody).toEqual({ viewerId: "sales" });
  });
  it("anonymous or inactive users cannot read internal reports", async () => {
    const d = deps(); d.authenticate = vi.fn(async () => { throw new WhatsNewError(401, "no_autenticado", "No autenticado."); });
    const handler = vi.fn(); const response = await httpBoundary(handler, false, d)(req);
    expect(response.status).toBe(401); expect(handler).not.toHaveBeenCalled();
    expect(d.limit).not.toHaveBeenCalled();
  });
  it("does not expose provider/SQL details on errors", async () => {
    const response = await httpBoundary(async () => { throw new Error("PRIVATE_CONNECTION_PASSWORD"); }, false, deps())(req);
    expect(response.status).toBe(503); expect(JSON.stringify(response)).not.toContain("PRIVATE_CONNECTION");
  });
  it("public responses are no-store and bypass authentication, not rate limits", async () => {
    const d = deps(); const response = await httpBoundary(async () => ({ items: [] }), true, d)(req);
    expect(response.headers).toMatchObject({ "Cache-Control": "no-store" }); expect(d.authenticate).not.toHaveBeenCalled(); expect(d.limit).toHaveBeenCalled();
  });
  it("rate limited public calls cannot reach the domain handler", async () => {
    const d = deps(); d.limit = vi.fn(async () => ({ status: 429, headers: { "Retry-After": "60" } }));
    const handler = vi.fn(); const response = await httpBoundary(handler, true, d)(req);
    expect(response.status).toBe(429); expect(handler).not.toHaveBeenCalled(); expect(response.headers).toMatchObject({ "Cache-Control": "no-store", "Retry-After": "60" });
  });
  it("rate limits authenticated calls after auth and before the domain handler", async () => {
    const d = deps(); const order: string[] = [];
    d.authenticate = vi.fn(async () => { order.push("auth"); return actor; });
    d.limit = vi.fn(async (_r, current) => { order.push("limit"); expect(current).toBe(actor); return { status: 429, headers: { "Retry-After": "60" } }; });
    const handler = vi.fn(); const response = await httpBoundary(handler, false, d)(req);
    expect(order).toEqual(["auth", "limit"]); expect(response.status).toBe(429); expect(handler).not.toHaveBeenCalled();
    expect(response.headers).toMatchObject({ "Cache-Control": "private, no-store", "Retry-After": "60" });
  });
});
