import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateTask } from "../types/models";

const mocks = vi.hoisted(() => ({
  tasks: [] as UpdateTask[],
  enqueue: vi.fn(async () => ({ created: true, id: "outbox-1" })),
  timer: vi.fn(),
}));

vi.mock("@azure/functions", () => ({ app: { timer: mocks.timer } }));
vi.mock("../lib/workflowTasksSqlRepository", () => ({
  readSqlWorkflowTasks: vi.fn(async () => mocks.tasks),
}));
vi.mock("../lib/emailOutboxSqlRepository", () => ({ enqueueSqlEmail: mocks.enqueue }));
vi.mock("../lib/settingsService", () => ({
  loadEmailAlertsSettings: vi.fn(async () => ({
    blockedReminderEnabled: true,
    blockedReminderTime: "08:00",
    blockedReminderDaysAfter: [1],
    blockedAlertRecipientRoleIds: ["super_admin"],
    blockedAlertCustomEmails: [],
    frontendBaseUrl: "https://app.example.com",
  })),
}));
vi.mock("../lib/emailRecipients", () => ({
  resolveConfiguredRecipients: vi.fn(async () => ["admin@example.com"]),
}));

import { ejecutarRecordatoriosBloqueos } from "../functions/sendBlockedReminders";

function blockedTask(): UpdateTask {
  return {
    id: "task_xss", taskDate: "2026-07-02", taskBucket: "2026-07-02_database",
    clientId: "c1", clientName: `<script>alert("cliente")</script>`,
    domainId: "d1", domainName: `erp.example.com"><img src=x onerror=alert(2)>`,
    targetType: "database", targetId: "db1", targetName: `<a href="javascript:alert(3)">ERP & DB</a>`,
    scheduleId: "s1", rootScheduleId: "s1", assignedRole: "database_updater", assignedUserIds: [],
    status: "blocked", result: null, notes: "", blockReason: `<svg onload=alert(4)>Tom & Jerry`,
    blockedAt: "2026-07-02T08:00:00.000Z", blockedBy: "u1",
    createdAt: "2026-07-02T08:00:00.000Z", createdBy: "system",
    updatedAt: "2026-07-02T08:00:00.000Z", updatedBy: "u1",
    completedAt: null, completedBy: null,
  };
}

describe("sendBlockedReminders SQL", () => {
  beforeEach(() => {
    mocks.tasks = [blockedTask()];
    mocks.enqueue.mockClear();
    mocks.enqueue.mockResolvedValue({ created: true, id: "outbox-1" });
  });

  it("encola la plantilla con valores dinámicos escapados", async () => {
    await expect(ejecutarRecordatoriosBloqueos(
      () => undefined,
      new Date("2026-07-03T08:00:00.000Z"),
    )).resolves.toEqual({ enviados: 1 });
    const request = mocks.enqueue.mock.calls[0][0];
    expect(request.html).not.toMatch(/<script|<img|<svg|<a href="javascript:/i);
    expect(request.html).toContain("&lt;script&gt;");
    expect(request.html).toContain("ERP &amp; DB");
    expect(request.html).toContain("Tom &amp; Jerry");
    expect(request.text).toContain(`<script>alert("cliente")</script>`);
    expect(request.idempotencyKey).toBe("blockedReminder:task_xss:1");
  });
});
