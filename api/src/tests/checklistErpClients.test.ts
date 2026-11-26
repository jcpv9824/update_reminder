import { describe, expect, it } from "vitest";
import { selectChecklistErpClients } from "../lib/checklistErpClients";
import type { CatalogDirectoryInput, CatalogErpCustomer } from "../lib/catalogCustomerDirectory";

const row = (id: string, officialName: string): CatalogErpCustomer => ({
  sourceCustomerId: id, customerId: id, officialName, activeCode: "S", document: null,
});
const source = (sourceId: string, customers: CatalogErpCustomer[]) => ({
  sourceId, label: sourceId, priority: 1, state: "verified" as const, verifiedAt: null, customers,
});
const catalog: CatalogDirectoryInput = {
  allowedSourceIds: new Set(["erp", "stale"]),
  erp: [source("erp", [row("opaque-id-zzz", "Comercial Pólux"), ...Array.from({ length: 24 }, (_, i) => row(`p-${i}`, `Pólux ${i}`))]),
    source("forbidden", [row("forbidden", "Pólux Privado")]),
    { ...source("stale", [row("stale", "Pólux Obsoleto")]), state: "stale" }],
  sag: { state: "unavailable", verifiedAt: null, documents: [], completeScopes: [] },
  sagOnlyCustomers: [{ customerId: "sag-only", name: "Pólux de SAG Admin" }],
};

describe("Selección de clientes ERP de Checklists", () => {
  it("CA-02 busca dentro del nombre sin distinguir tildes ni mayúsculas, limita a 20 y devuelve solo id y nombre", () => {
    const results = selectChecklistErpClients(catalog, { search: "pOL" });
    expect(results).toHaveLength(20);
    expect(results).toContainEqual({ id: "opaque-id-zzz", name: "Comercial Pólux" });
    expect(results.every(({ id }) => id === "opaque-id-zzz" || id.startsWith("p-"))).toBe(true);
    expect(results[0]).toEqual({ id: expect.any(String), name: expect.any(String) });
    expect(selectChecklistErpClients(catalog, { search: "zzz" })).toEqual([]);
  });
  it("CA-03 rechaza un ID que no pertenece a un ERP verificado y autorizado", () => {
    for (const clientId of ["missing", "forbidden", "stale", "sag-only"]) {
      expect(selectChecklistErpClients(catalog, { clientId })).toEqual([]);
    }
    expect(selectChecklistErpClients(catalog, { clientId: "opaque-id-zzz" })).toEqual([
      { id: "opaque-id-zzz", name: "Comercial Pólux" },
    ]);
  });
});
