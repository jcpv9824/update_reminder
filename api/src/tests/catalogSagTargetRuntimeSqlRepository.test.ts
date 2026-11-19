import sql from "mssql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyCatalogSagTargetRuntimeProof } from "../lib/catalogSagTargetRuntimeSqlRepository";

const read = "settings.read_catalog_sag_target_link_candidates";
const verify = "settings.verify_catalog_sag_target_link";
const scope = {
  environment: "qa", purpose: "task", operationalLinkId: "20000000-0000-0000-0000-000000000001",
  physicalLinkId: "20000000-0000-0000-0000-000000000002", physicalTargetId: "20000000-0000-0000-0000-000000000003",
  matchKeyVersion: 1, reportInstanceId: null,
};
const candidate = {
  server_host_port: "origin.example.test,1433", initial_catalog: "QA Sample", accessProfileVersion: Buffer.alloc(8, 4),
  sagSourceId: "20000000-0000-0000-0000-000000000004", sagRevisionKey: "9223372036854775807", sagCompanyRecordId: -1,
};
const later = { ...candidate, sagCompanyRecordId: 1 };
const key = Buffer.alloc(32, 1);
const clock = new Date("2026-11-18T17:00:00.000Z");
const expiry = new Date("2026-11-18T17:01:00.000Z");

function envelope(rows?: unknown[], output = {}) {
  return { recordsets: rows ? [rows] : [], recordset: rows, returnValue: 0, rowsAffected: [], output };
}

function fakeTransaction(...replies: unknown[]) {
  const calls: { procedure: string; requestIndex: number; bindings: unknown[][]; outputs: unknown[][] }[] = [];
  let requests = 0;
  const request = vi.fn(() => {
    const requestIndex = ++requests;
    const bindings: unknown[][] = [];
    const outputs: unknown[][] = [];
    const rpc = {
      input: (...args: unknown[]) => { bindings.push(args); return rpc; },
      output: (...args: unknown[]) => { outputs.push(args); return rpc; },
      execute: async (procedure: string): Promise<unknown> => {
        const reply = replies[calls.length];
        calls.push({ procedure, requestIndex, bindings, outputs });
        if (reply instanceof Error) throw reply;
        return typeof reply === "function" ? reply() : reply;
      },
    };
    return rpc;
  });
  const transaction = { request } as unknown as sql.Transaction;
  return { transaction, request, calls };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(clock); });
afterEach(() => vi.useRealTimers());

describe("runtime SAG link proof", () => {
  it("binds only fixed RPCs on the supplied transaction and allows exactly one confirmed candidate", async () => {
    const { transaction, calls } = fakeTransaction(envelope([candidate, later]), envelope(undefined, { validUntil: null }),
      envelope(undefined, { validUntil: expiry }));
    expect(await verifyCatalogSagTargetRuntimeProof(transaction, scope, key)).toEqual({ targetId: scope.physicalTargetId, validUntil: expiry });
    expect(calls.map(({ procedure, requestIndex }) => [procedure, requestIndex])).toEqual([[read, 1], [verify, 2], [verify, 3]]);
    expect(calls[0].bindings).toEqual([
      ["environment", sql.VarChar(32), "qa"], ["purpose", sql.VarChar(16), "task"],
      ["operationalLinkId", sql.UniqueIdentifier, scope.operationalLinkId], ["physicalLinkId", sql.UniqueIdentifier, scope.physicalLinkId],
      ["physicalTargetId", sql.UniqueIdentifier, scope.physicalTargetId], ["matchKeyVersion", sql.SmallInt, 1],
      ["reportInstanceId", sql.UniqueIdentifier, null],
    ]);
    expect(calls[0].outputs).toEqual([]);
    expect(calls[2].bindings).toContainEqual(["sagRevisionKey", sql.BigInt, 9223372036854775807n]);
    expect(calls[2].bindings).toContainEqual(["accessProfileVersion", sql.VarBinary(32), candidate.accessProfileVersion]);
    expect(calls[2].bindings).toContainEqual(["sagCompanyRecordId", sql.Int, 1]);
    expect(calls[2].bindings).toContainEqual(["locationToken", sql.VarBinary(64), Buffer.alloc(32)]);
    expect(calls[2].outputs).toEqual([["validUntil", sql.DateTime2(3)]]);
    expect(key).toEqual(Buffer.alloc(32, 1));
  });

  it("keeps the exact report instance on both RPCs", async () => {
    const reportInstanceId = "20000000-0000-0000-0000-000000000005";
    const { transaction, calls } = fakeTransaction(envelope([candidate]), envelope(undefined, { validUntil: expiry }));
    expect(await verifyCatalogSagTargetRuntimeProof(transaction, { ...scope, purpose: "report", reportInstanceId }, key)).not.toBeNull();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.bindings).toContainEqual(["purpose", sql.VarChar(16), "report"]);
      expect(call.bindings).toContainEqual(["reportInstanceId", sql.UniqueIdentifier, reportInstanceId]);
    }
  });

  it.each([
    { ...scope, environment: "qa " }, { ...scope, purpose: "report" }, { ...scope, extra: 1 },
    { ...scope, matchKeyVersion: 0 }, { ...scope, physicalLinkId: "00000000-0000-0000-0000-000000000000" },
  ])("rejects invalid scope before requesting transport (%#)", async badScope => {
    const { transaction, request } = fakeTransaction();
    expect(await verifyCatalogSagTargetRuntimeProof(transaction, badScope, key)).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not invoke a scope accessor and rejects a short key", async () => {
    const { transaction, request } = fakeTransaction();
    const getter = vi.fn(() => "qa");
    const withAccessor = Object.defineProperty({ ...scope }, "environment", { get: getter });
    expect(await verifyCatalogSagTargetRuntimeProof(transaction, withAccessor, key)).toBeNull();
    expect(await verifyCatalogSagTargetRuntimeProof(transaction, scope, Buffer.alloc(31))).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [], [candidate, candidate], [later, candidate], Array.from({ length: 9 }, (_, sagCompanyRecordId) => ({ ...candidate, sagCompanyRecordId })),
    [candidate, {...later, sagRevisionKey: "2"}], [candidate, {...later, accessProfileVersion: Buffer.alloc(8, 5)}],
    [candidate, {...later, initial_catalog: "different"}], [{ ...candidate, unexpected: 1 }],
    [{ ...candidate, sagRevisionKey: 2 }], [{ ...candidate, sagRevisionKey: "9223372036854775808" }],
    [{ ...candidate, accessProfileVersion: Buffer.alloc(7) }], [{ ...candidate, server_host_port: "no explicit port" }],
  ])("rejects empty or invalid candidate sets (%#)", async (...rows) => {
    const { transaction, calls } = fakeTransaction(envelope(rows));
    expect(await verifyCatalogSagTargetRuntimeProof(transaction, scope, key)).toBeNull();
    expect(calls.map(call => call.procedure)).toEqual([read]);
  });

  it.each([new Error("fixture transport failure"), envelope(undefined, {}), envelope(undefined, { validUntil: clock }),
    envelope(undefined, { validUntil: expiry.toISOString() }), envelope([{}], { validUntil: expiry })])(
    "does not let a subsequent positive mask malformed, stale or failed verification (%#)", async failure => {
      const { transaction, calls } = fakeTransaction(envelope([candidate, later]), failure, envelope(undefined, { validUntil: expiry }));
      expect(await verifyCatalogSagTargetRuntimeProof(transaction, scope, key)).toBeNull();
      expect(calls).toHaveLength(2);
    },
  );

  it("rejects zero confirmed candidates, ambiguous proofs and unavailable transaction", async () => {
    const none = fakeTransaction(envelope([candidate]), envelope(undefined, { validUntil: null }));
    expect(await verifyCatalogSagTargetRuntimeProof(none.transaction, scope, key)).toBeNull();
    const ambiguous = fakeTransaction(envelope([candidate, later]), envelope(undefined, { validUntil: expiry }),
      envelope(undefined, { validUntil: expiry }));
    expect(await verifyCatalogSagTargetRuntimeProof(ambiguous.transaction, scope, key)).toBeNull();
    const unavailable = fakeTransaction(new Error("not begun"));
    expect(await verifyCatalogSagTargetRuntimeProof(unavailable.transaction, scope, key)).toBeNull();
  });

  it("rechecks expiry after the last candidate returns", async () => {
    const { transaction } = fakeTransaction(envelope([candidate, later]), envelope(undefined, { validUntil: expiry }), () => {
      vi.setSystemTime(expiry);
      return envelope(undefined, { validUntil: null });
    });
    expect(await verifyCatalogSagTargetRuntimeProof(transaction, scope, key)).toBeNull();
  });
});
