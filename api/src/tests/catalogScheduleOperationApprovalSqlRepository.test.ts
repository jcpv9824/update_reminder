import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ query: vi.fn(), input: vi.fn(), pool: vi.fn() }));
vi.mock("../lib/sql", () => ({ getSqlPool: mock.pool }));
import { isCatalogScheduleOperationId, readSqlCatalogScheduleOperationApprovals } from "../lib/catalogScheduleOperationApprovalSqlRepository";

const schedule = { scheduleId: "schedule-1", scheduleVersion: "0000000000000001" };
const approved = { ...schedule, operationId: "release:SAG_5.2" };

beforeEach(() => {
  vi.clearAllMocks();
  mock.pool.mockResolvedValue({ request: () => ({ input: mock.input, query: mock.query }) });
  mock.input.mockReturnValue({ input: mock.input, query: mock.query });
  mock.query.mockResolvedValue({ recordset: [approved] });
});

describe("schedule operation approval authority", () => {
  it("binds only the exact schedule versions and environment; missing approvals stay absent", async () => {
    const missing = { scheduleId: "schedule-2", scheduleVersion: "0000000000000002" };
    const result = await readSqlCatalogScheduleOperationApprovals("qa", [schedule, missing]);
    expect(result).toEqual(new Map([[schedule.scheduleId, { scheduleVersion: schedule.scheduleVersion, operationId: approved.operationId }]]));
    expect(mock.input.mock.calls.map(([name, , value]) => [name, value])).toEqual([
      ["portalEnvironment", "qa"],
      ["expectedSchedules", JSON.stringify([{ id: schedule.scheduleId, version: schedule.scheduleVersion },
        { id: missing.scheduleId, version: missing.scheduleVersion }])],
    ]);
    const statement = mock.query.mock.calls[0][0];
    expect(statement).toContain("a.schedule_version=s.row_version");
    expect(statement).toContain("a.portal_environment=@portalEnvironment AND a.retired_at IS NULL");
    expect(statement).toContain("a.approved_at<=SYSUTCDATETIME()");
    expect(statement).toContain("s.active=1 AND s.deleted_at IS NULL");
  });

  it.each([{ roster: [] }, { roster: [schedule, schedule] }, { roster: [{ ...schedule, scheduleVersion: "000000000000001\n" }] }])(
    "does not reach SQL for an empty or invalid roster", async ({ roster }) => {
      if (roster.length) {
        await expect(readSqlCatalogScheduleOperationApprovals("qa", roster)).rejects.toThrow("catalog_schedule_operation_approval_unavailable");
      } else expect(await readSqlCatalogScheduleOperationApprovals("qa", roster)).toEqual(new Map());
      expect(mock.pool).not.toHaveBeenCalled();
    },
  );

  it.each([
    { recordset: [{ ...approved, scheduleVersion: "0000000000000002" }] },
    { recordset: [{ ...approved, scheduleId: "SCHEDULE-1" }] },
    { recordset: [{ ...approved, operationId: "operation involves spaces" }] },
    { recordset: [approved, approved] },
  ])("rejects invalid or unexpected database approvals", async ({ recordset }) => {
    mock.query.mockResolvedValue({ recordset });
    await expect(readSqlCatalogScheduleOperationApprovals("qa", [schedule])).rejects.toThrow("catalog_schedule_operation_approval_unavailable");
  });

  it("operation IDs are opaque case-sensitive tokens, not customer data or display labels", () => {
    expect(isCatalogScheduleOperationId("R:1.0_demo-hotfix")).toBe(true);
    for (const invalid of ["", "-first", "workspace/operation", "release\n", "a".repeat(201)]) {
      expect(isCatalogScheduleOperationId(invalid)).toBe(false);
    }
  });
});
