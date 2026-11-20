import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mapCatalogObservedInventoryV2Result, readCatalogObservedInventoryV2Sql, readSqlCatalogObservedInventoryV2,
} from "../lib/catalogObservedInventoryV2SqlRepository";
import { catalogReconciledIdentitySql } from "../lib/catalogReconciledIdentitySql";

const spies = vi.hoisted(() => ({ input: vi.fn(), query: vi.fn() }));
vi.mock("mssql", () => ({
  default: {
    Request: class {
      input(...args: unknown[]) { spies.input(...args); return this; }
      query(statement: string) { return spies.query(statement); }
    },
    NVarChar: (len: number) => ["nvarchar", len], VarChar: (len: number) => ["varchar", len],
    Char: (len: number) => ["char", len], MAX: -1, Int: "int", SmallInt: "smallint",
  },
}));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: (f: (transaction: unknown) => unknown) => f({}) }));

const customerId = "8e1a2337-be9f-4c78-a28e-070ab8f22bff";
const sourceId = "c905e778-c10e-438f-acb7-f4601ad79643";
const sqlRow = {
  id: "b".repeat(64), customerId, customerName: "Cliente Oficial", name: "cliente.example.com",
  environment: "test" as const, detail: null, code: null, licenseList: null,
  document: "must-not-leave-sql", rawHost: "must-not-leave-sql",
};
const summary = [{ state: "verified" as const, total: 1 }];

describe("observed inventory SQL v2", () => {
  beforeEach(() => vi.resetAllMocks());

  it("keeps public display relations only, with explicit environment", () => {
    expect(mapCatalogObservedInventoryV2Result({ view: "domains", pageSize: 25 }, summary, [sqlRow], [
      { id: sourceId, label: "ERP QA" },
    ])).toEqual({
      state: "verified", total: 1, sources: [{ id: sourceId, label: "ERP QA" }],
      items: [{ id: sqlRow.id, customerId, customerName: "Cliente Oficial", name: "cliente.example.com", environment: "test" }],
    });
    expect(mapCatalogObservedInventoryV2Result({ view: "databases", pageSize: 25 }, summary,
      [{ ...sqlRow, detail: sqlRow.name, name: "Cliente QA_2026" }], []).items[0]).toMatchObject({
      name: "Cliente QA_2026", detail: "cliente.example.com", environment: "test",
    });
  });

  it.each(["localhost", "127.0.0.1", "localhost:1433", "https://example.com", "a..example.com", "x-.example.com"])(
    "fails closed on non-host display data (%s)", name => {
      expect(() => mapCatalogObservedInventoryV2Result({ view: "domains", pageSize: 25 }, summary, [{ ...sqlRow, name }], []))
        .toThrow("catalog_observed_inventory_v2_result_invalid");
    },
  );

  it("maps observed license letters to vetted names and preserves no-named-license rows", () => {
    const scope = { view: "licenses" as const, tab: "customers" as const, pageSize: 25 };
    const row = { ...sqlRow, id: customerId, licenseList: "A,U,Z" };
    expect(mapCatalogObservedInventoryV2Result(scope, summary, [row], []).items).toEqual([
      { id: customerId, customerId, customerName: "Cliente Oficial", licenses: ["Contabilidad", "USA", "Portal Clientes"] },
    ]);
    expect(mapCatalogObservedInventoryV2Result(scope, summary, [{ ...row, licenseList: null }], []).items[0].licenses).toEqual([]);
    for (const licenseList of ["S", "T", "BI", "A,A", "Z,A"]) {
      expect(() => mapCatalogObservedInventoryV2Result(scope, summary, [{ ...row, licenseList }], []))
        .toThrow("catalog_observed_inventory_v2_result_invalid");
    }
  });

  it("scopes SQL to the authenticated actor and binds selected and global filters without interpolation", async () => {
    spies.query.mockResolvedValue({ recordsets: [summary, [sqlRow], [{ id: sourceId, label: "ERP QA" }]] });
    const scope = { view: "domains" as const, actorId: "portal-user", allowedSourceIds: new Set([sourceId]),
      page: 3, pageSize: 25, environment: "qa" as const, matchKeyVersion: 2,
      search: "literal % _ ' --", environmentFilter: "production" as const,
    };
    await readSqlCatalogObservedInventoryV2(scope);
    expect(spies.query).toHaveBeenCalledWith(readCatalogObservedInventoryV2Sql);
    const bound = Object.fromEntries(spies.input.mock.calls.map(([name, , value]) => [name, value]));
    expect(bound).toMatchObject({
      actorId: "portal-user", environment: "qa", environmentFilter: "production", matchKeyVersion: 2,
      skip: 50, take: 25, search: scope.search, sourceIds: JSON.stringify([sourceId]), selectedSourceIds: null,
    });
    expect(readCatalogObservedInventoryV2Sql).not.toContain(scope.search);
    expect(readCatalogObservedInventoryV2Sql).toContain("FROM @displayItems q\nWHERE @search IS NULL OR CHARINDEX");
    expect(readCatalogObservedInventoryV2Sql).toContain("FROM @pageRows r JOIN @displayItems q");
    spies.query.mockClear();
    await expect(readSqlCatalogObservedInventoryV2({ ...scope, sourceIds: [customerId] })).rejects.toMatchObject({ code: "invalid_filter" });
    expect(spies.query).not.toHaveBeenCalled();
  });

  it("keeps exact matches scope-wide, CO:NIT fallback narrow, and ambiguous matches out of standalone results", () => {
    expect(catalogReconciledIdentitySql).toContain("e.issuer=s.issuer AND e.document_type=s.document_type AND e.token=s.token");
    expect(catalogReconciledIdentitySql).toContain("e.issuer='CO' AND e.document_type='NIT' AND e.token=s.normalized_token");
    expect(catalogReconciledIdentitySql).toContain("HAVING COUNT_BIG(*)=1");
    expect(catalogReconciledIdentitySql).toContain("JOIN @observedSelected sel ON sel.source_key=e.source_key");
    expect(catalogReconciledIdentitySql).toContain("WHERE NOT EXISTS(SELECT 1 FROM @observedMatches m");
    expect(catalogReconciledIdentitySql).toContain("SET @observedPartial=1");
    expect(catalogReconciledIdentitySql).toContain("IF @observedIsSuper=1 AND @selectedSourceIds IS NULL");
    expect(catalogReconciledIdentitySql).toContain("CONVERT(char(64),s.token,2)");
    expect(readCatalogObservedInventoryV2Sql).toContain("GROUP BY customerId,observedHost,environment");
    expect(readCatalogObservedInventoryV2Sql).toContain("GROUP BY d.customerId,d.observedHost,d.environment");
  });
});
