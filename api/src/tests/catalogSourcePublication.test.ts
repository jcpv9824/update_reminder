import { describe, expect, it, vi } from "vitest";
import { catalogRefreshEnabled, parseCatalogSagPolicy, publishClaimedCatalogSource, publishSavedCatalogSource, readCatalogRefreshConfiguration } from "../lib/catalogSourcePublication";
import type { SqlCatalogSourceBinding } from "../lib/catalogSourceBindingsSqlRepository";
import { buildCatalogMatchKeyEvidence } from "../lib/catalogMatchKeyEvidence";

const mock = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("../lib/catalogCustomerRefresh", () => ({ refreshCatalogCustomerSource: mock.refresh }));
const source: SqlCatalogSourceBinding = { id: "ac51a754-337c-46c4-b131-85e1a79443db", profileId: "profile", label: "QA",
  environment: "qa", role: "erp-customers", issuerScope: "CO:NIT", state: "active", contractVersion: "erp_v1",
  canReadCurrentProfile: true, bindingVersion: "1234567890abcdef", profileRevision: "abcdef1234567890" };
const request = { environment: "qa" as const, sourceId: source.id, actorId: "operator" };
const config = { PORTAL_CATALOG_MATCH_KEY_VERSION: "2", PORTAL_CATALOG_MATCH_KEY_SECRET_NAME: "test-key",
  PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION: "0".repeat(32) };
const key = "ab".repeat(32);
const automation = { ...config, PORTAL_CATALOG_AUTOMATION_ENABLED: "true", PORTAL_CATALOG_READ_ENABLED: "true", PORTAL_SAG_ENVIRONMENT: "qa" };
const claim = { ...request, actorId: undefined, bindingRevision: source.bindingVersion, profileRevision: source.profileRevision,
  matchKeyVersion: 2, attempt: 1, jobId: "1a56df91-f51c-4320-a626-67fd22fd3db8",
  workerId: "3a56df91-f51c-4320-a626-67fd22fd3db8", leaseToken: "4a56df91-f51c-4320-a626-67fd22fd3db8" };
function setup(rows: SqlCatalogSourceBinding[]) {
  mock.refresh.mockReset();
  return { readBindings: vi.fn().mockResolvedValue(rows), getSecret: vi.fn().mockResolvedValue(key),
    loadTransport: vi.fn().mockResolvedValue({}), publisher: vi.fn().mockResolvedValue({}) };
}
describe("saved-source publication", () => {
  it("admits Clients-only read configuration only with independent automation and preserves owner readiness requirements", () => {
    const clients = { ...automation, PORTAL_CATALOG_READ_ENABLED: "false", PORTAL_CATALOG_CLIENTS_READ_ENABLED: "true" };
    expect(catalogRefreshEnabled(clients)).toBe(true);
    expect(catalogRefreshEnabled({ ...clients, PORTAL_CATALOG_AUTOMATION_ENABLED: undefined })).toBe(false);
    expect(readCatalogRefreshConfiguration(clients)).toMatchObject({ environment: "qa", matchKeyVersion: 2 });
    const owner = { ...clients, PORTAL_CATALOG_SAG_V2_ENABLED: "true", PORTAL_CATALOG_SAG_V2_PUBLISHER_MODE: "portal-owner",
      PORTAL_CATALOG_SAG_ISSUER_MAP: '[{"countryId":1,"issuerScope":"CO:NIT"}]', SQL_DATABASE: "PortalSAGWeb-TEST",
      SQL_SERVER_HOST: "qa.sagweb.co,54103", SQL_USERNAME: "SAGWebDev", SQL_PASSWORD: "synthetic-owner-password" };
    expect(readCatalogRefreshConfiguration(owner)?.includeSagV2).toBe(true);
    expect(readCatalogRefreshConfiguration({ ...owner, SQL_USERNAME: "different" })?.includeSagV2).toBeUndefined();
    expect(readCatalogRefreshConfiguration({ ...owner, PORTAL_CATALOG_AUTOMATION_ENABLED: "false" })).toBeNull();
  });

  it("preserves the ERP publication path with Clients-only admission", async () => {
    const io = setup([source]);
    const sink = { reserveAttempt: vi.fn().mockResolvedValue("912"), publish: vi.fn(), recordFailure: vi.fn() };
    io.publisher.mockResolvedValue(sink);
    mock.refresh.mockImplementationOnce(async options => { await options.sink.reserveAttempt(); await options.transport(); return "published"; });
    const { actorId: _, ...job } = claim;
    expect(await publishClaimedCatalogSource(job, io, { ...automation, PORTAL_CATALOG_READ_ENABLED: "false",
      PORTAL_CATALOG_CLIENTS_READ_ENABLED: "true" })).toBe("published");
    expect(io.publisher).toHaveBeenCalledOnce(); expect(io.loadTransport).toHaveBeenCalledOnce();
  });
  it("builds an isolated worker publisher without a human actor and checks binding before the credential pipeline", async () => {
    const io = setup([source]);
    const sink = { reserveAttempt: vi.fn().mockResolvedValue("912"), publish: vi.fn(), recordFailure: vi.fn() };
    io.publisher.mockResolvedValue(sink);
    mock.refresh.mockImplementationOnce(async options => {
      await options.sink.reserveAttempt();
      await options.transport();
      return "published";
    });
    const { actorId: _, ...job } = claim;
    expect(await publishClaimedCatalogSource(job, io, automation)).toBe("published");
    expect(io.publisher).toHaveBeenCalledExactlyOnceWith({ ...job, kind: "worker",
      ...buildCatalogMatchKeyEvidence("qa", 2, config.PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION, Buffer.from(key, "hex")) });
    expect(io.getSecret.mock.calls[0][2]).toBe(config.PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION);
    expect(sink.reserveAttempt.mock.invocationCallOrder[0]).toBeLessThan(io.loadTransport.mock.invocationCallOrder[0]);
    expect(mock.refresh.mock.calls[0][0].matchKey).toEqual(Buffer.alloc(32));
  });

  it("never reads secrets or opens transport for disabled automation or stale pinned versions", async () => {
    const { actorId: _, ...job } = claim;
    const io = setup([source]);
    expect(await publishClaimedCatalogSource(job, io, config)).toBe("not_configured");
    expect(io.readBindings).not.toHaveBeenCalled();
    expect(await publishClaimedCatalogSource({ ...job, profileRevision: "00".repeat(8) }, io, automation)).toBe("stale");
    expect(await publishClaimedCatalogSource({ ...job, bindingRevision: "00".repeat(8) }, io, automation)).toBe("stale");
    expect(await publishClaimedCatalogSource({ ...job, matchKeyVersion: 3 }, io, automation)).toBe("stale");
    expect(io.getSecret).not.toHaveBeenCalled();
    expect(io.loadTransport).not.toHaveBeenCalled();
    io.readBindings.mockResolvedValueOnce([source]).mockResolvedValueOnce([{ ...source, state: "retired" }]);
    io.publisher.mockResolvedValue({ reserveAttempt: async () => "912" });
    mock.refresh.mockImplementationOnce(async options => { await options.sink.reserveAttempt(); return options.transport(); });
    expect(await publishClaimedCatalogSource(job, io, automation)).toBe("stale");
    expect(io.loadTransport).not.toHaveBeenCalled();
    expect(mock.refresh.mock.calls[0][0].matchKey).toEqual(Buffer.alloc(32));
  });
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
      bindingRevision: source.bindingVersion, profileRevision: source.profileRevision, matchKeyVersion: 2,
      ...buildCatalogMatchKeyEvidence("qa", 2, config.PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION, Buffer.from(key, "hex")) });
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

  it("does not open legacy publication dependencies for a v2 binding", async () => {
    const io = setup([{ ...source, role: "sag-admin", contractVersion: "sag_admin_v2", issuerScope: undefined }]);
    const values = { ...automation, PORTAL_CATALOG_SAG_ISSUER_MAP: '[{"countryId":1,"issuerScope":"CO:NIT"}]' };
    const { actorId: _, ...job } = claim;
    expect(await publishSavedCatalogSource(request, io, values)).toBe("ineligible");
    expect(await publishClaimedCatalogSource(job, io, values)).toBe("stale");
    for (const fn of [io.getSecret, io.publisher, io.loadTransport, mock.refresh]) expect(fn).not.toHaveBeenCalled();
  });

  it("binds the verifier to the exact key bytes, vault version, numeric version and environment", () => {
    const vault = "ab".repeat(16), bytes = Buffer.alloc(32, 1);
    const original = buildCatalogMatchKeyEvidence("qa", 2, vault, bytes);
    expect(buildCatalogMatchKeyEvidence("qa", 2, vault.toUpperCase(), bytes)).toEqual(original);
    for (const alternative of [buildCatalogMatchKeyEvidence("production", 2, vault, bytes),
      buildCatalogMatchKeyEvidence("qa", 3, vault, bytes), buildCatalogMatchKeyEvidence("qa", 2, "ac".repeat(16), bytes),
      buildCatalogMatchKeyEvidence("qa", 2, vault, Buffer.alloc(32, 2))]) expect(alternative.keyVerifier).not.toEqual(original.keyVerifier);
    expect(() => buildCatalogMatchKeyEvidence("qa", 2, vault, Buffer.alloc(31))).toThrow("invalid_catalog_match_key_evidence");
  });
});
