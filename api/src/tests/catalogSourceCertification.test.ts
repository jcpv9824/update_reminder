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
  activate: vi.fn().mockResolvedValue("activated"),
});

describe("catalog source certification service", () => {
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
