import { describe, expect, it, vi } from "vitest";
import { certifyCatalogReportingProfile } from "../lib/catalogReportingProfileCertification";
import type { ResolveCertifiedCatalogActiveUserSqlTarget } from "../lib/catalogActiveUserSqlReader";
import type { CatalogActiveUserTarget } from "../lib/catalogActiveUserReport";

const args = {
  portalEnvironment: "qa", targetId: "912746b5-2e50-46ff-9135-f16ef53d677e", connectionId: "approved-qa-profile",
  evidence: { contract: "approved_aggregate_view_v1" }, actor: { id: "qa" },
} as const;
const trustedInstanceId = "33619f05-f1a3-4149-8a0a-9000b5126bbe";
const registry = JSON.stringify([{ environment: "qa", host: "fixture.invalid", port: 1433, instanceId: trustedInstanceId }]);
const expected = Buffer.alloc(32, 4);
function setup() {
  const inspect = vi.fn();
  const io = {
    readInstanceRoutes: vi.fn().mockReturnValue(registry),
    readDestination: vi.fn().mockResolvedValue({ fingerprint: expected, instanceId: trustedInstanceId }),
    readConnection: vi.fn().mockResolvedValue({ id: args.connectionId, active: true, status: "active", encrypt: true,
      passwordConfigured: true, passwordSecretName: "synthetic", etag: "0102030405060708",
      serverHost: "fixture.invalid", serverPort: 1433, databaseName: "fixture", username: "read" }),
    readSecret: vi.fn().mockResolvedValue("fixture-not-a-key"),
    createReader: vi.fn((resolve: ResolveCertifiedCatalogActiveUserSqlTarget) => async (target: CatalogActiveUserTarget, signal: AbortSignal) => {
      inspect(await resolve(target, signal));
      return 11;
    }),
    register: vi.fn().mockResolvedValue({ status: "registered", reportingProfileId: "new-opaque" }),
  };
  return { inspect, io };
}

describe("reporting profile certification orchestration", () => {
  it("requires a completed same-connection metadata/count check and persists no count or connection data", async () => {
    const { inspect, io } = setup();
    expect(await certifyCatalogReportingProfile(args, io)).toMatchObject({ status: "registered" });
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({
      identity: { instanceId: trustedInstanceId, expectedFingerprint: expected }, evidence: args.evidence,
    }));
    expect(io.register).toHaveBeenCalledWith(expect.objectContaining({ targetId: args.targetId,
      profileVersion: Buffer.from("0102030405060708", "hex"), identityFingerprint: expected, trustedInstanceId }));
    const written = io.register.mock.calls[0][0];
    expect(written).not.toHaveProperty("connection");
    expect(written).not.toHaveProperty("activeUsers");
    expect(JSON.stringify(written)).not.toMatch(/fixture-not-a-key|fixture\.invalid/);
  });

  it("does not persist if the probe fails or target is missing", async () => {
    const { io } = setup();
    io.createReader.mockReturnValueOnce(async () => { throw new Error("private"); });
    expect(await certifyCatalogReportingProfile(args, io)).toEqual({ status: "unavailable" });
    io.readDestination.mockResolvedValueOnce(null);
    expect(await certifyCatalogReportingProfile(args, io)).toEqual({ status: "unavailable" });
    expect(io.register).not.toHaveBeenCalled();
  });

  it("does not use a caller-supplied namespace or load a secret for an unapproved route", async () => {
    const { io } = setup();
    io.readInstanceRoutes.mockReturnValue(undefined);
    const injected = { ...args, trustedInstanceId };
    expect(await certifyCatalogReportingProfile(injected, io)).toEqual({ status: "unavailable" });
    expect(io.readSecret).not.toHaveBeenCalled();
    expect(io.createReader).not.toHaveBeenCalled();
    expect(io.register).not.toHaveBeenCalled();
  });

  it("does not probe a route that maps to a different namespace than the recorded destination", async () => {
    const { io } = setup();
    io.readDestination.mockResolvedValue({ fingerprint: expected, instanceId: args.targetId });
    expect(await certifyCatalogReportingProfile(args, io)).toEqual({ status: "unavailable" });
    expect(io.readSecret).not.toHaveBeenCalled();
    expect(io.createReader).not.toHaveBeenCalled();
    expect(io.register).not.toHaveBeenCalled();
  });

  it("discards a completed probe when its approved route changes during verification", async () => {
    const { io } = setup();
    io.register.mockClear();
    io.createReader.mockImplementationOnce(resolve => async (target, signal) => {
      expect(await resolve(target, signal)).not.toBeNull();
      io.readInstanceRoutes.mockReturnValue("[]");
      return 11;
    });
    expect(await certifyCatalogReportingProfile(args, io)).toEqual({ status: "unavailable" });
    expect(io.register).not.toHaveBeenCalled();
  });
});
