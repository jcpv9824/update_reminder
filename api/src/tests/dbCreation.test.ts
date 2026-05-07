import { describe, it, expect } from "vitest";
import { buildDatabaseRecordFromInput } from "../lib/databaseService";

describe("buildDatabaseRecordFromInput", () => {
  it("no almacena la contraseña en el documento de Cosmos", () => {
    const result = buildDatabaseRecordFromInput({
      clientId: "c1",
      clientName: "Cliente",
      domainId: "d1",
      domainName: "dom",
      companyName: "Empresa",
      environment: "production",
      rawDbAccess:
        "data12.sagerp.co,54101; Initial Catalog = LCC; User ID = U1; Password = secret123;",
      assignedUpdaterIds: [],
      notes: "",
      currentUser: { id: "creator", email: "c@x", displayName: "C", roles: ["admin"] },
    });

    const json = JSON.stringify(result.record);
    expect(json).not.toContain("secret123");
    expect(result.record.dbAccess.passwordSecretName).toMatch(/^db-/);
    expect(result.passwordToStore).toBe("secret123");
    expect(result.record.dbAccess.serverHostPort).toBe("data12.sagerp.co,54101");
    expect(result.record.dbAccess.initialCatalog).toBe("LCC");
    expect(result.record.dbAccess.userId).toBe("U1");
    expect(result.record.createdAt).toBeTruthy();
    expect(result.record.createdBy).toBe("creator");
  });

  it("genera fechas automáticas y status active por defecto", () => {
    const before = Date.now();
    const result = buildDatabaseRecordFromInput({
      clientId: "c1",
      clientName: "Cliente",
      domainId: "d1",
      domainName: "dom",
      companyName: "Empresa",
      environment: "production",
      rawDbAccess:
        "h.com,1; Initial Catalog = X; User ID = U; Password = p;",
      assignedUpdaterIds: [],
      notes: "",
      currentUser: { id: "u", email: "u@x", displayName: "u", roles: ["admin"] },
    });
    expect(result.record.status).toBe("active");
    const created = Date.parse(result.record.createdAt);
    expect(created).toBeGreaterThanOrEqual(before - 1000);
  });
});
