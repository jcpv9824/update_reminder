import { beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ query: vi.fn(), audit: vi.fn(), committed: false, rolledBack: false }));
vi.mock("../lib/whatsNewSqlRepository", async (original) => ({ ...await original<typeof import("../lib/whatsNewSqlRepository")>(), query: fake.query }));
vi.mock("../lib/auditSqlWriter", () => ({ writeSqlAuditLog: fake.audit }));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: async (fn: (db: object) => Promise<unknown>) => {
  try { const result = await fn({}); fake.committed = true; return result; } catch (e) { fake.rolledBack = true; throw e; }
} }));
import { buildActor, requireDeveloper } from "../lib/whatsNewAccess";
import { businessAreas } from "../lib/whatsNewService";
import { DEFAULT_ROLE_DEFINITIONS, type RoleDefinition } from "../lib/permissionModel";
const version = Buffer.from("0000000000000001", "hex");
function actor(permissions: string[], roles = ["custom"]) {
  const definitions: RoleDefinition[] = [{ id: "custom", name: "Custom", active: true, system: false, taskVisibility: { domain: "none", database: "none" }, permissions }];
  return buildActor({ id: "editor", email: "editor@example.invalid", displayName: "Editor", roles }, [...DEFAULT_ROLE_DEFINITIONS, ...definitions], []);
}
describe("Qué hay de nuevo business area access and concurrency", () => {
  beforeEach(() => { fake.query.mockReset(); fake.audit.mockReset(); fake.committed = false; fake.rolledBack = false; });
  it("resolves existing user edit/view keys without adding catalog duplicates", () => {
    const user = actor(["configuration.users.view", "configuration.users.edit"]);
    expect(user.permissions.has("configuration.users.edit")).toBe(true); expect(user.permissions.has("configuration.users.view")).toBe(true);
  });
  it("super_admin resolves user access but still needs Desarrollo to create", () => {
    const user = actor([], ["super_admin"]); expect(user.permissions.has("configuration.users.edit")).toBe(true);
    expect(() => requireDeveloper(user)).toThrow("Desarrollo");
  });
  it("a user viewer may read but may not update business areas", async () => {
    const user = actor(["configuration.users.view"]);
    fake.query.mockResolvedValueOnce([{ user_key: 1, row_version: version }]).mockResolvedValueOnce([{ row_version: version }]).mockResolvedValueOnce([{ area_code: "ventas" }]);
    expect(await businessAreas(user, "user")).toEqual({ areas: ["ventas"], etag: '"AAAAAAAAAAE="' });
    await expect(businessAreas(user, "user", { areas: [] }, '"AAAAAAAAAAE="')).rejects.toMatchObject({ status: 403 });
  });
  it.each([null, '"old"'])("rejects missing or stale version %s before any change", async (etag) => {
    fake.query.mockResolvedValueOnce([{ user_key: 1, row_version: version }]);
    await expect(businessAreas(actor(["configuration.users.edit"]), "user", { areas: [] }, etag)).rejects.toMatchObject({ status: etag ? 409 : 428 });
    expect(fake.query).toHaveBeenCalledTimes(1); expect(fake.audit).not.toHaveBeenCalled(); expect(fake.rolledBack).toBe(true);
  });
  it("atomically replaces explicit areas, bumps the user version and audits", async () => {
    fake.query.mockResolvedValue([]).mockResolvedValueOnce([{ user_key: 1, row_version: version }]);
    fake.query.mockImplementation(async (_db, statement) => statement.startsWith("SELECT user_key") ? [{ user_key: 1, row_version: version }]
      : statement.startsWith("SELECT row_version") ? [{ row_version: Buffer.from("0000000000000002", "hex") }]
      : statement.startsWith("SELECT area_code") ? [{ area_code: "soporte" }] : []);
    expect(await businessAreas(actor(["configuration.users.edit"]), "user", { areas: ["soporte"] }, '"AAAAAAAAAAE="')).toEqual({ areas: ["soporte"], etag: '"AAAAAAAAAAI="' });
    expect(fake.query.mock.calls.some((c) => c[1].startsWith("UPDATE security.users"))).toBe(true);
    expect(fake.audit).toHaveBeenCalledTimes(1); expect(fake.committed).toBe(true);
  });
});
