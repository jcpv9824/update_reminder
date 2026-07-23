import { describe, expect, it } from "vitest";
import {
  buildDatabaseConnectionFingerprint,
  databaseSqlConflictMessage,
  planDatabaseAssigneeReconciliation,
} from "../lib/databasesSqlWriteRepository";

describe("Databases SQL write contract", () => {
  it("builds the same normalized UTF-16LE connection fingerprint as SQL Server", () => {
    const first = buildDatabaseConnectionFingerprint({
      serverHostPort: " DATA14.SAGERP.CO,54103 ", initialCatalog: " PortalSAGWeb ", userId: " SAGWebDev ",
    });
    const second = buildDatabaseConnectionFingerprint({
      serverHostPort: "data14.sagerp.co,54103", initialCatalog: "portalsagweb", userId: "sagwebdev",
    });
    expect(first.equals(second)).toBe(true);
    expect(first).toHaveLength(32);
    expect(buildDatabaseConnectionFingerprint({
      serverHostPort: "server,1433", initialCatalog: "db", userId: "login",
    }).toString("hex")).toBe("3481d7f83cb1ad5256d2e344506b2285ef00f94bfe6e737f1f10e21980146b95");
  });

  it("keeps an inactive existing assignee but rejects a newly assigned inactive user", () => {
    expect(planDatabaseAssigneeReconciliation(
      ["user-keep", "user-remove"],
      [{ id: "user-keep", active: false }, { id: "user-new", active: true }],
    )).toEqual({
      ids: ["user-keep", "user-new"], added: ["user-new"],
      removed: ["user-remove"], retained: ["user-keep"],
    });
    expect(() => planDatabaseAssigneeReconciliation([], [{ id: "inactive", active: false }]))
      .toThrow(/activos/);
  });

  it("maps SQL uniqueness failures to a safe business conflict", () => {
    expect(databaseSqlConflictMessage({ number: 2601, message: "UX_database_access_fingerprint_active" }))
      .toMatch(/cadena de conexión/);
    expect(databaseSqlConflictMessage({ number: 2601, message: "UX_databases_company_domain_active" }))
      .toMatch(/empresa/);
    expect(databaseSqlConflictMessage({ number: 547 })).toBeNull();
  });
});
