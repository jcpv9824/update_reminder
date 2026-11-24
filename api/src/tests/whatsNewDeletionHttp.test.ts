import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app, HttpRequest, InvocationContext } from "@azure/functions";
import type { HttpFunctionOptions } from "@azure/functions";
import { WhatsNewError } from "../lib/whatsNewModel";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), profile: vi.fn(), pool: vi.fn(), limit: vi.fn(),
  roleDefinitions: vi.fn(), areas: vi.fn(), readReport: vi.fn() }));
vi.mock("@azure/functions", async (original) => ({
  ...await original<typeof import("@azure/functions")>(),
  app: { http: vi.fn() },
}));
vi.mock("../lib/auth", async (original) => ({
  ...await original<typeof import("../lib/auth")>(),
  requireUser: mocks.authenticate,
  loadUserProfile: mocks.profile,
}));
vi.mock("../lib/sql", async (original) => ({
  ...await original<typeof import("../lib/sql")>(),
  getSqlPool: mocks.pool,
}));
vi.mock("../lib/rateLimit", async (original) => ({
  ...await original<typeof import("../lib/rateLimit")>(),
  enforceRequestRateLimit: mocks.limit,
}));
vi.mock("../lib/roleDefinitionStore", async (original) => ({
  ...await original<typeof import("../lib/roleDefinitionStore")>(),
  loadRoleDefinitions: mocks.roleDefinitions,
}));
vi.mock("../lib/whatsNewSqlRepository", async (original) => ({
  ...await original<typeof import("../lib/whatsNewSqlRepository")>(),
  areasFor: mocks.areas,
}));
vi.mock("../lib/whatsNewSavedReports", async (original) => ({
  ...await original<typeof import("../lib/whatsNewSavedReports")>(),
  readSavedReport: mocks.readReport,
}));
import "../functions/whatsNew";

const id = "11111111-1111-4111-8111-111111111111";
const routes = [
  ["DELETE", "whats-new/entries/{id}"],
  ["GET", "whats-new/reports/saved"],
  ["POST", "whats-new/reports/saved"],
  ["GET", "whats-new/reports/{id}"],
  ["DELETE", "whats-new/reports/{id}"],
] as const;

function lookup(method: typeof routes[number][0], pattern: string): HttpFunctionOptions {
  const matches = vi.mocked(app.http).mock.calls
    .map(([, options]) => options)
    .filter((options) => options.route === pattern && options.methods?.includes(method));
  expect(matches).toHaveLength(1);
  return matches[0];
}

describe("Novedades · autenticación de operaciones privadas", () => {
  beforeEach(() => {
    vi.stubEnv("WHATS_NEW_ENABLED", "true");
    mocks.authenticate.mockReset().mockRejectedValue(new WhatsNewError(401, "no_autenticado", "No autenticado."));
    mocks.pool.mockReset();
    mocks.limit.mockReset();
    mocks.profile.mockReset();
    mocks.roleDefinitions.mockReset();
    mocks.areas.mockReset();
    mocks.readReport.mockReset();
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each(routes)("%s %s never reaches rate limit or SQL without authentication", async (method, pattern) => {
    const route = lookup(method, pattern);
    const path = pattern.replace("{id}", id);
    const req = new HttpRequest({ method, url: `https://qa.invalid/api/${path}`, params: { id } });
    const result = await route.handler(req, new InvocationContext());
    expect(result.status).toBe(401);
    expect(result.headers).toMatchObject({
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    expect(mocks.authenticate).toHaveBeenCalledOnce();
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.pool).not.toHaveBeenCalled();
    expect(mocks.readReport).not.toHaveBeenCalled();
  });

  it("keeps the kill switch before authentication on deletion", async () => {
    vi.stubEnv("WHATS_NEW_ENABLED", "false");
    const route = lookup("DELETE", "whats-new/entries/{id}");
    const req = new HttpRequest({ method: "DELETE", url: `https://qa.invalid/api/whats-new/entries/${id}`, params: { id } });
    expect((await route.handler(req, new InvocationContext())).status).toBe(404);
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.pool).not.toHaveBeenCalled();
  });

  it("serves authenticated HTML as a sandboxed private response rather than permitting active content", async () => {
    const user = { id: "qa-super", email: "super@example.invalid", displayName: "QA", roles: ["super_admin"] };
    const html = Buffer.from("<!doctype html><title>Reporte QA</title><p>Prueba</p>", "utf8");
    mocks.authenticate.mockResolvedValue(user);
    mocks.profile.mockResolvedValue(user);
    mocks.roleDefinitions.mockResolvedValue([]);
    mocks.areas.mockResolvedValue([]);
    mocks.limit.mockResolvedValue(null);
    mocks.readReport.mockResolvedValue(html);
    const route = lookup("GET", "whats-new/reports/{id}");
    const req = new HttpRequest({ method: "GET", url: `https://qa.invalid/api/whats-new/reports/${id}`, params: { id } });
    const response = await route.handler(req, new InvocationContext());
    expect(response.status).toBe(200);
    expect(response.body).toBe(html);
    expect(response.jsonBody).toBeUndefined();
    expect(response.headers).toMatchObject({
      "Cache-Control": "private, no-store",
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": expect.stringContaining("sandbox; default-src 'none'"),
      "X-Content-Type-Options": "nosniff",
    });
    expect(mocks.readReport).toHaveBeenCalledWith(expect.objectContaining({ id: user.id, superAdmin: true }), id);
  });
});
