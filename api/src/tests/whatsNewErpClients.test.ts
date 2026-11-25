import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type sql from "mssql";
import type { CatalogDirectoryInput, CatalogErpCustomer } from "../lib/catalogCustomerDirectory";
import { lookupWhatsNewErpClients, resolveWhatsNewErpClientName, selectWhatsNewErpClients } from "../lib/whatsNewErpClients";
import { PERMISSIONS } from "../lib/whatsNewModel";
import type { WhatsNewActor } from "../lib/whatsNewAccess";

const mock = vi.hoisted(() => ({ snapshot: vi.fn(), sources: vi.fn(), transaction: vi.fn() }));
vi.mock("../lib/catalogCustomerSnapshotsSqlRepository", () => ({ readSqlCatalogCustomerSnapshots: mock.snapshot }));
vi.mock("../lib/catalogSourceAccessSqlRepository", () => ({ readAuthorizedCatalogSourceIdsInTransaction: mock.sources }));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: mock.transaction }));

const customer = (id: string, officialName: string, activeCode: string | null, doc?: string): CatalogErpCustomer => ({
  sourceCustomerId: id, customerId: id, officialName, activeCode,
  document: doc ? { issuer: "CO", type: "NIT", number: doc } : null,
});

describe("authenticated ERP selection boundary", () => {
  const actor = (): WhatsNewActor => ({
    id: "actor", displayName: "Desarrollo", email: "actor@example.invalid", areas: new Set(["desarrollo"]),
    permissions: new Set([PERMISSIONS.view, PERMISSIONS.author, "clients.clients.view"]),
  });
  const db = {} as sql.Transaction;
  beforeEach(() => {
    vi.stubEnv("PORTAL_SAG_ENVIRONMENT", "qa");
    vi.stubEnv("PORTAL_CATALOG_CLIENTS_READ_ENABLED", "true");
    vi.stubEnv("PORTAL_CATALOG_READ_ENABLED", "false");
    vi.stubEnv("PORTAL_CATALOG_MATCH_KEY_VERSION", "1");
    vi.stubEnv("PORTAL_CATALOG_OBSERVED_INVENTORY_ENABLED", "false");
    vi.stubEnv("PORTAL_CATALOG_DIRECTORY_V2_ENABLED", "false");
    mock.sources.mockReset().mockResolvedValue(input.allowedSourceIds);
    mock.snapshot.mockReset().mockResolvedValue(input);
    mock.transaction.mockReset().mockImplementation(async (fn) => fn(db));
  });
  afterEach(() => vi.unstubAllEnvs());

  it("requires both Novedades author access and client catalog access before reads", async () => {
    await expect(lookupWhatsNewErpClients({ ...actor(), permissions: new Set([PERMISSIONS.view, PERMISSIONS.author]) }, "agil"))
      .rejects.toMatchObject({ status: 403 });
    await expect(lookupWhatsNewErpClients({ ...actor(), areas: new Set(["soporte"]) }, "agil"))
      .rejects.toMatchObject({ status: 403 });
    expect(mock.transaction).not.toHaveBeenCalled();
  });

  it("enforces the trusted source scope in the same transaction and has no stale fallback", async () => {
    await expect(lookupWhatsNewErpClients(actor(), "agil")).resolves.toEqual([{ id: "a", label: "Ágil ERP" }]);
    expect(mock.sources).toHaveBeenCalledWith(db, { actorId: "actor", environment: "qa" });
    expect(mock.snapshot).toHaveBeenCalledWith(expect.objectContaining({ allowedSourceIds: input.allowedSourceIds }), db);
    mock.sources.mockResolvedValue(new Set(["stale"]));
    await expect(lookupWhatsNewErpClients(actor(), "agil")).rejects.toMatchObject({ status: 503, code: "catalogo_clientes_no_disponible" });
  });

  it("does not query or offer an unfiltered directory for short search terms", () => {
    expect(() => lookupWhatsNewErpClients(actor(), " ab ")).toThrow("al menos 3 caracteres");
    expect(mock.transaction).not.toHaveBeenCalled();
  });

  it("resolves the canonical write name and rejects an ineligible identity before persistence", async () => {
    await expect(resolveWhatsNewErpClientName(actor(), "a", db)).resolves.toBe("Ágil ERP");
    await expect(resolveWhatsNewErpClientName(actor(), "g", db)).rejects.toMatchObject({ status: 400, code: "cliente_erp_no_disponible" });
    expect(mock.transaction).not.toHaveBeenCalled();
  });

  it("uses a live ERP-only projection for V2 lookup, but not in the save transaction", async () => {
    vi.stubEnv("PORTAL_CATALOG_OBSERVED_INVENTORY_ENABLED", "true");
    vi.stubEnv("PORTAL_CATALOG_DIRECTORY_V2_ENABLED", "true");
    await expect(lookupWhatsNewErpClients(actor(), "agil")).resolves.toEqual([{ id: "a", label: "Ágil ERP" }]);
    expect(mock.snapshot).toHaveBeenLastCalledWith(expect.objectContaining({
      actorId: "actor", includeSagDirectory: true, erpAutocomplete: true,
    }), db);
    await expect(resolveWhatsNewErpClientName(actor(), "a", db)).resolves.toBe("Ágil ERP");
    expect(mock.snapshot).toHaveBeenLastCalledWith(expect.objectContaining({
      actorId: "actor", includeSagDirectory: true, erpAutocomplete: false,
    }), db);
    mock.sources.mockResolvedValue(new Set());
    await expect(lookupWhatsNewErpClients(actor(), "agil")).resolves.toEqual([]);
    expect(mock.snapshot).toHaveBeenCalledTimes(2);
  });
});
const input: CatalogDirectoryInput = {
  allowedSourceIds: new Set(["fresh", "stale"]),
  erp: [
    { sourceId: "fresh", label: "ERP", priority: 1, state: "verified", verifiedAt: "2026-11-20T00:00:00Z", customers: [
      customer("a", "Ágil ERP", "S", "1"), customer("b", "Beta ERP", null),
      customer("c", "Fuera", "S", "3"), customer("d", "Inactivo", "N", "4"),
    ] },
    { sourceId: "stale", label: "Anterior", priority: 0, state: "stale", verifiedAt: null,
      customers: [customer("a", "Nombre obsoleto", "S", "1"), customer("e", "Solo obsoleto", "S")] },
    { sourceId: "forbidden", label: "No autorizado", priority: 0, state: "verified", verifiedAt: null,
      customers: [customer("f", "Solo no autorizado", "S")] },
  ],
  sag: { state: "verified", verifiedAt: "2026-11-20T00:00:00Z",
    documents: [{ issuer: "CO", type: "NIT", number: "1" }, { issuer: "CO", type: "NIT", number: "4" }],
    completeScopes: [{ issuer: "CO", type: "NIT" }] },
  sagOnlyCustomers: [{ customerId: "g", name: "Solo Admin" }],
};

describe("Novedades ERP client selector", () => {
  it("returns only authorized, fresh ERP names for in-Web or unverified customers", () => {
    expect(selectWhatsNewErpClients(input)).toEqual([{ id: "a", label: "Ágil ERP" }, { id: "b", label: "Beta ERP" }]);
    expect(selectWhatsNewErpClients(input, { search: "agil" })).toEqual([{ id: "a", label: "Ágil ERP" }]);
  });

  it("checks exact identities against the same eligibility policy", () => {
    expect(selectWhatsNewErpClients(input, { clientId: "b" })).toEqual([{ id: "b", label: "Beta ERP" }]);
    for (const clientId of ["c", "d", "e", "f", "g", "missing"]) {
      expect(selectWhatsNewErpClients(input, { clientId })).toEqual([]);
    }
  });

  it("applies eligibility before limiting the results", () => {
    const manyOutside = Array.from({ length: 55 }, (_, i) => customer(`outside-${i}`, `A empresa ${i}`, "S", `doc-${i}`));
    const [fresh, ...rest] = input.erp;
    expect(selectWhatsNewErpClients({ ...input, erp: [{ ...fresh, customers: [...manyOutside, ...fresh.customers] }, ...rest] }))
      .toHaveLength(2);
  });

  it("needs no SAG body for V2 selection: positives and unknowns have the same eligibility", () => {
    const v2 = { ...input, sag: { ...input.sag, completeScopes: [] } };
    const lean = { ...v2, sag: { ...v2.sag, state: "unavailable" as const, documents: [] } };
    for (const search of ["agil", "ERP", "fuera", "inactivo", "solo", "a"]) {
      expect(selectWhatsNewErpClients(lean, { search })).toEqual(selectWhatsNewErpClients(v2, { search }));
    }
    expect(selectWhatsNewErpClients(lean, { search: "fuera" })).toEqual([{ id: "c", label: "Fuera" }]);
  });
});
