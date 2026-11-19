import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  readSqlClients,
  readSqlDomains,
  readSqlPublicDatabases,
  readSqlSchedules,
  readSqlLicenseModules,
  readSqlLicenseAssignments,
  transaction, catalogQuery, catalogInputs,
} = vi.hoisted(() => ({
  readSqlClients: vi.fn(),
  readSqlDomains: vi.fn(),
  readSqlPublicDatabases: vi.fn(),
  readSqlSchedules: vi.fn(),
  readSqlLicenseModules: vi.fn(),
  readSqlLicenseAssignments: vi.fn(),
  transaction: vi.fn(), catalogQuery: vi.fn(), catalogInputs: vi.fn(),
}));

vi.mock("../lib/clientsSqlRepository", () => ({ readSqlClients }));
vi.mock("../lib/coreMastersSqlRepository", () => ({ readSqlDomains, readSqlPublicDatabases }));
vi.mock("../lib/schedulingSqlRepository", () => ({ readSqlSchedules }));
vi.mock("../lib/licensingSqlRepository", () => ({ readSqlLicenseModules, readSqlLicenseAssignments }));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: transaction }));

import { catalogReportDatabaseLinkIds, loadSqlCatalogMastersReportData, loadSqlMastersReportData } from "../lib/mastersReportSqlData";

describe("loadSqlMastersReportData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readSqlClients.mockResolvedValue([
      { id: "client-active", status: "active" },
      { id: "client-inactive", status: "inactive" },
    ]);
    readSqlDomains.mockResolvedValue([{ id: "domain-active", status: "active" }]);
    readSqlPublicDatabases.mockResolvedValue([{ id: "database-active", status: "active" }]);
    readSqlSchedules.mockResolvedValue([
      { id: "schedule-active", active: true },
      { id: "schedule-inactive", active: false },
    ]);
    readSqlLicenseModules.mockResolvedValue([{ id: "module-active", status: "active" }]);
    readSqlLicenseAssignments.mockResolvedValue([{ id: "assignment-active", status: "active" }]);
  });

  it("lee únicamente el conjunto operacional necesario desde SQL", async () => {
    const result = await loadSqlMastersReportData("2026-07-23");

    expect(readSqlDomains).toHaveBeenCalledWith(
      { status: "active" },
      { enabled: false, page: 1, pageSize: 500 },
    );
    expect(readSqlPublicDatabases).toHaveBeenCalledWith(
      { visibility: "active" },
      { enabled: false, page: 1, pageSize: 500 },
    );
    expect(readSqlSchedules).toHaveBeenCalledWith(
      {},
      { enabled: false, page: 1, pageSize: 500 },
      "2026-07-23",
    );
    expect(readSqlLicenseModules).toHaveBeenCalledWith(
      { includeDeleted: false },
      { enabled: false, page: 1, pageSize: 500 },
    );
    expect(readSqlLicenseAssignments).toHaveBeenCalledWith(
      false,
      { enabled: false, page: 1, pageSize: 500 },
    );
    expect(result.clients.map((item) => item.id)).toEqual(["client-active"]);
    expect(result.schedules.map((item) => item.id)).toEqual(["schedule-active"]);
  });
});

describe("scoped catalog report data", () => {
  const first = "11111111-1111-4111-8111-111111111111", second = "22222222-2222-4222-8222-222222222222";
  const databaseLink = "33333333-3333-4333-8333-333333333333", alternateLink = "44444444-4444-4444-8444-444444444444";
  const rowDate = new Date("2030-06-22T05:00:00Z");
  const domain = { certified_source_count: 2, open_link_count: 1, source_id: first, client_id: "client", official_name: "Cliente pruebas", client_created_at: rowDate,
    domain_id: "domain", domain_name: "https://client.example.test", domain_environment: "production", domain_created_at: rowDate,
    target_kind: "domain", link_id: first, database_id: null, database_name: null, database_alias: null, database_environment: null, database_created_at: null };
  const database = { ...domain, source_id: second, official_name: "Cliente ERP oficial", target_kind: "database", database_id: "database",
    link_id: databaseLink, database_name: "Base autorizada", database_alias: "cliente_sag", database_environment: "production", database_created_at: rowDate };
  const scope = { portalEnvironment: "qa" as const, allowedSourceIds: new Set([first, second]) };

  beforeEach(() => {
    vi.clearAllMocks();
    const request = { input: (...values: unknown[]) => { catalogInputs(...values); return request; }, query: catalogQuery };
    transaction.mockImplementation(async work => work({ request: () => request }));
  });

  it("reads exact approved ERP rows and does not include a database under an unapproved domain or legacy fields", async () => {
    catalogQuery.mockResolvedValue({ recordset: [domain, database, database, { ...database, database_id: "unapproved", domain_id: "outside" }]
      .map(row => ({ ...row, open_link_count: 4 })) });
    const result = await loadSqlCatalogMastersReportData(scope);
    expect(result.clients).toEqual([expect.objectContaining({ id: "client", name: "Cliente ERP oficial" })]);
    expect(result.domains).toEqual([expect.objectContaining({ id: "domain", clientId: "client", clientName: "Cliente ERP oficial" })]);
    expect(result.databases).toEqual([expect.objectContaining({ id: "database", domainId: "domain", dbAccess: { initialCatalog: "cliente_sag" } })]);
    expect([result.schedules, result.licenseModules, result.licenseAssignments]).toEqual([[], [], []]);
    expect(result.catalogCoverage).toEqual({ partial: true });
    for (const read of [readSqlClients, readSqlDomains, readSqlPublicDatabases, readSqlSchedules, readSqlLicenseModules, readSqlLicenseAssignments]) {
      expect(read).not.toHaveBeenCalled();
    }
    expect(catalogInputs).toHaveBeenCalledWith("allowedSourceIds", expect.anything(), JSON.stringify([first, second]));
    const sql = catalogQuery.mock.calls[0][0];
    expect(sql).toContain("e.evidence_state='verified'");
    expect(sql).toContain("published.source_record_id=e.source_record_id");
    expect(sql).not.toMatch(/server_host_port|secret_name|document_number_token|e\.\*/);
  });

  it("rejects no scope before SQL and does not expose an out-of-scope row or unsafe error", async () => {
    await expect(loadSqlCatalogMastersReportData({ ...scope, allowedSourceIds: new Set() })).rejects.toThrow("catalog_masters_report_unavailable");
    expect(transaction).not.toHaveBeenCalled();
    catalogQuery.mockResolvedValueOnce({ recordset: [{ ...domain, source_id: "33333333-3333-4333-8333-333333333333" }] });
    await expect(loadSqlCatalogMastersReportData(scope)).rejects.toThrow("catalog_masters_report_unavailable");
    catalogQuery.mockRejectedValueOnce(new Error("private driver detail"));
    await expect(loadSqlCatalogMastersReportData(scope)).rejects.toThrow("catalog_masters_report_unavailable");
  });

  it("keeps only the exact database-link IDs from the authorized report selection out of the public data", async () => {
    catalogQuery.mockResolvedValue({ recordset: [domain, database, { ...database, link_id: alternateLink },
      { ...database, database_id: "unapproved", domain_id: "outside" }, { ...database, link_id: second, domain_id: "outside" }]
      .map(row => ({ ...row, open_link_count: 5 })) });
    const scoped = await loadSqlCatalogMastersReportData(scope);
    expect(catalogReportDatabaseLinkIds(scoped, "database")).toEqual([databaseLink, alternateLink]);
    expect(catalogReportDatabaseLinkIds(scoped, "unapproved")).toEqual([]);
    expect(catalogReportDatabaseLinkIds({ ...scoped }, "database")).toEqual([]);
    expect(JSON.stringify(scoped)).not.toContain(databaseLink);
    expect(JSON.stringify(scoped)).not.toContain(alternateLink);
  });

  it("rejects a malformed database-link identity inside the certified selection", async () => {
    catalogQuery.mockResolvedValue({ recordset: [domain, { ...database, link_id: "untrusted" }]
      .map(row => ({ ...row, open_link_count: 2 })) });
    await expect(loadSqlCatalogMastersReportData(scope)).rejects.toThrow("catalog_masters_report_unavailable");
  });

  it("rejects unavailable total coverage and labels held relationships and partial sources explicitly", async () => {
    catalogQuery.mockResolvedValueOnce({ recordset: [{ certified_source_count: 0, open_link_count: 2, source_id: null }] });
    await expect(loadSqlCatalogMastersReportData(scope)).rejects.toThrow("catalog_masters_report_unavailable");
    catalogQuery.mockResolvedValueOnce({ recordset: [{ certified_source_count: 2, open_link_count: 2, source_id: null }] });
    await expect(loadSqlCatalogMastersReportData(scope)).resolves.toMatchObject({ clients: [], catalogCoverage: { partial: true } });
    catalogQuery.mockResolvedValueOnce({ recordset: [{ ...domain, certified_source_count: 1 }] });
    await expect(loadSqlCatalogMastersReportData(scope)).resolves.toMatchObject({
      clients: [expect.objectContaining({ name: "Cliente pruebas" })], catalogCoverage: { partial: true },
    });
  });

  it("projects only a normalized HTTPS host; unsafe authorities never enter report links", async () => {
    catalogQuery.mockResolvedValue({ recordset: [
      { ...domain, domain_name: "https://CLIENT.example.test/private/file?secret=value#fragment", open_link_count: 2 },
      { ...domain, domain_id: "unsafe", domain_name: "https://someone:secret@private.example.test", open_link_count: 2 },
    ] });
    const result = await loadSqlCatalogMastersReportData(scope);
    expect(result.domains).toEqual([expect.objectContaining({ domainName: "https://client.example.test" })]);
    expect(result.catalogCoverage).toEqual({ partial: true });
    expect(JSON.stringify(result)).not.toMatch(/private|fragment|someone|secret/);
  });
});
