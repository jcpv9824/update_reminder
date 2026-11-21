import { describe, expect, it } from "vitest";
import type { UpdateSchedule } from "../types/models";
import { reconcileScheduleActivation } from "../lib/catalogScheduleActivation";
import { resolveCatalogScheduleDynamicCutoff } from "../lib/catalogScheduleDynamicCutoff";
import type { CatalogScheduleHistoricalLinkProof as Link } from "../lib/catalogScheduleHistoricalLinkProofSqlRepository";

const asOf = new Date("2026-11-20T05:00:00Z");
const manual: UpdateSchedule = {
  id: "schedule-1", clientId: "A", clientName: "Cliente A", targetType: "domain", targetIds: [],
  frequencyType: "once", startDate: "2026-11-20", timezone: "America/Bogota", active: true,
  assignedRole: "support", assignedUserIds: ["u1"], databaseAssignedUserIds: ["u2"], assignmentMode: "users",
  createdAt: "2026-11-19T01:00:00Z", updatedAt: "2026-11-19T01:00:00Z", createdBy: "author", updatedBy: "author",
  selectionMode: "manual", manualEnvironment: "production", manualTargetTypes: "domains_and_databases",
  scopeGroups: [{ clientId: "A", includeAllDomains: false, domains: [{ domainId: "host-a", includeAllDatabases: true, databaseIds: [] }] }],
};
const licensed: UpdateSchedule = {
  ...manual, scopeGroups: [], selectionMode: "licensing",
  licensingScope: {
    licenseModuleIds: ["inventory", "accounting"], licenseMatchMode: "all", activeOnly: true, environment: "production",
    targetTypes: "domains_and_databases", excludedDomainIds: ["host-a"],
  },
};
const proof = (linkId: string, fields: Partial<Link> = {}): Link => ({
  linkId, clientId: "A", clientName: "Cliente A", domainId: "host-a", domainName: "shared.example.test",
  targetId: "host-a", targetName: "shared.example.test", kind: "domain", state: "eligible",
  environment: "production", verifiedTargetId: `physical-${linkId}`, historicalModuleIds: ["inventory", "accounting"], ...fields,
});
const host = proof("web");
const database = proof("db", { kind: "database", targetId: "db-a", targetName: "Accounts" });
const other = proof("other-domain", { clientId: "B", domainId: "host-b", targetId: "host-b", verifiedTargetId: host.verifiedTargetId });
const inTest = proof("test-db", { ...database, linkId: "test-db", environment: "test", historicalModuleIds: null });
const evidence = (links: readonly Link[], linkIds = links.filter(link => link.state !== "absent").map(link => link.linkId)) => ({
  links, linkIds, asOf, validUntil: new Date(asOf.valueOf() + 60_000),
  ownerStates: new Map<string, "eligible" | "absent">([["A", "eligible"]]),
  activeLicenseIds: new Set(["inventory", "accounting"]),
});
const freeze = (schedule: UpdateSchedule, rows: ReturnType<typeof evidence>) => {
  const candidate = resolveCatalogScheduleDynamicCutoff(schedule, rows);
  const state = reconcileScheduleActivation({ startDate: schedule.startDate, createdAt: Date.parse(schedule.createdAt),
    members: candidate.previousMembers }, asOf.valueOf(), candidate.evidence);
  return { candidate, state };
};

describe("historical dynamic catalog scope at the Bogotá cutoff", () => {
  it("uses exact client/domain/environment relations with independent frozen assignees", () => {
    const { candidate, state } = freeze(manual, evidence([host, database, other, inTest]));
    expect(state).toMatchObject({ phase: "frozen", members: [{ linkId: "db", state: "eligible" }, { linkId: "web", state: "eligible" }] });
    expect(candidate.responsibles).toEqual([
      { targetKind: "domain", principalKind: "user", principalId: "u1" },
      { targetKind: "database", principalKind: "user", principalId: "u2" },
    ]);
  });

  it("retains explicit historical retirements and freezes only surviving work", () => {
    const retired = { ...database, state: "absent" as const, verifiedTargetId: null };
    const selection = { ...manual, scopeGroups: [{ clientId: "A", includeAllDomains: false,
      domains: [{ domainId: "host-a", includeAllDatabases: false, databaseIds: ["db-a"] }] }] };
    expect(freeze(selection, evidence([host, retired])).state).toMatchObject({ phase: "frozen", members: [
      { linkId: "db", state: "absent" }, { linkId: "web", state: "eligible" },
    ] });
    expect(freeze({ ...selection, manualTargetTypes: "databases_only" }, evidence([host, retired])).state.phase).toBe("cancelled");
    expect(freeze(selection, evidence([host])).state.phase).toBe("held");
  });

  it("applies all/any with historical modules and separates parent exclusion from database exclusion", () => {
    const accountingOnly = { ...database, historicalModuleIds: ["accounting"] };
    expect(freeze(licensed, evidence([host, accountingOnly, inTest])).state.phase).toBe("cancelled");
    expect(freeze({ ...licensed, licensingScope: { ...licensed.licensingScope!, licenseMatchMode: "any" } },
      evidence([host, accountingOnly, inTest])).state).toMatchObject({ phase: "frozen", members: [{ linkId: "db", state: "eligible" }] });
    expect(freeze(licensed, evidence([host, { ...database, historicalModuleIds: [] }])).state.phase).toBe("cancelled");
    expect(freeze(licensed, evidence([host, { ...database, historicalModuleIds: null }])).state.phase).toBe("held");
    expect(freeze(licensed, { ...evidence([host, database]), activeLicenseIds: new Set(["inventory"]) }).state.phase).toBe("held");
  });

  it("holds an incomplete or later population, including an unknown sibling next to a survivor", () => {
    expect(freeze(manual, { ...evidence([host, database]), asOf: new Date(asOf.valueOf() + 1) }).state.phase).toBe("held");
    expect(freeze({ ...manual, updatedAt: new Date(asOf.valueOf() + 1).toISOString() }, evidence([host, database])).state.phase).toBe("held");
    expect(freeze(manual, evidence([host], ["web", "db"])).state.phase).toBe("held");
    expect(freeze(manual, evidence([host, database], ["web"])).state.phase).toBe("held");
    expect(freeze(manual, evidence([host, database, { ...database, linkId: "second-db", state: "unverifiable",
      verifiedTargetId: null }])).state.phase).toBe("held");
    expect(freeze(licensed, evidence([database, other])).state.phase).toBe("held");
    expect(freeze(licensed, evidence([database, { ...host, environment: "test" }])).state.phase).toBe("held");
  });
  it("accepts the SQL approval cut for a same-day licensed draft but does not backdate other schedules", () => {
    const approval = new Date(asOf.valueOf() + 30 * 60_000);
    const createdAt = new Date(asOf.valueOf() + 20 * 60_000).toISOString();
    const schedule = { ...licensed, createdAt, updatedAt: createdAt };
    const current = { ...evidence([host, database]), asOf: approval, validUntil: new Date(approval.valueOf() + 1_000) };
    expect(resolveCatalogScheduleDynamicCutoff(schedule, current).evidence).toBeUndefined();
    expect(resolveCatalogScheduleDynamicCutoff(schedule, current, approval).evidence?.targets)
      .toEqual([{ linkId: "db", state: "eligible" }]);
    expect(resolveCatalogScheduleDynamicCutoff(schedule, current, new Date(approval.valueOf() + 1)).evidence).toBeUndefined();
    expect(resolveCatalogScheduleDynamicCutoff(licensed, current, approval).evidence).toBeUndefined();
  });
});
