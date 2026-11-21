import { describe, expect, it, vi } from "vitest";
import { generateCatalogPersistedScheduleDay, compileCatalogScheduleScopes, compileExactCopyProposal } from "../lib/catalogScheduleScopes";
import { generateCatalogScheduleDay } from "../lib/catalogScheduleDay";
import type { UpdateSchedule } from "../types/models";
import type { CatalogTaskLink } from "../lib/catalogTaskTargetPlanning";
import type { CatalogScheduleRosterRow } from "../lib/schedulingSqlRepository";

const date = "2030-06-22";
const version = "0000000000000001";
const physicalId = "31140f4d-81c3-4938-9ab2-a275473feb17";
const base = { id: "sch", clientId: "a", clientName: "A", targetType: "domain", targetIds: [], frequencyType: "once",
  startDate: date, timezone: "America/Bogota", active: true, assignedRole: "domain_updater", assignedUserIds: [] } as unknown as UpdateSchedule;
const inv = (kind: "domain" | "database", customerId: string, domainId: string, databaseId?: string,
  environment: "production" | "test" = "production", moduleIds: string[] | null = ["A", "B"]) => {
  const identity = `${customerId}:${domainId}:${databaseId ?? "domain"}:${environment}`;
  const link = { linkId: identity, customerId, domainId, databaseId, kind, environment, state: "active",
    target: { status: "unverifiable" }, catalogRecordId: identity, moduleIds } as CatalogTaskLink;
  return { link, sourceId: null, clientName: "Cliente", domainName: "Dominio", targetName: "Objetivo" };
};
const input = { date, checkedAt: new Date("2030-06-22T05:00:00Z"), cutoffAt: new Date("2030-06-23T05:00:00Z"),
  portalEnvironment: "qa" as const, revision: { id: "rev", complete: true },
  operationsBySchedule: new Map([["sch", { operationId: "operation", scheduleVersion: version }]]),
  activeLicenseIds: new Set(["A", "B"]), inventory: [inv("domain", "a", "shared"), inv("database", "a", "shared", "same"),
    inv("domain", "a", "different"), inv("database", "a", "different", "same"),
    inv("domain", "b", "shared"), inv("database", "b", "shared", "same"), inv("database", "a", "shared", "testdb", "test", null)] };
const row = (values: Partial<UpdateSchedule>) => [{ version, schedule: { ...base, ...values } }];

describe("persisted catalog scope adapter", () => {
  const frozen = (): CatalogScheduleRosterRow => ({ ...row({ selectionMode: "licensing", licensingScope: {
    licenseMatchMode: "any", targetTypes: "domains_only", environment: "all", licenseModuleIds: ["A"], activeOnly: true,
  } })[0], activation: { version, environment: "qa", phase: "frozen", targets: [{ kind: "domain",
    linkId: "a:shared:domain:production", targetId: physicalId }], principals: [{ kind: "domain", principalKind: "user", id: "frozen-owner" }] } });

  it("uses the frozen explicit links and assignee without expanding from current license memberships", async () => {
    const register = vi.fn().mockResolvedValue({ status: "registered", taskId: "task" });
    const resolve = vi.fn().mockResolvedValue(input.inventory.map(() => ({ status: "verified", id: physicalId })));
    await expect(generateCatalogPersistedScheduleDay(input, {
      readRoster: vi.fn().mockResolvedValue([frozen()]), generate: day => generateCatalogScheduleDay(day, { register, resolve }),
    })).resolves.toMatchObject({ registered: 1 });
    expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      task: expect.objectContaining({ assignedUserIds: ["frozen-owner"], clientId: "a", domainId: "shared" }),
      group: expect.objectContaining({ sources: [expect.objectContaining({ link: expect.objectContaining({ linkId: "a:shared:domain:production" }) })] }),
    }));
  });

  it("retains a frozen member in the snapshot but does not execute it without current licensing proof", async () => {
    const register = vi.fn();
    const inventory = input.inventory.map(record => ({ ...record, link: { ...record.link, moduleIds: null } }));
    const resolve = vi.fn().mockResolvedValue(inventory.map(() => ({ status: "verified", id: physicalId })));
    await expect(generateCatalogPersistedScheduleDay({ ...input, inventory }, { readRoster: vi.fn().mockResolvedValue([frozen()]),
      generate: day => generateCatalogScheduleDay(day, { register, resolve }) })).resolves.toMatchObject({ held: 1, registered: 0 });
    expect(register).not.toHaveBeenCalled();
  });

  it("holds a frozen link if current proof points to a different physical target", async () => {
    const register = vi.fn();
    const resolve = vi.fn().mockResolvedValue(input.inventory.map(() => ({ status: "verified", id: "rebound-target" })));
    await expect(generateCatalogPersistedScheduleDay(input, { readRoster: vi.fn().mockResolvedValue([frozen()]),
      generate: day => generateCatalogScheduleDay(day, { register, resolve }),
    })).resolves.toMatchObject({ held: 1, registered: 0 });
    expect(register).not.toHaveBeenCalled();
  });

  it("never replaces a missing activation snapshot with today's license matches", () => {
    expect(compileCatalogScheduleScopes(input, [{ ...frozen(), activation: null }])).toMatchObject({
      status: "ready", missingSelections: 1, rules: [{ scope: { linkIds: [] } }],
    });
  });

  it("uses only the copied exact links; a copied database never adds its unselected domain", () => {
    const selected = { kind: "database" as const, linkId: "a:shared:same:production", targetId: physicalId };
    const copy: CatalogScheduleRosterRow = { ...row({ manualTargetTypes: "domains_and_databases" })[0], copyLinks: [selected],
      activation: { version, environment: "qa", phase: "frozen", targets: [selected],
        principals: [{ kind: "database", principalKind: "role", id: "database_updater" }] } };
    expect(compileCatalogScheduleScopes(input, [copy])).toMatchObject({ status: "ready", rules: [
      { scope: { kind: "database", linkIds: ["a:shared:same:production"] } },
    ] });
    expect(compileCatalogScheduleScopes(input, [{ ...copy, activation: { ...copy.activation!, targets: [
      { ...selected, targetId: "changed" },
    ] } }])).toEqual({ status: "unverified" });
    expect(compileExactCopyProposal({ ...copy, activation: { ...copy.activation!, phase: "cancelled", targets: [] } },
      "2030-06-23", "operation")).toMatchObject({ status: "ready", rules: [
      { calendar: { startDate: "2030-06-23" }, scope: { kind: "database", linkIds: [selected.linkId] } },
    ] });
  });
  it("restricts manual selections to the requested environment before collecting target IDs", () => {
    const rule = row({ manualTargetTypes: "databases_only", manualEnvironment: "production", scopeGroups: [
      { clientId: "a", includeAllDomains: true, domains: [] },
    ] });
    expect(compileCatalogScheduleScopes(input, rule)).toMatchObject({ rules: [{ scope: { linkIds: [
      "a:different:same:production", "a:shared:same:production",
    ] } }] });
  });
  it("uses a new manual draft's independently approved exact lanes and rejects changed scope or version", () => {
    const selected = { kind: "database" as const, linkId: "a:shared:same:production", targetId: physicalId };
    const draft: CatalogScheduleRosterRow = { ...row({ selectionMode: "manual" })[0],
      draftOrigin: { manual: true, version, environment: "qa", operationId: "operation" }, draftLinks: [selected],
      activation: { version, environment: "qa", phase: "frozen", targets: [selected],
        principals: [{ kind: "database", principalKind: "role", id: "database_updater" }] } };
    expect(compileCatalogScheduleScopes(input, [draft])).toMatchObject({ status: "ready", rules: [
      { scope: { kind: "database", linkIds: [selected.linkId] } },
    ] });
    expect(compileExactCopyProposal(draft, "2030-06-23", "operation")).toMatchObject({ status: "ready", rules: [
      { scope: { kind: "database", linkIds: [selected.linkId] } },
    ] });
    for (const changed of [
      { ...draft, draftLinks: undefined },
      { ...draft, copyLinks: [selected] },
      { ...draft, draftOrigin: { ...draft.draftOrigin!, version: "0000000000000002" } },
      { ...draft, draftOrigin: { ...draft.draftOrigin!, operationId: "other" } },
      { ...draft, activation: { ...draft.activation!, targets: [{ ...selected, targetId: "another-destination" }] } },
    ]) expect(compileCatalogScheduleScopes(input, [changed])).toEqual({ status: "unverified" });
  });

  it("keeps all databases within a declared customer and domain, even with identical labels/target IDs in other branches", () => {
    const plan = compileCatalogScheduleScopes(input, row({ manualTargetTypes: "databases_only", scopeGroups: [
      { clientId: "a", includeAllDomains: false, domains: [{ domainId: "shared", includeAllDatabases: true, databaseIds: [] }] },
    ] }));
    expect(plan).toMatchObject({ status: "ready", rules: [{ scope: { kind: "database", linkIds: [
      "a:shared:same:production", "a:shared:testdb:test",
    ] } }] });
  });

  it("keeps fixed empty selections empty, preserves missing selections, and never inherits bases for a flat domain", () => {
    const flat = compileCatalogScheduleScopes(input, row({ targetIds: ["shared"] }));
    expect(flat).toMatchObject({ rules: [{ scope: { kind: "domain", linkIds: ["a:shared:domain:production"] } }] });
    const foreign = compileCatalogScheduleScopes(input, row({ manualTargetTypes: "databases_only", scopeGroups: [
      { clientId: "a", includeAllDomains: false, domains: [{ domainId: "shared", includeAllDatabases: false, databaseIds: ["removed"] },
        { domainId: "unknown", includeAllDatabases: false, databaseIds: [] }] },
    ] }));
    expect(foreign).toMatchObject({ missingSelections: 1, rules: [{ scope: { linkIds: [] } }] });
  });

  it("carries missing or inactive explicit selections only on the affected rule without changing the held count", () => {
    const inactive = input.inventory.map(item => item.link.linkId === "a:shared:same:production"
      ? { ...item, link: { ...item.link, state: "inactive" as const } } : item);
    const groups = [{ clientId: "a", includeAllDomains: false, domains: [
      { domainId: "shared", includeAllDatabases: false, databaseIds: ["same", "removed"] },
    ] }];
    const fixed = compileCatalogScheduleScopes({ ...input, inventory: inactive }, row({ scopeGroups: groups }));
    expect(fixed).toMatchObject({ status: "ready", missingSelections: 1, rules: [
      { scope: { kind: "domain", linkIds: ["a:shared:domain:production"] } },
      { oneTimeSelectionIncomplete: true, scope: { kind: "database", linkIds: ["a:shared:same:production"] } },
    ] });
    if (fixed.status !== "ready") throw new Error("expected a ready plan");
    expect(fixed.rules[0]).not.toHaveProperty("oneTimeSelectionIncomplete");
    const inactiveOnly = compileCatalogScheduleScopes({ ...input, inventory: inactive }, row({ scopeGroups: groups.map(group => ({
      ...group, domains: group.domains.map(domain => ({ ...domain, databaseIds: ["same"] })),
    })) }));
    expect(inactiveOnly).toMatchObject({ missingSelections: 0, rules: [{}, { oneTimeSelectionIncomplete: true }] });
  });

  it("distinguishes dynamic inactive rows from a missing explicitly selected parent domain", () => {
    const inactive = input.inventory.map(item => item.link.linkId === "a:shared:same:production"
      ? { ...item, link: { ...item.link, state: "inactive" as const } } : item);
    const dynamic = [{ clientId: "a", includeAllDomains: false, domains: [
      { domainId: "shared", includeAllDatabases: true, databaseIds: [] },
    ] }];
    const plan = compileCatalogScheduleScopes({ ...input, inventory: inactive }, row({
      manualTargetTypes: "databases_only", scopeGroups: dynamic,
    }));
    if (plan.status !== "ready") throw new Error("expected a ready plan");
    expect(plan.rules[0]).not.toHaveProperty("oneTimeSelectionIncomplete");
    expect(compileCatalogScheduleScopes(input, row({ manualTargetTypes: "databases_only", scopeGroups: dynamic.map(group => ({
      ...group, domains: [...group.domains, { domainId: "gone", includeAllDatabases: true, databaseIds: [] }],
    })) }))).toMatchObject({ missingSelections: 0, rules: [{ oneTimeSelectionIncomplete: true }] });
  });

  it("never turns an all-licenses rule into a narrower predicate when a module goes inactive", async () => {
    const roster = row({ selectionMode: "licensing", licensingScope: { licenseMatchMode: "all", targetTypes: "databases_only",
      environment: "production", licenseModuleIds: ["A", "B"], activeOnly: true } });
    const generate = vi.fn();
    await expect(generateCatalogPersistedScheduleDay({ ...input, activeLicenseIds: new Set(["A"]) },
      { readRoster: vi.fn().mockResolvedValue(roster), generate })).resolves.toEqual({ status: "unverified" });
    expect(generate).not.toHaveBeenCalled();
    const plan = compileCatalogScheduleScopes(input, roster);
    expect(plan).toMatchObject({ rules: [{ scope: { modules: { mode: "all", ids: ["A", "B"] },
      linkIds: ["a:different:same:production", "a:shared:same:production", "b:shared:same:production"] } }] });
  });

  it("does not fall back to role assignment or an old operation when proof is missing", () => {
    expect(compileCatalogScheduleScopes(input, row({ assignmentMode: "users", targetIds: ["shared"] })))
      .toEqual({ status: "unverified" });
    expect(compileCatalogScheduleScopes(input, [{ version: "0000000000000002", schedule: base }]))
      .toEqual({ status: "unverified" });
    expect(compileCatalogScheduleScopes(input, row({ selectionMode: "licensing", targetIds: ["shared"] })))
      .toEqual({ status: "unverified" });
  });

  it("keeps domain exclusions independent of databases, and holds unknown license evidence", async () => {
    const roster = row({ selectionMode: "licensing", licensingScope: { licenseMatchMode: "any", targetTypes: "domains_and_databases",
      environment: "test", excludedDomainIds: ["shared"], licenseModuleIds: ["A"], activeOnly: false } });
    const register = vi.fn();
    const scopedInput = { ...input, inventory: [...input.inventory, inv("domain", "a", "shared", undefined, "test")] };
    const resolve = vi.fn().mockResolvedValue(scopedInput.inventory.map(() => ({ status: "verified", id: physicalId })));
    const result = await generateCatalogPersistedScheduleDay(scopedInput, { readRoster: vi.fn().mockResolvedValue(roster),
      generate: day => generateCatalogScheduleDay(day, { register, resolve }) });
    expect(result).toMatchObject({ status: "evaluated", held: 1, registered: 0 });
    expect(register).not.toHaveBeenCalled();
  });

  it("does not license a database through a same-named parent from another customer or another environment", () => {
    const scopes = row({ selectionMode: "licensing", licensingScope: { licenseMatchMode: "any", targetTypes: "databases_only",
      environment: "test", licenseModuleIds: ["A"], activeOnly: true } });
    const otherOwner = { ...input, inventory: [...input.inventory, inv("domain", "b", "shared", undefined, "test")] };
    expect(compileCatalogScheduleScopes(otherOwner, scopes)).toMatchObject({ rules: [{ scope: { linkIds: [] } }] });
  });

  it("writes separately assigned domain and database tasks while preserving the entire explicit set of users", async () => {
    const roster = row({ assignmentMode: "users", assignedUserIds: ["domain-user"], databaseAssignedUserIds: ["b", "a", "b"],
      scopeGroups: [{ clientId: "a", includeAllDomains: false,
        domains: [{ domainId: "shared", includeAllDatabases: false, databaseIds: ["same"] }] }] });
    const register = vi.fn().mockResolvedValue({ status: "registered", taskId: "task" });
    const resolve = vi.fn().mockResolvedValue(input.inventory.map(() => ({ status: "verified", id: physicalId })));
    const result = await generateCatalogPersistedScheduleDay(input, { readRoster: vi.fn().mockResolvedValue(roster),
      generate: day => generateCatalogScheduleDay(day, { register, resolve }) });
    expect(result).toMatchObject({ registered: 2, conflicts: 0 });
    const assignments = register.mock.calls.map(([entry]) => [entry.task.targetType, entry.task.assignedRole, entry.task.assignedUserIds]);
    expect(assignments).toEqual(expect.arrayContaining([
      ["domain", "domain_updater", ["domain-user"]], ["database", "database_updater", ["a", "b"]],
    ]));
  });
});
