import { beforeEach, describe, expect, it, vi } from "vitest";
import { readCatalogTaskExecution, readCatalogTaskExecutionHistory } from "../lib/catalogExecutionSqlRepository";

const mocks = vi.hoisted(() => {
  const input = vi.fn();
  const query = vi.fn();
  const request = { input, query };
  input.mockReturnValue(request);
  return { input, query, getSqlPool: vi.fn(async () => ({ request: () => request })) };
});

vi.mock("../lib/sql", () => ({ getSqlPool: mocks.getSqlPool }));
vi.mock("mssql", () => ({
  default: { VarBinary: (n: number) => ["varbinary", n], NVarChar: (n: number) => ["nvarchar", n],
    VarChar: (n: number) => ["varchar", n], Int: "int" },
}));

const key = "4a".repeat(32);

describe("catalog execution SQL read repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockReset();
  });

  it("returns both provenances without losing cutoff evidence, reasons or integer precision", async () => {
    const link = {
      linkId: "route-db", clientId: "client-one", domainId: "domain-one", databaseId: "db-one",
      catalogSourceId: null, catalogRecordId: "record-one", environment: "production",
      state: "active", reason: null, lastEvidenceAt: 1763359010000, retiredAt: null,
      schedules: [{ scheduleId: "schedule-one", attachedAt: 1763359000000, detachedAt: null }],
      etag: "0000000000000002",
    };
    mocks.query.mockResolvedValue({
      recordset: [{
        execution_key_hex: key, task_id: "task-one", workflow_status: "pending", execution_kind: "database",
        operation_id: "release-one", initial_catalog_revision_id: "catalog-one",
        occurrence_id: "date-one", verified_target_id: "destination-one",
        cutoff_ms: "1763359011000", last_checked_ms: "1763359010000", cutoff_evaluated_ms: null, retired_ms: null,
        etag: "0000000000000001",
        links_json: JSON.stringify([
          link, { ...link, linkId: "route-db-2", clientId: "client-two", domainId: "domain-two",
            databaseId: "db-two", state: "hidden", reason: "unverifiable" },
        ]),
      }],
    });
    const result = await readCatalogTaskExecution({ executionKey: key });
    expect(result?.occurrence).toMatchObject({
      occurrenceId: "date-one", cutoffAt: 1763359011000, lastCheckedAt: 1763359010000, state: "open",
      links: [{ linkId: "route-db", state: "active", lastEvidenceAt: 1763359010000 },
        { linkId: "route-db-2", state: "hidden", reason: "unverifiable", lastEvidenceAt: 1763359010000 }],
    });
    expect(result?.links.map(route => [route.clientId, route.domainId, route.databaseId])).toEqual([
      ["client-one", "domain-one", "db-one"], ["client-two", "domain-two", "db-two"],
    ]);
    expect(result?.links[0].schedules).toEqual(link.schedules);
    expect(mocks.input).toHaveBeenCalledWith("executionKey", ["varbinary", 32], Buffer.from(key, "hex"));
    expect(mocks.query.mock.calls[0][0].trim()).toMatch(/^SELECT\b/);
  });

  it("parameterizes the exact workflow task ID and does not create a missing execution", async () => {
    mocks.query.mockResolvedValue({ recordset: [] });
    expect(await readCatalogTaskExecution({ taskId: "task:test/one" })).toBeNull();
    expect(mocks.input).toHaveBeenCalledWith("taskId", ["nvarchar", 260], "task:test/one");
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][0]).toContain("WHERE task.source_id=@taskId");
  });

  it("pages immutable history by decimal bigint cursor without rounding it in JavaScript", async () => {
    const knownCursor = "9007199254740991";
    const returnedKey = "9007199254740993";
    mocks.query.mockResolvedValue({
      recordset: [
        { event_key: returnedKey, link_id: "route-db-2", event_kind: "hidden",
          event_reason: "unverifiable", occurred_ms: "1763359010000" },
        { event_key: "9007199254740994", link_id: null, event_kind: "registered",
          event_reason: null, occurred_ms: "1763359010001" },
      ],
    });
    const result = await readCatalogTaskExecutionHistory({ executionKey: key, afterEventKey: knownCursor, limit: 1 });
    expect(mocks.input).toHaveBeenCalledWith("afterEventKey", ["varchar", 19], knownCursor);
    expect(mocks.input).toHaveBeenCalledWith("take", "int", 2);
    expect(mocks.query.mock.calls[0][0].trim()).toMatch(/^SELECT\b/);
    expect(result).toEqual({
      events: [{ eventKey: returnedKey, linkId: "route-db-2", kind: "hidden",
        reason: "unverifiable", occurredAt: 1763359010000 }],
      nextEventKey: returnedKey,
    });
  });

  it("rejects malformed identifiers, unbounded pages and excessive cursors before opening a pool", async () => {
    await expect(readCatalogTaskExecution({ executionKey: "xyz" })).rejects.toThrow();
    await expect(readCatalogTaskExecution({ taskId: " task " })).rejects.toThrow();
    await expect(readCatalogTaskExecutionHistory({ executionKey: key, limit: 201 })).rejects.toThrow();
    await expect(readCatalogTaskExecutionHistory({ executionKey: key, afterEventKey: "9223372036854775808" }))
      .rejects.toThrow();
    expect(mocks.getSqlPool).not.toHaveBeenCalled();
  });
});
