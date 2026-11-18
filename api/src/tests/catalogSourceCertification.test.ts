import { describe, expect, it, vi } from "vitest";
import { certifySavedCatalogSource } from "../lib/catalogSourceCertification";
import type { CatalogExternalSourceTransport } from "../lib/catalogExternalSourceQueries";
import type { SqlCatalogSourceBinding } from "../lib/catalogSourceBindingsSqlRepository";
import type { CurrentUser } from "../types/models";

const source: SqlCatalogSourceBinding = {
  id: "8462c0ad-cfb5-4fc8-a126-28ccce0ddfff", profileId: "private-profile", label: "ERP QA",
  role: "erp-customers", state: "draft", environment: "qa", issuerScope: "CO:NIT",
  profileRevision: "0000000000000421", bindingVersion: "0000000000000422", contractVersion: "erp_v1",
  canReadCurrentProfile: false,
};
const actor: CurrentUser = { id: "actor", email: "actor@example.invalid", roles: ["super_admin"], displayName: "Actor" };
const transport: CatalogExternalSourceTransport = { async withConsistentRead() { throw new Error("Do not open a connection"); } };
const args = { sourceId: source.id, action: "activate", environment: "qa", actor } as const;
const mocks = () => ({
  readBindings: vi.fn<() => Promise<SqlCatalogSourceBinding[]>>().mockResolvedValue([source]),
  loadTransport: vi.fn().mockResolvedValue(transport),
  verify: vi.fn().mockResolvedValue("verified"),
  discover: vi.fn().mockResolvedValue("verified"),
  publisherReady: vi.fn().mockResolvedValue(true),
  activate: vi.fn().mockResolvedValue("activated"),
});

describe("catalog source certification service", () => {
  const v2 = { ...source, role: "sag-admin", contractVersion: "sag_admin_v2", issuerScope: undefined } as const;
  const env = { PORTAL_SAG_ENVIRONMENT: "qa", PORTAL_CATALOG_READ_ENABLED: "true", PORTAL_CATALOG_AUTOMATION_ENABLED: "true",
    PORTAL_CATALOG_SAG_V2_ENABLED: "true", PORTAL_CATALOG_MATCH_KEY_VERSION: "2",
    PORTAL_CATALOG_MATCH_KEY_SECRET_NAME: "fixture-key", PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION: "ab".repeat(16),
    PORTAL_CATALOG_SAG_ISSUER_MAP: '[{"countryId":1,"issuerScope":"CO:NIT"}]', SQL_DATABASE: "PortalSAGWeb-TEST",
    SQL_SERVER_HOST: "qa.sagweb.co,54103", PORTAL_CATALOG_SAG_V2_PUBLISHER_USERNAME: "publisher-fixture",
    PORTAL_CATALOG_SAG_V2_PUBLISHER_PASSWORD_SECRET_NAME: "fixture-publisher", PORTAL_CATALOG_SAG_V2_PUBLISHER_PASSWORD_SECRET_VERSION: "cd".repeat(16) };

  it("uses a complete v2 discovery without falling back to legacy; verification does not open the publisher or write", async () => {
    const io = mocks();
    io.readBindings.mockResolvedValue([v2]);
    expect(await certifySavedCatalogSource({ ...args, action: "verify" }, io, env)).toBe("verified");
    expect(io.discover).toHaveBeenCalledExactlyOnceWith(transport, { signal: undefined });
    expect(io.verify).not.toHaveBeenCalled();
    expect(io.publisherReady).not.toHaveBeenCalled();
    expect(io.activate).not.toHaveBeenCalled();
  });

  it("requires configured v2 before credential access and rejects partial or privileged discovery", async () => {
    const io = mocks();
    io.readBindings.mockResolvedValue([v2]);
    expect(await certifySavedCatalogSource(args, io, { ...env, PORTAL_CATALOG_SAG_V2_ENABLED: "false" })).toBe("ineligible");
    expect(io.loadTransport).not.toHaveBeenCalled();
    io.discover.mockResolvedValueOnce("not_read_only").mockResolvedValueOnce("unavailable");
    expect(await certifySavedCatalogSource(args, io, env)).toBe("not_read_only");
    expect(await certifySavedCatalogSource(args, io, env)).toBe("unavailable");
    expect(io.activate).not.toHaveBeenCalled();
    expect(io.verify).not.toHaveBeenCalled();
  });

  it("requires the dedicated publisher and current authority before committing a v2 activation", async () => {
    const io = mocks();
    io.readBindings.mockResolvedValue([v2]);
    io.publisherReady.mockResolvedValueOnce(false);
    expect(await certifySavedCatalogSource(args, io, env)).toBe("unavailable");
    expect(await certifySavedCatalogSource({ ...args, authorizeActivation: async () => false }, io, env)).toBe("forbidden");
    expect(io.activate).not.toHaveBeenCalled();
    expect(await certifySavedCatalogSource({ ...args, authorizeActivation: async () => true }, io, env)).toBe("activated");
    expect(io.activate).toHaveBeenCalledExactlyOnceWith(v2, expect.objectContaining({ contractVersion: "sag_admin_v2" }), actor);
  });

  it("does not activate from an earlier v2 configuration after the probe", async () => {
    const io = mocks();
    const changing = { ...env };
    io.readBindings.mockResolvedValue([v2]);
    io.discover.mockImplementationOnce(async () => {
      changing.PORTAL_CATALOG_SAG_V2_ENABLED = "false";
      return "verified";
    });
    expect(await certifySavedCatalogSource(args, io, changing)).toBe("superseded");
    expect(io.publisherReady).not.toHaveBeenCalled();
    expect(io.activate).not.toHaveBeenCalled();
  });
  it("does not load credentials for a missing, retired, or different environment binding", async () => {
    for (const rows of [[], [{ ...source, environment: "production" as const }], [{ ...source, state: "retired" as const }]]) {
      const io = mocks();
      io.readBindings.mockResolvedValue(rows);
      expect(["missing", "ineligible"]).toContain(await certifySavedCatalogSource(args, io));
      expect(io.loadTransport).not.toHaveBeenCalled();
      expect(io.activate).not.toHaveBeenCalled();
    }
  });

  it("does not activate after an unavailable or write-capable source probe", async () => {
    const io = mocks();
    io.verify.mockResolvedValueOnce("not_read_only").mockResolvedValueOnce("unavailable");
    expect(await certifySavedCatalogSource(args, io)).toBe("not_read_only");
    expect(await certifySavedCatalogSource(args, io)).toBe("unavailable");
    expect(io.activate).not.toHaveBeenCalled();
  });

  it("binds the same proof to the exact rowversions and re-probes stale active profiles", async () => {
    const io = mocks();
    const stale = { ...source, state: "active" as const };
    io.readBindings.mockResolvedValue([stale]);
    expect(await certifySavedCatalogSource(args, io)).toBe("activated");
    expect(io.verify).toHaveBeenCalledWith(transport, "erp_v1", undefined);
    expect(io.activate).toHaveBeenCalledWith(stale, expect.objectContaining({
      bindingId: source.id, bindingVersion: source.bindingVersion, profileId: source.profileId,
      profileRevision: source.profileRevision, tlsValidated: true, hasElevatedOrWriteAccess: false,
      canSelectApprovedProjection: true, checkedAtMs: expect.any(Number),
    }), actor);
  });

  it("does not report verification success when the stored profile changes during the probe", async () => {
    const io = mocks();
    io.readBindings.mockResolvedValueOnce([source])
      .mockResolvedValueOnce([{ ...source, profileRevision: "0000000000000423" }]);
    expect(await certifySavedCatalogSource({ ...args, action: "verify" }, io)).toBe("superseded");
    expect(io.activate).not.toHaveBeenCalled();
  });

  it("rechecks current active credentials without renewing or mutating the binding", async () => {
    const io = mocks();
    const active = { ...source, state: "active" as const, canReadCurrentProfile: true };
    io.readBindings.mockResolvedValue([active]);
    expect(await certifySavedCatalogSource({ ...args, action: "verify" }, io)).toBe("verified");
    expect(await certifySavedCatalogSource(args, io)).toBe("ineligible");
    expect(io.verify).toHaveBeenCalledTimes(1);
    expect(io.activate).not.toHaveBeenCalled();
  });
});
