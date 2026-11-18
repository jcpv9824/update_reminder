import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSqlTaskStatusHistoryMetadata, buildSqlTaskTransition, changeSqlWorkflowTaskStatus } from "../lib/workflowTasksSqlWriteRepository";
import type { UpdateTask } from "../types/models";

const io = vi.hoisted(() => ({ input: vi.fn(), query: vi.fn(), audit: vi.fn() }));
vi.mock("mssql", async importOriginal => {
  const actual = await importOriginal<typeof import("mssql")>();
  return { ...actual, default: { ...actual.default, Request: class {
    input = io.input;
    query = io.query;
  } } };
});
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: (work: (tx: object) => unknown) => work({}) }));
vi.mock("../lib/auditSqlWriter", () => ({ writeSqlAuditLog: io.audit }));

const task = {
  id: "task-1", taskDate: "2026-07-22", taskBucket: "2026-07", clientId: "client-1",
  clientName: "Cliente", domainId: "domain-1", domainName: "https://example.test",
  targetType: "domain", targetId: "domain-1", targetName: "https://example.test",
  scheduleId: "schedule-1", assignedRole: "domain_updater", assignedUserIds: [], status: "pending",
  notes: "", createdAt: "2026-07-22T10:00:00.000Z", createdBy: "system",
  updatedAt: "2026-07-22T10:00:00.000Z", updatedBy: "system",
} as UpdateTask;

describe("Workflow task SQL write contract", () => {
  beforeEach(() => { vi.resetAllMocks(); io.query.mockResolvedValue({ recordset: [] }); });
  afterEach(() => vi.unstubAllEnvs());

  it.each(["qa", "production", undefined, "", "QA"])("binds environment %j and refuses a task lacking an eligible stored representative", async env => {
    vi.stubEnv("PORTAL_SAG_ENVIRONMENT", env);
    expect(await changeSqlWorkflowTaskStatus("task-1", "completed", "task_completed", {}, {
      id: "actor", email: "actor@example.test",
    })).toBeNull();
    expect(io.input).toHaveBeenCalledWith("portalEnvironment", expect.anything(), env === "qa" || env === "production" ? env : null);
    expect(io.query).toHaveBeenCalledTimes(1);
    expect(io.audit).not.toHaveBeenCalled();
    const statement = io.query.mock.calls[0][0];
    expect(statement).toContain("DECLARE @now datetime2(3)=SYSUTCDATETIME();");
    expect(statement).toContain("WITH (UPDLOCK,HOLDLOCK)");
    expect(statement).toContain("@portalEnvironment IS NOT NULL AND catalog_execution.retired_at IS NULL");
    expect(statement).toContain("catalog_link.client_key=task.client_key");
    expect(statement).toContain("catalog_link.domain_key=task.domain_key");
    expect(statement).toContain("task.target_type='domain' OR catalog_link.database_key=task.database_key");
    expect(statement).not.toContain("active_catalog_link");
  });

  it("rechecks eligibility at the actual UPDATE and makes no downstream writes when evidence expired", async () => {
    vi.stubEnv("PORTAL_SAG_ENVIRONMENT", "qa");
    io.query.mockResolvedValueOnce({ recordset: [{
      source_id: task.id, task_date: task.taskDate, task_bucket: task.taskBucket,
      client_source_id: task.clientId, domain_source_id: task.domainId, target_type: task.targetType,
      target_source_id: task.targetId, status: task.status, assigned_role: task.assignedRole,
      created_at: new Date(task.createdAt), updated_at: new Date(task.updatedAt),
      assignees_json: "[]", sources_json: "[]",
    }] }).mockResolvedValueOnce({ recordset: [{ changed: 0 }] });
    expect(await changeSqlWorkflowTaskStatus(task.id, "completed", "task_completed", {}, {
      id: "actor", email: "actor@example.test",
    })).toBeNull();
    expect(io.query).toHaveBeenCalledTimes(2);
    expect(io.audit).not.toHaveBeenCalled();
    const statement: string = io.query.mock.calls[1][0];
    expect(statement).toContain("DECLARE @now datetime2(3)=SYSUTCDATETIME();");
    expect(statement).toContain("UPDATE task");
    expect(statement).toContain("FROM workflow.update_tasks AS task");
    expect(statement).toContain("catalog_link.client_key=task.client_key");
    expect(statement).toContain("catalog_link.domain_key=task.domain_key");
    expect(statement).toContain("catalog_execution.cutoff_at>@now OR catalog_execution.cutoff_evaluated_at IS NOT NULL");
    expect(statement).toContain("current_bridge.verified_until>@now");
    expect(statement).toContain("current_physical.valid_until>@now");
    expect(statement).toContain("updated_at=@updatedAt");
    expect(statement).toContain("SELECT @@ROWCOUNT AS changed;");
    expect(io.input).toHaveBeenCalledWith("updatedAt", expect.anything(), expect.any(Date));
    expect(io.input).not.toHaveBeenCalledWith("now", expect.anything(), expect.anything());
    expect(io.input.mock.calls.filter(([name]) => name === "portalEnvironment")).toHaveLength(2);
  });

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

  it("does not certify inherited success when a reopened task is completed without a new result", () => {
    const initial = buildSqlTaskTransition(task, "completed", "task_completed", { result: "success" }, "u",
      new Date("2026-07-22T21:00:00.000Z"));
    const reopened = buildSqlTaskTransition(initial, "pending", "task_reopened", {}, "u",
      new Date("2026-07-22T22:00:00.000Z"));
    const later = buildSqlTaskTransition(reopened, "completed", "task_completed", {}, "u",
      new Date("2026-07-22T23:00:00.000Z"));
    expect(later.result).toBe("success");
    expect(buildSqlTaskStatusHistoryMetadata(reopened.status, later.status, "task_completed", {}))
      .toEqual({ previousStatus: "pending", newStatus: "completed" });
    expect(buildSqlTaskStatusHistoryMetadata(reopened.status, later.status, "task_completed", { result: "success" }))
      .toEqual({ previousStatus: "pending", newStatus: "completed", explicitCompletionSuccess: true });
    expect(buildSqlTaskStatusHistoryMetadata(reopened.status, later.status, "task_completed", { result: "success", withProblems: true }))
      .not.toHaveProperty("explicitCompletionSuccess");
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
