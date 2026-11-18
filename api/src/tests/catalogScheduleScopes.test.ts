import { describe, expect, it, vi } from "vitest";
import { generateCatalogPersistedScheduleDay, compileCatalogScheduleScopes } from "../lib/catalogScheduleScopes";
import { generateCatalogScheduleDay } from "../lib/catalogScheduleDay";
import type { UpdateSchedule } from "../types/models";
import type { CatalogTaskLink } from "../lib/catalogTaskTargetPlanning";

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
