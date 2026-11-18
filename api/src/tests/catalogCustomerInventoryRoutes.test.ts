import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoleDefinition } from "../lib/permissionModel";

type Handler = (request: HttpRequest) => Promise<HttpResponseInit>;
const mocks = vi.hoisted(() => ({
  routes: new Map<string, Handler>(), auth: vi.fn(), profile: vi.fn(), roles: vi.fn(),
  scope: vi.fn(), evidence: vi.fn(),
}));
vi.mock("@azure/functions", () => ({
  app: { http: (_name: string, config: { route: string; handler: Handler }) => mocks.routes.set(config.route, config.handler) },
}));
vi.mock("../lib/auth", () => ({ requireUser: mocks.auth, loadUserProfile: mocks.profile }));
vi.mock("../lib/roleDefinitionStore", () => ({ loadRoleDefinitions: mocks.roles }));
vi.mock("../lib/catalogSourceAccessSqlRepository", () => ({ readAuthorizedCatalogSourceIds: mocks.scope }));
vi.mock("../lib/catalogSagCustomerEvidenceSqlRepository", () => ({ readSqlCatalogSagCustomerEvidence: mocks.evidence }));
vi.mock("../lib/catalogCustomerSnapshotsSqlRepository", () => ({ readSqlCatalogCustomerSnapshots: vi.fn() }));
import "../functions/catalogCustomers";

const id = "7115bf63-9ee5-4407-820b-b4e82baa45ee";
const request = { params: { id }, query: new URLSearchParams() } as unknown as HttpRequest;
const route = (view: "domains" | "licenses") => mocks.routes.get(`catalog/customers/{id}/${view}`)!;
const role = (permissions: string[]): RoleDefinition => ({
  id: "test-grants", name: "Test", permissions, system: false, taskVisibility: { domain: "none", database: "none" },
});
describe("catalog customer evidence route permissions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("PORTAL_CATALOG_READ_ENABLED", "true");
    vi.stubEnv("PORTAL_SAG_ENVIRONMENT", "qa");
    vi.stubEnv("PORTAL_CATALOG_MATCH_KEY_VERSION", "1");
    mocks.auth.mockResolvedValue({ get: "test" });
    mocks.profile.mockResolvedValue({ id: "actor", email: "test@example.invalid", roles: ["test-grants"] });
    mocks.scope.mockResolvedValue(new Set(["authorized"]));
    mocks.evidence.mockResolvedValue({ state: "verified", verifiedAt: null, items: [] });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("does not let either permission grant access to the other route", async () => {
    for (const [allowed, denied, permission] of [
      ["domains", "licenses", "clients.domains.view"], ["licenses", "domains", "clients.licensing.view"],
    ] as const) {
      mocks.roles.mockResolvedValue([role(["clients.clients.view", permission])]);
      expect((await route(allowed)(request)).status).toBe(200);
      expect((await route(denied)(request)).status).toBe(403);
    }
    expect(mocks.scope).toHaveBeenCalledTimes(2);
    expect(mocks.evidence).toHaveBeenCalledWith({
      customerId: id, environment: "qa", matchKeyVersion: 1, allowedSourceIds: new Set(["authorized"]),
    });
  });

  it("keeps the endpoint disabled by default and requires customer access when enabled", async () => {
    vi.stubEnv("PORTAL_CATALOG_READ_ENABLED", undefined);
    expect((await route("domains")(request)).status).toBe(404);
    expect(mocks.auth).not.toHaveBeenCalled();
    vi.stubEnv("PORTAL_CATALOG_READ_ENABLED", "true");
    mocks.roles.mockResolvedValue([role(["clients.domains.view", "clients.licensing.view"])]);
    expect((await route("licenses")(request)).status).toBe(403);
    mocks.auth.mockRejectedValueOnce(Object.assign(new Error("private"), { status: 401 }));
    expect((await route("domains")(request)).status).toBe(401);
    expect(mocks.evidence).not.toHaveBeenCalled();
  });
});
