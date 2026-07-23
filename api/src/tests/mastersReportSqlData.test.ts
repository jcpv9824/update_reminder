import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  readSqlClients,
  readSqlDomains,
  readSqlPublicDatabases,
  readSqlSchedules,
  readSqlLicenseModules,
  readSqlLicenseAssignments,
} = vi.hoisted(() => ({
  readSqlClients: vi.fn(),
  readSqlDomains: vi.fn(),
  readSqlPublicDatabases: vi.fn(),
  readSqlSchedules: vi.fn(),
  readSqlLicenseModules: vi.fn(),
  readSqlLicenseAssignments: vi.fn(),
}));

vi.mock("../lib/clientsSqlRepository", () => ({ readSqlClients }));
vi.mock("../lib/coreMastersSqlRepository", () => ({ readSqlDomains, readSqlPublicDatabases }));
vi.mock("../lib/schedulingSqlRepository", () => ({ readSqlSchedules }));
vi.mock("../lib/licensingSqlRepository", () => ({ readSqlLicenseModules, readSqlLicenseAssignments }));

import { loadSqlMastersReportData } from "../lib/mastersReportSqlData";

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
