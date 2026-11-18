import { describe, expect, it, vi } from "vitest";
import { generateCatalogScheduleDay, type CatalogScheduleDay, type CatalogScheduleRule } from "../lib/catalogScheduleDay";
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
    }, expect.any(Function));
    expect(scoped.register).toHaveBeenCalledOnce();
  });

  it("registers one task with both aliases and a stable ID across revisions and input order", async () => {
    const deps = io();
    const result = await generateCatalogScheduleDay(data, deps);
    expect(result).toMatchObject({ status: "evaluated", registered: 1, existing: 0, held: 0, conflicts: 0 });
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
