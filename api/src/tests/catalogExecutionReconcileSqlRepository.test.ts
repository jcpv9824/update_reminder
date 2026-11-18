import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistCatalogTaskCutoffCheck } from "../lib/catalogExecutionReconcileSqlRepository";
import type { CatalogExecutionSnapshot } from "../lib/catalogExecutionSqlRepository";

const mocks = vi.hoisted(() => ({
  parameters: new Map<string, unknown>(), query: vi.fn(), transaction: vi.fn(),
}));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: mocks.transaction }));
vi.mock("mssql", () => ({
  default: {
    Request: class {
      input(name: string, _type: unknown, value: unknown) { mocks.parameters.set(name, value); return this; }
      query(text: string) { return mocks.query(text); }
    },
    VarBinary: () => null, DateTime2: () => null, NVarChar: () => null, Bit: "bit", MAX: -1,
  },
}));

const cutoff = Date.parse("2026-11-17T15:00:00.000Z");
const fixture: CatalogExecutionSnapshot = {
  executionKey: "8a".repeat(32), taskId: "physical-task", workflowStatus: "pending",
  kind: "database", operationId: "release-42", initialCatalogRevisionId: "revision-1", etag: "0000000000000001",
  occurrence: { occurrenceId: "once", targetId: "target", cutoffAt: cutoff, state: "open",
    links: [{ linkId: "l1", state: "active" }, { linkId: "l2", state: "active" }] },
  links: ["l1", "l2"].map((linkId, i) => ({
    linkId, clientId: `client-${i}`, domainId: `domain-${i}`, databaseId: `db-${i}`,
    catalogSourceId: null, catalogRecordId: `record-${i}`, environment: "production",
    state: "active", reason: null, lastEvidenceAt: null, retiredAt: null, schedules: [],
    etag: `000000000000000${i + 2}`,
  })),
};

function dataFor(name: string) { return JSON.parse(String(mocks.parameters.get(name))); }

describe("catalog cutoff reconciliation SQL write", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.parameters.clear();
    mocks.transaction.mockImplementation(async (run) => run({}));
    mocks.query.mockResolvedValue({ recordset: [{ status: "updated" }] });
  });

  it("hides an unreadable logical link before cutoff without touching its scheduled task", async () => {
    const checkedAt = cutoff - 10;
    expect(await persistCatalogTaskCutoffCheck({ snapshot: fixture, checkedAt, observations: [
      { linkId: "l1", observedAt: cutoff - 20, status: "verified", targetId: "target", validUntil: cutoff },
      { linkId: "l2", observedAt: cutoff - 20, status: "unverifiable" },
    ] })).toBe("updated");
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.parameters.get("atCutoff")).toBe(false);
    expect(mocks.parameters.get("retired")).toBe(false);
    expect(mocks.parameters.get("expectedExecutionVersion")).toEqual(Buffer.from(fixture.etag, "hex"));
    expect(dataFor("rows")).toMatchObject([
      { linkId: "l1", expected: "0000000000000002", state: "active" },
      { linkId: "l2", expected: "0000000000000003", state: "hidden", reason: "unverifiable" },
    ]);
    expect(dataFor("events")).toEqual([{ type: "hidden", linkId: "l2", reason: "unverifiable" }]);
    const sqlText: string = mocks.query.mock.calls[0][0];
    expect(sqlText).toContain("links.row_version<>wanted.expected");
    expect(sqlText).toContain("t.status NOT IN ('completed','cancelled')");
    expect(sqlText).toContain("INSERT INTO workflow.catalog_task_execution_events");
    expect(sqlText).not.toMatch(/\b(?:DELETE|UPDATE)\s+(?:workflow\.update_tasks|scheduling\.)/i);
  });

  it("retires only the unverified link at cutoff, ignoring recovery after the original cutoff", async () => {
    expect(await persistCatalogTaskCutoffCheck({ snapshot: fixture, checkedAt: cutoff + 10, observations: [
      { linkId: "l1", observedAt: cutoff - 5, status: "verified", targetId: "target", validUntil: cutoff },
      { linkId: "l2", observedAt: cutoff + 2, status: "verified", targetId: "target", validUntil: cutoff + 10 },
    ] })).toBe("updated");
    expect(mocks.parameters.get("retired")).toBe(false);
    expect(dataFor("events")).toEqual([
      { type: "link_retired", linkId: "l2", reason: "unverifiable" },
      { type: "cutoff_checked", linkId: null, reason: null },
    ]);
  });

  it("retires the whole occurrence only when all links fail and a concurrent mutation wins cleanly", async () => {
    mocks.query.mockResolvedValueOnce({ recordset: [{ status: "superseded" }] });
    expect(await persistCatalogTaskCutoffCheck({ snapshot: fixture, checkedAt: cutoff, observations: [] })).toBe("superseded");
    expect(mocks.parameters.get("retired")).toBe(true);
    expect(dataFor("events")).toContainEqual({ type: "occurrence_retired", linkId: null, reason: null });
    expect(mocks.query.mock.calls[0][0]).toContain("WITH (UPDLOCK,HOLDLOCK)");
  });

  it("leaves closed, already evaluated and future-checked occurrences alone", async () => {
    for (const changes of [{ state: "completed" as const }, { cutoffEvaluatedAt: cutoff }, { lastCheckedAt: cutoff + 50 }]) {
      expect(await persistCatalogTaskCutoffCheck({ snapshot: { ...fixture, occurrence: { ...fixture.occurrence, ...changes } },
        checkedAt: cutoff + 5, observations: [] })).toBe("unchanged");
    }
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
