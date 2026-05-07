import { describe, it, expect } from "vitest";
import { generateTasksForDate } from "../lib/taskGenerator";
import type { UpdateSchedule, UpdateTask } from "../types/models";

const schedule: UpdateSchedule = {
  id: "schedule_1",
  clientId: "client_1",
  clientName: "Cliente",
  domainId: "domain_1",
  domainName: "ejemplo.sagerp.co",
  targetType: "database",
  targetIds: ["db_1", "db_2"],
  frequencyType: "weekly",
  everyNWeeks: 1,
  weekdays: ["FRIDAY"],
  startDate: "2026-05-01",
  timezone: "America/Bogota",
  assignedRole: "database_updater",
  assignedUserIds: ["user_a"],
  active: true,
  createdAt: "",
  createdBy: "",
  updatedAt: "",
  updatedBy: "",
};

describe("generateTasksForDate", () => {
  it("genera una tarea por target cuando aplica la frecuencia", () => {
    const targetNameResolver = (id: string) => `Nombre de ${id}`;
    const tasks = generateTasksForDate(
      [schedule],
      "2026-05-08",
      [],
      targetNameResolver
    );
    expect(tasks).toHaveLength(2);
    expect(tasks[0].id).toBe("schedule_1_db_1_2026-05-08");
    expect(tasks[0].status).toBe("pending");
    expect(tasks[0].targetType).toBe("database");
    expect(tasks[0].assignedUserIds).toEqual(["user_a"]);
  });

  it("no genera tareas en una fecha que no aplica", () => {
    const tasks = generateTasksForDate(
      [schedule],
      "2026-05-09",
      [],
      (id) => id
    );
    expect(tasks).toHaveLength(0);
  });

  it("no duplica tareas existentes (idempotencia)", () => {
    const existing: UpdateTask[] = [
      {
        id: "schedule_1_db_1_2026-05-08",
        taskDate: "2026-05-08",
        taskBucket: "2026-05-08_database",
        clientId: "client_1",
        clientName: "Cliente",
        domainId: "domain_1",
        domainName: "ejemplo.sagerp.co",
        targetType: "database",
        targetId: "db_1",
        targetName: "BD 1",
        scheduleId: "schedule_1",
        assignedRole: "database_updater",
        assignedUserIds: ["user_a"],
        status: "pending",
        result: null,
        notes: "",
        createdAt: "",
        createdBy: "",
        updatedAt: "",
        updatedBy: "",
        completedAt: null,
        completedBy: null,
      },
    ];
    const tasks = generateTasksForDate(
      [schedule],
      "2026-05-08",
      existing,
      (id) => id
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].targetId).toBe("db_2");
  });

  it("ignora frecuencias inactivas", () => {
    const inactive = { ...schedule, active: false };
    const tasks = generateTasksForDate([inactive], "2026-05-08", [], (i) => i);
    expect(tasks).toHaveLength(0);
  });
});
