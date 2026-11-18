import { describe, expect, it, vi } from "vitest";
import { catalogDocumentNumberToken, refreshCatalogCustomerSource } from "../lib/catalogCustomerRefresh";
import type { CatalogExternalSourceTransport } from "../lib/catalogExternalSourceQueries";
import type { CatalogSourceBinding } from "../lib/catalogSourceConfiguration";

const binding: CatalogSourceBinding = {
  id: "2ab4b319-5de1-4bb0-83b6-ae05583de657", profileId: "internal", label: "ERP",
  role: "erp-customers", environment: "qa", state: "active", profileRevision: "0000000000000001",
  contractVersion: "erp_v1", issuerScope: "CO:NIT",
};
const matchKey = Buffer.alloc(32, 42);
const now = () => new Date("2026-11-01T00:00:00Z");
const noSagEvidence = { domainCandidate: null, testStartedOn: null, productionStartedOn: null, demoStartedOn: null };

function setup(rows: readonly unknown[], compatible = true, readOnly = true) {
  const select = vi.fn(async (statement: { tag: string }) => statement.tag === "schema" ? [{ compatible, readOnly }] : rows);
  const transport: CatalogExternalSourceTransport = {
    withConsistentRead: async (_, read) => read({ consistency: "verified", select }),
  };
  const sink = { reserveAttempt: vi.fn(async () => "1"), publish: vi.fn(async () => "published" as const),
    recordFailure: vi.fn(async () => undefined) };
  const args = { binding, bindingRevision: "0000000000000002", environment: "qa" as const,
    transport, sink, matchKey, matchKeyVersion: 1, now };
  return { args, select, sink };
}

describe("refreshCatalogCustomerSource", () => {
  it("publishes a complete ERP revision with exact scoped opaque tokens and no raw document", async () => {
    const { args, sink } = setup([
      { sourceRecordId: 1, officialName: "Cliente de prueba", documentNumber: "00123456789", activeCode: "S" },
      { sourceRecordId: 2, officialName: null, documentNumber: null, activeCode: null },
    ]);
    expect(await refreshCatalogCustomerSource(args)).toBe("published");
    expect(sink.publish).toHaveBeenCalledWith({
      environment: "qa", sourceId: binding.id, profileRevision: "0000000000000001", bindingRevision: "0000000000000002",
      attemptOrdinal: "1", matchKeyVersion: 1, observedAt: now(),
      role: "erp-customers", completeScopes: [],
      rows: [
        { sourceRecordId: 1, issuerScope: "CO:NIT", matchToken: catalogDocumentNumberToken(matchKey, "qa", "00123456789"),
          name: "Cliente de prueba", activeCode: "S" },
        { sourceRecordId: 2, issuerScope: null, matchToken: null, name: null, activeCode: null },
      ],
    });
    expect(JSON.stringify(sink.publish.mock.calls)).not.toContain("00123456789");
    expect(sink.recordFailure).not.toHaveBeenCalled();
    expect(catalogDocumentNumberToken(matchKey, "production", "00123456789"))
      .not.toEqual(catalogDocumentNumberToken(matchKey, "qa", "00123456789"));
  });

  it("keeps unknown SAG issuers unresolved and suppresses negative claims", async () => {
    const { args, sink } = setup([
      { sourceRecordId: 1, documentNumber: "12301", reportedCountryId: 9, environment: "production", licensedModules: "A",
        ...noSagEvidence, domainCandidate: "tenant.example", productionStartedOn: "2026-10-31" },
      { sourceRecordId: 2, documentNumber: "12302", reportedCountryId: 400, environment: "test", licensedModules: "B",
        ...noSagEvidence },
    ]);
    expect(await refreshCatalogCustomerSource({ ...args,
      binding: { ...binding, role: "sag-admin", contractVersion: "sag_admin_v1", issuerScope: undefined },
      sagPolicy: { scopesByCountry: new Map([[9, "CO:NIT"]]), completeScopes: ["CO:NIT"] },
    })).toBe("published");
    expect(sink.publish).toHaveBeenCalledWith(expect.objectContaining({ role: "sag-admin", includesSagInventory: true, completeScopes: [], rows: [
      expect.objectContaining({ sourceRecordId: 1, issuerScope: "CO:NIT", matchToken: expect.any(Buffer), name: null, activeCode: null,
        sagEvidence: { ...noSagEvidence, domainCandidate: "tenant.example", productionStartedOn: "2026-10-31",
          environment: "production", licenseCodes: ["A"] } }),
      expect.objectContaining({ sourceRecordId: 2, issuerScope: null, matchToken: expect.any(Buffer), name: null, activeCode: null }),
    ] }));
  });

  it("rejects elevated credentials without reading a page or replacing a valid revision", async () => {
    const { args, sink, select } = setup([], true, false);
    expect(await refreshCatalogCustomerSource(args)).toBe("unavailable");
    expect(select).toHaveBeenCalledTimes(1);
    expect(sink.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ sourceId: binding.id, observedAt: now() }));
    expect(sink.publish).not.toHaveBeenCalled();
  });

  it("does not access external data on draft, other environment, or cancelled runs", async () => {
    const { args, sink, select } = setup([]);
    expect(await refreshCatalogCustomerSource({ ...args, binding: { ...binding, state: "draft" } })).toBe("ineligible");
    expect(await refreshCatalogCustomerSource({ ...args, binding: { ...binding, environment: "production" } })).toBe("ineligible");
    expect(await refreshCatalogCustomerSource({ ...args, bindingRevision: "malformed" })).toBe("ineligible");
    expect(await refreshCatalogCustomerSource({ ...args, signal: AbortSignal.abort() })).toBe("cancelled");
    expect(select).not.toHaveBeenCalled();
    expect(sink.reserveAttempt).not.toHaveBeenCalled();
    expect(sink.recordFailure).not.toHaveBeenCalled();
  });

  it("allows a verified empty source as distinct from an unavailable source", async () => {
    const { args, sink } = setup([]);
    expect(await refreshCatalogCustomerSource(args)).toBe("published");
    expect(sink.publish).toHaveBeenCalledWith(expect.objectContaining({ rows: [], completeScopes: [] }));
  });

  it("freezes reviewed issuer mapping before reserving the read and discards a cancelled observation", async () => {
    const { args, sink, select } = setup([]);
    const scopesByCountry = new Map([[9, "CO:NIT"]]);
    const sagBinding = { ...binding, role: "sag-admin" as const, contractVersion: "sag_admin_v1", issuerScope: undefined };
    const observation = { sourceRecordId: 1, documentNumber: "12301", reportedCountryId: 9,
      environment: "production", licensedModules: "A", ...noSagEvidence };
    select.mockImplementationOnce(async () => [{ compatible: true, readOnly: true }]).mockImplementationOnce(async () => {
      scopesByCountry.set(9, "US:EIN");
      return [observation];
    });
    await expect(refreshCatalogCustomerSource({ ...args, binding: sagBinding,
      sagPolicy: { scopesByCountry, completeScopes: ["CO:NIT"] } })).resolves.toBe("published");
    expect(sink.publish).toHaveBeenCalledWith(expect.objectContaining({
      completeScopes: ["CO:NIT"], rows: [expect.objectContaining({ issuerScope: "CO:NIT" })],
    }));
    sink.publish.mockClear();
    const ctl = new AbortController();
    select.mockImplementationOnce(async () => [{ compatible: true, readOnly: true }]).mockImplementationOnce(async () => {
      ctl.abort();
      return [observation];
    });
    await expect(refreshCatalogCustomerSource({ ...args, binding: sagBinding, signal: ctl.signal })).resolves.toBe("cancelled");
    expect(sink.publish).not.toHaveBeenCalled();
    expect(sink.recordFailure).not.toHaveBeenCalled();
  });
});
