import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  route: null as ((req: HttpRequest) => Promise<HttpResponseInit>) | null,
  env: vi.fn(), check: vi.fn(), counts: vi.fn(), masters: vi.fn(), enqueue: vi.fn(),
  catalogMasters: vi.fn(), resolveScope: vi.fn(), verifyScope: vi.fn(),
  claim: vi.fn(), renew: vi.fn(), complete: vi.fn(), send: vi.fn(), render: vi.fn(),
}));
vi.mock("@azure/functions", () => ({
  app: {
    http: (_name: string, opts: { handler: typeof fake.route }) => { fake.route = opts.handler; },
    timer: vi.fn(),
  },
}));
vi.mock("../lib/auth", () => ({
  requireUser: vi.fn(), loadUserProfile: async () => ({ id: "alice", email: "alice@example.test" }),
}));
vi.mock("../lib/managementAccess", () => ({ canSendConfiguredReport: () => true }));
vi.mock("../lib/roleDefinitionStore", () => ({ loadRoleDefinitions: async () => [] }));
vi.mock("../lib/audit", () => ({ writeAuditLog: async () => undefined }));
vi.mock("../lib/reportsService", () => ({ parseSemicolonEmails: () => ["alice@example.test"], buildMastersReportEmail: fake.render }));
vi.mock("../lib/rateLimit", () => ({ enforceRequestRateLimit: async () => null, RATE_LIMIT_POLICIES: { mastersReport: {} } }));
vi.mock("../lib/mastersReportSqlData", () => ({ loadSqlMastersReportData: fake.masters, loadSqlCatalogMastersReportData: fake.catalogMasters }));
vi.mock("../lib/catalogMastersActiveUsers", () => ({
  catalogActiveUserReportEnvironment: fake.env, loadCatalogMastersActiveUsers: fake.counts,
}));
vi.mock("../lib/catalogReportRecipients", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/catalogReportRecipients")>(),
  mayReceiveCatalogActiveUsersReport: fake.check, resolveCatalogMastersReportScope: fake.resolveScope,
  mayDeliverCatalogMastersReport: fake.verifyScope,
}));
vi.mock("../lib/emailOutboxSqlRepository", () => ({
  enqueueSqlEmail: fake.enqueue, claimSqlEmailBatch: fake.claim, renewSqlEmailClaim: fake.renew, completeSqlEmailAttempt: fake.complete,
}));
vi.mock("../lib/settingsService", () => ({ loadEmailAlertsSettings: async () => ({}) }));
vi.mock("../lib/emailService", () => ({ sendEmail: fake.send, renderResetPasswordEmail: vi.fn() }));
vi.mock("../lib/securityManagementSqlWriteRepository", () => ({ setSqlPasswordResetToken: vi.fn() }));
import "../functions/reports";
import { processSqlEmailOutbox } from "../functions/processEmailOutbox";

const req = { json: async () => ({ recipients: "alice@example.test" }) } as unknown as HttpRequest;
const scope = { senderId: "alice", environment: "qa", sourceIds: ["11111111-1111-4111-8111-111111111111"], recipientIds: ["alice"] };
const queueReport = (metadata: Record<string, unknown>) => fake.claim.mockResolvedValueOnce([{
  type: "masters_report", subject: "Reporte", recipients: [{ type: "to", email: "alice@example.test" }], metadata,
}]).mockResolvedValue([]);
describe("catalog report authorization at generation and delivery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("PORTAL_CATALOG_ACTIVE_USERS_REPORT_ENABLED", "true");
    vi.stubEnv("PORTAL_CATALOG_MASTERS_REPORT_ENABLED", undefined);
    fake.env.mockReturnValue("qa");
    fake.check.mockResolvedValue(true);
    fake.counts.mockResolvedValue({ rows: [], summary: { activeUsers: null } });
    fake.masters.mockResolvedValue({});
    fake.catalogMasters.mockResolvedValue({ clients: [{ name: "Cliente oficial" }] });
    fake.resolveScope.mockResolvedValue(scope);
    fake.verifyScope.mockResolvedValue(true);
    fake.render.mockReturnValue({ subject: "Reporte", html: "<p>Reporte</p>", text: "Reporte" });
    fake.enqueue.mockResolvedValue({ created: true });
    fake.renew.mockResolvedValue(true);
    fake.send.mockResolvedValue({ ok: true, provider: "fake" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("does not read sources or queue mail for an unauthorized recipient", async () => {
    fake.check.mockResolvedValue(false);
    expect((await fake.route!(req)).status).toBe(403);
    expect(fake.masters).not.toHaveBeenCalled();
    expect(fake.counts).not.toHaveBeenCalled();
    expect(fake.enqueue).not.toHaveBeenCalled();
  });

  it("rechecks before queuing and marks only the detailed report for delivery re-authorization", async () => {
    fake.check.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await fake.route!(req)).status).toBe(403);
    expect(fake.enqueue).not.toHaveBeenCalled();
    expect((await fake.route!(req)).status).toBe(200);
    expect(fake.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { catalogActiveUsers: true, recipientsCount: 1 },
    }));
    fake.env.mockReturnValue(null);
    expect((await fake.route!(req)).status).toBe(200);
    expect(fake.enqueue.mock.calls.at(-1)?.[0].metadata).toEqual({ recipientsCount: 1 });
  });

  it("does not send queued count details to recipients whose access is now revoked", async () => {
    fake.check.mockResolvedValue(false);
    queueReport({ catalogActiveUsers: true, html: "<p>Reporte</p>", text: "Reporte" });
    expect(await processSqlEmailOutbox(vi.fn())).toMatchObject({ sent: 0, failed: 1 });
    expect(fake.send).not.toHaveBeenCalled();
    fake.check.mockResolvedValue(true);
    queueReport({ catalogActiveUsers: true, html: "<p>Reporte</p>", text: "Reporte" });
    expect(await processSqlEmailOutbox(vi.fn())).toMatchObject({ sent: 1, failed: 0 });
    expect(fake.send).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty shared scope before data, counts, rendering, or enqueue; it never queries the legacy dataset", async () => {
    vi.stubEnv("PORTAL_CATALOG_MASTERS_REPORT_ENABLED", "true");
    vi.stubEnv("PORTAL_CATALOG_READ_ENABLED", "true");
    vi.stubEnv("PORTAL_SAG_ENVIRONMENT", "qa");
    fake.resolveScope.mockResolvedValue(null);
    expect((await fake.route!(req)).status).toBe(403);
    for (const read of [fake.catalogMasters, fake.masters, fake.counts, fake.render, fake.enqueue]) expect(read).not.toHaveBeenCalled();
  });

  it("reads only the catalog intersection, rechecks before enqueue, and rechecks the same scope on delivery", async () => {
    vi.stubEnv("PORTAL_CATALOG_MASTERS_REPORT_ENABLED", "true");
    vi.stubEnv("PORTAL_CATALOG_READ_ENABLED", "true");
    vi.stubEnv("PORTAL_SAG_ENVIRONMENT", "qa");
    fake.verifyScope.mockResolvedValueOnce(false);
    expect((await fake.route!(req)).status).toBe(403);
    expect(fake.enqueue).not.toHaveBeenCalled();
    expect((await fake.route!(req)).status).toBe(200);
    expect(fake.masters).not.toHaveBeenCalled();
    expect(fake.catalogMasters).toHaveBeenCalledWith({ portalEnvironment: "qa", allowedSourceIds: new Set(scope.sourceIds) });
    expect(fake.enqueue.mock.calls.at(-1)?.[0].metadata.catalogReportScope).toEqual(scope);
    const metadata = { ...fake.enqueue.mock.calls.at(-1)?.[0].metadata, html: "<p>Reporte</p>", text: "Reporte" };
    queueReport(metadata);
    fake.verifyScope.mockResolvedValueOnce(false);
    expect(await processSqlEmailOutbox(vi.fn())).toMatchObject({ sent: 0, failed: 1 });
    expect(fake.send).not.toHaveBeenCalled();
    queueReport(metadata);
    expect(await processSqlEmailOutbox(vi.fn())).toMatchObject({ sent: 1, failed: 0 });
    expect(fake.verifyScope).toHaveBeenLastCalledWith(scope, ["alice@example.test"], "qa");
  });

  it("does not fall back on catalog failure or deliver an older unscoped report during cutover", async () => {
    vi.stubEnv("PORTAL_CATALOG_MASTERS_REPORT_ENABLED", "true");
    vi.stubEnv("PORTAL_CATALOG_READ_ENABLED", "true");
    vi.stubEnv("PORTAL_SAG_ENVIRONMENT", "qa");
    fake.catalogMasters.mockRejectedValue(new Error("private driver detail"));
    expect(await fake.route!(req)).toEqual({ status: 503, jsonBody: { error: "El reporte del catálogo no está disponible." } });
    for (const read of [fake.masters, fake.counts, fake.enqueue]) expect(read).not.toHaveBeenCalled();
    queueReport({ html: "<p>Reporte</p>", text: "Reporte" });
    expect(await processSqlEmailOutbox(vi.fn())).toMatchObject({ sent: 0, failed: 1 });
    expect(fake.send).not.toHaveBeenCalled();
  });

  it("does not activate reporting with catalog reads alone, or fall back when the report flag is misconfigured", async () => {
    vi.stubEnv("PORTAL_CATALOG_READ_ENABLED", "true");
    vi.stubEnv("PORTAL_SAG_ENVIRONMENT", "qa");
    expect((await fake.route!(req)).status).toBe(200);
    expect(fake.masters).toHaveBeenCalledOnce();
    expect(fake.catalogMasters).not.toHaveBeenCalled();
    vi.stubEnv("PORTAL_CATALOG_MASTERS_REPORT_ENABLED", "true");
    vi.stubEnv("PORTAL_CATALOG_READ_ENABLED", undefined);
    expect((await fake.route!(req)).status).toBe(503);
    expect(fake.masters).toHaveBeenCalledOnce();
    expect(fake.catalogMasters).not.toHaveBeenCalled();
  });
});
