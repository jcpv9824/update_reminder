import { describe, expect, it } from "vitest";
import {
  buildCatalogCustomerDirectory,
  catalogDocumentKey,
  CatalogDirectoryError,
  getCatalogCustomerDetail,
  type CatalogDirectoryInput,
  type CatalogDocument,
  type CatalogErpRevision,
} from "../lib/catalogCustomerDirectory";

const coDoc: CatalogDocument = { issuer: "CO", type: "NIT", number: "000-FIXTURE" };
const peDoc: CatalogDocument = { issuer: "PE", type: "NIT", number: "000-FIXTURE" };
const verifiedAt = "2026-11-01T01:00:00.000Z";

const colombia: CatalogErpRevision = {
  sourceId: "source-co", label: "Empresa Colombia", priority: 1, state: "verified", verifiedAt,
  customers: [
    { sourceCustomerId: "erp-co-1", customerId: "portal-01", document: coDoc, officialName: "Ábaco Colombia", activeCode: "S" },
    { sourceCustomerId: "erp-co-2", customerId: "portal-02", document: { ...coDoc, number: "OTHER" }, officialName: "Beta", activeCode: "N" },
  ],
};
const peru: CatalogErpRevision = {
  sourceId: "source-pe", label: "Empresa Perú", priority: 2, state: "verified", verifiedAt,
  customers: [
    { sourceCustomerId: "erp-co-1", customerId: "portal-03", document: peDoc, officialName: "Cúbica Perú", activeCode: "S" },
    { sourceCustomerId: "erp-pe-2", customerId: "portal-01", document: coDoc, officialName: "Ábaco Perú", activeCode: "N" },
  ],
};

const fixture: CatalogDirectoryInput = {
  erp: [colombia, peru],
  sag: { state: "verified", verifiedAt, documents: [coDoc], completeScopes: [coDoc, peDoc] },
  allowedSourceIds: new Set([colombia.sourceId, peru.sourceId]),
};
const all = { state: "all", web: "all" } as const;

describe("multiempresa customer directory", () => {
  it("searches stable Portal IDs as well as official names without changing defaults", () => {
    expect(buildCatalogCustomerDirectory(fixture, { ...all, search: "portal-01" }).items.map(item => item.id))
      .toEqual(["portal-01"]);
    expect(buildCatalogCustomerDirectory(fixture, { ...all, search: "abaco" }).items[0].name).toBe("Ábaco Colombia");
  });

  it("includes only trusted verified SAG-only customers when all sources and unverified state are selected", () => {
    const input = { ...fixture, sagOnlyCustomers: [{
      customerId: "3d2f732f-5746-5d88-9283-7e301f293998", name: "Solo SAG",
    }] };
    expect(buildCatalogCustomerDirectory(input).items.every(item => item.name !== "Solo SAG")).toBe(true);
    expect(buildCatalogCustomerDirectory(input, { state: "unverified" }).items).toMatchObject([{
      id: input.sagOnlyCustomers[0].customerId, name: "Solo SAG", state: "unverified", web: "in_web",
      sagOnly: true, sources: [],
    }]);
    expect(buildCatalogCustomerDirectory(input, { ...all, sourceIds: [colombia.sourceId] }).items.some(item => item.sagOnly)).toBe(false);
    expect(buildCatalogCustomerDirectory({ ...input, sag: { ...input.sag, state: "stale" } }, all)
      .items.some(item => item.sagOnly)).toBe(false);
    expect(getCatalogCustomerDetail(input, input.sagOnlyCustomers[0].customerId)?.sagOnly).toBe(true);
  });
  it("consolidates the same verified document across sources, not different issuing countries", () => {
    const page = buildCatalogCustomerDirectory(fixture, all);
    expect(page.total).toBe(3);
    expect(page.items.map(item => [item.id, item.name, item.state, item.web])).toEqual([
      ["portal-01", "Ábaco Colombia", "active", "in_web"],
      ["portal-02", "Beta", "inactive", "not_in_web"],
      ["portal-03", "Cúbica Perú", "active", "not_in_web"],
    ]);
    expect(page.items[0].sources.map(source => [source.sourceId, source.state])).toEqual([
      ["source-co", "active"], ["source-pe", "inactive"],
    ]);
    expect(page.items[0]).toMatchObject({ stateVaries: true, requiresReconciliation: true });
    expect(JSON.stringify(page)).not.toMatch(/000-FIXTURE|erp-co-1|erp-pe-2/);
  });

  it("defaults to active and in SAG Web and recalculates status for selected sources", () => {
    expect(buildCatalogCustomerDirectory(fixture).items.map(item => item.id)).toEqual(["portal-01"]);
    expect(buildCatalogCustomerDirectory(fixture, { sourceIds: [peru.sourceId] }).items).toHaveLength(0);
    expect(buildCatalogCustomerDirectory(fixture, { sourceIds: [peru.sourceId], state: "inactive" }).items[0]).toMatchObject({
      id: "portal-01", name: "Ábaco Perú", state: "inactive", stateVaries: false, sources: [{ sourceId: "source-pe" }],
    });
  });

  it("does not let a hidden or unselected ERP determine the name, state, search, or counts", () => {
    const restricted = { ...fixture, allowedSourceIds: new Set([peru.sourceId]),
      preferredSourceByCustomer: new Map([["portal-01", colombia.sourceId]]) };
    const page = buildCatalogCustomerDirectory(restricted, all);
    expect(page.sources.map(source => source.sourceId)).toEqual([peru.sourceId]);
    expect(page.items[0]).toMatchObject({ id: "portal-01", name: "Ábaco Perú", state: "inactive" });
    expect(buildCatalogCustomerDirectory(restricted, { ...all, search: "colombia" }).total).toBe(0);
    for (const invalid of [colombia.sourceId, "missing-source"]) {
      expect(() => buildCatalogCustomerDirectory(restricted, { ...all, sourceIds: [invalid] })).toThrow(CatalogDirectoryError);
    }
  });

  it("uses a deterministic verified name preference without letting supplemental sources invent clients", () => {
    const page = buildCatalogCustomerDirectory({ ...fixture,
      preferredSourceByCustomer: new Map([["portal-01", peru.sourceId]]),
      sag: { ...fixture.sag, documents: [coDoc, { ...coDoc, number: "SAG-ONLY" }] } }, all);
    expect(page.total).toBe(3);
    expect(page.items[0].name).toBe("Ábaco Perú");
  });

  it("marks inaccessible SAG presence or non-authoritative absences as unverified", () => {
    const unavailable = { ...fixture, sag: { ...fixture.sag, state: "unavailable" as const } };
    const page = buildCatalogCustomerDirectory(unavailable, all);
    expect(page.partial).toBe(true);
    expect(page.items.every(item => item.web === "unverified")).toBe(true);
    expect(buildCatalogCustomerDirectory(unavailable, { ...all, web: "not_in_web" }).total).toBe(0);
    const unresolved = buildCatalogCustomerDirectory({ ...fixture,
      sag: { ...fixture.sag, completeScopes: [coDoc], unresolvedNumbers: ["OTHER"] } }, all);
    expect(unresolved.items.map(item => item.web)).toEqual(["in_web", "unverified", "unverified"]);
  });

  it("keeps known active records available when another ERP is stale without declaring false inactives", () => {
    const degraded = { ...fixture, erp: [colombia, { ...peru, state: "stale" as const }] };
    expect(buildCatalogCustomerDirectory(degraded).items.map(item => item.id)).toEqual(["portal-01"]);
    const page = buildCatalogCustomerDirectory(degraded, all);
    expect(page.partial).toBe(true);
    expect(page.items.map(item => item.state)).toEqual(["active", "unverified", "unverified"]);
    expect(buildCatalogCustomerDirectory(degraded, { ...all, sourceIds: [colombia.sourceId], state: "inactive" }).total).toBe(1);
  });

  it("fails closed when a supplied opaque ID would merge distinct documents", () => {
    const corrupted = { ...fixture, erp: [colombia, { ...peru, customers: [
      { ...peru.customers[0], customerId: colombia.customers[0].customerId },
    ] }] };
    expect(() => buildCatalogCustomerDirectory(corrupted, all)).toThrow(CatalogDirectoryError);
  });

  it("fails closed if an adapter accidentally provides the fiscal document as the public ID", () => {
    const leaked = { ...fixture, erp: [{ ...colombia, customers: [
      { ...colombia.customers[0], customerId: coDoc.number },
    ] }] };
    expect(() => buildCatalogCustomerDirectory(leaked, all)).toThrow("Revisión de catálogo inconsistente.");
  });

  it("returns only authorized detail across sources and makes a hidden ID indistinguishable from a missing ID", () => {
    expect(getCatalogCustomerDetail(fixture, "portal-01")?.sources).toHaveLength(2);
    const restricted = { ...fixture, allowedSourceIds: new Set([peru.sourceId]) };
    expect(getCatalogCustomerDetail(restricted, "portal-01")?.sources).toHaveLength(1);
    expect(getCatalogCustomerDetail(restricted, "portal-02")).toBeNull();
    expect(getCatalogCustomerDetail(restricted, "missing")).toBeNull();
  });

  it("does not assign verified presence when an identity is split between local IDs", () => {
    const split = { ...fixture, erp: [colombia, { ...peru, customers: [
      { ...peru.customers[1], customerId: "portal-pending" },
    ] }] };
    const { items } = buildCatalogCustomerDirectory(split, all);
    expect(items.filter(item => item.name.startsWith("Ábaco"))).toMatchObject([
      { web: "unverified", requiresReconciliation: true }, { web: "unverified", requiresReconciliation: true },
    ]);
  });

  it("preserves document punctuation, leading zeros and type and paginates stable names", () => {
    expect(catalogDocumentKey({ ...coDoc, issuer: " co " })).toBe(catalogDocumentKey(coDoc));
    expect(catalogDocumentKey({ ...coDoc, number: "FIXTURE" })).not.toBe(catalogDocumentKey(coDoc));
    expect(catalogDocumentKey({ ...coDoc, type: "CC" })).not.toBe(catalogDocumentKey(coDoc));
    expect(catalogDocumentKey({ ...coDoc, issuer: "" })).toBeNull();
    expect(buildCatalogCustomerDirectory(fixture, { ...all, search: "abaco", pageSize: 1 }).items[0].id).toBe("portal-01");
    expect(buildCatalogCustomerDirectory({ ...fixture, erp: [peru, colombia] }, { ...all, page: 2, pageSize: 1 }).items[0].id)
      .toBe("portal-02");
    expect(() => buildCatalogCustomerDirectory(fixture, { pageSize: 101 })).toThrow(CatalogDirectoryError);
  });
});
