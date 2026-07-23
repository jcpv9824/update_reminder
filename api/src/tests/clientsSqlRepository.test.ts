import { describe, expect, it } from "vitest";
import { mapSqlClientRows, mapSqlDomainRows, mapSqlPublicDatabaseRows } from "../lib/clientsSqlRepository";

const at = new Date("2026-07-21T12:00:00.000Z");

describe("Clients SQL mapping", () => {
  it("reconstructs normalized client licenses in stable order", () => {
    const base = {
      source_id: "client-1", external_id: "100", name: "Cliente", status: "active" as const,
      notes: null, created_at: at, created_by: "migration", updated_at: at, updated_by: "migration",
      deleted_at: null, deleted_by: null,
    };
    expect(mapSqlClientRows([
      { ...base, module_source_id: "module-1", module_name: "Contabilidad" },
      { ...base, module_source_id: "module-2", module_name: "Ventas" },
    ])).toMatchObject({
      id: "client-1",
      licenseModuleIds: ["module-1", "module-2"],
      licenseModuleNames: ["Contabilidad", "Ventas"],
    });
  });

  it("maps domain assignees and exposes only the safe database access field", () => {
    const domainBase = {
      source_id: "domain-1", client_source_id: "client-1", client_name: "Cliente",
      domain_name: "https://example.test", environment_id: "test", current_web_version: null,
      status: "active" as const, notes: null, created_at: at, created_by: "migration",
      updated_at: at, updated_by: "migration", deleted_at: null, deleted_by: null,
      last_updated_at: null, last_updated_by: null,
    };
    expect(mapSqlDomainRows([
      { ...domainBase, assignee_source_id: "user-1" },
      { ...domainBase, assignee_source_id: "user-2" },
    ]).assignedUpdaterIds).toEqual(["user-1", "user-2"]);

    const database = mapSqlPublicDatabaseRows([{
      source_id: "database-1", client_source_id: "client-1", client_name: "Cliente",
      domain_source_id: "domain-1", domain_name: "https://example.test", company_name: "Compañía",
      environment_id: "test", initial_catalog: "SAG", current_db_version: null,
      status: "active", notes: null, created_at: at, updated_at: at, last_updated_at: null,
      assignee_source_id: null,
    }]);
    expect(database.dbAccess).toEqual({ initialCatalog: "SAG" });
    expect(database.dbAccess).not.toHaveProperty("passwordSecretName");
    expect(database.dbAccess).not.toHaveProperty("serverHostPort");
    expect(database).not.toHaveProperty("assignedUpdaterIds");
  });
});
