import { beforeEach, describe, expect, it, vi } from "vitest";
import { recheckCatalogReportSagTarget } from "../lib/catalogReportSagTargetProof";

const m = vi.hoisted(() => ({ tx: {}, transaction: vi.fn(), links: vi.fn(), profiles: vi.fn(), verify: vi.fn(), ids: vi.fn() }));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: m.transaction }));
vi.mock("../lib/catalogPhysicalTargetSqlRepository", () => ({ readSqlCatalogPhysicalTargetPinsInTransaction: m.links }));
vi.mock("../lib/catalogReportingProfilesSqlRepository", () => ({ readSqlCatalogReportingProfilesInTransaction: m.profiles }));
vi.mock("../lib/catalogSagTargetRuntimeSqlRepository", () => ({ verifyCatalogSagTargetRuntimeProof: m.verify }));
vi.mock("../lib/mastersReportSqlData", () => ({ catalogReportDatabaseLinkIds: m.ids }));

const id = "fd521ec0-1019-42a1-8e3e-a817bd328e16";
const physicalLinkId = "9f100bf7-82db-45e4-b220-64ed926f88e1";
const instanceId = "2ca15298-cc36-4f06-bce4-4ed96adc40d7";
const authorizedLinkId = "0083a331-9d5a-42ac-9500-a0430df7fa5e";
const expected = {
  target: { physicalDatabaseId: id, reportingProfileId: "profile", serverGroupId: instanceId },
  connectionId: "fixture", profileVersion: "0000000000000001", expectedFingerprint: Buffer.alloc(32),
  evidence: { contract: "approved_aggregate_view_v1" as const },
};
const input = {
  portalEnvironment: "qa" as const,
  data: { clients: [], domains: [], databases: [], schedules: [], licenseModules: [], licenseAssignments: [] },
  links: [{ kind: "database" as const, customerId: "client", domainId: "domain", databaseId: "database", environment: "test" as const }],
  matchKey: Buffer.alloc(32, 1), matchKeyVersion: 2, expected, signal: new AbortController().signal,
};

beforeEach(() => {
  vi.resetAllMocks();
  m.transaction.mockImplementation(async work => work(m.tx));
  m.ids.mockReturnValue([authorizedLinkId]);
  m.links.mockResolvedValue([{ status: "verified", id, physicalLinkId }]);
  m.verify.mockResolvedValue({ targetId: id, validUntil: new Date(Date.now() + 60_000) });
  m.profiles.mockResolvedValue(new Map([[id, expected]]));
});

describe("SAG v2 report target proof", () => {
  it("uses the exact authorized database and reporting namespace in one SQL transaction", async () => {
    await expect(recheckCatalogReportSagTarget(input)).resolves.toEqual(expected);
    expect(m.ids).toHaveBeenCalledWith(input.data, "database");
    expect(m.links).toHaveBeenCalledWith(m.tx, { portalEnvironment: "qa", links: input.links });
    expect(m.verify).toHaveBeenCalledExactlyOnceWith(m.tx, {
      environment: "qa", purpose: "report", operationalLinkId: authorizedLinkId, physicalLinkId,
      physicalTargetId: id, matchKeyVersion: 2, reportInstanceId: instanceId,
    }, input.matchKey);
    expect(m.profiles).toHaveBeenCalledExactlyOnceWith(m.tx, { portalEnvironment: "qa", physicalIds: new Set([id]) });
    expect(m.transaction).toHaveBeenCalledOnce();
  });

  it("does not attempt SQL for a database outside the report authorization", async () => {
    m.ids.mockReturnValue([]);
    await expect(recheckCatalogReportSagTarget(input)).resolves.toBeNull();
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("does not read the count profile when the pinned route proof is stale or missing", async () => {
    m.verify.mockResolvedValueOnce({ targetId: id, validUntil: new Date(0) }).mockResolvedValueOnce(null);
    await expect(recheckCatalogReportSagTarget(input)).resolves.toBeNull();
    await expect(recheckCatalogReportSagTarget(input)).resolves.toBeNull();
    expect(m.profiles).not.toHaveBeenCalled();
  });

  it("rejects a verified route without an independent current profile", async () => {
    m.profiles.mockResolvedValue(new Map());
    await expect(recheckCatalogReportSagTarget(input)).resolves.toBeNull();
  });
});
