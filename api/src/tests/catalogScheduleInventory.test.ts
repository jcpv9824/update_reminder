import { describe, expect, it, vi } from "vitest";
import { composeCatalogScheduleInventory, generateApprovedCatalogOperationalScheduleDay,
  generateCatalogOperationalScheduleDay } from "../lib/catalogScheduleInventory";
import type { CatalogOperationalLink } from "../lib/catalogOperationalLinksSqlRepository";
import { generateCatalogScheduleDay, type CatalogScheduleDay } from "../lib/catalogScheduleDay";
import type { UpdateSchedule } from "../types/models";

const { readSagEvidence } = vi.hoisted(() => ({ readSagEvidence: vi.fn() }));
vi.mock("../lib/catalogSagCustomerEvidenceSqlRepository", () => ({ readSqlCatalogSagCustomerEvidence: readSagEvidence }));

const date = "2030-06-22";
const checkedAt = new Date("2030-06-22T05:00:00.000Z");
const version = "0000000000000001";
const physicalId = "31140f4d-81c3-4938-9ab2-a275473feb17";
const linkA = "11140f4d-81c3-4938-9ab2-a275473feb17";
const linkB = "21140f4d-81c3-4938-9ab2-a275473feb17";
const sourceA = "41140f4d-81c3-4938-9ab2-a275473feb17";
const sourceB = "51140f4d-81c3-4938-9ab2-a275473feb17";
const links: CatalogOperationalLink[] = [0, 1].map(index => ({
  linkId: index ? linkB : linkA, catalogCustomerId: index ? linkB : linkA,
  customerId: `client-${index}`, customerName: `Client ${index}`, domainId: `domain-${index}`,
  domainName: "https://shared.example.test", catalogRecordId: index ? "-2147483648" : "2147483647",
  kind: "domain", environment: index ? "test" : "production",
  evidence: { state: "verified", sourceId: index ? sourceB : sourceA, revisionId: "9007199254740993",
    bindingVersion: version, profileVersion: "0000000000000002", verifiedUntil: "2031-01-01T00:00:00.000Z" },
}));
const input = { date, checkedAt, cutoffAt: new Date("2030-06-23T05:00:00.000Z"), portalEnvironment: "qa" as const,
  operationsBySchedule: new Map([["schedule", { operationId: "release", scheduleVersion: version }]]),
  activeLicenseIds: new Set(["sales"]),
};
const schedule = {
  id: "schedule", clientId: "client-0", clientName: "Client 0", targetType: "domain", targetIds: [],
  frequencyType: "once", startDate: date, timezone: "America/Bogota", active: true,
  assignedRole: "domain_updater", assignedUserIds: [], manualTargetTypes: "domains_only",
  scopeGroups: [{ clientId: "client-0", includeAllDomains: true, domains: [] },
    { clientId: "client-1", includeAllDomains: true, domains: [] }],
} as unknown as UpdateSchedule;

function dependencies(rows = links, complete = true, licensed = true) {
  const register = vi.fn().mockResolvedValue({ status: "registered", taskId: "written" });
  const resolve = vi.fn().mockResolvedValue(rows.map(() => ({ status: "verified", id: physicalId })));
  const generate = vi.fn((day: CatalogScheduleDay) => generateCatalogScheduleDay(day, { register, resolve }));
  const readRoster = vi.fn().mockResolvedValue([{ schedule, version }]);
  return {
    register, resolve, readRoster, generate,
    io: {
      readLinks: vi.fn().mockResolvedValue(rows),
      certifyCoverage: vi.fn().mockResolvedValue({ id: "certified-population", complete }),
      readLicenseProof: vi.fn().mockResolvedValue(new Map(rows.map(row => [row.linkId, licensed ? ["sales"] : null]))),
      persisted: { readRoster, generate },
    },
  };
}

describe("operational schedule inventory composition", () => {
  it("preserves every alias, external record and exact source witness without inventing physical proof", () => {
    const inventory = composeCatalogScheduleInventory(links, new Map([[linkA, ["sales"]]]), checkedAt);
    expect(inventory.map(row => row.link.linkId)).toEqual([linkA, linkB]);
    expect(inventory[0]).toMatchObject({ sourceId: sourceA, clientName: "Client 0",
      domainName: links[0].domainName, targetName: links[0].domainName,
      link: { state: "active", customerId: "client-0", domainId: "domain-0", kind: "domain",
        catalogRecordId: "2147483647", environment: "production", moduleIds: ["sales"], target: { status: "unverifiable" } },
      sourceEvidence: { sourceId: sourceA, revisionId: "9007199254740993", bindingVersion: version,
        profileVersion: "0000000000000002", verifiedUntil: "2031-01-01T00:00:00.000Z" },
    });
    expect(inventory[1].link.moduleIds).toBeNull();
    expect(inventory[1].link.catalogRecordId).toBe("-2147483648");
    expect(inventory[1].link.environment).toBe("test");
    expect(inventory[1].sourceId).toBe(sourceB);
  });

  it("retains unverifiable and expired edges solely as nonregistrable holds, never local authorization", () => {
    const expired = { ...links[1], evidence: { ...links[1].evidence, state: "verified", verifiedUntil: checkedAt.toISOString() } } as CatalogOperationalLink;
    const inventory = composeCatalogScheduleInventory([{ ...links[0], evidence: { state: "unverifiable" } }, expired], new Map(), checkedAt);
    expect(inventory).toHaveLength(2);
    for (const row of inventory) {
      expect(row.sourceId).toBeNull();
      expect(row.link.state).toBe("unverifiable");
      expect(row).not.toHaveProperty("sourceEvidence");
      expect(row.link.target.status).toBe("unverifiable");
    }
  });

  it("keeps database aliases and their local display name distinct from catalog identity", () => {
    const database = { ...links[0], kind: "database" as const, databaseId: "database-stable", databaseName: "Company label" };
    const [row] = composeCatalogScheduleInventory([database], new Map([[linkA, []]]), checkedAt);
    expect(row.link).toMatchObject({ kind: "database", databaseId: "database-stable", customerId: "client-0", moduleIds: [] });
    expect(row.targetName).toBe("Company label");
  });

  it("rejects duplicate aliases, foreign license proof, overflow and incomplete verified witnesses", () => {
    expect(() => composeCatalogScheduleInventory([links[0], links[0]], new Map(), checkedAt)).toThrow("unverified");
    expect(() => composeCatalogScheduleInventory(links, new Map([["foreign", ["sales"]]]), checkedAt)).toThrow("unverified");
    expect(() => composeCatalogScheduleInventory(Array(5001).fill(links[0]), new Map(), checkedAt)).toThrow("unverified");
    for (const field of ["sourceId", "revisionId", "bindingVersion", "profileVersion", "verifiedUntil"]) {
      const malformed = { ...links[0], evidence: { ...links[0].evidence, [field]: undefined } } as unknown as CatalogOperationalLink;
      expect(() => composeCatalogScheduleInventory([malformed], new Map(), checkedAt)).toThrow("unverified");
    }
  });
});

describe("integration with the existing persisted schedule generator", () => {
  it("loads one exact SQL roster and uses its approved operation instead of a caller-supplied map", async () => {
    const deps = dependencies();
    const readOperations = vi.fn().mockResolvedValue(new Map([["schedule", { operationId: "sql-approved", scheduleVersion: version }]]));
    expect(await generateApprovedCatalogOperationalScheduleDay(input, { ...deps.io, readOperations }))
      .toMatchObject({ registered: 1 });
    expect(deps.readRoster).toHaveBeenCalledExactlyOnceWith(date);
    expect(readOperations).toHaveBeenCalledExactlyOnceWith("qa", [{ scheduleId: "schedule", scheduleVersion: version }]);
    expect(deps.register.mock.calls[0][0].group.operationId).toBe("sql-approved");
  });

  it("performs no generation without approval and no SQL operation read after cutoff", async () => {
    const deps = dependencies();
    const readOperations = vi.fn().mockResolvedValue(new Map());
    expect(await generateApprovedCatalogOperationalScheduleDay(input, { ...deps.io, readOperations })).toEqual({ status: "unverified" });
    expect(deps.register).not.toHaveBeenCalled();
    readOperations.mockClear();
    deps.readRoster.mockClear();
    expect(await generateApprovedCatalogOperationalScheduleDay({ ...input, checkedAt: input.cutoffAt }, { ...deps.io, readOperations }))
      .toEqual({ status: "cutoff" });
    expect(readOperations).not.toHaveBeenCalled();
    expect(deps.readRoster).not.toHaveBeenCalled();
  });
  it("uses the existing cutoff policy without any inventory, coverage, licensing or roster I/O", async () => {
    const deps = dependencies();
    expect(await generateCatalogOperationalScheduleDay({ ...input, checkedAt: input.cutoffAt }, deps.io))
      .toEqual({ status: "cutoff" });
    expect(deps.io.readLinks).not.toHaveBeenCalled();
    expect(deps.io.certifyCoverage).not.toHaveBeenCalled();
    expect(deps.io.readLicenseProof).not.toHaveBeenCalled();
    expect(deps.readRoster).not.toHaveBeenCalled();
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(deps.register).not.toHaveBeenCalled();
    expect(deps.generate.mock.calls[0][0]).toMatchObject({ revision: { complete: false }, inventory: [], rules: [] });
  });

  it("uses trusted coverage/license providers and the real persisted engine to deduplicate physically, preserving both aliases", async () => {
    const deps = dependencies();
    const result = await generateCatalogOperationalScheduleDay(input, deps.io);
    expect(result).toMatchObject({ status: "evaluated", registered: 1, held: 0, conflicts: 0 });
    expect(deps.io.readLinks).toHaveBeenCalledWith({ portalEnvironment: "qa" });
    expect(deps.io.certifyCoverage).toHaveBeenCalledWith({ portalEnvironment: "qa", date, checkedAt, links });
    expect(deps.io.readLicenseProof).toHaveBeenCalledWith({ portalEnvironment: "qa", date, checkedAt, links });
    expect(deps.readRoster).toHaveBeenCalledWith(date);
    expect(deps.register).toHaveBeenCalledOnce();
    const write = deps.register.mock.calls[0][0];
    expect(write.group.sources.map((source: { link: { linkId: string } }) => source.link.linkId)).toEqual([linkA, linkB]);
    expect([...write.catalogSourceIdsByLink]).toEqual([[linkA, sourceA], [linkB, sourceB]]);
    expect([...write.catalogEvidenceByLink]).toEqual(links.map(link => {
      const { state: _state, ...proof } = link.evidence;
      return [link.linkId, proof];
    }));
    expect(deps.generate.mock.calls[0][0].inventory.map(row => row.link.environment)).toEqual(["production", "test"]);
    expect(deps.generate.mock.calls[0][0].inventory.map(row => row.sourceId)).not.toContain(null);
  });

  it("incomplete explicit coverage causes zero roster reads, resolution or writes even with otherwise verified rows", async () => {
    const deps = dependencies(links, false);
    expect(await generateCatalogOperationalScheduleDay(input, deps.io)).toEqual({ status: "unverified" });
    expect(deps.io.readLicenseProof).not.toHaveBeenCalled();
    expect(deps.readRoster).not.toHaveBeenCalled();
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(deps.register).not.toHaveBeenCalled();
  });

  it("an empty read is not complete without explicit coverage and a failed read never certifies anything", async () => {
    const deps = dependencies([], false);
    expect(await generateCatalogOperationalScheduleDay(input, deps.io)).toEqual({ status: "unverified" });
    expect(deps.register).not.toHaveBeenCalled();
    deps.io.readLinks.mockRejectedValueOnce(new Error("catalog_operational_links_unavailable"));
    deps.io.certifyCoverage.mockClear();
    await expect(generateCatalogOperationalScheduleDay(input, deps.io)).rejects.toThrow("unavailable");
    expect(deps.io.certifyCoverage).not.toHaveBeenCalled();
  });

  it("unverifiable rows stay held despite physical proof and never reach registration with null sourceId", async () => {
    const deps = dependencies(links.map(row => ({ ...row, evidence: { state: "unverifiable" } })));
    expect(await generateCatalogOperationalScheduleDay(input, deps.io)).toMatchObject({ registered: 0, held: 2 });
    expect(deps.generate.mock.calls[0][0].inventory).toHaveLength(2);
    expect(deps.register).not.toHaveBeenCalled();
  });

  it("unknown licensing remains null and held under persisted licensing scopes, not silently an empty approved set", async () => {
    const deps = dependencies(links, true, false);
    deps.readRoster.mockResolvedValue([{ version, schedule: { ...schedule, scopeGroups: undefined,
      selectionMode: "licensing", licensingScope: { targetTypes: "domains_only", environment: "all",
        licenseModuleIds: ["sales"], licenseMatchMode: "all", activeOnly: true } } }]);
    expect(await generateCatalogOperationalScheduleDay(input, deps.io)).toMatchObject({ status: "evaluated", registered: 0, held: 2 });
    expect(deps.register).not.toHaveBeenCalled();
    expect(deps.generate.mock.calls[0][0].inventory.every(row => row.link.moduleIds === null)).toBe(true);
  });

  it("uses exact ERP sources for default license planning and binds the same enrollment to registration", async () => {
    const deps = dependencies();
    deps.readRoster.mockResolvedValue([{ version, schedule: { ...schedule, scopeGroups: undefined,
      selectionMode: "licensing", licensingScope: { targetTypes: "domains_only", environment: "all",
        licenseModuleIds: ["sales"], licenseMatchMode: "all", activeOnly: true } } }]);
    readSagEvidence.mockReset();
    readSagEvidence.mockImplementation(async ({ customerId }) => ({
      state: "verified", verifiedAt: "2020-01-01T00:00:00.000Z",
      items: [{ domainCandidate: "shared.example.test", environment: customerId === linkA ? "production" : "test",
        licenseCodes: ["A"], productionStartedOn: null, testStartedOn: null, demoStartedOn: null }],
      licenseModules: [{ code: "A", moduleId: "sales", name: "Sales", description: null }],
    }));
    expect(await generateCatalogOperationalScheduleDay({ ...input, matchKeyVersion: 7 }, { ...deps.io, readLicenseProof: undefined }))
      .toMatchObject({ status: "evaluated", registered: 1 });
    expect(readSagEvidence.mock.calls.map(([scope]) => ({ ...scope, allowedSourceIds: [...scope.allowedSourceIds] }))).toEqual([
      { customerId: linkA, environment: "qa", matchKeyVersion: 7, allowedSourceIds: [sourceA] },
      { customerId: linkB, environment: "qa", matchKeyVersion: 7, allowedSourceIds: [sourceB] },
    ]);
    expect(deps.register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ matchKeyVersion: 7 }));
  });

  it("holds licensed work when default proof has no server-trusted enrollment", async () => {
    const deps = dependencies();
    deps.readRoster.mockResolvedValue([{ version, schedule: { ...schedule, scopeGroups: undefined,
      selectionMode: "licensing", licensingScope: { targetTypes: "domains_only", environment: "all",
        licenseModuleIds: ["sales"], licenseMatchMode: "all", activeOnly: true } } }]);
    expect(await generateCatalogOperationalScheduleDay(input, { ...deps.io, readLicenseProof: undefined }))
      .toMatchObject({ status: "evaluated", registered: 0, held: 2 });
    expect(deps.register).not.toHaveBeenCalled();
  });

  it("does not infer coverage when the trusted provider omits certification", async () => {
    const deps = dependencies();
    deps.io.certifyCoverage.mockResolvedValue(undefined);
    await expect(generateCatalogOperationalScheduleDay(input, deps.io)).rejects.toThrow("unverified");
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.register).not.toHaveBeenCalled();
  });

  it("failed licensing proof cannot reach generation or registration", async () => {
    const deps = dependencies();
    deps.io.readLicenseProof.mockRejectedValueOnce(new Error("license_evidence_unavailable"));
    await expect(generateCatalogOperationalScheduleDay(input, deps.io)).rejects.toThrow("license_evidence_unavailable");
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.register).not.toHaveBeenCalled();
  });
});
