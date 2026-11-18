import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  handlers: new Map<string, (req: HttpRequest) => Promise<HttpResponseInit>>(),
  read: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), profile: vi.fn(),
}));
vi.mock("@azure/functions", () => ({
  app: { http: (name: string, config: { handler: (req: HttpRequest) => Promise<HttpResponseInit> }) => {
    fakes.handlers.set(name, config.handler);
  } },
}));
vi.mock("../lib/auth", () => ({ requireUser: vi.fn(), loadUserProfile: fakes.profile }));
vi.mock("../lib/roleDefinitionStore", () => ({
  loadRoleDefinitions: async () => (await import("../lib/permissionModel")).DEFAULT_ROLE_DEFINITIONS,
}));
vi.mock("../lib/clientsSqlRepository", () => ({ readSqlClients: fakes.read, readSqlClientTree: vi.fn() }));
vi.mock("../lib/clientsSqlWriteRepository", () => ({ createSqlClient: fakes.create, updateSqlClient: fakes.update }));
vi.mock("../lib/coreCascadeSqlRepository", () => ({ deleteSqlCoreCascade: fakes.remove }));
import "../functions/clients";

const request = () => ({ params: { id: "legacy" }, query: new URLSearchParams(), json: vi.fn(async () => ({ name: "Example" })) }) as
  unknown as HttpRequest;

describe("customer catalog ownership at HTTP boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fakes.profile.mockResolvedValue({ id: "known-user", email: "example@example.invalid", roles: ["super_admin"] });
    fakes.read.mockResolvedValue([]);
    fakes.create.mockResolvedValue({ id: "example" });
    vi.stubEnv("PORTAL_CATALOG_READ_ENABLED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("blocks every direct legacy mutation even for an administrator when the catalog owns clients", async () => {
    for (const action of ["Create", "Update", "Delete", "Deactivate", "Reactivate"]) {
      const req = request();
      const response = await fakes.handlers.get(`clients${action}`)!(req);
      expect(response.status).toBe(409);
      expect(req.json).not.toHaveBeenCalled();
    }
    expect(fakes.create).not.toHaveBeenCalled();
    expect(fakes.update).not.toHaveBeenCalled();
    expect(fakes.remove).not.toHaveBeenCalled();
    expect(fakes.read).not.toHaveBeenCalled();
  });

  it("retains authorized legacy reads for dependents and legacy writes when the feature is off", async () => {
    expect((await fakes.handlers.get("clientsList")!(request())).status).toBe(200);
    expect(fakes.read).toHaveBeenCalledTimes(1);
    vi.stubEnv("PORTAL_CATALOG_READ_ENABLED", undefined);
    expect((await fakes.handlers.get("clientsCreate")!(request())).status).toBe(201);
    expect(fakes.create).toHaveBeenCalledTimes(1);
  });
});
