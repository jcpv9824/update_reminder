import { describe, expect, it, vi } from "vitest";
import { updateSqlSchedule } from "../lib/schedulingSqlWriteRepository";
import type { UpdateSchedule } from "../types/models";

const gate = vi.hoisted(() => ({ run: vi.fn(), query: vi.fn(), audit: vi.fn(), cancel: vi.fn() }));
vi.mock("mssql", () => ({
  default: {
    NVarChar: vi.fn(), BigInt: {},
    Request: class {
      input() { return this; }
      query = gate.query;
    },
  },
}));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: gate.run }));
vi.mock("../lib/auditSqlWriter", () => ({ writeSqlAuditLog: gate.audit }));
vi.mock("../lib/workflowTaskCleanupSqlRepository", () => ({ cancelOpenSqlTasksForSchedule: gate.cancel }));

const actor = { id: "user", email: "user@example.invalid" };
const before = {
  id: "existing-schedule", clientId: "legacy-client", startDate: "2099-01-03", frequencyType: "once",
} as UpdateSchedule;
const after = { ...before, clientId: "another-client", startDate: "2099-01-04" };

function setup(recordset: { enrolled: boolean }[]) {
  vi.resetAllMocks();
  const input = vi.fn().mockReturnThis();
  const enrollmentQuery = vi.fn().mockResolvedValue({ recordset });
  gate.run.mockImplementation(async work => work({ request: () => ({ input, query: enrollmentQuery }) }));
  gate.query.mockResolvedValueOnce({ recordset: [{ schedule_key: 42 }] });
  return { input, enrollmentQuery };
}

describe("legacy schedule update catalog enrollment guard", () => {
  it("rejects an enrolled future row regardless of source ID and before resolving an owner or cancelling tasks", async () => {
    const { input, enrollmentQuery } = setup([{ enrolled: true }]);
    await expect(updateSqlSchedule(before, after, actor)).rejects.toMatchObject({ status: 409 });
    expect(gate.query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("WITH (UPDLOCK,HOLDLOCK)"));
    expect(input).toHaveBeenCalledWith("scheduleKey", expect.anything(), 42);
    expect(enrollmentQuery).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("s.catalog_activation_enabled AS enrolled"));
    expect(gate.cancel).not.toHaveBeenCalled();
    expect(gate.audit).not.toHaveBeenCalled();
  });

  it("permits an unenrolled row with a catalog-like source ID to proceed through existing legacy validation", async () => {
    setup([{ enrolled: false }]);
    gate.query.mockResolvedValueOnce({ recordset: [] });
    await expect(updateSqlSchedule({ ...before, id: "catalog-draft-example" }, after, actor)).rejects.toMatchObject({ status: 400 });
    expect(gate.query).toHaveBeenLastCalledWith(expect.stringContaining("FROM core.clients"));
    expect(gate.cancel).not.toHaveBeenCalled();
  });
});
