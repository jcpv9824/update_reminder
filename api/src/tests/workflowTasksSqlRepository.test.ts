import { describe, expect, it } from "vitest";
import { mapSqlWorkflowTask, normalizedLogicalTaskCount } from "../lib/workflowTasksSqlRepository";
import type { UpdateTask } from "../types/models";

const at = new Date("2026-07-21T12:00:00.000Z");

describe("Workflow tasks SQL mapping", () => {
  it("reconstructs a consolidated task without exposing normalized internals in the public DTO layer", () => {
    const task = mapSqlWorkflowTask({
      source_id: "task-1", dedupe_key: "database:db-1:2026-07-21", task_date: "2026-07-21",
      task_bucket: "2026-07", client_source_id: "client-1", client_name: "Cliente",
      domain_source_id: "domain-1", domain_name: "https://example.test", target_type: "database",
      target_source_id: "db-1", target_name: "SAG", primary_schedule_source_id: "schedule-1",
      assigned_role: "database_updater", status: "blocked", result: null, notes: "",
      completed_at: null, completed_by: null, completed_with_problems: false,
      problem_note: "Requiere revisión", completion_note: null, blocked_at: at,
      blocked_by: "user-1", block_reason: "Requiere revisión", resolved_at: null,
      resolved_by: null, resolution_comment: null, reopened_at: null, reopened_by: null,
      reopen_reason: null, created_at: at, created_by: "migration", updated_at: at,
      updated_by: "user-1", assignees_json: '[{"id":"user-1"},{"id":"user-2"}]',
      sources_json: '[{"scheduleId":"schedule-1","scheduleType":"special","reason":"primary","createdAt":"2026-07-21T12:00:00.000"},{"scheduleId":"schedule-2","scheduleType":"licensing","reason":null,"createdAt":"2026-07-21T12:01:00.000"}]',
    });

    expect(task).toMatchObject({
      id: "task-1", targetId: "db-1", scheduleId: "schedule-1", rootScheduleId: "schedule-1",
      assignedUserIds: ["user-1", "user-2"], status: "blocked", blockReason: "Requiere revisión",
      sources: [{ scheduleId: "schedule-1", scheduleType: "special" }, { scheduleId: "schedule-2", scheduleType: "licensing" }],
    });
  });

  it("counts consolidated logical target/date identities instead of physical Cosmos aliases", () => {
    const task = { targetType: "database", targetId: "db-1", taskDate: "2026-07-21" } as UpdateTask;
    expect(normalizedLogicalTaskCount([
      { ...task, id: "task-1" },
      { ...task, id: "task-alias" },
      { ...task, id: "task-2", taskDate: "2026-07-22" },
    ])).toBe(2);
  });
});
