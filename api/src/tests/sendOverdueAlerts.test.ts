import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailAlertsSettings, UpdateTask, UserRecord } from "../types/models";

const mocks = vi.hoisted(() => ({
  tasks: [] as UpdateTask[],
  schedules: [] as Array<{ id: string; active?: boolean; deletedAt?: string | null }>,
  users: new Map<string, UserRecord>(),
  replaceTask: vi.fn(async (_task: UpdateTask) => ({})),
  sendEmail: vi.fn(async () => ({ ok: true, provider: "mock", messageId: "mock-1" })),
  saveSettings: vi.fn(async () => ({})),
  audit: vi.fn(async () => ({})),
  timer: vi.fn(),
}));

vi.mock("@azure/functions", () => ({
  app: { timer: mocks.timer },
}));

vi.mock("../lib/cosmos", () => ({
  getContainer: (name: string) => {
    if (name === "updateTasks") {
      return {
        items: {
          query: () => ({ fetchAll: async () => ({ resources: mocks.tasks }) }),
        },
        item: () => ({ replace: mocks.replaceTask }),
      };
    }
    if (name === "updateSchedules") {
      return {
        items: {
          query: () => ({ fetchAll: async () => ({ resources: mocks.schedules }) }),
        },
      };
    }
    if (name === "users") {
      return {
        item: (id: string) => ({
          read: async () => ({ resource: mocks.users.get(id) }),
        }),
        items: {
          query: () => ({ fetchAll: async () => ({ resources: Array.from(mocks.users.values()) }) }),
        },
      };
    }
    return {
      items: {
        query: () => ({ fetchAll: async () => ({ resources: [] }) }),
      },
      item: () => ({ read: async () => ({ resource: undefined }), replace: async () => ({}) }),
    };
  },
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
  saveEmailAlertsSettings: mocks.saveSettings,
}));

vi.mock("../lib/emailService", async () => {
  const actual = await vi.importActual<typeof import("../lib/emailService")>("../lib/emailService");
  return { ...actual, sendEmail: mocks.sendEmail };
});

vi.mock("../lib/audit", () => ({
  writeAuditLog: mocks.audit,
}));

import { ejecutarAlertasVencidas } from "../functions/sendOverdueAlerts";

function overdueTask(overrides: Partial<UpdateTask> = {}): UpdateTask {
  return {
    id: overrides.id ?? "task_overdue",
    taskDate: "2026-06-01",
    taskBucket: "2026-06-01_domain",
    clientId: "client_1",
    clientName: "P&A",
    domainId: "domain_1",
    domainName: "https://sagweb-test.sagerp.cloud:54678/",
    targetType: "domain",
    targetId: "domain_1",
    targetName: "https://sagweb-test.sagerp.cloud:54678/",
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
    ...overrides,
  };
}

function activeUser(): UserRecord {
  return {
    id: "user_1",
    email: "actualizador@pya.com.co",
    displayName: "Actualizador",
    roles: ["domain_updater"],
    active: true,
    createdAt: "2026-06-01T08:00:00.000Z",
    updatedAt: "2026-06-01T08:00:00.000Z",
  } as UserRecord;
}

describe("sendOverdueAlerts", () => {
  beforeEach(() => {
    process.env.DATA_BACKEND = "cosmos";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T13:00:00.000Z"));
    mocks.tasks = [];
    mocks.schedules = [];
    mocks.users = new Map([["user_1", activeUser()]]);
    mocks.replaceTask.mockClear();
    mocks.sendEmail.mockClear();
    mocks.saveSettings.mockClear();
    mocks.audit.mockClear();
  });

  afterEach(() => {
    delete process.env.DATA_BACKEND;
    vi.useRealTimers();
  });

  it("no envía alertas por tareas vencidas cuya actualización programada ya no existe", async () => {
    mocks.tasks = [overdueTask({ rootScheduleId: "schedule_deleted", scheduleId: "schedule_deleted" })];
    mocks.schedules = [];

    const logs: string[] = [];
    const result = await ejecutarAlertasVencidas((m) => logs.push(m));

    expect(result).toEqual({ enviados: 0, tareas: 0 });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.replaceTask).not.toHaveBeenCalled();
    expect(logs.join(" ")).toMatch(/hu[eé]rfanas|inactivas|eliminadas/i);
  });

  it("no envía alertas por tareas abiertas si la actualización programada está inactiva", async () => {
    mocks.tasks = [overdueTask()];
    mocks.schedules = [{ id: "schedule_1", active: false }];

    const result = await ejecutarAlertasVencidas(() => undefined);

    expect(result).toEqual({ enviados: 0, tareas: 0 });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.replaceTask).not.toHaveBeenCalled();
  });

  it("envía alerta y marca fecha enviada cuando la tarea vencida pertenece a una actualización activa", async () => {
    mocks.tasks = [overdueTask()];
    mocks.schedules = [{ id: "schedule_1", active: true }];

    const result = await ejecutarAlertasVencidas(() => undefined);

    expect(result).toEqual({ enviados: 1, tareas: 1 });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.replaceTask).toHaveBeenCalledTimes(1);
    expect(mocks.replaceTask.mock.calls[0][0].overdueAlertSentDates).toContain("2026-06-16");
    expect(mocks.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({ overdueAlertLastSentPeriod: "2026-06-16" }),
      performedBy: "system",
    }));
  });
});
