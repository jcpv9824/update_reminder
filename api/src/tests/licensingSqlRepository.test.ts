import { describe, expect, it } from "vitest";
import { expectedNormalizedLicenseAssignmentCount, mapSqlLicenseAssignment, mapSqlLicenseModule } from "../lib/licensingSqlRepository";
import type { ClientRecord, LicenseAssignmentRecord } from "../types/models";

const at = new Date("2026-07-21T12:00:00.000Z");

describe("Licensing SQL mapping", () => {
  it("maps module lifecycle consistently", () => {
    expect(mapSqlLicenseModule({
      source_id: "module-1", name: "Ventas", code: "VENTAS", description: null,
      status: "active", notes: null, created_at: at, created_by: "migration",
      updated_at: at, updated_by: "migration", deleted_at: null, deleted_by: null, total_count: 1,
    })).toMatchObject({ id: "module-1", active: true, status: "active" });
  });

  it("reconstructs a database assignment hierarchy without technical access data", () => {
    const assignment = mapSqlLicenseAssignment({
      source_id: "assignment-1", module_source_id: "module-1", module_name: "Ventas",
      module_code: "VENTAS", target_type: "database", client_source_id: "client-1",
      client_name: "Cliente", domain_source_id: "domain-1", domain_name: "https://example.test",
      database_source_id: "database-1", database_name: "SAG", environment_id: null,
      status: "active", created_at: at, created_by: "migration", updated_at: at,
      updated_by: "migration", deleted_at: null, deleted_by: null, total_count: 1,
    });
    expect(assignment).toMatchObject({
      targetType: "database", targetId: "database-1", clientId: "client-1",
      domainId: "domain-1", databaseId: "database-1", databaseName: "SAG", environment: "all",
    });
    expect(JSON.stringify(assignment)).not.toContain("password");
    expect(JSON.stringify(assignment)).not.toContain("server_host");
  });

  it("compares SQL against explicit plus embedded client licenses without double counting", () => {
    const client = { id: "client-1", licenseModuleIds: ["module-1", "module-2"] } as ClientRecord;
    const explicit = [{
      id: "assignment-1", moduleId: "module-1", clientId: "client-1",
      targetType: "client", environment: "all", status: "active",
    }] as LicenseAssignmentRecord[];
    expect(expectedNormalizedLicenseAssignmentCount(explicit, [client], false)).toBe(2);
  });
});
