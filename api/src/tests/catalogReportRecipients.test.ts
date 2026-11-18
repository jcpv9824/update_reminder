import { beforeEach, describe, expect, it, vi } from "vitest";
import { mayReceiveCatalogActiveUsersReport } from "../lib/catalogReportRecipients";

const fake = vi.hoisted(() => ({ useEmail: vi.fn(), roles: vi.fn() }));
vi.mock("../lib/securityManagementSqlWriteRepository", () => ({ findSqlUserByEmail: fake.useEmail }));
vi.mock("../lib/roleDefinitionStore", () => ({ loadRoleDefinitions: fake.roles }));

describe("configured report recipients", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    fake.roles.mockResolvedValue((await import("../lib/permissionModel")).DEFAULT_ROLE_DEFINITIONS);
  });
  it("requires all addresses to resolve to active authorized Portal users", async () => {
    const allowed = { id: "u", email: "qa@example.test", roles: ["super_admin"], displayName: "QA", active: true };
    fake.useEmail.mockResolvedValueOnce(allowed).mockResolvedValueOnce(null);
    expect(await mayReceiveCatalogActiveUsersReport(["qa@example.test", "other@example.test"])).toBe(false);
    fake.useEmail.mockResolvedValueOnce({ ...allowed, active: false });
    expect(await mayReceiveCatalogActiveUsersReport(["qa@example.test"])).toBe(false);
    fake.useEmail.mockResolvedValueOnce({ ...allowed, roles: ["viewer"] });
    expect(await mayReceiveCatalogActiveUsersReport(["qa@example.test"])).toBe(false);
    fake.useEmail.mockResolvedValueOnce(allowed);
    expect(await mayReceiveCatalogActiveUsersReport(["qa@example.test"])).toBe(true);
  });
  it("bounds the requested recipient list and fails closed on lookup errors", async () => {
    expect(await mayReceiveCatalogActiveUsersReport(Array(26).fill("qa@example.test"))).toBe(false);
    expect(fake.useEmail).not.toHaveBeenCalled();
    fake.useEmail.mockRejectedValueOnce(new Error("private detail"));
    expect(await mayReceiveCatalogActiveUsersReport(["qa@example.test"])).toBe(false);
  });

  it("does not accept a user's inactive custom role even when it includes the report permission", async () => {
    const reportRole = { id: "report-auditor", name: "Report auditor", permissions: ["configuration.alerts.send_report"],
      taskVisibility: { domain: "none", database: "none" }, system: false };
    const user = { id: "u", email: "qa@example.test", roles: [reportRole.id], displayName: "QA", active: true };
    fake.useEmail.mockResolvedValue(user);
    fake.roles.mockResolvedValue([{ ...reportRole, active: false }]);
    expect(await mayReceiveCatalogActiveUsersReport([user.email])).toBe(false);
    fake.roles.mockResolvedValue([{ ...reportRole, active: true }]);
    expect(await mayReceiveCatalogActiveUsersReport([user.email])).toBe(true);
  });
});
