import { describe, it, expect } from "vitest";
import { buildAuditLogEntry } from "../lib/audit";

describe("buildAuditLogEntry", () => {
  it("genera id y performedAt automáticamente", () => {
    const entry = buildAuditLogEntry({
      entityType: "client",
      entityId: "c1",
      clientId: "c1",
      action: "client_created",
      performedBy: "u1",
      performedByEmail: "u1@x.com",
      after: { name: "Nuevo cliente" },
    });
    expect(entry.id).toMatch(/^audit_/);
    expect(entry.performedAt).toBeTruthy();
    expect(entry.action).toBe("client_created");
  });

  it("nunca incluye contraseñas aunque vengan en after", () => {
    const entry = buildAuditLogEntry({
      entityType: "database",
      entityId: "db1",
      clientId: "c1",
      action: "database_created",
      performedBy: "u1",
      performedByEmail: "u@x.com",
      after: {
        companyName: "X",
        password: "no-debe-aparecer",
        Password: "tampoco",
        rawDbAccess: "...; Password = secreto;",
      } as any,
    });
    const json = JSON.stringify(entry);
    expect(json).not.toContain("no-debe-aparecer");
    expect(json).not.toContain("secreto");
    expect(json).not.toContain("tampoco");
  });
});
