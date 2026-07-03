import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateTask } from "../types/models";

const mocks = vi.hoisted(() => ({
  tasks: [] as UpdateTask[],
  sentNotifications: new Set<string>(),
  upsert: vi.fn(async (record: any) => { mocks.sentNotifications.add(record.id); }),
  sendEmail: vi.fn(async () => ({ ok: true, provider: "mock", messageId: "message-1" })),
  audit: vi.fn(async () => ({})),
  timer: vi.fn(),
}));

vi.mock("@azure/functions", () => ({ app: { timer: mocks.timer } }));
vi.mock("../lib/cosmos", () => ({
  getContainer: (name: string) => name === "updateTasks" ? {
    items: { query: () => ({ fetchAll: async () => ({ resources: mocks.tasks }) }) },
  } : {
    item: (id: string) => ({ read: async () => ({ resource: mocks.sentNotifications.has(id) ? { id } : undefined }) }),
    items: { upsert: mocks.upsert },
  },
}));
vi.mock("../lib/settingsService", () => ({
  loadEmailAlertsSettings: vi.fn(async () => ({
    blockedReminderEnabled: true,
    blockedReminderTime: "08:00",
    blockedReminderDaysAfter: [1],
    blockedAlertRecipientRoleIds: ["admin"],
    blockedAlertCustomEmails: [],
    frontendBaseUrl: "https://app.example.com",
  })),
}));
vi.mock("../lib/emailRecipients", () => ({ resolveConfiguredRecipients: vi.fn(async () => ["admin@example.com"]) }));
vi.mock("../lib/emailService", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("../lib/audit", () => ({ writeAuditLog: mocks.audit }));

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
    createdAt: "2026-07-02T08:00:00.000Z", createdBy: "system", updatedAt: "2026-07-02T08:00:00.000Z", updatedBy: "u1",
    completedAt: null, completedBy: null,
  };
}

describe("sendBlockedReminders seguro", () => {
  beforeEach(() => {
    mocks.tasks = [blockedTask()];
    mocks.sentNotifications.clear();
    mocks.upsert.mockClear(); mocks.sendEmail.mockClear(); mocks.audit.mockClear();
  });

  it("envía la plantilla central con todos los valores dinámicos escapados", async () => {
    const result = await ejecutarRecordatoriosBloqueos(() => undefined, new Date("2026-07-03T08:00:00.000Z"));
    expect(result).toEqual({ enviados: 1 });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const message = mocks.sendEmail.mock.calls[0][0];
    expect(message.html).not.toMatch(/<script|<img|<svg|<a href="javascript:/i);
    expect(message.html).toContain("&lt;script&gt;");
    expect(message.html).toContain("ERP &amp; DB");
    expect(message.html).toContain("Tom &amp; Jerry");
    expect(message.text).toContain(`<script>alert("cliente")</script>`);
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ id: "blockedReminder:task_xss:1" }));
  });
});
