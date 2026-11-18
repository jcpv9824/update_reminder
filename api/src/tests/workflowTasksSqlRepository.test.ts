import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapSqlWorkflowTask, normalizedLogicalTaskCount, readSqlWorkflowTasks } from "../lib/workflowTasksSqlRepository";
import type { UpdateTask } from "../types/models";

const at = new Date("2026-07-21T12:00:00.000Z");
const mock = vi.hoisted(() => ({ query: vi.fn(), input: vi.fn() }));
vi.mock("../lib/sql", () => ({ getSqlPool: async () => ({ request: () => mock }) }));

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

  it("counts consolidated logical target/date identities instead of physical aliases", () => {
    const task = { targetType: "database", targetId: "db-1", taskDate: "2026-07-21" } as UpdateTask;
    expect(normalizedLogicalTaskCount([
      { ...task, id: "task-1" },
      { ...task, id: "task-alias" },
      { ...task, id: "task-2", taskDate: "2026-07-22" },
    ])).toBe(2);
  });
});

describe("current task SQL visibility", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.query.mockResolvedValue({ recordset: [] });
  });

  it("omits invisible or retired occurrences from the board and direct open-task lookup", async () => {
    await readSqlWorkflowTasks({ today: "2026-11-17" });
    await readSqlWorkflowTasks({ today: "2026-11-17", sourceId: "look-up", operationalOnly: false });
    for (const call of mock.query.mock.calls) {
      expect(call[0]).toContain("task.status='completed' OR NOT EXISTS");
      expect(call[0]).toContain("catalog_execution.retired_at IS NOT NULL");
      expect(call[0]).toContain("catalog_link.link_state='active'");
    }
  });

  it("keeps the legacy generator from adopting hidden, retired, or active catalog occurrences", async () => {
    await readSqlWorkflowTasks({ today: "2026-11-17", operationalOnly: false, includeCancelled: true, legacyOnly: true });
    expect(mock.query.mock.calls[0][0]).toMatch(/NOT EXISTS \([\s\S]*?catalog_execution\.task_key=task\.task_key\s+\)/);
    expect(mock.query.mock.calls[0][0]).not.toContain("catalog_link.link_state");
  });

  it("projects an active alternate link and matches client/domain filters on that projection", async () => {
    await readSqlWorkflowTasks({ today: "2026-11-17", clientId: "visible-client", domainId: "visible-domain" });
    const statement: string = mock.query.mock.calls[0][0];
    expect(statement).toContain("link.link_state='active'");
    expect(statement).toContain("COALESCE(active_catalog_link.target_id,task.target_source_id) AS target_source_id");
    expect(statement).toContain("COALESCE(active_catalog_link.client_id,task.client_source_id)=@clientId");
    expect(statement).toContain("COALESCE(active_catalog_link.domain_id,task.domain_source_id)=@domainId");
  });
});
