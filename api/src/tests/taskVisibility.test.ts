import { describe, expect, it } from "vitest";
import type { UpdateTask } from "../types/models";
import { filterTasksForOperationalView, isTaskVisibleForOperationalView } from "../lib/taskVisibility";

function task(overrides: Partial<UpdateTask>): UpdateTask {
  return {
    id: overrides.id ?? "task_1",
    taskDate: "2026-06-01",
    taskBucket: "2026-06-01_domain",
    clientId: "client_1",
    clientName: "Cliente Uno",
    domainId: "domain_1",
    domainName: "https://cliente.example.com",
    targetType: "domain",
    targetId: "domain_1",
    targetName: "https://cliente.example.com",
    scheduleId: "schedule_1",
    rootScheduleId: "schedule_1",
    assignedRole: "domain_updater",
    assignedUserIds: [],
    status: "pending",
    result: null,
    notes: "",
    createdAt: "",
    createdBy: "system",
    updatedAt: "",
    updatedBy: "system",
    completedAt: null,
    completedBy: null,
    ...overrides,
  };
}

describe("taskVisibility", () => {
  const noSchedules = {
    activeScheduleIds: new Set<string>(),
    existingScheduleIds: new Set<string>(),
  };
  const inactiveSchedule = {
    activeScheduleIds: new Set<string>(),
    existingScheduleIds: new Set(["schedule_1"]),
  };
  const activeSchedule = {
    activeScheduleIds: new Set(["schedule_1"]),
    existingScheduleIds: new Set(["schedule_1"]),
  };

  it("oculta tareas abiertas cuya actualización programada raíz ya no existe", () => {
    expect(isTaskVisibleForOperationalView(task({ status: "failed" }), noSchedules)).toBe(false);
    expect(isTaskVisibleForOperationalView(task({ status: "blocked" }), noSchedules)).toBe(false);
    expect(isTaskVisibleForOperationalView(task({ status: "pending" }), noSchedules)).toBe(false);
  });

  it("oculta tareas abiertas cuando la actualización programada raíz existe pero está inactiva", () => {
    expect(isTaskVisibleForOperationalView(task({ status: "failed" }), inactiveSchedule)).toBe(false);
    expect(isTaskVisibleForOperationalView(task({ status: "pending" }), inactiveSchedule)).toBe(false);
  });

  it("mantiene tareas abiertas cuando la actualización programada raíz está activa", () => {
    expect(isTaskVisibleForOperationalView(task({ status: "failed" }), activeSchedule)).toBe(true);
  });

  it("oculta completadas si la actualización programada raíz ya no existe", () => {
    expect(isTaskVisibleForOperationalView(task({ status: "completed" }), noSchedules)).toBe(false);
  });

  it("preserva completadas como historial si la actualización programada todavía existe", () => {
    expect(isTaskVisibleForOperationalView(task({ status: "completed" }), inactiveSchedule)).toBe(true);
  });

  it("filtra mezcla de tareas huérfanas y activas", () => {
    const visible = filterTasksForOperationalView([
      task({ id: "orphan", status: "failed", rootScheduleId: "missing_schedule" }),
      task({ id: "active", status: "pending", rootScheduleId: "schedule_1" }),
      task({ id: "done", status: "completed", rootScheduleId: "missing_schedule" }),
      task({ id: "done_with_schedule", status: "completed", rootScheduleId: "schedule_1" }),
    ], activeSchedule);
    expect(visible.map((item) => item.id)).toEqual(["active", "done_with_schedule"]);
  });
});
