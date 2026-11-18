import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ tx: {}, query: vi.fn(), begin: vi.fn(), commit: vi.fn(), rollback: vi.fn() }));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: async (work: (tx: object) => Promise<unknown>) => {
  m.begin();
  try { const value = await work(m.tx); m.commit(); return value; }
  catch (error) { m.rollback(); throw error; }
} }));
vi.mock("mssql", () => ({ default: {
  Request: class {
    params: Record<string, unknown> = {};
    constructor(readonly tx: object) {}
    input(key: string, _type: unknown, value: unknown) { this.params[key] = value; return this; }
    query(statement: string) { return m.query(statement, this.params, this.tx); }
  },
  VarChar: vi.fn(), NVarChar: vi.fn(), DateTime2: vi.fn(), Date: Symbol(), Int: Symbol(), MAX: Symbol(),
} }));
import { appendSqlCatalogManualDayIntents, readSqlCatalogManualDayIntents,
  readSqlCatalogManualDayIntentsInTransaction } from "../lib/catalogManualDayIntentSqlRepository";

const day = { portalEnvironment: "qa" as const, date: "2030-01-01" };
const intent = { scheduleId: "manual-1", scheduleVersion: "00000000000000ab" };
const append = { ...day, actorId: "active-user", selected: [intent], cutoffAt: new Date("2030-01-02T05:00:00Z") };
const result = (recordset: unknown[]) => m.query.mockResolvedValue({ recordset });
beforeEach(() => { vi.resetAllMocks(); });

describe("persisted manual schedule intentions", () => {
  it("reads only the current schedule version under the caller-owned range locks", async () => {
    result([intent]);
    const tx = {} as Parameters<typeof readSqlCatalogManualDayIntentsInTransaction>[0];
    await expect(readSqlCatalogManualDayIntentsInTransaction(tx, day))
      .resolves.toEqual(new Map([[intent.scheduleId, intent.scheduleVersion]]));
    expect(m.query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("s.row_version=i.schedule_version"),
      { portalEnvironment: "qa", taskDate: "2030-01-01" }, tx);
    expect(m.query.mock.calls[0][0]).toContain("i WITH (HOLDLOCK)");
    expect(m.query.mock.calls[0][0]).toContain("a.retired_at IS NULL");
    expect(m.begin).not.toHaveBeenCalled();
  });
  it("appends only approved exact versions, preserving the first request and checking the SQL deadline", async () => {
    result([{ accepted: 1 }]);
    await expect(appendSqlCatalogManualDayIntents(append)).resolves.toBeUndefined();
    const [sql, params, tx] = m.query.mock.calls[0];
    expect(tx).toBe(m.tx);
    expect(params).toMatchObject({ actorId: "active-user", expectedCount: 1, cutoffAt: append.cutoffAt,
      schedules: JSON.stringify([{ id: intent.scheduleId, version: intent.scheduleVersion }]) });
    expect(sql).toContain("approved.schedule_version=s.row_version");
    expect(sql).toContain("u.active=1");
    expect(sql).toContain("WITH (UPDLOCK,HOLDLOCK)");
    expect(sql).toContain("IF SYSUTCDATETIME()>=@cutoffAt");
    expect(m.commit).toHaveBeenCalledOnce();
  });
  it("never partially commits a selection", async () => {
    result([{ accepted: 0 }]);
    await expect(appendSqlCatalogManualDayIntents(append)).rejects.toThrow("catalog_manual_intent_unavailable");
    expect(m.rollback).toHaveBeenCalledOnce();
    expect(m.commit).not.toHaveBeenCalled();
  });
  it("rejects duplicate inputs and malformed dates before opening SQL", async () => {
    await expect(appendSqlCatalogManualDayIntents({ ...append, selected: [intent, intent] })).rejects.toThrow("catalog_manual_intent_invalid");
    await expect(readSqlCatalogManualDayIntents({ ...day, date: "2030-02-30" })).rejects.toThrow("catalog_manual_intent_invalid");
    expect(m.begin).not.toHaveBeenCalled();
  });
  it("rejects duplicate/versionless output rather than broadening the saved day", async () => {
    result([intent, intent]);
    await expect(readSqlCatalogManualDayIntents(day)).rejects.toThrow("catalog_manual_intent_unavailable");
    result([{ scheduleId: "manual-1", scheduleVersion: "not-a-version" }]);
    await expect(readSqlCatalogManualDayIntents(day)).rejects.toThrow("catalog_manual_intent_unavailable");
  });
});
