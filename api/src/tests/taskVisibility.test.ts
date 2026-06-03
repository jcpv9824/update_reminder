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
  it("oculta tareas abiertas cuya actualización programada raíz ya no está activa", () => {
    const active = new Set<string>();
    expect(isTaskVisibleForOperationalView(task({ status: "failed" }), active)).toBe(false);
    expect(isTaskVisibleForOperationalView(task({ status: "blocked" }), active)).toBe(false);
    expect(isTaskVisibleForOperationalView(task({ status: "pending" }), active)).toBe(false);
  });

  it("mantiene tareas abiertas cuando la actualización programada raíz está activa", () => {
    const active = new Set(["schedule_1"]);
    expect(isTaskVisibleForOperationalView(task({ status: "failed" }), active)).toBe(true);
  });

  it("preserva completadas como historial aunque la actualización programada ya no exista", () => {
    const active = new Set<string>();
    expect(isTaskVisibleForOperationalView(task({ status: "completed" }), active)).toBe(true);
  });

  it("filtra mezcla de tareas huérfanas y activas", () => {
    const visible = filterTasksForOperationalView([
      task({ id: "orphan", status: "failed", rootScheduleId: "missing_schedule" }),
      task({ id: "active", status: "pending", rootScheduleId: "schedule_1" }),
      task({ id: "done", status: "completed", rootScheduleId: "missing_schedule" }),
    ], new Set(["schedule_1"]));
    expect(visible.map((item) => item.id)).toEqual(["active", "done"]);
  });
});
