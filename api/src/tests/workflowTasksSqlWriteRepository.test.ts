import { describe, expect, it } from "vitest";
import { buildSqlTaskTransition } from "../lib/workflowTasksSqlWriteRepository";
import type { UpdateTask } from "../types/models";

const task = {
  id: "task-1", taskDate: "2026-07-22", taskBucket: "2026-07", clientId: "client-1",
  clientName: "Cliente", domainId: "domain-1", domainName: "https://example.test",
  targetType: "domain", targetId: "domain-1", targetName: "https://example.test",
  scheduleId: "schedule-1", assignedRole: "domain_updater", assignedUserIds: [], status: "pending",
  notes: "", createdAt: "2026-07-22T10:00:00.000Z", createdBy: "system",
  updatedAt: "2026-07-22T10:00:00.000Z", updatedBy: "system",
} as UpdateTask;

describe("Workflow task SQL write contract", () => {
  it("requires a blocking reason and records the immutable transition fields", () => {
    expect(() => buildSqlTaskTransition(task, "blocked", "task_blocked", {}, "user-1",
      new Date("2026-07-22T20:00:00.000Z"))).toThrow(/motivo/i);

    const blocked = buildSqlTaskTransition(task, "blocked", "task_blocked", { blockReason: " Esperando acceso " },
      "user-1", new Date("2026-07-22T20:00:00.000Z"));
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockReason).toBe("Esperando acceso");
    expect(blocked.problemNote).toBe("Esperando acceso");
    expect(blocked.blockedBy).toBe("user-1");
  });

  it("records successful and problem completions without losing the prior task identity", () => {
    const completed = buildSqlTaskTransition(task, "completed", "task_completed", {
      withProblems: true, completionNote: "Terminó", problemNote: "Advertencia", result: "ok",
    }, "user-2", new Date("2026-07-22T21:00:00.000Z"));
    expect(completed).toEqual(expect.objectContaining({
      id: "task-1", status: "completed", completedBy: "user-2", completedWithProblems: true,
      completionNote: "Terminó", problemNote: "Advertencia", result: "ok",
    }));
  });

  it("preserves block history when resolving and clears the completion problem flag when reopening", () => {
    const previouslyBlocked = { ...task, status: "blocked", blockReason: "Acceso", completedWithProblems: true } as UpdateTask;
    const resolved = buildSqlTaskTransition(previouslyBlocked, "in_progress", "task_block_resolved", {
      resolutionComment: "Acceso entregado",
    }, "user-3", new Date("2026-07-22T22:00:00.000Z"));
    expect(resolved.blockReason).toBe("Acceso");
    expect(resolved.resolutionComment).toBe("Acceso entregado");

    const reopened = buildSqlTaskTransition({ ...task, status: "completed", completedWithProblems: true }, "pending",
      "task_reopened", { reopenReason: "Reprocesar" }, "user-3", new Date("2026-07-22T23:00:00.000Z"));
    expect(reopened.completedWithProblems).toBe(false);
    expect(reopened.reopenReason).toBe("Reprocesar");
  });
});
