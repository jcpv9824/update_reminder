import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  query: vi.fn(),
  audit: vi.fn(),
  handlers: new Map<string, (request: HttpRequest) => Promise<HttpResponseInit>>(),
  roles: ["super_admin"],
}));

vi.mock("@azure/functions", () => ({
  app: { http: (name: string, options: { handler: (request: HttpRequest) => Promise<HttpResponseInit> }) =>
    fixtures.handlers.set(name, options.handler) },
}));
vi.mock("mssql", () => ({
  default: {
    ISOLATION_LEVEL: { READ_COMMITTED: 1 },
    Bit: "bit", DateTime2: () => "datetime2", NVarChar: () => "nvarchar", VarChar: () => "varchar",
    Request: class {
      readonly values: Record<string, unknown> = {};
      input(name: string, _type: unknown, value: unknown) { this.values[name] = value; return this; }
      query(statement: string) { return fixtures.query(statement, this.values); }
    },
  },
}));
vi.mock("../lib/sqlTransaction", () => ({
  runSqlTransaction: (callback: (transaction: object) => Promise<unknown>) => callback({}),
}));
vi.mock("../lib/sql", () => ({
  getSqlPool: async () => ({ request: () => ({
    input: vi.fn(), query: (statement: string) => fixtures.query(statement, {}),
  }) }),
}));
vi.mock("../lib/auth", () => ({
  requireUser: async () => ({ id: "editor", email: "editor@example.test", roles: fixtures.roles }),
  loadUserProfile: async (u: unknown) => u,
}));
vi.mock("../lib/roleDefinitionStore", () => ({
  loadRoleDefinitions: async () => (await import("../lib/permissionModel")).DEFAULT_ROLE_DEFINITIONS,
}));
vi.mock("../lib/auditSqlWriter", () => ({ writeSqlAuditLog: fixtures.audit }));

import { updateSqlUser } from "../lib/securityManagementSqlWriteRepository";
import "../functions/users";

const now = new Date("2026-11-20T00:00:00Z");
const actor = { id: "editor", email: "editor@example.test" };
const request = (body: object) => ({
  params: { id: "fixture" }, json: async () => body,
}) as unknown as HttpRequest;

describe("Área del usuario", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fixtures.roles = ["super_admin"];
    let area: unknown = "support";
    fixtures.query.mockImplementation(async (statement: string, values: Record<string, unknown>) => {
      if (statement.includes("UPDATE security.users SET display_name")) {
        area = values.area;
        return { recordset: [] };
      }
      if (statement.includes("SELECT active FROM security.roles")) return { recordset: [{ active: true }] };
      if (statement.includes("FROM security.users users")) {
        return { recordset: [{ source_id: "fixture", display_name: "Usuario", email: "user@example.test",
          active: true, area, token_version: 8, created_at: now, updated_at: now,
          roles_json: '[{"value":"super_admin"}]' }] };
      }
      throw new Error("Unexpected SQL");
    });
  });

  it("preserves the locked SQL area on omission and explicitly clears it with null", async () => {
    expect(await updateSqlUser("fixture", { displayName: "Otro nombre" }, actor)).toMatchObject({ area: "support" });
    expect(await updateSqlUser("fixture", { area: null }, actor)).toMatchObject({ area: null, roles: ["super_admin"] });
    expect(fixtures.query.mock.calls.some(([statement]) => statement.includes("DELETE user_role")
      || statement.includes("UPDATE sessions"))).toBe(false);
    expect(fixtures.audit.mock.calls.at(-1)?.[1]).toMatchObject({
      action: "user_updated", before: { area: "support" }, after: { area: null },
    });
  });

  it("accepts sales while preserving the super_admin role and existing token version", async () => {
    const result = await fixtures.handlers.get("usersUpdate")!(request({ area: "sales" }));
    expect(result).toMatchObject({ status: 200, jsonBody: { area: "sales", roles: ["super_admin"] } });
    expect(result.jsonBody).not.toHaveProperty("tokenVersion");
    const write = fixtures.query.mock.calls.find(([statement]) => statement.includes("UPDATE security.users SET display_name"));
    expect(write?.[1]).toMatchObject({ area: "sales", incrementTokenVersion: false });
  });

  it("rejects unknown areas and never allows an area write without edit permission", async () => {
    const handler = fixtures.handlers.get("usersUpdate")!;
    expect(await handler(request({ area: "super_admin" }))).toMatchObject({ status: 400 });
    fixtures.roles = ["viewer"];
    expect(await handler(request({ area: "support" }))).toMatchObject({ status: 403 });
    expect(fixtures.query.mock.calls.some(([statement]) => statement.includes("UPDATE security.users"))).toBe(false);
  });
});
