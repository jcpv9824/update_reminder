import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlCatalogSourceBinding } from "../lib/catalogSourceBindingsSqlRepository";

const stubs = vi.hoisted(() => ({
  routes: new Map<string, (req: HttpRequest) => Promise<HttpResponseInit>>(),
  requireUser: vi.fn(),
  loadUserProfile: vi.fn(),
  canManageIntegration: vi.fn(),
  loadRoleDefinitions: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
  certify: vi.fn(),
  limit: vi.fn(),
}));
vi.mock("@azure/functions", () => ({
  app: { http(_name: string, registration: { route: string; handler: (req: HttpRequest) => Promise<HttpResponseInit> }) {
    stubs.routes.set(registration.route, registration.handler);
  } },
}));
vi.mock("../lib/auth", () => ({ requireUser: stubs.requireUser, loadUserProfile: stubs.loadUserProfile }));
vi.mock("../lib/managementAccess", () => ({ canManageIntegration: stubs.canManageIntegration }));
vi.mock("../lib/roleDefinitionStore", () => ({ loadRoleDefinitions: stubs.loadRoleDefinitions }));
vi.mock("../lib/catalogSourceCertification", () => ({ certifySavedCatalogSource: stubs.certify }));
vi.mock("../lib/rateLimit", () => ({ enforceRequestRateLimit: stubs.limit, RATE_LIMIT_POLICIES: { integrationTest: {} } }));
vi.mock("../lib/catalogSourceBindingsSqlRepository", () => ({
  CATALOG_ERP_ISSUER_SCOPE: /^[A-Z]{2}:[A-Z][A-Z0-9_-]{0,31}$/,
  readSqlCatalogSourceBindings: stubs.read,
  saveSqlCatalogSourceDraft: stubs.save,
}));

import "../functions/catalogSources";

const listRoute = "settings/integrations/catalog-sources";
const saveRoute = listRoute + "/profile/{profileId}";
const verifyRoute = listRoute + "/{sourceId}/verify";
const activateRoute = listRoute + "/{sourceId}/activate";
const sourceId = "ac51a754-337c-46c4-b131-85e1a79443db";
const actor = { id: "actor-test", email: "actor@example.invalid", displayName: "Actor", roles: ["test-role"] };
const binding: SqlCatalogSourceBinding = {
  id: "source-test", profileId: "profile-test", label: "Empresa QA",
  role: "erp-customers", state: "draft", issuerScope: "CO:NIT",
  canReadCurrentProfile: false, environment: "qa", profileRevision: "fake-profile-revision",
  bindingVersion: "fake-binding-revision", contractVersion: "erp_v1",
};

const request = (body: unknown = null, profileId = "profile-test") => ({
  params: { profileId, sourceId },
  // The route must ignore any environment offered by the caller.
  query: new URLSearchParams({ environment: "production" }),
  json: vi.fn(async () => body),
}) as unknown as HttpRequest;

describe("catalog source draft management routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PORTAL_CATALOG_ADMIN_ENABLED", "true");
    vi.stubEnv("PORTAL_SAG_ENVIRONMENT", "qa");
    stubs.requireUser.mockResolvedValue(actor);
    stubs.loadUserProfile.mockResolvedValue(actor);
    stubs.canManageIntegration.mockReturnValue(true);
    stubs.loadRoleDefinitions.mockResolvedValue([]);
    stubs.read.mockResolvedValue([binding]);
    stubs.save.mockResolvedValue({ status: "saved", binding });
    stubs.limit.mockResolvedValue(null);
    stubs.certify.mockResolvedValue("verified");
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("keeps both routes off by default before authentication or SQL", async () => {
    vi.stubEnv("PORTAL_CATALOG_ADMIN_ENABLED", undefined);
    expect((await stubs.routes.get(listRoute)!(request())).status).toBe(404);
    expect((await stubs.routes.get(saveRoute)!(request())).status).toBe(404);
    expect(stubs.requireUser).not.toHaveBeenCalled();
    expect(stubs.read).not.toHaveBeenCalled();
    expect(stubs.save).not.toHaveBeenCalled();
  });

  it("requires the existing integration view permission and returns only the frozen fields", async () => {
    const response = await stubs.routes.get(listRoute)!(request());
    expect(stubs.canManageIntegration).toHaveBeenCalledWith(actor, "view", []);
    expect(stubs.read).toHaveBeenCalledWith("qa");
    expect(response.jsonBody).toEqual({
      items: [{ id: "source-test", profileId: "profile-test", label: "Empresa QA",
        role: "erp-customers", state: "draft", issuerScope: "CO:NIT", canReadCurrentProfile: false }],
    });
  });

  it("rejects unauthenticated or unauthorized users before reading settings or request body", async () => {
    stubs.requireUser.mockRejectedValueOnce(Object.assign(new Error("private-auth-details"), { status: 401 }));
    const unauthenticated = await stubs.routes.get(listRoute)!(request());
    expect(unauthenticated.status).toBe(401);
    expect(JSON.stringify(unauthenticated)).not.toContain("private-auth-details");
    stubs.canManageIntegration.mockReturnValue(false);
    const req = request({ role: "erp-customers", issuerScope: "CO:NIT" });
    expect((await stubs.routes.get(saveRoute)!(req)).status).toBe(403);
    expect(stubs.canManageIntegration).toHaveBeenLastCalledWith(actor, "edit_database", []);
    expect(req.json).not.toHaveBeenCalled();
    expect(stubs.read).not.toHaveBeenCalled();
    expect(stubs.save).not.toHaveBeenCalled();
  });

  it("only saves strict ERP issuer or issuer-free SAG payloads in the trusted runtime environment", async () => {
    const save = stubs.routes.get(saveRoute)!;
    const valid = await save(request({ role: "erp-customers", issuerScope: "co:nit" }));
    expect(valid.status).toBe(200);
    expect(stubs.save).toHaveBeenCalledWith(
      { profileId: "profile-test", environment: "qa", role: "erp-customers", issuerScope: "CO:NIT" }, actor,
    );
    stubs.save.mockClear();
    for (const body of [{ role: "erp-customers" }, { role: "erp-customers", issuerScope: "CO-NIT" },
      { role: "sag-admin", issuerScope: "CO:NIT" }, { role: "sag-admin", environment: "production" },
      { role: "sag-admin", state: "active" }, { role: "sag-admin", password: "must-not-be-read" }]) {
      const response = await save(request(body));
      expect(response.status).toBe(400);
      expect(JSON.stringify(response)).not.toContain("must-not-be-read");
    }
    expect(stubs.save).not.toHaveBeenCalled();
    expect((await save(request({ role: "sag-admin" }))).status).toBe(200);
    expect(stubs.save).toHaveBeenCalledWith({ profileId: "profile-test", environment: "qa", role: "sag-admin" }, actor);
  });

  it("does not expose SQL or profile details on error and maps active binding replacement to conflict", async () => {
    const save = stubs.routes.get(saveRoute)!;
    stubs.save.mockResolvedValueOnce({ status: "conflict" });
    expect((await save(request({ role: "sag-admin" }))).status).toBe(409);
    stubs.save.mockResolvedValueOnce({ status: "profile-not-found" });
    expect((await save(request({ role: "sag-admin" }))).status).toBe(404);
    stubs.read.mockRejectedValue(new Error("private server_host login_name credentials"));
    const failed = await stubs.routes.get(listRoute)!(request());
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed)).not.toContain("server_host");
  });

  it("requires test and edit permissions for activation and never trusts browser evidence", async () => {
    stubs.canManageIntegration.mockImplementation((_actor, action) => action === "test_database");
    const verify = await stubs.routes.get(verifyRoute)!(request({}));
    expect(verify.jsonBody).toEqual({ status: "verified" });
    expect(stubs.certify).toHaveBeenCalledWith({ environment: "qa", sourceId, action: "verify", actor });
    expect((await stubs.routes.get(activateRoute)!(request({}))).status).toBe(403);
    stubs.canManageIntegration.mockReturnValue(true);
    stubs.certify.mockClear();
    expect((await stubs.routes.get(activateRoute)!(request({ tlsValidated: true }))).status).toBe(400);
    expect(stubs.certify).not.toHaveBeenCalled();
    stubs.certify.mockResolvedValueOnce("activated");
    expect((await stubs.routes.get(activateRoute)!(request({}))).jsonBody).toEqual({ status: "activated" });
  });

  it("rate limits probes and does not infer production when the environment is missing", async () => {
    stubs.limit.mockResolvedValueOnce({ status: 429 });
    expect((await stubs.routes.get(verifyRoute)!(request({}))).status).toBe(429);
    vi.stubEnv("PORTAL_SAG_ENVIRONMENT", undefined);
    expect((await stubs.routes.get(activateRoute)!(request({}))).status).toBe(500);
    expect(stubs.certify).not.toHaveBeenCalled();
  });
});
