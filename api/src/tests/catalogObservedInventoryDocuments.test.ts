import { describe, expect, it, vi } from "vitest";
import type { CatalogDirectoryInput, CatalogErpCustomer, CatalogErpRevision } from "../lib/catalogCustomerDirectory";
import { readCatalogObservedInventoryDocuments } from "../lib/catalogObservedInventoryDocuments";

const customer = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const orphan = "00000000-0000-4000-8000-000000000003";
const record = (customerId: string, displayDocument?: string): CatalogErpCustomer => ({
  customerId, sourceCustomerId: customerId, officialName: "Cliente de prueba", displayDocument, activeCode: "S",
  document: { issuer: "CO", type: "NIT", number: "internal-fixture" },
});
const source = (sourceId: string, state: CatalogErpRevision["state"], customers: CatalogErpCustomer[]): CatalogErpRevision => ({
  sourceId, label: "ERP de prueba", priority: 1, verifiedAt: null, state, customers,
});
const input: CatalogDirectoryInput = {
  allowedSourceIds: new Set(["visible", "stale", "blocked"]),
  erp: [source("visible", "verified", [record(customer, "unverified-raw"), record(other)]),
    source("stale", "stale", [record(other)]), source("blocked", "verified", [record(other)])],
  sag: { state: "verified", verifiedAt: null, documents: [], completeScopes: [] },
  sagOnlyCustomers: [{ customerId: orphan, name: "Solo SAG" }],
};
const scope = {
  actorId: "actor", environment: "qa" as const, matchKeyVersion: 1, allowedSourceIds: new Set(["visible", "stale"]),
};

describe("observed inventory document labels", () => {
  it("only resolves identities on the current page from verified authorized sources", async () => {
    const readSnapshots = vi.fn().mockResolvedValue(input);
    const addDocuments = vi.fn(async (view: CatalogDirectoryInput) => ({
      ...view, showDocuments: true,
      erp: view.erp.map(revision => ({ ...revision,
        customers: revision.customers.map(row => ({ ...row, displayDocument: "000481-2" })),
      })),
    }));
    const output = await readCatalogObservedInventoryDocuments(scope, [customer], { readSnapshots, addDocuments });
    expect([...output]).toEqual([[customer, "000481-2"]]);
    expect(readSnapshots).toHaveBeenCalledWith({
      allowedSourceIds: scope.allowedSourceIds, actorId: "actor", environment: "qa", matchKeyVersion: 1, includeSagDirectory: true,
    });
    const verifiedInput = addDocuments.mock.calls[0][0];
    expect(verifiedInput.erp.map(row => row.sourceId)).toEqual(["visible"]);
    expect(verifiedInput.erp[0].customers).toHaveLength(1);
    expect(verifiedInput.erp[0].customers[0].displayDocument).toBeUndefined();
  });

  it("does not resolve a SAG-only document in an explicitly selected ERP scope", async () => {
    const readSnapshots = vi.fn().mockResolvedValue(input);
    const addDocuments = vi.fn(async (view: CatalogDirectoryInput) => ({ ...view, showDocuments: true }));
    const output = await readCatalogObservedInventoryDocuments({ ...scope, sourceIds: ["visible"] }, [orphan], { readSnapshots, addDocuments });
    expect(output.size).toBe(0);
    expect(addDocuments.mock.calls[0][0].sagOnlyCustomers).toBeUndefined();
    expect(readSnapshots.mock.calls[0][0].allowedSourceIds).toEqual(new Set(["visible"]));
  });
});
