import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoleDefinition } from "../lib/permissionModel";

type Route = { route: string; methods: string[]; handler: (request: HttpRequest) => Promise<HttpResponseInit> };
const hooks = vi.hoisted(() => ({ routes: new Map<string, Route>(), auth: vi.fn(), profile: vi.fn(), roles: vi.fn(),
  enqueue: vi.fn(), status: vi.fn(), limit: vi.fn() }));
vi.mock("@azure/functions", () => ({ app: { http: (_: string, route: Route) => hooks.routes.set(route.route, route) } }));
vi.mock("../lib/auth", () => ({ requireUser: hooks.auth, loadUserProfile: hooks.profile }));
vi.mock("../lib/roleDefinitionStore", () => ({ loadRoleDefinitions: hooks.roles }));
vi.mock("../lib/catalogRefreshQueueSqlRepository", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/catalogRefreshQueueSqlRepository")>(),
  enqueueCatalogRefreshRequest: hooks.enqueue, readCatalogRefreshStatus: hooks.status }));
vi.mock("../lib/rateLimit", () => ({ enforceRequestRateLimit: hooks.limit, RATE_LIMIT_POLICIES: { catalogRefreshRequest: {}, catalogRefreshStatus: {} } }));
import "../functions/catalogRefresh";

const request = { query: new URLSearchParams(), text: async () => "{}" } as unknown as HttpRequest;
const role = (permission: string, active = true): RoleDefinition => ({ id: "fixture", name: "QA", active, system: false,
  permissions: [permission], taskVisibility: { domain: "none", database: "none" } });
const routes = () => [hooks.routes.get("catalog/refresh")!, hooks.routes.get("catalog/refresh/status")!];

describe("catalog refresh registered routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("PORTAL_CATALOG_READ_ENABLED", "true");
    vi.stubEnv("PORTAL_CATALOG_CLIENTS_READ_ENABLED", undefined);
    vi.stubEnv("PORTAL_CATALOG_AUTOMATION_ENABLED", "true");
    vi.stubEnv("PORTAL_SAG_ENVIRONMENT", "qa");
    vi.stubEnv("PORTAL_CATALOG_MATCH_KEY_VERSION", "2");
    vi.stubEnv("PORTAL_CATALOG_MATCH_KEY_SECRET_NAME", "synthetic-key");
    vi.stubEnv("PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION", "0".repeat(32));
    hooks.auth.mockResolvedValue({ id: "unloaded" });
    hooks.profile.mockResolvedValue({ id: "persisted", roles: ["fixture"] });
    hooks.enqueue.mockResolvedValue({ accepted: 1, coalesced: 0 });
    hooks.status.mockResolvedValue({ pending: true, items: [] });
    hooks.limit.mockResolvedValue(null);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("does not enqueue or authorize refresh from the Clients read flag alone", async () => {
    vi.stubEnv("PORTAL_CATALOG_READ_ENABLED", "false"); vi.stubEnv("PORTAL_CATALOG_CLIENTS_READ_ENABLED", "true");
    vi.stubEnv("PORTAL_CATALOG_AUTOMATION_ENABLED", undefined);
    for (const route of routes()) expect((await route.handler(request)).status).toBe(404);
    expect(hooks.auth).not.toHaveBeenCalled(); expect(hooks.enqueue).not.toHaveBeenCalled(); expect(hooks.status).not.toHaveBeenCalled();
  });

  it.each(["clients.clients.view", "clients.domains.view", "clients.databases.view", "clients.licensing.view"])(
    "Clients-only refresh evaluates %s without widening option access", async permission => {
      vi.stubEnv("PORTAL_CATALOG_READ_ENABLED", "false"); vi.stubEnv("PORTAL_CATALOG_CLIENTS_READ_ENABLED", "true");
      hooks.roles.mockResolvedValue([role(permission)]);
      const allowed = permission === "clients.clients.view";
      const [post, get] = routes();
      expect((await post.handler(request)).status).toBe(allowed ? 202 : 403);
      expect((await get.handler(request)).status).toBe(allowed ? 200 : 403);
      expect(hooks.enqueue).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(hooks.status).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(hooks.limit).toHaveBeenCalledTimes(allowed ? 2 : 0);
    });

  it.each(["clients.clients.view", "clients.databases.view", "clients.domains.view", "clients.licensing.view"])(
    "allows %s to queue and to poll under the persisted identity", async permission => {
      hooks.roles.mockResolvedValue([role(permission)]);
      const [post, get] = routes();
      expect(post.methods).toEqual(["POST"]);
      expect(get.methods).toEqual(["GET"]);
      expect((await post.handler(request)).status).toBe(202);
      expect((await get.handler(request)).status).toBe(200);
      expect(hooks.enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ actorId: "persisted" }));
      expect(hooks.status).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ actorId: "persisted" }));
      expect(hooks.limit).toHaveBeenCalledTimes(2);
    });

  it("denies unrelated and inactive roles, no session, inactive users, and the default-off flag", async () => {
    const [post, get] = routes();
    hooks.roles.mockResolvedValueOnce([role("updates.schedules.view")]);
    expect((await post.handler(request)).status).toBe(403);
    hooks.roles.mockResolvedValueOnce([role("clients.clients.view", false)]);
    expect((await get.handler(request)).status).toBe(403);
    hooks.auth.mockRejectedValueOnce(Object.assign(new Error("not a DTO"), { status: 401 }));
    expect((await get.handler(request)).status).toBe(401);
    hooks.profile.mockResolvedValueOnce(null);
    expect((await post.handler(request)).status).toBe(403);
    vi.stubEnv("PORTAL_CATALOG_AUTOMATION_ENABLED", undefined);
    expect((await post.handler(request)).status).toBe(404);
    expect(hooks.auth).toHaveBeenCalledTimes(4);
    expect(hooks.limit).not.toHaveBeenCalled();
    expect(hooks.enqueue).not.toHaveBeenCalled();
    expect(hooks.status).not.toHaveBeenCalled();
  });
});
