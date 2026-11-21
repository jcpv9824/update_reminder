import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateSchedule, UpdateTask, UserRecord } from "../types/models";

const mocks = vi.hoisted(() => ({
  timer: vi.fn(),
  enqueue: vi.fn(async () => ({ created: true, outboxId: 1 })),
  tasks: vi.fn(),
  schedules: vi.fn(),
  covered: vi.fn(),
}));

const schedule: UpdateSchedule = {
  id: "schedule_sql",
  clientId: "client_1",
  clientName: "Cliente SQL",
  targetType: "domain",
  targetIds: ["domain_1"],
  frequencyType: "once",
  startDate: "2026-05-10",
  timezone: "America/Bogota",
  assignedRole: "domain_updater",
  assignedUserIds: ["user_1"],
  active: true,
  reminders: {
    remindersEnabled: true,
    reminderDaysBefore: [0],
    reminderTime: "08:00",
    reminderRecipientsMode: "assignedUsers",
  },
  createdAt: "2026-05-01T00:00:00.000Z",
  createdBy: "system",
  updatedAt: "2026-05-01T00:00:00.000Z",
  updatedBy: "system",
};

const task: UpdateTask = {
  id: "task_sql",
  taskDate: "2026-05-10",
  taskBucket: "2026-05-10_domain",
  clientId: "client_1",
  clientName: "Cliente SQL",
  domainId: "domain_1",
  domainName: "https://sql.example.com",
  targetType: "domain",
  targetId: "domain_1",
  targetName: "https://sql.example.com",
  scheduleId: "schedule_sql",
  rootScheduleId: "schedule_sql",
  assignedRole: "domain_updater",
  assignedUserIds: ["user_1"],
  status: "pending",
  result: null,
  notes: "",
  createdAt: "2026-05-01T00:00:00.000Z",
  createdBy: "system",
  updatedAt: "2026-05-01T00:00:00.000Z",
  updatedBy: "system",
  completedAt: null,
  completedBy: null,
};

const user: UserRecord = {
  id: "user_1",
  displayName: "Responsable SQL",
  email: "responsable@example.com",
  roles: ["domain_updater"],
  active: true,
  createdAt: "2026-05-01T00:00:00.000Z",
  createdBy: "system",
  updatedAt: "2026-05-01T00:00:00.000Z",
  updatedBy: "system",
};

vi.mock("@azure/functions", () => ({ app: { timer: mocks.timer } }));
vi.mock("../lib/audit", () => ({ writeAuditLog: vi.fn(async () => undefined) }));
vi.mock("../lib/settingsService", () => ({
  loadEmailAlertsSettings: vi.fn(async () => ({
    remindersEnabled: true,
    defaultReminderDaysBefore: [0],
    defaultReminderTime: "08:00",
    defaultTimezone: "America/Bogota",
    frontendBaseUrl: "https://portal.example.com",
  })),
}));
vi.mock("../lib/securityUsersSqlRepository", () => ({
  readSqlPublicUsers: vi.fn(async () => [user]),
}));
vi.mock("../lib/workflowTasksSqlRepository", () => ({
  readSqlWorkflowTasks: mocks.tasks,
}));
vi.mock("../lib/schedulingSqlRepository", () => ({
  readSqlSchedules: mocks.schedules,
}));
vi.mock("../lib/emailOutboxSqlRepository", () => ({ enqueueSqlEmail: mocks.enqueue, readCoveredTaskReminders: mocks.covered }));

import { ejecutarRecordatorios } from "../functions/sendScheduledReminders";

describe("recordatorios programados SQL-only", () => {
  beforeEach(() => {
    process.env.DATA_BACKEND = "sql";
    process.env.SQL_SECURITY_RUNTIME_ENABLED = "true";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T13:00:00.000Z"));
    mocks.enqueue.mockClear();
    mocks.tasks.mockReset().mockResolvedValue([task]);
    mocks.schedules.mockReset().mockResolvedValue([schedule]);
    mocks.covered.mockReset().mockResolvedValue(new Set<string>());
  });

  afterEach(() => {
    delete process.env.DATA_BACKEND;
    delete process.env.SQL_SECURITY_RUNTIME_ENABLED;
    vi.useRealTimers();
  });

  it("resuelve usuarios y encola el correo desde SQL", async () => {
    await expect(ejecutarRecordatorios(() => undefined)).resolves.toEqual({
      enviados: 1,
      fallidos: 0,
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      type: "task_reminder",
      recipients: [{ email: user.email, name: user.displayName }],
    }));
  });

  it("mantiene el aviso de la copia del mismo día tras eliminar su programación original", async () => {
    const copy = { ...schedule, id: "copy_same_day" };
    mocks.tasks.mockResolvedValue([{ ...task, sources: [
      { scheduleId: schedule.id, scheduleType: "normal", createdAt: schedule.createdAt },
      { scheduleId: copy.id, scheduleType: "normal", createdAt: schedule.createdAt },
    ] }]);
    mocks.schedules.mockImplementation(async ({ sourceId }: { sourceId: string }) => sourceId === copy.id ? [copy] : []);
    await expect(ejecutarRecordatorios(() => undefined)).resolves.toEqual({ enviados: 1, fallidos: 0 });
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ metadata: expect.objectContaining({
      schedulesByTask: [[task.id, copy.id]], taskIds: [task.id],
    }) }));
  });

  it("no usa la configuración global para revivir el aviso de una programación eliminada sin copia", async () => {
    mocks.schedules.mockResolvedValue([]);
    await expect(ejecutarRecordatorios(() => undefined)).resolves.toEqual({ enviados: 0, fallidos: 0 });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("no encola un segundo aviso si la copia ya está incluida en un correo agrupado", async () => {
    mocks.covered.mockResolvedValue(new Set([task.id]));
    await expect(ejecutarRecordatorios(() => undefined)).resolves.toEqual({ enviados: 0, fallidos: 0 });
    expect(mocks.covered).toHaveBeenCalledWith("2026-05-10", user.email, [[task.id, schedule.id]]);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
