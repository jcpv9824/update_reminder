import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimedEmail } from "../lib/emailOutboxSqlRepository";

const fake = vi.hoisted(() => ({ claim: vi.fn(), renew: vi.fn(), complete: vi.fn(), send: vi.fn(), authorize: vi.fn(), query: vi.fn(),
  input: vi.fn(),
  timer: null as ((timer: unknown, context: { log: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }) => Promise<void>) | null,
}));
vi.mock("mssql", () => ({ default: {
  Request: class { input(...args: unknown[]) { fake.input(...args); return this; } query = fake.query; },
  BigInt: "BigInt", Int: "Int", NVarChar: vi.fn(), VarChar: vi.fn(), ISOLATION_LEVEL: { READ_COMMITTED: 2 },
} }));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: async (work: (transaction: unknown) => unknown) => work({}) }));
vi.mock("../lib/auditSqlWriter", () => ({ writeSqlAuditLog: vi.fn() }));
vi.mock("@azure/functions", () => ({ app: { timer: (_name: string, options: { handler: typeof fake.timer }) => { fake.timer = options.handler; } } }));
vi.mock("../lib/emailOutboxSqlRepository", () => ({
  claimSqlEmailBatch: fake.claim, renewSqlEmailClaim: fake.renew, completeSqlEmailAttempt: fake.complete,
}));
vi.mock("../lib/settingsService", () => ({ loadEmailAlertsSettings: async () => ({}) }));
vi.mock("../lib/emailService", () => ({ sendEmail: fake.send, renderResetPasswordEmail: vi.fn() }));
vi.mock("../lib/securityManagementSqlWriteRepository", () => ({ setSqlPasswordResetToken: vi.fn() }));
vi.mock("../lib/catalogReportRecipients", () => ({
  catalogMastersReportsEnabled: () => true, catalogMastersReportEnvironment: () => "qa",
  mayDeliverCatalogMastersReport: fake.authorize, mayReceiveCatalogActiveUsersReport: vi.fn(),
}));
import { processSqlEmailOutbox } from "../functions/processEmailOutbox";

const message = {
  notificationKey: 7, attemptNo: 1, type: "masters_report", subject: "Reporte sintético",
  metadata: { catalogReportScope: {}, html: "<p>Prueba</p>", text: "Prueba" },
  recipients: [{ type: "to", email: "qa@example.test" }],
};

describe("email worker lease ownership", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fake.claim.mockResolvedValueOnce([message]).mockResolvedValue([]);
    fake.renew.mockResolvedValue(true);
    fake.authorize.mockResolvedValue(true);
    fake.send.mockImplementation(async (_message, _settings, options) =>
      await options.beforeSend() ? { ok: true, provider: "fake" } : { ok: false, provider: "outbox", leaseLost: true });
  });

  it("claims just one at a time and rechecks ownership after authorization, immediately before sending", async () => {
    expect(await processSqlEmailOutbox(vi.fn())).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(fake.claim).toHaveBeenCalledWith(expect.any(String), 1, 120);
    expect(fake.renew).toHaveBeenCalledTimes(2);
    expect(fake.renew.mock.invocationCallOrder[1]).toBeGreaterThan(fake.authorize.mock.invocationCallOrder[0]);
    expect(fake.complete).toHaveBeenCalledWith(message, expect.any(String), expect.objectContaining({ ok: true }));
  });

  it("never prepares or sends a claim that is already expired or reclaimed", async () => {
    fake.renew.mockResolvedValue(false);
    expect(await processSqlEmailOutbox(vi.fn())).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(fake.authorize).not.toHaveBeenCalled();
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.complete).not.toHaveBeenCalled();
  });

  it("does not send or complete after a second worker reclaims during deferred authorization", async () => {
    let release!: (value: boolean) => void;
    fake.authorize.mockReturnValue(new Promise<boolean>(resolve => { release = resolve; }));
    const processing = processSqlEmailOutbox(vi.fn());
    await vi.waitFor(() => expect(fake.authorize).toHaveBeenCalled());
    fake.renew.mockResolvedValue(false);
    release(true);
    expect(await processing).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(fake.complete).not.toHaveBeenCalled();
  });

  it("fails closed when renewal SQL fails", async () => {
    fake.renew.mockRejectedValue(new Error("sensitive SQL detail"));
    const log = vi.fn();
    expect(await processSqlEmailOutbox(log)).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.complete).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("sensitive SQL detail");
  });

  it("does not send revoked or malformed reports", async () => {
    fake.authorize.mockResolvedValue(false);
    expect(await processSqlEmailOutbox(vi.fn())).toMatchObject({ sent: 0, failed: 1 });
    expect(fake.send).not.toHaveBeenCalled();
    fake.claim.mockResolvedValueOnce([{ ...message, metadata: {} }]);
    fake.authorize.mockResolvedValue(true);
    expect(await processSqlEmailOutbox(vi.fn())).toMatchObject({ sent: 0, failed: 1 });
    expect(fake.send).not.toHaveBeenCalled();
  });

  it("freshly claims the next message only after completing the preceding one and caps the run at ten", async () => {
    fake.claim.mockReset().mockResolvedValue([message]);
    expect(await processSqlEmailOutbox(vi.fn())).toEqual({ claimed: 10, sent: 10, failed: 0 });
    expect(fake.claim).toHaveBeenCalledTimes(10);
    expect(fake.claim.mock.invocationCallOrder[1]).toBeGreaterThan(fake.complete.mock.invocationCallOrder[0]);
  });

  it("does not mutate a reclaimed attempt when completion is fenced out", async () => {
    fake.complete.mockRejectedValue(new Error("claim expired"));
    expect(await processSqlEmailOutbox(vi.fn())).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(fake.complete).toHaveBeenCalledTimes(1);
  });

  it("logs only a controlled message if initial SQL claiming fails", async () => {
    fake.claim.mockReset().mockRejectedValue(new Error("synthetic-private-sql-detail"));
    const context = { log: vi.fn(), error: vi.fn() };
    await fake.timer!({}, context);
    expect(context.error).toHaveBeenCalledExactlyOnceWith("No se pudo procesar la bandeja de salida SQL.");
    expect(JSON.stringify(context.error.mock.calls)).not.toContain("synthetic-private");
  });
});

describe("SQL email lease fence", () => {
  beforeEach(() => { vi.resetAllMocks(); fake.query.mockResolvedValue({ recordset: [{ renewed: 1 }] }); });
  afterEach(() => vi.restoreAllMocks());

  it("uses a SQL clock sampled after the row lock and never revives expired or mismatched attempts", async () => {
    const actual = await vi.importActual<typeof import("../lib/emailOutboxSqlRepository")>("../lib/emailOutboxSqlRepository");
    expect(await actual.renewSqlEmailClaim(message as ClaimedEmail, "worker-one")).toBe(true);
    const statement = fake.query.mock.calls[0][0] as string;
    expect(statement).toContain("WITH (UPDLOCK,HOLDLOCK)");
    expect(statement.indexOf("WITH (UPDLOCK,HOLDLOCK)")).toBeLessThan(statement.indexOf("SYSUTCDATETIME()"));
    expect(statement).toContain("claimed_by=@workerId AND attempt_count=@attemptNo AND claim_expires_at>@now");
    fake.query.mockResolvedValue({ recordset: [{ renewed: 0 }] });
    expect(await actual.renewSqlEmailClaim(message as ClaimedEmail, "worker-two")).toBe(false);
  });

  it("rejects a successful SQL renewal whose response consumed thirty seconds of the lease", async () => {
    const actual = await vi.importActual<typeof import("../lib/emailOutboxSqlRepository")>("../lib/emailOutboxSqlRepository");
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(30_000);
    expect(await actual.renewSqlEmailClaim(message as ClaimedEmail, "worker-one")).toBe(false);
  });

  it("fences completion by worker, exact attempt, SQL expiry and an unfinished attempt", async () => {
    const actual = await vi.importActual<typeof import("../lib/emailOutboxSqlRepository")>("../lib/emailOutboxSqlRepository");
    await actual.completeSqlEmailAttempt(message as ClaimedEmail, "worker-one", { ok: true });
    const statement = fake.query.mock.calls[0][0] as string;
    expect(statement).toContain("claimed_by=@workerId AND status='processing'");
    expect(statement).toContain("attempt_count=@attemptNo AND claim_expires_at>@now");
    expect(statement).toContain("attempt_no=@attemptNo AND completed_at IS NULL");
    expect(statement).toContain("IF @@ROWCOUNT<>1 THROW 51071");
  });

  it.each([true, false])("records only actual To recipients and skips exclusions atomically, ok=%s", async ok => {
    const actual = await vi.importActual<typeof import("../lib/emailOutboxSqlRepository")>("../lib/emailOutboxSqlRepository");
    const { writeSqlAuditLog } = await import("../lib/auditSqlWriter");
    const notice = {
      ...message, type: "blocked_task_reminder",
      recipients: [...message.recipients, { type: "to", email: "revoked@example.test" }],
    } as ClaimedEmail;
    await actual.completeSqlEmailAttempt(notice, "worker-one", {
      ok, attemptedTo: [" QA@Example.Test ", "qa@example.test"], deliveredTaskIds: ["copy"],
    });
    expect(fake.input).toHaveBeenCalledWith("attemptedTo", undefined, '["qa@example.test"]');
    expect(fake.input).toHaveBeenCalledWith("status", undefined, ok ? "sent" : "failed");
    const statement = String(fake.query.mock.calls[0][0]);
    expect(statement).toContain("THEN 'skipped'");
    expect(statement.indexOf("UPDATE recipient")).toBeGreaterThan(statement.lastIndexOf("IF @@ROWCOUNT<>1"));
    expect(statement).toContain("recipient.recipient_type='to'");
    expect(statement).toContain("recipient.delivery_status IN ('pending','failed')");
    expect(writeSqlAuditLog).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ metadata: { taskIds: ["copy"], deliveryTaskCount: 1, attemptedRecipientCount: 1 } }));
  });
});
