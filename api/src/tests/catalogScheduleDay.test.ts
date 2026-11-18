import { describe, expect, it, vi } from "vitest";
import { generateCatalogScheduleDay, type CatalogScheduleDay, type CatalogScheduleRule } from "../lib/catalogScheduleDay";
import { recordSqlCatalogOnceObservationsInTransaction } from "../lib/catalogOnceObservationSqlRepository";
import type { CatalogTaskLink } from "../lib/catalogTaskTargetPlanning";
import type { UpdateSchedule } from "../types/models";

const { runAtomic } = vi.hoisted(() => ({ runAtomic: vi.fn() }));
vi.mock("../lib/catalogScheduleDayTransaction", () => ({ runSqlCatalogScheduleDayTransaction: runAtomic }));

const date = "2030-06-22";
const physicalId = "31140f4d-81c3-4938-9ab2-a275473feb17";
const link = (n: number): CatalogTaskLink => ({ customerId: `client${n}`, domainId: `domain${n}`, databaseId: `db${n}`,
  linkId: `link${n}`, catalogRecordId: `record${n}`, kind: "database", state: "active", environment: "production",
  target: { status: "unverifiable" }, moduleIds: ["sales"] });
const links = [link(1), link(2)];
const rule = (n: number, frequencyType: UpdateSchedule["frequencyType"] = "once"): CatalogScheduleRule => ({
  calendar: { id: `schedule${n}`, frequencyType, startDate: date, timezone: "America/Bogota", active: true,
    version: `000000000000000${n}` },
  operationId: "release1", assignment: { kind: "role", id: "db_updater" }, workflowRole: "db_updater",
  scope: { kind: "database", customerId: `client${n}`, domainId: `domain${n}` },
});
const data: CatalogScheduleDay = { date, portalEnvironment: "qa", checkedAt: new Date("2030-06-20T00:00:00Z"),
  cutoffAt: new Date("2030-06-23T05:00:00Z"), revision: { id: "revision1", complete: true },
  rules: [rule(1), rule(2)], inventory: links.map((item, i) => ({ link: item, sourceId: null,
    clientName: `Cliente ${i}`, domainName: `Dominio ${i}`, targetName: `Base ${i}` })),
};
function io() {
  return { resolve: vi.fn().mockResolvedValue(links.map(() => ({ status: "verified", id: physicalId }))),
    register: vi.fn().mockResolvedValue({ status: "registered", taskId: "written" }) };
}

function observingIo() {
  const deps = { ...io(), observeOneTimeSchedules: vi.fn().mockResolvedValue(undefined) };
  deps.register.mockImplementation(async ({ task }) => ({ status: "existing", taskId: task.id, oneTimeExpectationVerified: true }));
  return deps;
}

describe("catalog schedule day", () => {
  it("requires the population fence and routes a certified default day through the atomic writer", async () => {
    const revision = { id: "catalog-population-v1:00000000-0000-0000-0000-000000000099", complete: true };
    await expect(generateCatalogScheduleDay({ ...data, revision })).resolves.toEqual({ status: "unverified" });
    expect(runAtomic).not.toHaveBeenCalled();
    const scope = { date, portalEnvironment: data.portalEnvironment, checkedAt: data.checkedAt, links: [] };
    const roster = new Map(data.rules.map(({ calendar }) => [calendar.id, calendar.version]));
    const manualIntents = new Map<string, string>();
    const scoped = io();
    runAtomic.mockImplementationOnce(async (_context, work) => ({ status: "committed", value: await work(scoped) }));
    await expect(generateCatalogScheduleDay({ ...data, revision, populationFence: { scope, roster, manualIntents } }))
      .resolves.toMatchObject({ status: "evaluated", registered: 1 });
    expect(runAtomic).toHaveBeenCalledExactlyOnceWith({
      scope, roster, manualIntents, date, cutoffAt: data.cutoffAt, revisionId: revision.id,
    }, expect.any(Function), recordSqlCatalogOnceObservationsInTransaction);
    expect(scoped.register).toHaveBeenCalledOnce();
  });

  it("registers one task with both aliases and a stable ID across revisions and input order", async () => {
    const deps = io();
    const result = await generateCatalogScheduleDay(data, deps);
    expect(result).toEqual({ status: "evaluated", registered: 1, existing: 0, held: 0, conflicts: 0 });
    expect(deps.register).toHaveBeenCalledOnce();
    const first = deps.register.mock.calls[0][0];
    expect(first.task).toMatchObject({ taskDate: date, scheduleId: "schedule1", clientId: "client1", targetId: "db1" });
    expect(first.group.sources).toHaveLength(2);
    expect([...first.scheduleVersions]).toEqual([["schedule1", "0000000000000001"], ["schedule2", "0000000000000002"]]);
    expect([...first.catalogSourceIdsByLink]).toEqual([["link1", null], ["link2", null]]);
    deps.register.mockResolvedValue({ status: "existing", taskId: first.task.id });
    expect(await generateCatalogScheduleDay({ ...data, revision: { id: "revision2", complete: true },
      rules: [...data.rules].reverse() }, deps)).toMatchObject({ existing: 1 });
    expect(deps.register.mock.calls[1][0].task.id).toBe(first.task.id);
    expect(deps.register.mock.calls[1][0].group.executionKey).toBe(first.group.executionKey);
  });

  it("observes the exact nonempty pair set per due once rule, including two aliases of one execution", async () => {
    const deps = observingIo();
    const alias = { ...rule(1), scope: { kind: "database" as const, linkIds: ["link2", "link1"] } };
    await expect(generateCatalogScheduleDay({ ...data, rules: [rule(2, "daily"), alias] }, deps))
      .resolves.toEqual({ status: "evaluated", registered: 0, existing: 1, held: 0, conflicts: 0 });
    const key = deps.register.mock.calls[0][0].group.executionKey;
    expect(deps.observeOneTimeSchedules).toHaveBeenCalledExactlyOnceWith([{
      scheduleId: "schedule1", scheduleVersion: "0000000000000001", operationId: "release1",
      pairs: [{ linkId: "link1", executionKey: key }, { linkId: "link2", executionKey: key }],
    }]);
    expect(deps.observeOneTimeSchedules.mock.invocationCallOrder[0]).toBeGreaterThan(deps.register.mock.invocationCallOrder[0]);
  });

  it.each(["release1", "changed-operation"])("combines both target kinds only for one operation: %s", async operationId => {
    const deps = observingIo();
    const single = rule(1);
    const { databaseId: _unused, ...domain } = data.inventory[1].link;
    const domainRule = { ...single, operationId, scope: { kind: "domain" as const, linkIds: [domain.linkId] } };
    await generateCatalogScheduleDay({ ...data, rules: [single, domainRule], inventory: [data.inventory[0], {
      ...data.inventory[1], link: { ...domain, kind: "domain" },
    }] }, deps);
    const executions = new Map(deps.register.mock.calls.map(([{ group }]) => [group.sources[0].link.linkId, group.executionKey]));
    expect(deps.register).toHaveBeenCalledTimes(2);
    expect(deps.observeOneTimeSchedules).toHaveBeenCalledExactlyOnceWith([{
      scheduleId: "schedule1", scheduleVersion: "0000000000000001", operationId: "release1",
      pairs: operationId !== "release1" ? null : ["link1", "link2"].map(linkId => ({ linkId, executionKey: executions.get(linkId) })),
    }]);
  });

  it.each(["wrong-id", "ordinary", "receipt-only", "mixed-receipt", "conflict"])(
    "does not certify a group lacking exact trusted registration evidence: %s", async failure => {
      const deps = observingIo();
      deps.register.mockImplementation(async ({ task }) => {
        if (failure === "conflict") return { status: "conflict", reason: "evidence-unverified" };
        return { status: "existing", taskId: failure === "wrong-id" ? "old-id" : task.id,
          ...(failure === "ordinary" ? {} : { oneTimeExpectationVerified: true }),
          ...(failure === "receipt-only" ? { receiptOnly: true } : {}),
          ...(failure === "mixed-receipt" ? { accountedOrigins: 1 } : {}) };
      });
      await generateCatalogScheduleDay(data, deps);
      expect(deps.observeOneTimeSchedules).toHaveBeenCalledExactlyOnceWith([
        { scheduleId: "schedule1", scheduleVersion: "0000000000000001", operationId: "release1", pairs: null },
        { scheduleId: "schedule2", scheduleVersion: "0000000000000002", operationId: "release1", pairs: null },
      ]);
    },
  );

  it.each(["empty", "incomplete-scope", "held", "plan-conflict"])("does not certify %s work", async failure => {
    const deps = observingIo();
    const first = { ...rule(1), scope: { kind: "database" as const,
      linkIds: failure === "empty" ? [] : failure === "held" ? ["link1", "missing"] : ["link1"] },
      ...(failure === "incomplete-scope" ? { oneTimeSelectionIncomplete: true as const } : {}) };
    const second = { ...rule(2), operationId: failure === "plan-conflict" ? "other" : "release1" };
    const result = await generateCatalogScheduleDay({ ...data, rules: [first, second] }, deps);
    expect(result).toMatchObject({ status: "evaluated" });
    expect(deps.observeOneTimeSchedules.mock.calls[0][0]).toEqual([
      expect.objectContaining({ scheduleId: "schedule1", pairs: null }),
      expect.objectContaining({ scheduleId: "schedule2", pairs: failure === "plan-conflict" ? null
        : [expect.objectContaining({ linkId: "link2" })] }),
    ]);
  });

  it("does not include a receipt-only disposition in the operative task counts", async () => {
    const deps = io();
    deps.register.mockResolvedValue({ status: "existing", taskId: "task", accountedOrigins: 2, receiptOnly: true });
    expect(await generateCatalogScheduleDay(data, deps)).toEqual({
      status: "evaluated", registered: 0, existing: 0, held: 0, conflicts: 0, accountedOrigins: 2,
    });
  });

  it("sums accounting-only and mixed dispositions but counts only the mixed task as operative", async () => {
    const deps = io();
    deps.resolve.mockResolvedValue([{ status: "verified", id: physicalId },
      { status: "verified", id: "31140f4d-81c3-4938-9ab2-a275473feb18" }]);
    deps.register.mockResolvedValueOnce({ status: "existing", taskId: "one", accountedOrigins: 2, receiptOnly: true })
      .mockResolvedValueOnce({ status: "existing", taskId: "two", accountedOrigins: 1 });
    expect(await generateCatalogScheduleDay(data, deps)).toEqual({
      status: "evaluated", registered: 0, existing: 1, held: 0, conflicts: 0, accountedOrigins: 3,
    });
  });

  it("ignores explicit-only schedules during the timer run and checks manual work against all due schedules", async () => {
    const deps = io();
    const config = { ...data, rules: [rule(1), { ...rule(2, "manual"), operationId: "other" }] };
    expect(await generateCatalogScheduleDay(config, deps)).toMatchObject({ registered: 1 });
    deps.register.mockClear();
    expect(await generateCatalogScheduleDay({ ...config, manualScheduleIds: ["schedule2"] }, deps))
      .toMatchObject({ registered: 0, conflicts: 1 });
    expect(deps.register).not.toHaveBeenCalled();
  });

  it.each([
    { shareProof: true, registered: 1 },
    { shareProof: false, registered: 2 },
  ])("uses physical web proof, not equal domain labels (shared proof: $shareProof)", async ({ shareProof, registered }) => {
    const sharedUrl = "https://shared.example.test";
    const deps = io();
    deps.resolve.mockResolvedValue([
      { status: "verified", id: physicalId },
      { status: "verified", id: shareProof ? physicalId : "31140f4d-81c3-4938-9ab2-a275473feb18" },
    ]);
    const inventory = data.inventory.map(({ link: { databaseId: _unused, ...item }, ...record }, i) => ({
      ...record, link: { ...item, kind: "domain" as const, environment: i === 0 ? "production" as const : "test" as const },
      domainName: sharedUrl, targetName: sharedUrl,
    }));
    const rules = data.rules.map(item => ({
      ...item, workflowRole: "domain_updater", assignment: { kind: "role" as const, id: "domain_updater" },
      scope: { ...item.scope, kind: "domain" as const },
    }));
    expect(await generateCatalogScheduleDay({ ...data, inventory, rules }, deps)).toMatchObject({ registered });
    const origins = deps.register.mock.calls.flatMap(([entry]) => entry.group.sources)
      .map(source => [source.link.customerId, source.link.domainId, source.link.environment].join(":")).sort();
    expect(origins).toEqual(["client1:domain1:production", "client2:domain2:test"]);
  });

  it("keeps the full domain name and stable target ID when the redundant task label is short", async () => {
    const domainName = "x".repeat(238) + "🌐" + "path";
    const { databaseId: _unused, ...link } = data.inventory[0].link;
    const deps = io();
    deps.resolve.mockResolvedValue([{ status: "verified", id: physicalId }]);
    const singleRule = { ...rule(1), scope: { ...rule(1).scope, kind: "domain" as const } };
    await generateCatalogScheduleDay({ ...data, rules: [singleRule], inventory: [{ ...data.inventory[0],
      link: { ...link, kind: "domain" }, domainName, targetName: domainName }] }, deps);
    expect(deps.register.mock.calls[0][0].task).toMatchObject({
      domainName, targetId: "domain1", targetName: "x".repeat(238) + "…",
    });
  });

  it("has no writes when coverage is incomplete, the cutoff passed, or the manual request is out of scope", async () => {
    const deps = io();
    await expect(generateCatalogScheduleDay({ ...data, revision: { id: "revision1", complete: false } }, deps))
      .resolves.toEqual({ status: "unverified" });
    await expect(generateCatalogScheduleDay({ ...data, checkedAt: data.cutoffAt }, deps)).resolves.toEqual({ status: "cutoff" });
    await expect(generateCatalogScheduleDay({ ...data, manualScheduleIds: ["schedule2"] }, deps)).rejects.toThrow("manual");
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(deps.register).not.toHaveBeenCalled();
  });

  it("does not broaden an exact empty selection or assume unknown licenses are eligible", async () => {
    const deps = io();
    const config = { ...data,
      inventory: data.inventory.map(item => ({ ...item, link: { ...item.link, moduleIds: null } })),
      rules: [{ ...rule(1), scope: { kind: "database" as const, customerId: "client1", linkIds: [] } },
        { ...rule(2), scope: { kind: "database" as const, customerId: "client2", modules: { mode: "all" as const, ids: ["sales"] } } }],
    };
    expect(await generateCatalogScheduleDay(config, deps)).toMatchObject({ registered: 0, held: 1, conflicts: 0 });
    expect(deps.register).not.toHaveBeenCalled();
  });
});
