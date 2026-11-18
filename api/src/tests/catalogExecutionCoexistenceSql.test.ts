import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateTask } from "../types/models";

const mock = vi.hoisted(() => ({ query: vi.fn(), audit: vi.fn(), tx: {} }));
vi.mock("mssql", () => ({ default: {
  Request: class {
    parameters: Record<string, unknown> = {};
    constructor(readonly transaction: object) {}
    input(name: string, _type: unknown, value: unknown) { this.parameters[name] = value; return this; }
    query(query: string) { return mock.query(query, this.parameters, this.transaction); }
  },
  NVarChar: vi.fn(), VarChar: vi.fn(), DateTime2: vi.fn(), Date: Symbol(), BigInt: Symbol(), MAX: Symbol(),
} }));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: (work: (tx: object) => Promise<unknown>) => work(mock.tx) }));
vi.mock("../lib/auditSqlWriter", () => ({ writeSqlAuditLog: mock.audit }));

import { CATALOG_TASK_DAY_LOCK_SQL, LEGACY_CATALOG_COVERAGE_GATE_SQL, LEGACY_CATALOG_COVERAGE_SQL } from "../lib/catalogExecutionCoexistenceSql";
import { createSqlGeneratedTask, syncSqlGeneratedTask } from "../lib/workflowTaskGenerationSqlRepository";

const now = "2030-06-18T00:00:00.000Z";
const task: UpdateTask = { id: "legacy-task", taskDate: "2030-06-18", taskBucket: "database-2030-06-18",
  clientId: "c1", clientName: "Cliente", domainId: "d1", domainName: "Dominio", targetType: "database", targetId: "db2",
  targetName: "Base de datos", scheduleId: "schedule_1", assignedRole: "db_updater", assignedUserIds: [], status: "pending",
  result: null, notes: "", createdAt: now, updatedAt: now, createdBy: "system", updatedBy: "system", completedAt: null, completedBy: null };

const rows = (...sets: object[][]) => { for (const recordset of sets) mock.query.mockResolvedValueOnce({ recordset }); };
beforeEach(() => vi.resetAllMocks());

describe("catalog and legacy execution coexistence", () => {
  it.each([
    ["a non-representative logical database", () => createSqlGeneratedTask(task)],
    ["a hidden or retired logical source", () => syncSqlGeneratedTask(task, "task_obsoleted")],
    ["a catalog-owned public id or alias", () => syncSqlGeneratedTask({ ...task, id: "catalog-owned", targetId: "mismatched" }, "task_assignment_synced")],
  ] as const)("blocks legacy writes to %s under the shared task-day lock", async (_name, action) => {
    rows([{ lockCode: 0 }], [{ covered: true }]);
    await expect(action()).resolves.toBe(false);
    expect(mock.query).toHaveBeenCalledTimes(2);
    expect(mock.query.mock.calls[0]).toEqual([CATALOG_TASK_DAY_LOCK_SQL, { taskDate: task.taskDate, targetType: "database" }, mock.tx]);
    expect(mock.query.mock.calls[1][0]).toBe(LEGACY_CATALOG_COVERAGE_GATE_SQL);
    expect(mock.query.mock.calls[1][1].statement).toBe(LEGACY_CATALOG_COVERAGE_SQL);
    expect(mock.audit).not.toHaveBeenCalled();
  });

  it("queries the actual persisted candidate and every typed link without filtering by lifecycle state", () => {
    expect(LEGACY_CATALOG_COVERAGE_SQL).toContain("owned.source_id=@taskId");
    expect(LEGACY_CATALOG_COVERAGE_SQL).toContain("alias.alias_source_id=@taskId");
    expect(LEGACY_CATALOG_COVERAGE_SQL).toContain("persisted.source_id=@taskId");
    expect(LEGACY_CATALOG_COVERAGE_SQL).toContain("catalog_task.task_date=candidate.task_date");
    expect(LEGACY_CATALOG_COVERAGE_SQL).toContain("db.database_key=link.database_key");
    expect(LEGACY_CATALOG_COVERAGE_SQL).toContain("domain_record.domain_key=link.domain_key");
    expect(LEGACY_CATALOG_COVERAGE_SQL).not.toMatch(/link_state|retired_at|\.status|target_source_id=@targetId/);
    expect(CATALOG_TASK_DAY_LOCK_SQL).toContain("@LockOwner=N'Transaction'");
    expect(LEGACY_CATALOG_COVERAGE_GATE_SQL).toContain("IF @hasExecutions IS NULL AND @hasLinks IS NULL");
    expect(LEGACY_CATALOG_COVERAGE_GATE_SQL).toContain("IF @hasExecutions IS NULL OR @hasLinks IS NULL");
  });

  it("preserves legacy creation when the counterpart does not exist, even if the lock waited", async () => {
    rows([{ lockCode: 1 }], [{ covered: false }], [{ task_key: 12 }], [], [], []);
    await expect(createSqlGeneratedTask(task)).resolves.toBe(true);
    expect(mock.query.mock.calls[2][0]).toContain("INSERT workflow.update_tasks");
    expect(mock.query.mock.calls[5][0]).toContain("INSERT workflow.task_status_history");
    expect(mock.audit).toHaveBeenCalledOnce();
  });

  it("treats missing coverage proof as blocked and lock contention as a controlled conflict", async () => {
    rows([{ lockCode: 0 }], [], [{ lockCode: -1 }]);
    await expect(createSqlGeneratedTask(task)).resolves.toBe(false);
    await expect(syncSqlGeneratedTask(task, "task_obsoleted")).rejects.toMatchObject({ status: 409 });
    expect(mock.query).toHaveBeenCalledTimes(3);
    expect(mock.audit).not.toHaveBeenCalled();
  });
});
