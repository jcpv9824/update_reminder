import { describe, expect, it, vi } from "vitest";
import { loadCatalogMastersActiveUsers } from "../lib/catalogMastersActiveUsers";
import type { ResolveCertifiedCatalogActiveUserSqlTarget } from "../lib/catalogActiveUserSqlReader";
import type { SqlMastersReportData } from "../lib/mastersReportSqlData";

const physical = "406ab958-6da4-4525-ada7-30d6f1c199d3";
const target = { physicalDatabaseId: physical, reportingProfileId: "qa-profile", serverGroupId: "group" };
const connection = { id: "connection", etag: "version", active: true, status: "active",
  encrypt: true, passwordConfigured: true, passwordSecretName: "synthetic-reference",
  serverHost: "example.test", serverPort: 1433, databaseName: "example", username: "readOnly" };
const profile = { target, profileVersion: "version", connectionId: "connection",
  expectedFingerprint: Buffer.alloc(32, 1), evidence: { contract: "approved_aggregate_view_v1" as const } };
const masters = {
  clients: [{ id: "a", name: "Empresa A", status: "active" }, { id: "b", name: "Empresa B", status: "active" }],
  domains: [{ id: "da", clientId: "a", status: "active" }, { id: "db", clientId: "b", status: "active" }],
  databases: [
    { id: "one", clientId: "a", domainId: "da", environment: "test", status: "active", dbAccess: { initialCatalog: "Db One" } },
    { id: "two", clientId: "b", domainId: "db", environment: "production", status: "active", dbAccess: { initialCatalog: "Db alias" } },
    { id: "three", clientId: "a", domainId: "da", environment: "production", status: "active", dbAccess: { initialCatalog: "Not verified" } },
    { id: "wrong", clientId: "b", domainId: "da", environment: "production", status: "active", dbAccess: { initialCatalog: "Other client" } },
  ],
} as unknown as SqlMastersReportData;

function setup() {
  const observed = vi.fn();
  return { observed, io: {
    readTargets: vi.fn().mockResolvedValue([{ status: "verified", id: physical }, { status: "verified", id: physical }])
      .mockResolvedValueOnce([{ status: "verified", id: physical },
        { status: "verified", id: physical }, { status: "unverifiable" }]),
    readProfiles: vi.fn().mockResolvedValue(new Map([[physical, profile]])),
    readConnection: vi.fn().mockResolvedValue(connection),
    readSecret: vi.fn().mockResolvedValue("synthetic-value"),
    createReader: vi.fn((resolve: ResolveCertifiedCatalogActiveUserSqlTarget) => async (ref: typeof target, signal: AbortSignal) => {
      const certified = await resolve(ref, signal);
      observed(certified);
      if (!certified) throw new Error("Unavailable");
      return 0;
    }),
  } };
}

describe("active users in the authorized masters report", () => {
  it("counts one physical database across authorized clients and leaves unknown targets unavailable", async () => {
    const { io, observed } = setup();
    const report = await loadCatalogMastersActiveUsers(masters, "qa", io);
    expect(io.readProfiles).toHaveBeenCalledWith({ portalEnvironment: "qa", physicalIds: new Set([physical]) });
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({
      identity: { instanceId: target.serverGroupId, expectedFingerprint: profile.expectedFingerprint },
    }));
    expect(report.rows.map(row => [row.databaseLinkId, row.status, row.activeUsers])).toEqual([
      ["one", "available", 0], ["two", "available", 0], ["three", "unavailable", null],
    ]);
    expect(report.summary).toMatchObject({ activeUsers: 0, verifiedCounts: 1, partial: true });
    expect(JSON.stringify(report)).not.toMatch(/synthetic-value|synthetic-reference|example\.test|reportingProfileId/);
  });

  it("never requests the password of a reporting profile that changed after the lookup", async () => {
    const { io } = setup();
    io.readConnection.mockResolvedValue({ ...connection, etag: "different" });
    const result = await loadCatalogMastersActiveUsers(masters, "qa", io);
    expect(io.readSecret).not.toHaveBeenCalled();
    expect(result.rows.every(row => row.status === "unavailable")).toBe(true);
    expect(result.summary.activeUsers).toBeNull();
  });

  it("does not resolve credentials when a proof retires or expires before dispatch", async () => {
    const { io } = setup();
    io.readProfiles.mockResolvedValueOnce(new Map([[physical, profile]])).mockResolvedValue(new Map());
    const result = await loadCatalogMastersActiveUsers(masters, "qa", io);
    expect(io.readConnection).not.toHaveBeenCalled();
    expect(io.readSecret).not.toHaveBeenCalled();
    expect(result.summary).toMatchObject({ activeUsers: null, verifiedCounts: 0, partial: true });
  });

  it("discards a count if an exact alias loses eligibility while the SQL reader is in flight", async () => {
    const { io, observed } = setup();
    io.readTargets.mockResolvedValueOnce([{ status: "verified", id: physical }, { status: "verified", id: physical }])
      .mockResolvedValue([{ status: "verified", id: physical }, { status: "unverifiable" }]);
    const result = await loadCatalogMastersActiveUsers(masters, "qa", io);
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ target }));
    expect(result.rows.every(row => row.status === "unavailable")).toBe(true);
    expect(result.summary.activeUsers).toBeNull();
  });
});
