import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogExecutionRegistration } from "../lib/catalogExecutionRegistrationSqlRepository";

const m = vi.hoisted(() => ({ tx: {}, order: [] as string[], lock: vi.fn(), coverage: vi.fn(), roster: vi.fn(),
  physical: vi.fn(), register: vi.fn(), clock: vi.fn(), commit: vi.fn(), rollback: vi.fn(), intents: vi.fn(),
  reason: vi.fn() }));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: async (work: (tx: object) => Promise<unknown>) => {
  try { const result = await work(m.tx); m.commit(); return result; }
  catch (error) { m.rollback(); throw error; }
} }));
vi.mock("mssql", () => ({ default: {
  Request: class {
    params: Record<string, unknown> = {};
    constructor(readonly tx: object) {}
    input(key: string, _type: unknown, value: unknown) { this.params[key] = value; return this; }
    query() { return m.clock(this.tx, this.params); }
  },
  DateTime2: vi.fn(),
} }));
vi.mock("../lib/catalogExecutionCoexistenceSql", () => ({ lockCatalogTaskDay: m.lock }));
vi.mock("../lib/catalogSchedulePopulationCoverage", () => ({ readSqlCatalogSchedulePopulationCoverageInTransaction: m.coverage }));
vi.mock("../lib/schedulingSqlRepository", () => ({ readSqlCatalogScheduleRosterInTransaction: m.roster }));
vi.mock("../lib/catalogManualDayIntentSqlRepository", () => ({ readSqlCatalogManualDayIntentsInTransaction: m.intents }));
vi.mock("../lib/catalogPhysicalTargetSqlRepository", () => ({ readSqlCatalogPhysicalTargetsInTransaction: m.physical }));
vi.mock("../lib/catalogExecutionRegistrationSqlRepository", () => ({
  registerSqlCatalogTaskExecutionInTransaction: m.register, catalogRegistrationConflictReason: m.reason,
}));

import { runSqlCatalogScheduleDayTransaction } from "../lib/catalogScheduleDayTransaction";
const date = "2030-01-01";
const cutoffAt = new Date("2030-01-02T05:00:00Z");
const approval = new Date("2030-01-02T03:00:00Z");
const earliest = new Date("2030-01-02T02:00:00Z");
const revisionId = "catalog-population-v1:00000000-0000-0000-0000-000000000012";
const roster = [{ schedule: { id: "a" }, version: "0000000000000001" }];
const context = { date, cutoffAt, revisionId, scope: { date, portalEnvironment: "qa" as const,
  checkedAt: new Date("2030-01-01T06:00:00Z"), links: [] }, roster: new Map([["a", roster[0].version]]),
  manualIntents: new Map<string, string>() };
const write = { cutoffAt, portalEnvironment: "qa", task: { taskDate: date }, group: { occurrenceId: date,
  revisionId, kind: "domain" }, scheduleVersions: context.roster } as unknown as CatalogExecutionRegistration;
const outcome = { status: "registered", taskId: "t1" };

beforeEach(() => {
  vi.resetAllMocks();
  m.order.length = 0;
  m.lock.mockImplementation(async (_tx, request) => { m.order.push(request.targetType); return true; });
  m.coverage.mockImplementation(async () => { m.order.push("coverage"); return { id: revisionId, complete: true, validUntil: approval }; });
  m.roster.mockImplementation(async () => { m.order.push("roster"); return roster; });
  m.physical.mockResolvedValue([]);
  m.register.mockResolvedValue({ outcome, validUntil: earliest });
  m.clock.mockResolvedValue({ recordset: [{ status: "valid" }] });
  m.reason.mockReturnValue(null);
  m.intents.mockResolvedValue(new Map());
});

describe("atomic certified catalog business day", () => {
  it("takes legacy-compatible locks before the certified read, uses one transaction, and checks the earliest deadline", async () => {
    const result = await runSqlCatalogScheduleDayTransaction(context, async io => {
      await io.resolve({ portalEnvironment: "qa", links: [] });
      return io.register(write);
    });
    expect(result).toEqual({ status: "committed", value: outcome });
    expect(m.order).toEqual(["database", "domain", "coverage", "roster"]);
    expect(m.coverage).toHaveBeenCalledExactlyOnceWith(m.tx, context.scope);
    expect(m.roster).toHaveBeenCalledExactlyOnceWith(m.tx, date);
    expect(m.physical).toHaveBeenCalledExactlyOnceWith(m.tx, { portalEnvironment: "qa", links: [] });
    expect(m.register).toHaveBeenCalledExactlyOnceWith(m.tx, write, { replayMode: "certified-day" });
    expect(m.clock).toHaveBeenLastCalledWith(m.tx, { cutoffAt, validUntil: earliest });
    expect(m.commit).toHaveBeenCalledOnce();
  });
  it.each(["lock busy", "population replaced", "same-count roster changed", "manual intent arrived"])("does not begin work when %s", async kind => {
    if (kind === "lock busy") m.lock.mockResolvedValueOnce(false);
    if (kind === "population replaced") m.coverage.mockResolvedValueOnce({ id: "another", complete: true, validUntil: approval });
    if (kind === "same-count roster changed") m.roster.mockResolvedValueOnce([{ ...roster[0], version: "0000000000000002" }]);
    if (kind === "manual intent arrived") m.intents.mockResolvedValueOnce(new Map([["a", roster[0].version]]));
    const work = vi.fn();
    expect(await runSqlCatalogScheduleDayTransaction(context, work)).toEqual({ status: "unverified" });
    expect(work).not.toHaveBeenCalled();
    expect(m.rollback).toHaveBeenCalledOnce();
  });
  it.each(["cutoff", "unverified"] as const)("rolls back every provisional registration if the final SQL guard returns %s", async status => {
    m.clock.mockResolvedValueOnce({ recordset: [{ status: "valid" }] }).mockResolvedValueOnce({ recordset: [{ status }] });
    const result = await runSqlCatalogScheduleDayTransaction(context, async io => {
      await io.register(write);
      return io.register(write);
    });
    expect(result).toEqual({ status });
    expect(m.register).toHaveBeenCalledTimes(2);
    expect(m.commit).not.toHaveBeenCalled();
    expect(m.rollback).toHaveBeenCalledOnce();
  });
  it("rolls back previous groups if the registration of a later group loses evidence", async () => {
    const problem = new Error("fictional registration conflict");
    m.register.mockResolvedValueOnce({ outcome, validUntil: earliest }).mockRejectedValueOnce(problem);
    m.reason.mockImplementation(error => error === problem ? "catalog-reference-changed" : null);
    expect(await runSqlCatalogScheduleDayTransaction(context, async io => {
      await io.register(write);
      return io.register(write);
    })).toEqual({ status: "unverified" });
    expect(m.rollback).toHaveBeenCalledOnce();
    expect(m.commit).not.toHaveBeenCalled();
  });

  const once = { ...roster[0], schedule: { id: "a", active: true, frequencyType: "once", startDate: date } };
  const executionKey = "a".repeat(64);
  const operationId = "approved";
  const onceWrite = { ...write, task: { ...write.task, id: "t1" },
    group: { ...write.group, executionKey, operationId, sources: [{ scheduleId: "a", link: { linkId: "link-a" } }] },
  } as CatalogExecutionRegistration;
  const observedOnce = { scheduleId: "a", scheduleVersion: once.version, operationId,
    pairs: [{ linkId: "link-a", executionKey }] };

  it("passes one-time evidence to the observer in the same transaction and before the final deadline guard", async () => {
    m.roster.mockResolvedValue([once]);
    m.register.mockResolvedValue({ outcome: { ...outcome, oneTimeExpectationVerified: true }, validUntil: earliest });
    const observer = vi.fn();
    const result = await runSqlCatalogScheduleDayTransaction(context, async io => {
      await io.register(onceWrite);
      await io.observeOneTimeSchedules!([observedOnce]);
      return "evaluated";
    }, observer);
    expect(result).toEqual({ status: "committed", value: "evaluated" });
    expect(m.register).toHaveBeenCalledExactlyOnceWith(m.tx, onceWrite, {
      replayMode: "certified-day", verifyOneTimeExpectation: true,
    });
    expect(observer).toHaveBeenCalledExactlyOnceWith(m.tx, context, [observedOnce], earliest);
    expect(observer.mock.invocationCallOrder[0]).toBeLessThan(m.clock.mock.invocationCallOrder[1]);
    expect(observer.mock.invocationCallOrder[0]).toBeLessThan(m.commit.mock.invocationCallOrder[0]);
  });

  it.each(["unproven", "wrong execution", "wrong operation", "wrong version", "missing observation"])(
    "rolls back before observing a %s one-time proof", async failure => {
      m.roster.mockResolvedValue([once]);
      m.register.mockResolvedValue({ outcome: { ...outcome, ...(failure === "unproven" ? {} : { oneTimeExpectationVerified: true }) },
        validUntil: earliest });
      const observer = vi.fn();
      const candidate = { ...observedOnce, ...(failure === "wrong execution" ? { pairs: [{ linkId: "link-a", executionKey: "b".repeat(64) }] } : {}),
        ...(failure === "wrong operation" ? { operationId: "other" } : {}),
        ...(failure === "wrong version" ? { scheduleVersion: "0000000000000003" } : {}) };
      expect(await runSqlCatalogScheduleDayTransaction(context, async io => {
        await io.register(onceWrite);
        if (failure !== "missing observation") await io.observeOneTimeSchedules!([candidate]);
      }, observer)).toEqual({ status: "unverified" });
      expect(observer).not.toHaveBeenCalled();
      expect(m.commit).not.toHaveBeenCalled();
      expect(m.rollback).toHaveBeenCalledOnce();
    });

  it("passes an explicitly blocked observation without inventing pairs, and rolls it back if the cutoff is crossed", async () => {
    m.roster.mockResolvedValue([once]);
    m.clock.mockResolvedValueOnce({ recordset: [{ status: "valid" }] }).mockResolvedValueOnce({ recordset: [{ status: "cutoff" }] });
    const observer = vi.fn();
    const blocked = { ...observedOnce, pairs: null };
    expect(await runSqlCatalogScheduleDayTransaction(context, async io => {
      await io.observeOneTimeSchedules!([blocked]);
    }, observer)).toEqual({ status: "cutoff" });
    expect(observer).toHaveBeenCalledExactlyOnceWith(m.tx, context, [blocked], approval);
    expect(m.commit).not.toHaveBeenCalled();
    expect(m.rollback).toHaveBeenCalledOnce();
  });
});
