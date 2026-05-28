import { describe, expect, it } from "vitest";
import { markTaskCancelledForOneTimeReschedule, shouldCancelTaskForOneTimeReschedule } from "../lib/scheduleReschedule";
import type { UpdateSchedule, UpdateTask } from "../types/models";

const before: UpdateSchedule = {
  id: "schedule_once",
  clientId: "client_1",
  clientName: "Cliente",
  targetType: "domain",
  targetIds: ["domain_1"],
  frequencyType: "once",
  startDate: "2026-05-27",
  timezone: "America/Bogota",
  assignedRole: "domain_updater",
  assignedUserIds: [],
  active: true,
  createdAt: "",
  createdBy: "",
  updatedAt: "",
  updatedBy: "",
};

const after: UpdateSchedule = {
  ...before,
  startDate: "2026-05-28",
};

function task(overrides: Partial<UpdateTask> = {}): UpdateTask {
  return {
    id: "task_1",
    taskDate: "2026-05-27",
    taskBucket: "2026-05-27_domain",
    clientId: "client_1",
    clientName: "Cliente",
    domainId: "domain_1",
    domainName: "cliente.sagerp.cloud",
    targetType: "domain",
    targetId: "domain_1",
    targetName: "cliente.sagerp.cloud",
    scheduleId: "schedule_once__domain_domain_1",
    sources: [{ scheduleId: "schedule_once__domain_domain_1", scheduleType: "special", createdAt: "2026-05-27T08:00:00Z" }],
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

describe("reprogramación de programación única", () => {
  it("cancela tareas abiertas de la fecha anterior asociadas a la programación", () => {
    expect(shouldCancelTaskForOneTimeReschedule(task(), before, after)).toBe(true);
    expect(shouldCancelTaskForOneTimeReschedule(task({ status: "blocked" }), before, after)).toBe(true);
    expect(shouldCancelTaskForOneTimeReschedule(task({ status: "in_progress" }), before, after)).toBe(true);
  });

  it("no cancela tareas completadas, canceladas, de otra fecha o de otra programación", () => {
    expect(shouldCancelTaskForOneTimeReschedule(task({ status: "completed" }), before, after)).toBe(false);
    expect(shouldCancelTaskForOneTimeReschedule(task({ status: "cancelled" }), before, after)).toBe(false);
    expect(shouldCancelTaskForOneTimeReschedule(task({ taskDate: "2026-05-28" }), before, after)).toBe(false);
    expect(shouldCancelTaskForOneTimeReschedule(task({ scheduleId: "otra_programacion", sources: [] }), before, after)).toBe(false);
  });

  it("no cancela si la programación única ya estaba cerrada o si la fecha no cambió", () => {
    expect(shouldCancelTaskForOneTimeReschedule(task(), { ...before, active: false }, after)).toBe(false);
    expect(shouldCancelTaskForOneTimeReschedule(task(), { ...before, completedAt: "2026-05-27T12:00:00Z" }, after)).toBe(false);
    expect(shouldCancelTaskForOneTimeReschedule(task(), before, { ...before })).toBe(false);
  });

  it("marca la tarea vieja como obsoleta sin borrar historial", () => {
    const updated = markTaskCancelledForOneTimeReschedule(
      task({ notes: "Nota previa." }),
      before,
      after,
      "user_1",
      "2026-05-28T09:00:00Z"
    );
    expect(updated.status).toBe("cancelled");
    expect(updated.result).toBe("obsolete");
    expect(updated.updatedBy).toBe("user_1");
    expect(updated.updatedAt).toBe("2026-05-28T09:00:00Z");
    expect(updated.notes).toContain("Nota previa.");
    expect(updated.notes).toContain("se reprogramó de 2026-05-27 a 2026-05-28");
  });
});
