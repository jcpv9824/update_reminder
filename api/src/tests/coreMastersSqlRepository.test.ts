import { describe, expect, it } from "vitest";
import { mapSqlDomainRows, mapSqlPublicDatabase, mapSqlRestrictedDatabaseRows } from "../lib/coreMastersSqlRepository";

const at = new Date("2026-07-21T12:00:00.000Z");

describe("Core masters SQL mapping", () => {
  it("reconstructs domain assignees", () => {
    const base = {
      source_id: "domain-1", client_source_id: "client-1", client_name: "Cliente",
      domain_name: "https://example.test", environment_id: "test", current_web_version: null,
      status: "active" as const, notes: null, created_at: at, created_by: "migration",
      updated_at: at, updated_by: "migration", deleted_at: null, deleted_by: null,
      last_updated_at: null, last_updated_by: null, total_count: 1,
    };
    expect(mapSqlDomainRows([
      { ...base, assignee_source_id: "user-1" }, { ...base, assignee_source_id: "user-2" },
    ]).assignedUpdaterIds).toEqual(["user-1", "user-2"]);
  });

  it("keeps the ordinary database DTO free of technical access and secret references", () => {
    const publicRow = {
      source_id: "db-1", client_source_id: "client-1", client_name: "Cliente",
      domain_source_id: "domain-1", domain_name: "https://example.test", company_name: "Compañía",
      environment_id: "test", initial_catalog: "SAG", current_db_version: null,
      status: "active" as const, notes: null, created_at: at, updated_at: at,
      last_updated_at: null, total_count: 1,
    };
    const dto = mapSqlPublicDatabase(publicRow);
    expect(dto.dbAccess).toEqual({ initialCatalog: "SAG" });
    expect(JSON.stringify(dto)).not.toContain("password_secret_name");
    expect(JSON.stringify(dto)).not.toContain("server.example");

    const restricted = mapSqlRestrictedDatabaseRows([{
      ...publicRow, server_host_port: "server.example,1433", sql_user_id: "runtime",
      password_secret_name: "kv-secret-reference", created_by: "migration", updated_by: "migration",
      deleted_at: null, deleted_by: null, last_updated_by: null, assignee_source_id: null,
    }]);
    expect(restricted.dbAccess).toMatchObject({ serverHostPort: "server.example,1433", passwordSecretName: "kv-secret-reference" });
  });
});
