import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimedEmail } from "../lib/emailOutboxSqlRepository";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";

const io = vi.hoisted(() => ({
  query: vi.fn(), claim: vi.fn(), renew: vi.fn(), complete: vi.fn(), suppress: vi.fn(), provider: vi.fn(), rendered: vi.fn(),
  resolveRecipients: vi.fn(), input: vi.fn(), enqueue: vi.fn(), settings: vi.fn(),
}));
vi.mock("mssql", () => ({ default: {
  Request: class { input() { return this; } query = io.query; },
  NVarChar: vi.fn(), VarChar: vi.fn(), DateTime2: vi.fn(),
} }));
vi.mock("../lib/sql", () => ({ getSqlPool: async () => ({ request: () => ({ input: io.input, query: io.query }) }) }));
vi.mock("../lib/auditSqlWriter", () => ({ writeSqlAuditLog: vi.fn() }));
vi.mock("@azure/functions", () => ({ app: { timer: vi.fn(), http: vi.fn() } }));
vi.mock("../lib/emailOutboxSqlRepository", () => ({
  claimSqlEmailBatch: io.claim, renewSqlEmailClaim: io.renew,
  completeSqlEmailAttempt: io.complete, suppressSqlEmailClaim: io.suppress,
  cancelQueuedEmailsForRemovedTasks: vi.fn(), enqueueSqlEmail: io.enqueue,
}));
vi.mock("../lib/settingsService", () => ({ loadEmailAlertsSettings: io.settings, getSmtpPassword: async () => "synthetic-only" }));
vi.mock("../lib/emailRecipients", () => ({ resolveConfiguredRecipients: io.resolveRecipients }));
vi.mock("../lib/emailService", () => ({
  sendEmail: io.provider,
  buildDomainReminderEmail: io.rendered,
  buildDatabaseReminderEmail: io.rendered,
  buildOverdueTasksEmail: io.rendered,
  renderResetPasswordEmail: vi.fn(),
  escapeHtml: (value: unknown) => String(value),
  formatDomainForPublishing: (value: string) => value,
}));
vi.mock("../lib/securityManagementSqlWriteRepository", () => ({ setSqlPasswordResetToken: vi.fn() }));

import { processSqlEmailOutbox } from "../functions/processEmailOutbox";
import { cancelOpenSqlTasksForSchedule } from "../lib/workflowTaskCleanupSqlRepository";
import { notificarCompletadaConExito, notificarProblemaAdmins } from "../functions/tasks";
import type { UpdateTask } from "../types/models";

const original = "qa-original-same-day";
const copy = "qa-copy-same-day";
const copyRow = { task_id: copy, client_name: "Copia vigente", domain_name: "copy.example.test",
  target_name: "copy.example.test", target_type: "domain", task_date: "2026-11-20", status: "pending", notes: "" };
const message: ClaimedEmail = {
  notificationKey: 8, sourceId: "qa-summary", type: "task_reminder", taskId: original, entityType: "task", entityId: original,
  subject: "Antes del borrado", attemptNo: 1,
  metadata: { targetType: "domain", taskIds: [original, copy], html: "Incluye original", text: "Incluye original" },
  recipients: [{ email: "qa@example.test", name: "QA", type: "to" }],
};
const sharedTask = {
  id: "shared-task", rootScheduleId: original, scheduleId: original, clientId: "copy-client", domainId: "copy-domain",
  targetId: "copy-db", targetType: "database", targetName: "Base de la copia", clientName: "Cliente de la copia",
  domainName: "copy.example.test", taskDate: "2026-11-20", status: "failed", updatedAt: "2026-11-20T14:30:00.000Z",
} as UpdateTask;

const defaultSettings = { frontendBaseUrl: "https://test.invalid", blockedReminderEnabled: true, blockedAlertsEnabled: true,
  blockedAlertRecipientRoleIds: ["blocking-observer"], overdueAlertRecipientRoleIds: ["completion-observer"] };

describe("same-day deletion and the task email queue", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    io.claim.mockResolvedValueOnce([message]).mockResolvedValue([]);
    io.renew.mockResolvedValue(true);
    io.query.mockResolvedValue({ recordset: [copyRow] });
    io.rendered.mockReturnValue({ subject: "Copia", html: "Solo copia", text: "Solo copia" });
    io.resolveRecipients.mockResolvedValue(["qa@example.test"]);
    io.enqueue.mockResolvedValue({ id: "notification-copy", created: true });
    io.settings.mockResolvedValue(defaultSettings);
    io.provider.mockImplementation(async (_mail, _settings, { beforeSend }) =>
      await beforeSend() ? { ok: true } : { ok: false, leaseLost: true });
  });

  it("rebuilds a mixed queued digest without the deleted original and delivers the same-day copy", async () => {
    expect(await processSqlEmailOutbox(vi.fn())).toMatchObject({ sent: 1 });
    expect(io.rendered).toHaveBeenCalledWith(expect.objectContaining({
      tasks: [expect.objectContaining({ clientName: "Copia vigente" })],
    }));
    expect(io.provider).toHaveBeenCalledWith(expect.objectContaining({ html: "Solo copia", text: "Solo copia" }),
      expect.anything(), expect.anything());
    expect(io.complete).toHaveBeenCalled();
  });

  it("terminally suppresses a claim for which no task survives without starting transport", async () => {
    io.query.mockResolvedValue({ recordset: [] });
    await processSqlEmailOutbox(vi.fn());
    expect(io.provider).not.toHaveBeenCalled();
    expect(io.suppress).toHaveBeenCalledWith(message, expect.any(String));
  });

  it("delivers the surviving copy over real loopback SMTP and never opens a socket for the deleted original", async () => {
    const { sendEmail } = await vi.importActual<typeof import("../lib/emailService")>("../lib/emailService");
    const sockets = new Set<Socket>(), deliveries: string[] = [], recipients: string[] = [];
    let connections = 0;
    const server = createServer(socket => {
      connections++;
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => { sockets.delete(socket); });
      socket.setEncoding("utf8");
      socket.write("220 synthetic loopback SMTP\r\n");
      let buffered = "", data: string[] | null = null;
      socket.on("data", (chunk: string) => {
        buffered += chunk;
        for (;;) {
          const index = buffered.indexOf("\r\n");
          if (index < 0) break;
          const line = buffered.slice(0, index);
          buffered = buffered.slice(index + 2);
          if (data) {
            if (line === ".") { deliveries.push(data.join("\r\n")); data = null; socket.write("250 accepted\r\n"); }
            else data.push(line);
          } else if (/^EHLO /i.test(line)) socket.write("250-synthetic\r\n250 AUTH PLAIN\r\n");
          else if (/^AUTH PLAIN /i.test(line)) socket.write("235 authenticated\r\n");
          else if (/^MAIL FROM:/i.test(line)) socket.write("250 sender accepted\r\n");
          else if (/^RCPT TO:/i.test(line)) { recipients.push(line); socket.write("250 recipient accepted\r\n"); }
          else if (line === "DATA") { data = []; socket.write("354 send content\r\n"); }
          else if (line === "QUIT") socket.end("221 closing\r\n");
          else socket.write("500 unsupported fixture command\r\n");
        }
      });
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("loopback fixture port unavailable");
      io.settings.mockResolvedValue({ ...defaultSettings, emailProvider: "smtp", smtpHost: "127.0.0.1",
        smtpPort: address.port, smtpSecure: false, smtpUser: "synthetic", emailFrom: "qa@example.test", emailFromName: "QA" });
      io.provider.mockImplementation(sendEmail);
      io.query.mockResolvedValue({ recordset: [] });
      await expect(processSqlEmailOutbox(vi.fn())).resolves.toMatchObject({ sent: 0 });
      expect(io.suppress).toHaveBeenCalledOnce();
      expect(connections).toBe(0);
      io.claim.mockResolvedValueOnce([message]).mockResolvedValue([]);
      io.query.mockResolvedValue({ recordset: [copyRow] });
      await expect(processSqlEmailOutbox(vi.fn())).resolves.toMatchObject({ sent: 1 });
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toContain("Solo copia");
      expect(deliveries[0]).not.toContain("Incluye original");
      expect(recipients).toEqual(["RCPT TO:<qa@example.test>"]);
      expect(io.complete).toHaveBeenCalledWith(message, expect.any(String), expect.objectContaining({ ok: true, deliveredTaskIds: [copy] }));
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 15_000);

  it("rejects the provider handoff when the surviving task disappears during delivery preparation", async () => {
    io.query.mockResolvedValueOnce({ recordset: [copyRow] }).mockResolvedValue({ recordset: [] });
    expect(await processSqlEmailOutbox(vi.fn())).toMatchObject({ sent: 0 });
    expect(io.complete).not.toHaveBeenCalled();
    expect(io.suppress).toHaveBeenCalledWith(message, expect.any(String));
  });

  it("rejects a new representative for the same physical task ID at the provider handoff", async () => {
    io.query.mockResolvedValueOnce({ recordset: [copyRow] }).mockResolvedValue({
      recordset: [{ ...copyRow, client_name: "Otro cliente", target_name: "otro.example.test" }],
    });
    expect(await processSqlEmailOutbox(vi.fn())).toMatchObject({ sent: 0 });
    expect(io.complete).not.toHaveBeenCalled();
  });

  it("does not reschedule a failed transport after concurrent retirement", async () => {
    io.provider.mockImplementation(async (_mail, _settings, { beforeSend }) => {
      expect(await beforeSend()).toBe(true);
      io.query.mockResolvedValue({ recordset: [] });
      return { ok: false, provider: "fixture" };
    });
    expect(await processSqlEmailOutbox(vi.fn())).toMatchObject({ sent: 0 });
    expect(io.complete).not.toHaveBeenCalled();
    expect(io.suppress).toHaveBeenCalledWith(message, expect.any(String));
  });

  it("still records an accepted handoff honestly if deletion occurred afterwards", async () => {
    io.provider.mockImplementation(async (_mail, _settings, { beforeSend }) => {
      expect(await beforeSend()).toBe(true);
      io.query.mockResolvedValue({ recordset: [] });
      return { ok: true, provider: "fixture", messageId: "fixture-accepted" };
    });
    expect(await processSqlEmailOutbox(vi.fn())).toMatchObject({ sent: 1 });
    expect(io.complete).toHaveBeenCalledWith(message, expect.any(String),
      expect.objectContaining({ ok: true, deliveredTaskIds: [copy] }));
    expect(io.suppress).not.toHaveBeenCalled();
  });

  it.each(["blocked_task_reminder", "task_status_notification"] as const)(
    "uses the original representative and origin to suppress stale stored %s HTML on a shared task", async type => {
      const legacyBody = { ...message, type, metadata: { html: "Texto del cliente anterior", text: "Anterior" } };
      io.claim.mockReset().mockResolvedValueOnce([legacyBody]).mockResolvedValue([]);
      io.query.mockResolvedValue({ recordset: [] });
      await processSqlEmailOutbox(vi.fn());
      const guard = String(io.query.mock.calls[0][0]);
      expect(guard).toContain("schedule.source_id=COALESCE(r.schedule_id,task.primary_schedule_source_id)");
      expect(guard).toContain("COALESCE(active_catalog_link.client_id,task.client_source_id)=COALESCE(r.client_id,task.client_source_id)");
      expect(guard).toContain("COALESCE(active_catalog_link.domain_id,task.domain_source_id)=COALESCE(r.domain_id,task.domain_source_id)");
      expect(guard).toContain("COALESCE(active_catalog_link.target_id,task.target_source_id)=COALESCE(r.target_id,task.target_source_id)");
      expect(io.provider).not.toHaveBeenCalled();
      expect(io.suppress).toHaveBeenCalledWith(legacyBody, expect.any(String));
    },
  );

  it.each(["blocked_task_reminder", "task_status_notification"] as const)(
    "delivers newly pinned %s for a surviving copy, not to a now-unauthorized recipient", async type => {
      const envelope = { ...message, type, taskId: sharedTask.id, subject: "Copia",
        metadata: { html: "Solo copia", text: "Solo copia", problem: true, status: "failed",
          taskIds: [sharedTask.id], schedulesByTask: [[sharedTask.id, copy]],
          taskRepresentatives: [[sharedTask.id, sharedTask.clientId, sharedTask.domainId, sharedTask.targetId]] },
        recipients: [...message.recipients, { email: "revoked@example.test", type: "to" as const }] };
      io.claim.mockReset().mockResolvedValueOnce([envelope]).mockResolvedValue([]);
      io.query.mockResolvedValue({ recordset: [{ ...copyRow, task_id: sharedTask.id, schedule_id: copy }] });
      expect(await processSqlEmailOutbox(vi.fn())).toMatchObject({ sent: 1 });
      expect(io.provider).toHaveBeenCalledWith(expect.objectContaining({ to: ["qa@example.test"], html: "Solo copia" }),
        expect.anything(), expect.anything());
      expect(io.complete).toHaveBeenCalledWith(envelope, expect.any(String),
        expect.objectContaining({ ok: true, attemptedTo: ["qa@example.test"] }));
      expect(io.input).toHaveBeenCalledWith("refs", undefined, expect.stringContaining(`"scheduleId":"${copy}"`));
      expect(io.input).toHaveBeenCalledWith("resolveEnqueueOrigin", undefined, false);
    },
  );

  it("rejects a pinned single-copy handoff if authorization is revoked while preparing transport", async () => {
    const envelope = { ...message, type: "blocked_task_reminder" as const, taskId: sharedTask.id,
      metadata: { html: "Solo copia", text: "Solo copia", taskIds: [sharedTask.id], schedulesByTask: [[sharedTask.id, copy]],
        taskRepresentatives: [[sharedTask.id, sharedTask.clientId, sharedTask.domainId, sharedTask.targetId]] } };
    io.claim.mockReset().mockResolvedValueOnce([envelope]).mockResolvedValue([]);
    io.query.mockResolvedValue({ recordset: [{ ...copyRow, task_id: sharedTask.id, schedule_id: copy }] });
    io.resolveRecipients.mockReset().mockResolvedValueOnce(["qa@example.test"]).mockResolvedValue([]);
    expect(await processSqlEmailOutbox(vi.fn())).toMatchObject({ sent: 0 });
    expect(io.complete).not.toHaveBeenCalled();
    expect(io.suppress).toHaveBeenCalledWith(envelope, expect.any(String));
  });

  it.each([
    ["failed", notificarProblemaAdmins, "blocking-observer", true],
    ["completed", notificarCompletadaConExito, "completion-observer", false],
  ] as const)("enqueues a new %s event only for the exact surviving copy", async (status, notify, role, problem) => {
    const task = { ...sharedTask, status };
    io.query.mockResolvedValue({ recordset: [{ ...copyRow, task_id: task.id, schedule_id: copy }] });
    await notify(task, "operator@example.test");
    expect(io.input).toHaveBeenCalledWith("resolveEnqueueOrigin", undefined, true);
    expect(io.input).toHaveBeenCalledWith("refs", undefined, JSON.stringify([{
      taskId: task.id, scheduleId: null, clientId: task.clientId, domainId: task.domainId, targetId: task.targetId, status,
    }]));
    expect(io.resolveRecipients).toHaveBeenCalledWith([role], []);
    expect(io.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      type: "task_status_notification", idempotencyKey: expect.stringMatching(new RegExp(`:${copy}$`)),
      html: expect.stringContaining("Base de la copia"), recipients: [{ email: "qa@example.test" }],
      metadata: expect.objectContaining({ status, problem, schedulesByTask: [[task.id, copy]],
        taskRepresentatives: [[task.id, task.clientId, task.domainId, task.targetId]] }),
    }));
    expect(io.enqueue.mock.calls[0][0].html).not.toContain("Servidor y puerto");
    io.enqueue.mockClear();
    io.query.mockResolvedValue({ recordset: [] });
    await notify(task, "operator@example.test");
    expect(io.enqueue).not.toHaveBeenCalled();
  });

  it("selects both catalog and legacy tasks without cancelling a task backed by the surviving schedule", async () => {
    io.query.mockResolvedValue({ recordset: [] });
    await cancelOpenSqlTasksForSchedule({} as never, original, { id: "test", email: "qa@example.test" },
      "schedule_deactivated_or_deleted", new Date("2026-11-20T14:00:00Z"), { deleting: true });
    const statements = io.query.mock.calls.map(([sql]) => String(sql)).join(" ");
    expect(statements).toContain("detached_at");
    expect(statements).toContain("workflow.catalog_task_execution_sources");
    expect(statements).toContain("surviving_schedule");
    expect(statements).toContain("surviving_schedule.deleted_at IS NULL");
  });
});
