import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapSqlWorkflowTask, normalizedLogicalTaskCount, readSqlWorkflowTasks } from "../lib/workflowTasksSqlRepository";
import type { UpdateTask } from "../types/models";
import { toPublicTask } from "../lib/publicDtos";

const at = new Date("2026-07-21T12:00:00.000Z");
const mock = vi.hoisted(() => ({ query: vi.fn(), input: vi.fn() }));
vi.mock("../lib/sql", () => ({ getSqlPool: async () => ({ request: () => mock }) }));

describe("Workflow tasks SQL mapping", () => {
  it("reconstructs a consolidated task without exposing normalized internals in the public DTO layer", () => {
    const row: Parameters<typeof mapSqlWorkflowTask>[0] = {
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
    };
    const task = mapSqlWorkflowTask(row);

    expect(task).toMatchObject({
      id: "task-1", targetId: "db-1", scheduleId: "schedule-1", rootScheduleId: "schedule-1",
      assignedUserIds: ["user-1", "user-2"], status: "blocked", blockReason: "Requiere revisión",
      sources: [{ scheduleId: "schedule-1", scheduleType: "special" }, { scheduleId: "schedule-2", scheduleType: "licensing" }],
    });
    expect(toPublicTask(task)).not.toHaveProperty("catalogPlannedOnly");
    expect(toPublicTask(task)).not.toHaveProperty("displayScheduleId");
    expect(toPublicTask(mapSqlWorkflowTask({ ...row, catalog_planned_only: true }))).toHaveProperty("catalogPlannedOnly", true);
    const copyRemains = toPublicTask(mapSqlWorkflowTask({ ...row, display_schedule_source_id: "schedule-2" }));
    expect(copyRemains).toMatchObject({ scheduleId: "schedule-1", rootScheduleId: "schedule-1", displayScheduleId: "schedule-2" });
    expect(copyRemains).not.toHaveProperty("sources");
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
  afterEach(() => vi.unstubAllEnvs());

  it("omits invisible or retired occurrences from the board and direct open-task lookup", async () => {
    await readSqlWorkflowTasks({ today: "2026-11-17" });
    await readSqlWorkflowTasks({ today: "2026-11-17", sourceId: "look-up", operationalOnly: false });
    for (const call of mock.query.mock.calls) {
      expect(call[0]).toContain("task.status='completed' AND (NOT EXISTS");
      expect(call[0]).toContain("OR active_catalog_link.catalog_execution_link_key IS NOT NULL");
      expect(call[0]).toContain("e.retired_at IS NULL");
      expect(call[0]).toContain("link.link_state='active' AND link.retired_at IS NULL");
      expect(call[0].match(/FROM core\.catalog_operational_link_evidence/g)).toHaveLength(1);
    }
  });

  it("keeps in-range future catalog tasks eligible for the board without granting any action", async () => {
    await readSqlWorkflowTasks({ today: "2026-11-17", dateTo: "2026-11-21" });
    const statement: string = mock.query.mock.calls[0][0];
    expect(statement).toContain("OR active_catalog_link.catalog_execution_link_key IS NOT NULL");
    expect(statement).toContain("AS catalog_planned_only");
    expect(statement.split("FROM workflow.update_tasks task").at(-1)).not.toContain("DATEADD(hour,-5,SYSUTCDATETIME())");
  });

  it("keeps the legacy generator from adopting hidden, retired, or active catalog occurrences", async () => {
    await readSqlWorkflowTasks({ today: "2026-11-17", operationalOnly: false, includeCancelled: true, legacyOnly: true });
    expect(mock.query.mock.calls[0][0]).toMatch(/NOT EXISTS \([\s\S]*?catalog_execution\.task_key=task\.task_key\s+\)/);
    expect(mock.query.mock.calls[0][0]).not.toContain("catalog_link.link_state");
  });

  it("discovers aliases by paired filters without changing the canonical actionable projection", async () => {
    await readSqlWorkflowTasks({ today: "2026-11-17", clientId: "visible-client", domainId: "visible-domain" });
    const statement: string = mock.query.mock.calls[0][0];
    expect(statement).toContain("link.link_state='active'");
    expect(statement).toContain("COALESCE(active_catalog_link.target_id,task.target_source_id) AS target_source_id");
    expect(statement).toContain("active_catalog_link.catalog_execution_link_key IS NOT NULL AND active_catalog_link.matches_filters=1");
    expect(statement).toContain("(@clientId IS NULL OR task.client_source_id=@clientId)");
    expect(statement).toContain("(@domainId IS NULL OR task.domain_source_id=@domainId)");
    expect(statement).toMatch(/MAX\(CASE WHEN \(@clientId IS NULL OR client\.source_id=@clientId\)\s+AND \(@domainId IS NULL OR domain_row\.source_id=@domainId\) THEN 1 ELSE 0 END\) OVER \(\) AS matches_filters/);
    expect(statement).toContain("CASE WHEN link.client_key=task.client_key AND link.domain_key=task.domain_key");
    expect(statement).toContain("link.catalog_execution_link_key\n) AS active_catalog_link");
    const projectionOrder = statement.slice(statement.lastIndexOf("ORDER BY CASE WHEN link.client_key"), statement.indexOf(") AS active_catalog_link"));
    expect(projectionOrder).not.toContain("@clientId");
    expect(projectionOrder).not.toContain("@domainId");
    expect(statement.match(/FROM core\.catalog_operational_link_evidence/g)).toHaveLength(1);
  });

  it("projects the primary or stable surviving schedule only from live attachments on the visible link", async () => {
    await readSqlWorkflowTasks({ today: "2026-11-17" });
    const statement: string = mock.query.mock.calls[0][0];
    const projection = statement.slice(statement.indexOf("SELECT TOP (1) schedule.source_id"), statement.indexOf(") AS display_schedule"));
    expect(projection).toContain("FROM workflow.catalog_task_execution_sources attachment");
    expect(projection).toContain("attachment.catalog_execution_link_key=active_catalog_link.catalog_execution_link_key");
    expect(projection).toContain("attachment.detached_at IS NULL AND schedule.deleted_at IS NULL AND schedule.active=1");
    expect(projection).toContain("task.status NOT IN ('completed','cancelled')");
    expect(projection).toMatch(/ORDER BY CASE WHEN schedule\.schedule_key=task\.primary_schedule_key THEN 0 ELSE 1 END,\s+schedule\.schedule_key/);
  });

  it.each([{ clientId: "c" }, { domainId: "d" }, { clientId: "c", domainId: "d" }])("keeps historical and legacy snapshot filters for %j", async filters => {
    await readSqlWorkflowTasks({ today: "2026-11-17", ...filters });
    const statement: string = mock.query.mock.calls[0][0];
    expect(statement).toContain("task.status NOT IN ('completed','cancelled')");
    expect(statement).toContain("task.status IN ('completed','cancelled') OR active_catalog_link.catalog_execution_link_key IS NULL");
    expect(statement).toContain("AND (@clientId IS NULL OR task.client_source_id=@clientId)");
    expect(statement).toContain("AND (@domainId IS NULL OR task.domain_source_id=@domainId)");
  });

  it.each(["qa", "production", " qa "])("binds the trusted explicit environment %j", async value => {
    vi.stubEnv("PORTAL_SAG_ENVIRONMENT", value);
    await readSqlWorkflowTasks({ today: "2026-11-17" });
    expect(mock.input).toHaveBeenCalledWith("portalEnvironment", expect.anything(), value.trim());
    expect(mock.query.mock.calls[0][0]).toContain("DECLARE @now datetime2(3)=SYSUTCDATETIME();");
  });

  it.each([undefined, "", "QA", "unknown"])("fails closed for catalog with environment %j without blocking legacy history", async value => {
    vi.stubEnv("PORTAL_SAG_ENVIRONMENT", value);
    await readSqlWorkflowTasks({ today: "2026-11-17", operationalOnly: false });
    expect(mock.input).toHaveBeenCalledWith("portalEnvironment", expect.anything(), null);
    const statement: string = mock.query.mock.calls[0][0];
    expect(statement).toContain("@portalEnvironment IS NOT NULL AND e.retired_at IS NULL");
    expect(statement).toContain("task.status='completed' AND (NOT EXISTS");
    expect(statement).toContain("catalog_execution.task_key=task.task_key");
  });

  it("keeps completed and cancelled snapshots while evaluating cancelled eligibility", async () => {
    await readSqlWorkflowTasks({ today: "2026-11-17", includeCancelled: true });
    const statement: string = mock.query.mock.calls[0][0];
    expect(statement).toContain("WHERE e.task_key=task.task_key AND task.status<>'completed'");
    expect(statement).toContain("CASE WHEN task.status<>'cancelled' THEN client.source_id END AS client_id");
    expect(statement).toContain("CASE WHEN task.status='cancelled' THEN NULL WHEN task.target_type='database'");
    expect(statement).not.toContain("AND task.status<>'cancelled'");
  });
});
