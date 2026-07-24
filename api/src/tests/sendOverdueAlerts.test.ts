import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailAlertsSettings, UpdateTask, UserRecord } from "../types/models";

const mocks = vi.hoisted(() => ({
  tasks: [] as UpdateTask[],
  users: new Map<string, UserRecord>(),
  enqueue: vi.fn(async () => ({ created: true, id: "outbox-1" })),
  timer: vi.fn(),
}));

vi.mock("@azure/functions", () => ({ app: { timer: mocks.timer } }));
vi.mock("../lib/workflowTasksSqlRepository", () => ({
  readSqlWorkflowTasks: vi.fn(async () => mocks.tasks),
}));
vi.mock("../lib/securityManagementSqlWriteRepository", () => ({
  findSqlUserById: vi.fn(async (id: string) => mocks.users.get(id) ?? null),
}));
vi.mock("../lib/emailOutboxSqlRepository", () => ({ enqueueSqlEmail: mocks.enqueue }));
vi.mock("../lib/emailRecipients", () => ({
  resolveConfiguredRecipients: vi.fn(async () => ["admin@example.com"]),
}));
vi.mock("../lib/settingsService", () => ({
  loadEmailAlertsSettings: vi.fn(async (): Promise<EmailAlertsSettings> => ({
    id: "email-alerts",
    emailProvider: "mock",
    emailFrom: "info@pya.com.co",
    emailFromName: "Portal SAG Web",
    frontendBaseUrl: "https://example.com",
    remindersEnabled: true,
    defaultReminderDaysBefore: [1, 0],
    defaultReminderTime: "08:00",
    defaultTimezone: "America/Bogota",
    overdueAlertsEnabled: true,
    overdueAlertTime: "08:00",
    overdueAlertTimezone: "America/Bogota",
    overdueAlertRecipientsMode: "admins",
    overdueAlertRecipientRoleIds: ["super_admin"],
    overdueAlertCustomEmails: [],
    overdueAlertFrequency: "daily",
    overdueAlertLastSentPeriod: null,
    passwordNotificationEnabled: true,
    sendTemporaryPasswordByEmail: false,
  })),
}));

import { ejecutarAlertasVencidas } from "../functions/sendOverdueAlerts";

function overdueTask(): UpdateTask {
  return {
    id: "task_overdue",
    taskDate: "2026-06-01",
    taskBucket: "2026-06-01_domain",
    clientId: "client_1",
    clientName: "P&A",
    domainId: "domain_1",
    domainName: "sagweb-test.sagerp.cloud",
    targetType: "domain",
    targetId: "domain_1",
    targetName: "sagweb-test.sagerp.cloud",
    scheduleId: "schedule_1",
    rootScheduleId: "schedule_1",
    assignedRole: "domain_updater",
    assignedUserIds: ["user_1"],
    status: "pending",
    result: null,
    notes: "",
    createdAt: "2026-06-01T08:00:00.000Z",
    createdBy: "system",
    updatedAt: "2026-06-01T08:00:00.000Z",
    updatedBy: "system",
    completedAt: null,
    completedBy: null,
  };
}

describe("sendOverdueAlerts SQL", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T13:00:00.000Z"));
    mocks.tasks = [];
    mocks.users = new Map([["user_1", {
      id: "user_1", email: "actualizador@pya.com.co", displayName: "Actualizador",
      roles: ["domain_updater"], active: true, createdAt: "", updatedAt: "",
    } as UserRecord]]);
    mocks.enqueue.mockClear();
    mocks.enqueue.mockResolvedValue({ created: true, id: "outbox-1" });
  });

  it("no encola correo cuando SQL no devuelve tareas operacionales vencidas", async () => {
    await expect(ejecutarAlertasVencidas(() => undefined)).resolves.toEqual({ enviados: 0, tareas: 0 });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("encola una alerta idempotente para una tarea operacional vencida", async () => {
    mocks.tasks = [overdueTask()];
    await expect(ejecutarAlertasVencidas(() => undefined)).resolves.toEqual({ enviados: 1, tareas: 1 });
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      type: "overdue_alert",
      idempotencyKey: expect.stringContaining("overdue:2026-06-16:actualizador@pya.com.co:"),
      recipients: [{ email: "actualizador@pya.com.co", name: "Actualizador" }],
    }));
    vi.useRealTimers();
  });
});
