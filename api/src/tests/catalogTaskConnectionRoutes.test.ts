import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({ routes: new Map<string, (req: HttpRequest) => Promise<HttpResponseInit>>(),
  read: vi.fn(), loadUser: vi.fn(), restrictedDb: vi.fn(), unscopedPermissions: vi.fn() }));
vi.mock("@azure/functions", () => ({ app: { http(name: string, def: { handler: (req: HttpRequest) => Promise<HttpResponseInit> }) {
  stubs.routes.set(name, def.handler);
} } }));
vi.mock("../lib/catalogTaskDatabaseConnection", () => ({ readAuditedTaskDatabaseConnection: stubs.read }));
vi.mock("../lib/auth", () => ({ requireUser: vi.fn(), loadUserProfile: stubs.loadUser }));
vi.mock("../lib/roleDefinitionStore", () => ({ loadRoleDefinitions: stubs.unscopedPermissions }));
vi.mock("../lib/coreMastersSqlRepository", () => ({ readSqlRestrictedDatabase: stubs.restrictedDb }));
import "../functions/databases";
const actor = { id: "admin", email: "admin@example.invalid", roles: ["super_admin"] };
const request = (body: unknown, taskId?: string) => ({ params: { id: "db-a" }, json: async () => body,
  query: new URLSearchParams(taskId ? { taskId } : {}) }) as unknown as HttpRequest;

describe("catalog database access routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("PORTAL_CATALOG_READ_ENABLED", "true");
    vi.stubEnv("PORTAL_SAG_ENVIRONMENT", "qa");
    stubs.loadUser.mockResolvedValue(actor);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("cannot use global super-admin metadata permissions to bypass a missing or denied task", async () => {
    const view = stubs.routes.get("databasesAccessInfo")!;
    expect((await view(request({}))).status).toBe(403);
    stubs.read.mockResolvedValueOnce(null);
    expect((await view(request({}, "task-a"))).status).toBe(403);
    expect(stubs.read).toHaveBeenCalledExactlyOnceWith({ taskId: "task-a", databaseId: "db-a", actor,
      environment: "qa", action: { kind: "view" } });
    expect(stubs.restrictedDb).not.toHaveBeenCalled();
    expect(stubs.unscopedPermissions).not.toHaveBeenCalled();
  });

  it("never serializes the revealed password as JSON, prevents caching, and sanitizes failures", async () => {
    const reveal = stubs.routes.get("databasesRevealPassword")!;
    stubs.read.mockResolvedValueOnce({ kind: "password", value: "synthetic" });
    expect(await reveal(request({ taskId: "task-a" }))).toEqual({ status: 200, body: "synthetic", headers: {
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Type": "text/plain; charset=utf-8",
    } });
    stubs.read.mockRejectedValueOnce(new Error("secret ref should not escape"));
    const result = await reveal(request({ taskId: "task-a" }));
    expect(result.status).toBe(503);
    expect(JSON.stringify(result)).not.toContain("secret ref should not escape");
    const copy = stubs.routes.get("databasesCopyAccessPart")!;
    expect((await copy(request({ taskId: "task-a", part: "userId", secret: "x" }))).status).toBe(400);
    expect(stubs.restrictedDb).not.toHaveBeenCalled();
  });
});
