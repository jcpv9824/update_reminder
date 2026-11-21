import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogExecutionRegistration } from "../lib/catalogExecutionRegistrationSqlRepository";
import type { CatalogOperationalLink } from "../lib/catalogOperationalLinksSqlRepository";

const m = vi.hoisted(() => ({ tx: {}, order: [] as string[], lock: vi.fn(), coverage: vi.fn(), roster: vi.fn(),
  physical: vi.fn(), register: vi.fn(), clock: vi.fn(), commit: vi.fn(), rollback: vi.fn(), intents: vi.fn(),
  reason: vi.fn(), pins: vi.fn(), proof: vi.fn(), getSecret: vi.fn(), sourceAccess: vi.fn(), approvals: vi.fn() }));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: async (work: (tx: object) => Promise<unknown>) => {
  m.order.push("transaction");
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
vi.mock("../lib/catalogSourceAccessSqlRepository", () => ({ readAuthorizedCatalogSourceIdsInTransaction: m.sourceAccess }));
vi.mock("../lib/catalogScheduleOperationApprovalSqlRepository", () => ({ readSqlCatalogScheduleOperationApprovalsInTransaction: m.approvals }));
vi.mock("../lib/catalogPhysicalTargetSqlRepository", () => ({ readSqlCatalogPhysicalTargetsInTransaction: m.physical,
  readSqlCatalogPhysicalTargetPinsInTransaction: m.pins }));
vi.mock("../lib/catalogSagTargetRuntimeSqlRepository", () => ({ verifyCatalogSagTargetRuntimeProof: m.proof }));
vi.mock("../lib/keyVault", () => ({ getSecret: m.getSecret }));
vi.mock("../lib/catalogExecutionRegistrationSqlRepository", () => ({
  registerSqlCatalogTaskExecutionInTransaction: m.register, catalogRegistrationConflictReason: m.reason,
}));

import { runSqlCatalogScheduleDayTransaction } from "../lib/catalogScheduleDayTransaction";
import { catalogScheduleRosterToken } from "../lib/catalogScheduleActivation";
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
  vi.stubEnv("PORTAL_CATALOG_SAG_V2_ENABLED", "false");
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
afterEach(() => vi.unstubAllEnvs());

describe("atomic certified catalog business day", () => {
  it("does not inspect reservations if the original operation approval changed", async () => {
    m.approvals.mockResolvedValueOnce(new Map());
    const origin = { scheduleId: "a", scheduleVersion: roster[0].version, operationId: "snapshot-op" };
    const work = vi.fn();
    await expect(runSqlCatalogScheduleDayTransaction({ ...context, previewActorId: "actor", previewOrigin: origin }, work))
      .resolves.toEqual({ status: "unverified" });
    expect(m.approvals).toHaveBeenCalledWith(m.tx, "qa", [origin]);
    expect(work).not.toHaveBeenCalled();
  });

  it("forbids registration on the interactive preview transaction", async () => {
    await expect(runSqlCatalogScheduleDayTransaction({ ...context, previewActorId: "actor" }, io => io.register(write)))
      .resolves.toEqual({ status: "unverified" });
    expect(m.register).not.toHaveBeenCalled();
  });

  it("rolls back if a copy's selected physical proof expires while approval is being finalized", async () => {
    m.clock.mockResolvedValueOnce({ recordset: [{ status: "valid" }] }).mockResolvedValueOnce({ recordset: [{ status: "unverified" }] });
    await expect(runSqlCatalogScheduleDayTransaction({ ...context, previewActorId: "actor" },
      async (_io, _inspect, transaction, deadline, tighten) => {
        expect(transaction).toBe(m.tx);
        expect(deadline()).toEqual(approval);
        tighten(earliest);
        expect(deadline()).toEqual(earliest);
        return "simulated-created";
      })).resolves.toEqual({ status: "unverified" });
    expect(m.clock).toHaveBeenLastCalledWith(m.tx, { cutoffAt, validUntil: earliest });
    expect(m.rollback).toHaveBeenCalledOnce();
  });

  it("does not inspect or expose candidates after the actor loses source access", async () => {
    m.sourceAccess.mockResolvedValueOnce(new Set());
    const linkId = "any-link";
    const preview = await runSqlCatalogScheduleDayTransaction({ ...context, previewActorId: "actor" },
      async (_io, inspect) => inspect({ taskDate: date, cutoffAt, workflowRoleFor: () => "role", plan: {
        ready: true, tasks: [], held: [], conflicts: [{ sources: [{ link: { linkId } }] } as never],
      } }));
    expect(preview).toEqual({ status: "committed", value: null });
    expect(m.sourceAccess).toHaveBeenCalledExactlyOnceWith(m.tx, { actorId: "actor", environment: "qa" });
    expect(m.lock).toHaveBeenCalledTimes(2);
    expect(m.register).not.toHaveBeenCalled();
  });
  it("takes legacy-compatible locks before the certified read, uses one transaction, and checks the earliest deadline", async () => {
    const result = await runSqlCatalogScheduleDayTransaction(context, async io => {
      await io.resolve({ portalEnvironment: "qa", links: [] });
      return io.register(write);
    });
    expect(result).toEqual({ status: "committed", value: outcome });
    expect(m.order).toEqual(["transaction", "database", "domain", "coverage", "roster"]);
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
  it("rejects an activation commit after planning even though the definition version did not change", async () => {
    const planning = { ...roster[0], activation: null };
    const after = { ...planning, activation: { version: planning.version, phase: "held", environment: "qa",
      targets: [], principals: [] } };
    m.roster.mockResolvedValueOnce([after]);
    const work = vi.fn();
    expect(await runSqlCatalogScheduleDayTransaction({ ...context,
      roster: new Map([[planning.schedule.id, catalogScheduleRosterToken(planning)]]) }, work)).toEqual({ status: "unverified" });
    expect(m.rollback).toHaveBeenCalledOnce();
    expect(work).not.toHaveBeenCalled();
  });
  it("registers against the locked definition version, not the activation fingerprint", async () => {
    const planning = { ...roster[0], activation: { version: roster[0].version, phase: "frozen" as const, environment: "qa" as const,
      targets: [{ kind: "domain" as const, linkId: "link-a", targetId: "target-a" }],
      principals: [{ kind: "domain" as const, principalKind: "role" as const, id: "operator" }] } };
    m.roster.mockResolvedValueOnce([planning]);
    const { version } = planning;
    const locked = { ...context, roster: new Map([[planning.schedule.id, catalogScheduleRosterToken(planning)]]) };
    expect(await runSqlCatalogScheduleDayTransaction(locked, io => io.register({ ...write,
      scheduleVersions: new Map([[planning.schedule.id, version]]) }))).toEqual({ status: "committed", value: outcome });
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

  it("commits frozen one-time registrations without sending their activation fingerprint to the old observer", async () => {
    const frozen = { ...once, activation: { version: once.version, phase: "frozen" as const,
      environment: "qa" as const, targets: [], principals: [] } };
    m.roster.mockResolvedValue([frozen]);
    const observer = vi.fn();
    const result = await runSqlCatalogScheduleDayTransaction({ ...context,
      roster: new Map([[once.schedule.id, catalogScheduleRosterToken(frozen)]]) }, io => io.register(onceWrite), observer);
    expect(result).toEqual({ status: "committed", value: outcome });
    expect(observer).not.toHaveBeenCalled();
    expect(m.rollback).not.toHaveBeenCalled();
  });

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

describe("SAG v2 database schedule proof", () => {
  const linkId = "30000000-0000-0000-0000-000000000001";
  const physicalLinkId = "30000000-0000-0000-0000-000000000002";
  const targetId = "30000000-0000-0000-0000-000000000003";
  const webId = "30000000-0000-0000-0000-000000000004";
  const db = { kind: "database", linkId, customerId: "c", domainId: "d", databaseId: "db", environment: "test" } as const;
  const web = { kind: "domain", customerId: "c", domainId: "d", environment: "test" } as const;
  const source = { ...db, evidence: { state: "verified" } } as unknown as CatalogOperationalLink;
  const proofDeadline = new Date("2030-01-02T01:00:00Z");
  const sagContext = { ...context, scope: { ...context.scope, links: [source] }, matchKeyVersion: 7,
    sagDatabaseLinkIds: new Set([linkId]) };
  const dbWrite = { ...write, task: { ...write.task, targetType: "database" }, matchKeyVersion: 7,
    group: { ...write.group, kind: "database", targetId,
    sources: [{ scheduleId: "a", link: db }] } } as unknown as CatalogExecutionRegistration;
  const version = "7".repeat(32);
  beforeEach(() => {
    vi.stubEnv("PORTAL_CATALOG_SAG_V2_ENABLED", "true");
    vi.stubEnv("PORTAL_SAG_ENVIRONMENT", "qa");
    vi.stubEnv("PORTAL_CATALOG_MATCH_KEY_VERSION", "7");
    vi.stubEnv("PORTAL_CATALOG_MATCH_KEY_SECRET_NAME", "sag-match-test-key");
    vi.stubEnv("PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION", version);
    m.getSecret.mockImplementation(async () => { m.order.push("vault"); return "a7".repeat(32); });
    m.pins.mockResolvedValue([{ status: "verified", id: targetId, physicalLinkId }]);
    m.physical.mockResolvedValue([{ status: "verified", id: webId }]);
    m.proof.mockResolvedValue({ targetId, validUntil: proofDeadline });
  });
  it("reads only the pinned key before SQL locks; verifies the exact relation and fences its earlier deadline", async () => {
    const result = await runSqlCatalogScheduleDayTransaction(sagContext, async io => {
      expect(await io.resolve({ portalEnvironment: "qa", links: [db, web, db] })).toEqual([
        { status: "verified", id: targetId }, { status: "verified", id: webId }, { status: "verified", id: targetId }]);
      return io.register(dbWrite);
    });
    expect(result).toEqual({ status: "committed", value: outcome });
    expect(m.order.slice(0, 2)).toEqual(["vault", "transaction"]);
    expect(m.getSecret).toHaveBeenCalledExactlyOnceWith("sag-match-test-key", expect.any(AbortSignal), version);
    expect(m.pins).toHaveBeenCalledExactlyOnceWith(m.tx, { portalEnvironment: "qa", links: [db] });
    expect(m.proof).toHaveBeenCalledExactlyOnceWith(m.tx, { environment: "qa", purpose: "task", operationalLinkId: linkId,
      physicalLinkId, physicalTargetId: targetId, matchKeyVersion: 7, reportInstanceId: null }, Buffer.alloc(32));
    expect(m.clock).toHaveBeenLastCalledWith(m.tx, { cutoffAt, validUntil: proofDeadline });
  });
  it.each(["relation", "no proof", "stale", "different target", "vault", "pin version", "wrong realm",
    "malformed secret", "deleted physical row"] as const)(
    "holds only database work when its prerequisite fails (%s)", async failure => {
      if (failure === "no proof") m.proof.mockResolvedValue(null);
      if (failure === "stale") m.proof.mockResolvedValue({ targetId, validUntil: new Date(0) });
      if (failure === "different target") m.proof.mockResolvedValue({ targetId: webId, validUntil: proofDeadline });
      if (failure === "vault") m.getSecret.mockRejectedValue(new Error("fictional vault failure"));
      if (failure === "pin version") vi.stubEnv("PORTAL_CATALOG_MATCH_KEY_VERSION", "8");
      if (failure === "wrong realm") vi.stubEnv("PORTAL_SAG_ENVIRONMENT", "production");
      if (failure === "malformed secret") m.getSecret.mockResolvedValue("a7".repeat(32) + "\n");
      if (failure === "deleted physical row") m.pins.mockResolvedValue([{ status: "not_found" }]);
      const result = await runSqlCatalogScheduleDayTransaction(sagContext, io => io.resolve({ portalEnvironment: "qa",
        links: [failure === "relation" ? { ...db, domainId: "other" } : db, web] }));
      expect(result).toEqual({ status: "committed", value: [{ status: "unverifiable" }, { status: "verified", id: webId }] });
      if (["relation", "vault", "pin version", "wrong realm", "malformed secret", "deleted physical row"].includes(failure)) {
        expect(m.proof).not.toHaveBeenCalled();
      }
      if (failure === "pin version" || failure === "wrong realm") expect(m.getSecret).not.toHaveBeenCalled();
    });
  it("bounds a Vault read which ignores cancellation outside the transaction", async () => {
    vi.useFakeTimers();
    try {
      m.getSecret.mockReturnValue(new Promise(() => undefined));
      const pending = runSqlCatalogScheduleDayTransaction(sagContext, io => io.resolve({ portalEnvironment: "qa", links: [db, web] }));
      expect(m.order).not.toContain("transaction");
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await pending).toEqual({
        status: "committed", value: [{ status: "unverifiable" }, { status: "verified", id: webId }],
      });
      expect(m.getSecret.mock.calls[0]?.[1]?.aborted).toBe(true);
      expect(m.proof).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps domains normal without loading the key when only domains were selected", async () => {
    expect(await runSqlCatalogScheduleDayTransaction({ ...sagContext, sagDatabaseLinkIds: new Set() },
      io => io.resolve({ portalEnvironment: "qa", links: [db, web] }))).toEqual({
      status: "committed", value: [{ status: "unverifiable" }, { status: "verified", id: webId }],
    });
    expect(m.getSecret).not.toHaveBeenCalled();
    expect(m.pins).not.toHaveBeenCalled();
  });
  it("checks all 33 distinct selected relations without a silent scheduling cap", async () => {
    const links = Array.from({ length: 33 }, (_, i) => ({ ...db,
      linkId: `30000000-0000-0000-0000-${(i + 100).toString().padStart(12, "0")}`, databaseId: `db-${i}` }));
    const selected = new Set(links.map(link => link.linkId));
    const scope = { ...sagContext.scope, links: links.map(link => ({ ...source, ...link })) };
    m.pins.mockResolvedValue(links.map(() => ({ status: "verified", id: targetId, physicalLinkId })));
    const result = await runSqlCatalogScheduleDayTransaction({ ...sagContext, scope, sagDatabaseLinkIds: selected },
      io => io.resolve({ portalEnvironment: "qa", links }));
    expect(result).toEqual({ status: "committed", value: links.map(() => ({ status: "verified", id: targetId })) });
    expect(m.getSecret).toHaveBeenCalledOnce();
    expect(m.proof).toHaveBeenCalledTimes(33);
  });
  it("refuses registration that did not go through the internal proof", async () => {
    expect(await runSqlCatalogScheduleDayTransaction(sagContext, io => io.register(dbWrite))).toEqual({ status: "unverified" });
    expect(m.register).not.toHaveBeenCalled();
    expect(m.rollback).toHaveBeenCalledOnce();
  });
  it("refuses to use a proof from one alias to register a different logical tuple", async () => {
    const changed = { ...dbWrite, group: { ...dbWrite.group,
      sources: [{ scheduleId: "a", link: { ...db, domainId: "other" } }] } } as unknown as CatalogExecutionRegistration;
    expect(await runSqlCatalogScheduleDayTransaction(sagContext, async io => {
      await io.resolve({ portalEnvironment: "qa", links: [db] });
      return io.register(changed);
    })).toEqual({ status: "unverified" });
    expect(m.proof).toHaveBeenCalledOnce();
    expect(m.register).not.toHaveBeenCalled();
  });
  it("preserves existing DB resolution without loading a key when the feature is off", async () => {
    vi.stubEnv("PORTAL_CATALOG_SAG_V2_ENABLED", "false");
    m.physical.mockResolvedValue([{ status: "verified", id: targetId }]);
    expect(await runSqlCatalogScheduleDayTransaction(sagContext,
      io => io.resolve({ portalEnvironment: "qa", links: [db] }))).toEqual({ status: "committed", value: [{ status: "verified", id: targetId }] });
    expect(m.getSecret).not.toHaveBeenCalled();
    expect(m.proof).not.toHaveBeenCalled();
  });
});
