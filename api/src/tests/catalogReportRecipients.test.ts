import { beforeEach, describe, expect, it, vi } from "vitest";
import { mayReceiveCatalogActiveUsersReport, mayDeliverCatalogMastersReport, resolveCatalogMastersReportScope } from "../lib/catalogReportRecipients";

const fake = vi.hoisted(() => ({ useEmail: vi.fn(), useId: vi.fn(), roles: vi.fn(), scope: vi.fn() }));
vi.mock("../lib/securityManagementSqlWriteRepository", () => ({ findSqlUserByEmail: fake.useEmail, findSqlUserById: fake.useId }));
vi.mock("../lib/roleDefinitionStore", () => ({ loadRoleDefinitions: fake.roles }));
vi.mock("../lib/catalogSourceAccessSqlRepository", () => ({ readAuthorizedCatalogSourceIds: fake.scope }));

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

  it("pins only the common source scope of sender and all recipients and refuses later revocation or identity reuse", async () => {
    const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222";
    const profiles = ["sender", "one", "two"].map(id => ({ id, active: true, roles: ["super_admin"], email: id + "@example.test" }));
    const recipients = profiles.slice(1).map(user => user.email);
    fake.useId.mockResolvedValue(profiles[0]);
    fake.useEmail.mockImplementation(async email => profiles.find(user => user.email === email));
    fake.scope.mockImplementation(async ({ actorId }) => new Set(actorId === "two" ? [b] : [a, b]));
    const pinned = await resolveCatalogMastersReportScope("sender", recipients, "qa");
    expect(pinned).toEqual({ senderId: "sender", environment: "qa", sourceIds: [b], recipientIds: ["one", "two"] });
    expect(await mayDeliverCatalogMastersReport(pinned, recipients, "qa")).toBe(true);
    expect(await mayDeliverCatalogMastersReport(pinned, recipients, "production")).toBe(false);
    fake.scope.mockImplementation(async ({ actorId }) => new Set(actorId === "two" ? [a] : [a, b]));
    expect(await mayDeliverCatalogMastersReport(pinned, recipients, "qa")).toBe(false);
    fake.scope.mockResolvedValue(new Set([b]));
    fake.useEmail.mockResolvedValue({ ...profiles[1], id: "new-owner" });
    expect(await mayDeliverCatalogMastersReport(pinned, recipients, "qa")).toBe(false);
  });
});
