import { describe, expect, it, vi } from "vitest";
import { parseCatalogSagPolicy, publishSavedCatalogSource } from "../lib/catalogSourcePublication";
import type { SqlCatalogSourceBinding } from "../lib/catalogSourceBindingsSqlRepository";

const mock = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("../lib/catalogCustomerRefresh", () => ({ refreshCatalogCustomerSource: mock.refresh }));
const source: SqlCatalogSourceBinding = { id: "ac51a754-337c-46c4-b131-85e1a79443db", profileId: "profile", label: "QA",
  environment: "qa", role: "erp-customers", issuerScope: "CO:NIT", state: "active", contractVersion: "erp_v1",
  canReadCurrentProfile: true, bindingVersion: "1234567890abcdef", profileRevision: "abcdef1234567890" };
const request = { environment: "qa" as const, sourceId: source.id, actorId: "operator" };
const config = { PORTAL_CATALOG_MATCH_KEY_VERSION: "2", PORTAL_CATALOG_MATCH_KEY_SECRET_NAME: "test-key",
  PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION: "0".repeat(32) };
const key = "ab".repeat(32);
function setup(rows: SqlCatalogSourceBinding[]) {
  mock.refresh.mockReset();
  return { readBindings: vi.fn().mockResolvedValue(rows), getSecret: vi.fn().mockResolvedValue(key),
    loadTransport: vi.fn().mockResolvedValue({}), publisher: vi.fn().mockResolvedValue({}) };
}
describe("saved-source publication", () => {
  it("binds one authorized source, gives it the exact secret version and clears the matching buffer", async () => {
    const second = { ...source, id: "bd51a754-337c-46c4-b131-85e1a79443db", profileId: "other-profile" };
    const io = setup([source, second]);
    mock.refresh.mockImplementationOnce(async options => {
      expect(options.matchKey.toString("hex")).toBe(key);
      await options.transport();
      return "published";
    });
    expect(await publishSavedCatalogSource(request, io, config)).toBe("published");
    expect(io.getSecret).toHaveBeenCalledExactlyOnceWith("test-key", expect.any(AbortSignal), config.PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION);
    expect(io.publisher).toHaveBeenCalledExactlyOnceWith({ id: "operator", sourceId: source.id, environment: "qa",
      bindingRevision: source.bindingVersion, profileRevision: source.profileRevision, matchKeyVersion: 2 });
    expect(io.loadTransport).toHaveBeenCalledExactlyOnceWith(source, undefined, expect.any(AbortSignal));
    expect(mock.refresh.mock.calls[0][0].matchKey).toEqual(Buffer.alloc(32));
  });

  it("does not request any secret for an uncertified binding, a different environment or an unpinned key", async () => {
    const io = setup([{ ...source, canReadCurrentProfile: false }]);
    expect(await publishSavedCatalogSource(request, io, config)).toBe("ineligible");
    io.readBindings.mockResolvedValue([source]);
    expect(await publishSavedCatalogSource({ ...request, environment: "production" }, io, config)).toBe("missing");
    expect(await publishSavedCatalogSource(request, io, { ...config, PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION: undefined })).toBe("not_configured");
    expect(io.getSecret).not.toHaveBeenCalled();
    expect(io.publisher).not.toHaveBeenCalled();
    expect(io.loadTransport).not.toHaveBeenCalled();
  });

  it("requires an explicit SAG country mapping and never asserts negative coverage", async () => {
    const io = setup([{ ...source, role: "sag-admin", contractVersion: "sag_admin_v1", issuerScope: undefined }]);
    expect(await publishSavedCatalogSource(request, io, config)).toBe("not_configured");
    expect(io.getSecret).not.toHaveBeenCalled();
    const policy = '[{"countryId":1,"issuerScope":"CO:NIT"}]';
    expect(parseCatalogSagPolicy(policy)).toEqual({ scopesByCountry: new Map([[1, "CO:NIT"]]), completeScopes: [] });
    expect(parseCatalogSagPolicy('[{"countryId":1,"issuerScope":"CO:NIT","complete":true}]')).toBeNull();
    expect(parseCatalogSagPolicy('[{"countryId":1,"issuerScope":"CO:NIT"},{"countryId":1,"issuerScope":"VE:RIF"}]')).toBeNull();
  });
});
