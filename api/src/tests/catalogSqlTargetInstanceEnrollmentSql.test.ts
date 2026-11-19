import sql from "mssql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fingerprintCatalogSqlTarget } from "../lib/catalogPhysicalTargetIdentity";
import { CatalogSqlTargetInstanceEnrollmentRollbackRequired, enrollCatalogSqlTargetInstanceInTransaction }
  from "../lib/catalogSqlTargetInstanceEnrollmentSql";

const actorId = "fixture-operator";
const physicalLinkId = "40000000-0000-0000-0000-000000000001";
const physicalTargetId = "40000000-0000-0000-0000-000000000002";
const trustedInstanceId = "40000000-0000-0000-0000-000000000003";
const databaseGuid = "40000000-0000-0000-0000-00000000a004";
const proofId = "40000000-0000-0000-0000-000000000005";
const now = new Date("2026-11-18T17:00:00.000Z");
const verifiedAt = new Date(now.getTime() - 10);
const validUntil = new Date(now.getTime() + 240_000);
const route = { serverHost: "Sql.Example.test", serverPort: 1433, databaseName: "QA Ñ ERP" };
const identity = fingerprintCatalogSqlTarget({ instanceId: trustedInstanceId, databaseGuid });
const pins = {
  environment: "qa", actorId, physicalLinkId, physicalTargetId, reportConnectionId: "fixture-report",
  operationalProfileVersion: Buffer.alloc(8, 1), reportProfileVersion: Buffer.alloc(8, 2), reportRoute: route,
  trustedInstanceId, expectedIdentityFingerprint: identity,
  proof: { proofId, databaseGuid, verifiedAt, validUntil },
};
const expectedRouteFingerprint = Buffer.from("943bceb0139e8eb2567f41fafed001f66f73e19cca6f3dd12b2254d6177b0716", "hex");

function result(status: unknown = "enrolled") {
  return { recordsets: [], recordset: undefined, rowsAffected: [], returnValue: 0, output: { result: status } };
}

function fakeOperator(reply: () => unknown = () => result()) {
  const bindings: unknown[][] = [];
  const outputs: unknown[][] = [];
  const observed: unknown[][] = [];
  const execute = vi.fn(async (_procedure: string) => {
    await Promise.resolve();
    observed.push(...bindings.map(args => args.map(value => Buffer.isBuffer(value) ? Buffer.from(value) : value)));
    return reply();
  });
  const request = vi.fn(() => ({
    input: (...args: unknown[]) => { bindings.push(args); },
    output: (...args: unknown[]) => { outputs.push(args); },
    execute,
  }));
  const operator = { request } as unknown as sql.Transaction;
  return { operator, request, execute, bindings, outputs, observed };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());

describe("058 private report enrollment RPC", () => {
  it("uses exactly the supplied transaction, output and fixed typed parameters with byte-exact SQL route fingerprint", async () => {
    const { operator, request, execute, bindings, outputs, observed } = fakeOperator();
    expect(await enrollCatalogSqlTargetInstanceInTransaction(operator, pins)).toBe("enrolled");
    expect(request).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledExactlyOnceWith("settings.enroll_catalog_sql_target_instance_internal");
    expect(outputs).toEqual([["result", sql.VarChar(32)]]);
    expect(observed).toEqual([
      ["environment", sql.VarChar(32), "qa"], ["actorId", sql.NVarChar(150), actorId],
      ["physicalLinkId", sql.UniqueIdentifier, physicalLinkId], ["physicalTargetId", sql.UniqueIdentifier, physicalTargetId],
      ["operationalProfileVersion", sql.VarBinary(32), pins.operationalProfileVersion],
      ["reportConnectionId", sql.NVarChar(150), pins.reportConnectionId], ["reportProfileVersion", sql.VarBinary(32), pins.reportProfileVersion],
      ["reportRouteFingerprint", sql.VarBinary(64), expectedRouteFingerprint], ["trustedInstanceId", sql.UniqueIdentifier, trustedInstanceId],
      ["verifiedDatabaseGuid", sql.UniqueIdentifier, databaseGuid], ["identityFingerprint", sql.VarBinary(64), identity],
      ["proofId", sql.UniqueIdentifier, proofId], ["verifiedAt", sql.DateTime2(3), verifiedAt], ["validUntil", sql.DateTime2(3), validUntil],
    ]);
    for (const [,,value] of bindings) if (Buffer.isBuffer(value)) expect(value).toEqual(Buffer.alloc(value.length));
    expect(pins.expectedIdentityFingerprint).toEqual(fingerprintCatalogSqlTarget({ instanceId: trustedInstanceId, databaseGuid }));
    expect(pins.operationalProfileVersion).toEqual(Buffer.alloc(8, 1));
    expect(pins.reportProfileVersion).toEqual(Buffer.alloc(8, 2));
  });

  it("returns only normalized success literals and preserves one stored route byte-for-byte", async () => {
    const first = fakeOperator(() => result("already-enrolled"));
    await expect(enrollCatalogSqlTargetInstanceInTransaction(first.operator, pins)).resolves.toBe("already-enrolled");
    const second = fakeOperator();
    await enrollCatalogSqlTargetInstanceInTransaction(second.operator, { ...pins,
      reportRoute: { ...route, serverHost: route.serverHost.toLowerCase() } });
    expect(second.observed.find(([name]) => name === "reportRouteFingerprint")?.[2]).not.toEqual(expectedRouteFingerprint);
  });

  it.each(["localhost", "127.0.0.1", "0177.0.0.1", "[::1]", "sql.example.test:1433", "sql.example.test,1433",
    "sql.example.test\\named", "https://sql.example.test", "sql.example.test.", " sql.example.test", "sql.example.test\n"])(
    "does not infer an endpoint or accept disallowed host forms (%#)", async serverHost => {
      const { operator, request } = fakeOperator();
      await expect(enrollCatalogSqlTargetInstanceInTransaction(operator, { ...pins, reportRoute: { ...route, serverHost } }))
        .rejects.toBeInstanceOf(CatalogSqlTargetInstanceEnrollmentRollbackRequired);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...pins, environment: "qa " }, { ...pins, actorId: " fixture-operator" },
    { ...pins, operationalProfileVersion: Buffer.alloc(7) }, { ...pins, reportProfileVersion: Buffer.alloc(9) },
    { ...pins, reportConnectionId: "" }, { ...pins, physicalLinkId: "00000000-0000-0000-0000-000000000000" },
    { ...pins, reportRoute: { ...route, serverPort: "1433" } }, { ...pins, reportRoute: { ...route, serverPort: 65536 } },
    { ...pins, reportRoute: { ...route, databaseName: "" } },
    { ...pins, reportRoute: { ...route, password: "must not inspect" } },
    { ...pins, proof: { ...pins.proof, databaseGuid: trustedInstanceId } },
    { ...pins, proof: { ...pins.proof, databaseGuid: databaseGuid.toUpperCase() } },
    { ...pins, proof: { ...pins.proof, databaseGuid: databaseGuid + "\n" } },
    { ...pins, expectedIdentityFingerprint: Buffer.alloc(32, 99) },
    { ...pins, proof: { ...pins.proof, verifiedAt: new Date(now.getTime() + 1) } },
    { ...pins, proof: { ...pins.proof, verifiedAt: new Date(now.getTime() - 300_000) } },
    { ...pins, proof: { ...pins.proof, validUntil: now } },
    { ...pins, proof: { ...pins.proof, validUntil: new Date(verifiedAt.getTime() + 300_001) } },
    { ...pins, proof: { ...pins.proof, validUntil: new Date(NaN) } },
  ])("throws and never requests SQL for malformed, stale or mismatched evidence (%#)", async candidate => {
    const { operator, request } = fakeOperator();
    await expect(enrollCatalogSqlTargetInstanceInTransaction(operator, candidate))
      .rejects.toThrow(/^catalog_sql_target_instance_enrollment_rollback_required$/);
    expect(request).not.toHaveBeenCalled();
  });

  it("never invokes getters in input or RPC output", async () => {
    const getter = vi.fn(() => "enrolled");
    const { operator, request } = fakeOperator(() => ({ ...result(), output: { get result() { return getter(); } } }));
    const withGetter = { ...pins, get actorId() { return getter(); } };
    await expect(enrollCatalogSqlTargetInstanceInTransaction(operator, withGetter))
      .rejects.toBeInstanceOf(CatalogSqlTargetInstanceEnrollmentRollbackRequired);
    expect(request).not.toHaveBeenCalled();
    await expect(enrollCatalogSqlTargetInstanceInTransaction(operator, pins))
      .rejects.toBeInstanceOf(CatalogSqlTargetInstanceEnrollmentRollbackRequired);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    () => result("reference-changed"), () => result("proof-stale"), () => result("enrolled "),
    () => ({ ...result(), returnValue: 1 }), () => ({ ...result(), recordsets: [[{}]] }),
    () => ({ ...result(), output: { result: "enrolled", raw: "fixture" } }), () => undefined,
    () => { throw new Error("fixture internal SQL diagnostic"); },
    () => { vi.setSystemTime(validUntil); return result(); },
  ])("fails closed with rollback required and clears scratch buffers (%#)", async reply => {
    const { operator, request, bindings } = fakeOperator(reply);
    await expect(enrollCatalogSqlTargetInstanceInTransaction(operator, pins))
      .rejects.toThrow(/^catalog_sql_target_instance_enrollment_rollback_required$/);
    expect(request).toHaveBeenCalledOnce();
    for (const [,,value] of bindings) if (Buffer.isBuffer(value)) expect(value).toEqual(Buffer.alloc(value.length));
  });
});
