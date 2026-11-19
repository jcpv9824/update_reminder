import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoleDefinition } from "../lib/permissionModel";

type Handler = (request: HttpRequest) => Promise<HttpResponseInit>;
const mocks = vi.hoisted(() => ({
  routes: new Map<string, Handler>(), auth: vi.fn(), profile: vi.fn(), roles: vi.fn(),
  scope: vi.fn(), evidence: vi.fn(), snapshots: vi.fn(), masters: vi.fn(),
}));
vi.mock("@azure/functions", () => ({
  app: { http: (_name: string, config: { route: string; handler: Handler }) => mocks.routes.set(config.route, config.handler) },
}));
vi.mock("../lib/auth", () => ({ requireUser: mocks.auth, loadUserProfile: mocks.profile }));
vi.mock("../lib/roleDefinitionStore", () => ({ loadRoleDefinitions: mocks.roles }));
vi.mock("../lib/catalogSourceAccessSqlRepository", () => ({ readAuthorizedCatalogSourceIds: mocks.scope }));
vi.mock("../lib/catalogSagCustomerEvidenceSqlRepository", () => ({ readSqlCatalogSagCustomerEvidence: mocks.evidence }));
vi.mock("../lib/catalogCustomerSnapshotsSqlRepository", () => ({ readSqlCatalogCustomerSnapshots: mocks.snapshots }));
vi.mock("../lib/catalogMasterInventorySqlRepository", () => ({ readSqlCatalogMasterInventory: mocks.masters }));
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
    vi.stubEnv("PORTAL_CATALOG_CLIENTS_READ_ENABLED", undefined);
    vi.stubEnv("PORTAL_SAG_ENVIRONMENT", "qa");
    vi.stubEnv("PORTAL_CATALOG_MATCH_KEY_VERSION", "1");
    mocks.auth.mockResolvedValue({ get: "test" });
    mocks.profile.mockResolvedValue({ id: "actor", email: "test@example.invalid", roles: ["test-grants"] });
    mocks.scope.mockResolvedValue(new Set(["authorized"]));
    mocks.evidence.mockResolvedValue({ state: "verified", verifiedAt: null, items: [] });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("enables only authorized customer list/detail in Clients-only scope, leaving every inventory closed", async () => {
    vi.stubEnv("PORTAL_CATALOG_READ_ENABLED", "false");
    vi.stubEnv("PORTAL_CATALOG_CLIENTS_READ_ENABLED", "true");
    vi.stubEnv("PORTAL_CATALOG_AUTOMATION_ENABLED", undefined);
    const sourceId = "7115bf63-9ee5-4407-820b-b4e82baa4566";
    mocks.roles.mockResolvedValue([role(["clients.clients.view", "clients.domains.view", "clients.databases.view", "clients.licensing.view"])]);
    mocks.scope.mockResolvedValue(new Set([sourceId]));
    mocks.snapshots.mockResolvedValue({ allowedSourceIds: new Set([sourceId]), erp: [{ sourceId, label: "ERP fixture", priority: 1,
      state: "verified", verifiedAt: "2026-11-17T15:00:00.000Z", customers: [{ sourceCustomerId: "1", customerId: id,
        document: { issuer: "CO", type: "NIT", number: "synthetic-opaque-token" }, officialName: "Cliente fixture", activeCode: "S" }] }],
      sag: { state: "unavailable", verifiedAt: null, documents: [], completeScopes: [] } });
    // Preserve the existing default "in_web" filter: this fixture deliberately
    // has no verified SAG membership, so request the explicit all-web-state view.
    const list = await mocks.routes.get("catalog/customers")!({ ...request, query: new URLSearchParams("web=all") } as HttpRequest);
    expect(list).toMatchObject({ status: 200, jsonBody: { items: [{ id, name: "Cliente fixture" }] } });
    expect(await mocks.routes.get("catalog/customers/{id}")!(request)).toMatchObject({ status: 200, jsonBody: { id } });
    expect(mocks.snapshots).toHaveBeenCalledWith({ allowedSourceIds: new Set([sourceId]), environment: "qa", matchKeyVersion: 1 });
    for (const path of ["catalog/customers/{id}/domains", "catalog/customers/{id}/licenses",
      "catalog/inventory/domains", "catalog/inventory/databases", "catalog/inventory/licenses"]) {
      expect((await mocks.routes.get(path)!(request)).status).toBe(404);
    }
    expect(mocks.auth).toHaveBeenCalledTimes(2); expect(mocks.evidence).not.toHaveBeenCalled(); expect(mocks.masters).not.toHaveBeenCalled();
    mocks.roles.mockResolvedValue([role(["clients.domains.view"])]);
    expect((await mocks.routes.get("catalog/customers")!(request)).status).toBe(403);
    expect(mocks.snapshots).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "false", "invalid", "true ", "TRUE"])("customer directory remains off without either read flag (%s)", async value => {
    vi.stubEnv("PORTAL_CATALOG_READ_ENABLED", undefined); vi.stubEnv("PORTAL_CATALOG_CLIENTS_READ_ENABLED", value);
    for (const path of ["catalog/customers", "catalog/customers/{id}"]) expect((await mocks.routes.get(path)!(request)).status).toBe(404);
    expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.snapshots).not.toHaveBeenCalled();
  });

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
