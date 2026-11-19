import { createHmac } from "node:crypto";
import sql from "mssql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyCatalogSagTargetLinkProof, type CatalogSagTargetLinkProofTransport } from "../lib/catalogSagTargetLinkProof";

const matchKey = Buffer.alloc(32, 19);
const scope = {
  environment: "qa", purpose: "task", operationalLinkId: "10000000-0000-0000-0000-000000000001",
  physicalLinkId: "10000000-0000-0000-0000-000000000002", physicalTargetId: "10000000-0000-0000-0000-000000000003",
  accessProfileVersion: "8877665544332211", sagSourceId: "10000000-0000-0000-0000-000000000004",
  sagRevisionKey: "9223372036854775807", sagCompanyRecordId: -2147483648, matchKeyVersion: 32767, reportInstanceId: null,
};
const reportInstanceId = "10000000-0000-0000-0000-000000000005";
const profile = { server_host_port: "SQL.Example.test,05433", initial_catalog: "SAG QA" };
const now = new Date("2026-11-18T17:00:00.000Z");
const future = new Date("2026-11-18T17:05:00.000Z");
type Verify = CatalogSagTargetLinkProofTransport["verify"];

function setTime() { vi.useFakeTimers(); vi.setSystemTime(now); }
afterEach(() => vi.useRealTimers());

describe("SAG target link proof adapter", () => {
  it("passes only 056 typed pins and exact 055 binary evidence, awaits result and wipes evidence", async () => {
    setTime();
    let original: Buffer | undefined;
    let snapshot: Parameters<Verify> | undefined;
    const verify = vi.fn<Verify>(async (inputs, output) => {
      original = inputs.find(input => input.name === "locationToken")?.value as Buffer;
      await Promise.resolve();
      snapshot = [inputs.map(input => ({ ...input, value: Buffer.isBuffer(input.value) ? Buffer.from(input.value) : input.value })), output];
      return { validUntil: future };
    });
    const result = await verifyCatalogSagTargetLinkProof(scope, profile, matchKey, { verify });
    const expectedToken = createHmac("sha256", matchKey).update(JSON.stringify([
      "portal-sag/company-location/v1", "qa", scope.sagSourceId, 32767, -2147483648, "sql.example.test", 5433, "SAG QA",
    ])).digest();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(snapshot).toEqual([[
      { name: "environment", type: sql.VarChar(32), value: "qa" },
      { name: "purpose", type: sql.VarChar(16), value: "task" },
      { name: "operationalLinkId", type: sql.UniqueIdentifier, value: scope.operationalLinkId },
      { name: "physicalLinkId", type: sql.UniqueIdentifier, value: scope.physicalLinkId },
      { name: "physicalTargetId", type: sql.UniqueIdentifier, value: scope.physicalTargetId },
      { name: "accessProfileVersion", type: sql.VarBinary(32), value: Buffer.from(scope.accessProfileVersion, "hex") },
      { name: "sagSourceId", type: sql.UniqueIdentifier, value: scope.sagSourceId },
      { name: "sagRevisionKey", type: sql.BigInt, value: 9223372036854775807n },
      { name: "sagCompanyRecordId", type: sql.Int, value: -2147483648 },
      { name: "matchKeyVersion", type: sql.SmallInt, value: 32767 },
      { name: "locationToken", type: sql.VarBinary(64), value: expectedToken },
      { name: "reportInstanceId", type: sql.UniqueIdentifier, value: null },
    ], { name: "validUntil", type: sql.DateTime2(3) }]);
    expect(original).toEqual(Buffer.alloc(32));
    expect(matchKey).toEqual(Buffer.alloc(32, 19));
    expect(result).toEqual({ targetId: scope.physicalTargetId, validUntil: future });
    expect(result?.validUntil).not.toBe(future);
  });

  it("uses the exact report instance and clears evidence on transport failure", async () => {
    let original: Buffer | undefined;
    const verify = vi.fn<Verify>(async inputs => {
      original = inputs.find(input => input.name === "locationToken")?.value as Buffer;
      throw new Error("fixture internal failure");
    });
    expect(await verifyCatalogSagTargetLinkProof({ ...scope, purpose: "report", reportInstanceId }, profile, matchKey, { verify })).toBeNull();
    expect(verify.mock.calls[0]?.[0]).toContainEqual({ name: "reportInstanceId", type: sql.UniqueIdentifier, value: reportInstanceId });
    expect(original).toEqual(Buffer.alloc(32));
  });

  it.each([
    { ...scope, environment: "production " }, { ...scope, purpose: "other" },
    { ...scope, physicalTargetId: "00000000-0000-0000-0000-000000000000" },
    { ...scope, accessProfileVersion: "8877665544332211\n" }, { ...scope, sagRevisionKey: 1 },
    { ...scope, sagRevisionKey: "9223372036854775808" }, { ...scope, sagRevisionKey: "01" },
    { ...scope, sagRevisionKey: "1\n" }, { ...scope, matchKeyVersion: 32768 }, { ...scope, sagCompanyRecordId: -2147483649 },
    { ...scope, purpose: "report" }, { ...scope, reportInstanceId }, { ...scope, unexpected: true },
  ])("rejects malformed scope without transport (%#)", async candidate => {
    const verify = vi.fn<Verify>();
    expect(await verifyCatalogSagTargetLinkProof(candidate, profile, matchKey, { verify })).toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });

  it.each(["sql.example.test", "sql.example.test:5433", "sql.example.test,0", "sql.example.test,65536",
    "sql.example.test,5433\n", "sql.example.test, 5433", "127.0.0.1,5433", "sql\\instance,5433", " sql.example.test,5433",
    "tcp:sql.example.test,5433", "sql.example.test.,5433", "sql.example.test,5433;extra=value"])(
    "rejects an unsupported address without transport (%#)", async address => {
      const verify = vi.fn<Verify>();
      expect(await verifyCatalogSagTargetLinkProof(scope, { ...profile, server_host_port: address }, matchKey, { verify })).toBeNull();
      expect(verify).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown fields, accessors, malformed catalog names and the wrong key length", async () => {
    const verify = vi.fn<Verify>();
    const accessor = vi.fn(() => scope.physicalTargetId);
    const scopeWithAccessor = Object.defineProperty({ ...scope }, "physicalTargetId", { get: accessor });
    const profileAccessor = vi.fn(() => profile.server_host_port);
    const profileWithAccessor = Object.defineProperty({ ...profile }, "server_host_port", { get: profileAccessor });
    for (const candidate of [profileWithAccessor, { ...profile, unexpected: true }, { ...profile, initial_catalog: " SAG QA" }]) {
      expect(await verifyCatalogSagTargetLinkProof(scope, candidate, matchKey, { verify })).toBeNull();
    }
    expect(await verifyCatalogSagTargetLinkProof(scopeWithAccessor, profile, matchKey, { verify })).toBeNull();
    expect(await verifyCatalogSagTargetLinkProof(scope, profile, Buffer.alloc(31), { verify })).toBeNull();
    expect(verify).not.toHaveBeenCalled();
    expect(accessor).not.toHaveBeenCalled();
    expect(profileAccessor).not.toHaveBeenCalled();
  });

  it.each([null, {}, { validUntil: null }, { validUntil: now }, { validUntil: new Date(now.getTime() - 1) },
    { validUntil: new Date(NaN) }, { validUntil: future.toISOString() }, { validUntil: future, extra: true }])(
    "fails closed on stale or malformed output (%#)", async output => {
      setTime();
      const verify = vi.fn<Verify>().mockResolvedValue(output);
      expect(await verifyCatalogSagTargetLinkProof(scope, profile, matchKey, { verify })).toBeNull();
      expect(verify).toHaveBeenCalledTimes(1);
    },
  );
});
