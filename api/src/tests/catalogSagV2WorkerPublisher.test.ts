import sql from "mssql";
import { describe, expect, it, vi } from "vitest";
import { createCatalogSagV2WorkerPublisher, type CatalogSagV2WorkerPublication } from "../lib/catalogSagV2WorkerPublisher";
import type { CatalogRefreshClaim } from "../lib/catalogRefreshQueueSqlRepository";
import type { CatalogSagCompanyTargetObservation } from "../lib/catalogExternalSourceQueries";

const ordinal = "9007199254740993";
const observedAt = new Date("2026-11-20T01:00:00.000Z");
const claim: CatalogRefreshClaim = { environment: "qa", sourceId: "1d384ec8-8d15-446f-827e-cd31f3b7158c",
  jobId: "2d384ec8-8d15-446f-827e-cd31f3b7158c", workerId: "3d384ec8-8d15-446f-827e-cd31f3b7158c",
  leaseToken: "4d384ec8-8d15-446f-827e-cd31f3b7158c", attempt: 2,
  bindingRevision: "aabbccddeeff0011", profileRevision: "1122334455667788", matchKeyVersion: 1 };
const proof = () => ({ vaultSecretVersion: Buffer.alloc(16, 1), keyVerifier: Buffer.alloc(32, 2) });
const customer = { sourceRecordId: 1, issuer: "CO", documentType: "NIT", token: Buffer.alloc(32, 0xae),
  domainCandidate: "tenant.example.invalid", environmentKind: "production" as const, licenseCodes: ["A", "S"],
  testStartedOn: null, productionStartedOn: "2026-11-18", demoStartedOn: null };
const company = { companyRecordId: 1, customerRecordId: 999, displayName: "Synthetic", isAvailable: false };
const observedTarget = { companyRecordId: 1, state: "candidate", locationToken: "af".repeat(32) } as const;
const payload = (customers = [customer], companies = [company]): CatalogSagV2WorkerPublication => ({
  customerCount: customers.length, companyCount: companies.length, customers, companies,
});
const resultSet = (...recordset: unknown[]) => ({ recordset, recordsets: [recordset] });
const success = { result: "published", jobStatus: "succeeded" };
const invalid = "invalid_catalog_sag_v2_publication";
const failed = "catalog_sag_v2_publication_failed";

function fake() {
  const execute = vi.fn<(_: string) => Promise<unknown>>();
  const query = vi.fn();
  const transaction = vi.fn();
  const requests: { input: ReturnType<typeof vi.fn> }[] = [];
  const request = vi.fn(() => {
    const req = { input: vi.fn().mockReturnThis(), execute, query };
    requests.push(req);
    return req;
  });
  const pool = { request, transaction } as unknown as Parameters<typeof createCatalogSagV2WorkerPublisher>[0];
  return { pool, request, requests, execute, query, transaction, publisher: (claim = defaultClaim(), keyProof = proof()) =>
    createCatalogSagV2WorkerPublisher(pool, { claim, keyProof }) };
}
const defaultClaim = () => ({ ...claim });
const constantPins = [
  ["environment", sql.VarChar(32), "qa"], ["sourceId", sql.UniqueIdentifier, claim.sourceId],
  ["jobId", sql.UniqueIdentifier, claim.jobId], ["workerId", sql.UniqueIdentifier, claim.workerId],
  ["leaseToken", sql.UniqueIdentifier, claim.leaseToken], ["attempt", sql.Int, claim.attempt],
  ["bindingVersion", sql.VarBinary(32), Buffer.from(claim.bindingRevision, "hex")],
  ["profileVersion", sql.VarBinary(32), Buffer.from(claim.profileRevision, "hex")],
  ["matchKeyVersion", sql.SmallInt, claim.matchKeyVersion],
  ["vaultSecretVersion", sql.VarBinary(64), proof().vaultSecretVersion], ["keyVerifier", sql.VarBinary(64), proof().keyVerifier],
];

describe("dedicated SAG v2 worker publication adapter", () => {
  it("owner mode binds the same typed claims only to reserve, with-target publication and failure wrappers", async () => {
    const io = fake(); const publisher = createCatalogSagV2WorkerPublisher(io.pool, { claim, keyProof: proof() }, "portal-owner");
    io.execute.mockResolvedValueOnce(resultSet({ attemptOrdinal: ordinal, observedAt }))
      .mockResolvedValueOnce(resultSet(success)).mockResolvedValueOnce(resultSet({ result: "failed", jobStatus: "retry" }));
    await expect(publisher.reserveAttempt()).resolves.toEqual({ attemptOrdinal: ordinal, observedAt });
    await expect(publisher.publishWithTargets(ordinal, payload(), [observedTarget])).resolves.toEqual(success);
    await expect(publisher.recordFailure(ordinal)).resolves.toEqual({ result: "failed", jobStatus: "retry" });
    expect(io.execute.mock.calls).toEqual([["settings.reserve_catalog_sag_v2_owner_attempt"],
      ["settings.publish_catalog_sag_v2_owner_with_targets"], ["settings.fail_catalog_sag_v2_owner_attempt"]]);
    for (const request of io.requests) expect(request.input.mock.calls.slice(0, 11)).toEqual(constantPins);
    await expect(publisher.publish(ordinal, payload())).rejects.toThrow(invalid);
    expect(io.request).toHaveBeenCalledTimes(3); expect(io.query).not.toHaveBeenCalled(); expect(io.transaction).not.toHaveBeenCalled();
  });

  it("rejects an invalid internal mode and never retries owner publication via legacy or dedicated RPC", async () => {
    const io = fake();
    expect(() => createCatalogSagV2WorkerPublisher(io.pool, { claim, keyProof: proof() }, "owner" as never)).toThrow(invalid);
    expect(io.request).not.toHaveBeenCalled();
    const publisher = createCatalogSagV2WorkerPublisher(io.pool, { claim, keyProof: proof() }, "portal-owner");
    io.execute.mockRejectedValue(new Error("synthetic private driver detail"));
    await expect(publisher.publishWithTargets(ordinal, payload(), [observedTarget])).rejects.toEqual(new Error(failed));
    expect(io.execute.mock.calls).toEqual([["settings.publish_catalog_sag_v2_owner_with_targets"]]);
  });
  it("publishes the exact bounded Company observation set exclusively through the 055 RPC", async () => {
    const io = fake(), publisher = io.publisher();
    const second = Object.freeze({ ...company, companyRecordId: -2 });
    const companies = Object.freeze([Object.freeze({ ...company }), second]);
    const targets = Object.freeze([Object.freeze({ companyRecordId: -2, state: "unverified", locationToken: null } as const),
      Object.freeze({ ...observedTarget })]);
    const publication = Object.freeze({ ...payload(), companyCount: 2, companies });
    io.execute.mockResolvedValueOnce(resultSet(success));
    await expect(publisher.publishWithTargets(ordinal, publication, targets)).resolves.toEqual(success);
    expect(io.execute).toHaveBeenCalledExactlyOnceWith("settings.publish_catalog_sag_v2_with_targets");
    const inputs = io.requests[0].input.mock.calls;
    expect(inputs.slice(0, 11)).toEqual(constantPins);
    expect(inputs.slice(11)).toEqual([
      ["attemptOrdinal", sql.BigInt, BigInt(ordinal)], ["customerCount", sql.Int, 1], ["companyCount", sql.Int, 2],
      ["customers", sql.NVarChar(sql.MAX), JSON.stringify([{ ...customer, token: "ae".repeat(32), licenseCodes: "AS" }])],
      ["companies", sql.NVarChar(sql.MAX), JSON.stringify(companies)],
      ["targets", sql.NVarChar(sql.MAX), JSON.stringify(targets)],
    ]);
    expect(io.query).not.toHaveBeenCalled();
    expect(io.transaction).not.toHaveBeenCalled();
    io.execute.mockResolvedValueOnce(resultSet({ result: "superseded", jobStatus: "cancelled" }));
    await expect(publisher.publishWithTargets(ordinal, payload([], []), [])).resolves.toEqual({ result: "superseded", jobStatus: "cancelled" });
    expect(io.requests[1].input.mock.calls.at(-1)).toEqual(["targets", sql.NVarChar(sql.MAX), "[]"]);
  });

  it("rejects missing, extra, unordered or malformed observations without SQL or getter access", async () => {
    const io = fake(), publisher = io.publisher();
    const getter = vi.fn(() => "synthetic opaque field");
    const accessor = Object.defineProperty({ ...observedTarget }, "locationToken", { get: getter, enumerable: true });
    const arrayAccessor = Object.defineProperty([], "0", { get: getter, enumerable: true });
    const extraOnArray = Object.assign([observedTarget], { rawLocation: "synthetic forbidden field" });
    const other = { ...observedTarget, companyRecordId: 2 };
    const asTargets = (value: unknown) => value as readonly CatalogSagCompanyTargetObservation[];
    for (const bad of [undefined, [], Array(1), [accessor], arrayAccessor, extraOnArray, [other], [observedTarget, other],
      [{ ...observedTarget, host: "synthetic forbidden field" }], [{ ...observedTarget, locationToken: null }],
      [{ ...observedTarget, locationToken: "AF".repeat(32) }], [{ ...observedTarget, locationToken: "af".repeat(32) + "\n" }],
      [{ ...observedTarget, locationToken: " " + "af".repeat(32) }], [{ ...observedTarget, state: "unverified" }],
      [{ ...observedTarget, state: "verified" }], [{ ...observedTarget, companyRecordId: 2147483648 }]]) {
      await expect(publisher.publishWithTargets(ordinal, payload(), asTargets(bad))).rejects.toThrow(invalid);
    }
    const two = payload([customer], [company, { ...company, companyRecordId: 2 }]);
    for (const rows of [[other, observedTarget], [observedTarget, observedTarget]]) {
      await expect(publisher.publishWithTargets(ordinal, two, rows)).rejects.toThrow(invalid);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(io.request).not.toHaveBeenCalled();
  });

  it("does not fall back after an unconfirmed 055 write or accept contradictory replies", async () => {
    const io = fake(), publisher = io.publisher();
    io.execute.mockRejectedValueOnce(new Error("synthetic confidential diagnostic"))
      .mockResolvedValueOnce(resultSet({ result: "published", jobStatus: "cancelled" }));
    for (let i = 0; i < 2; i++) {
      await expect(publisher.publishWithTargets(ordinal, payload(), [observedTarget])).rejects.toEqual(new Error(failed));
    }
    expect(io.execute.mock.calls).toEqual(Array.from({ length: 2 }, () => ["settings.publish_catalog_sag_v2_with_targets"]));
    expect(io.query).not.toHaveBeenCalled();
  });
  it("executes only the fixed RPCs with exact types and immutable pins, without owning a transaction", async () => {
    const io = fake();
    const pins = defaultClaim(), evidence = proof();
    const publisher = io.publisher(pins, evidence);
    pins.attempt = 4;
    evidence.vaultSecretVersion.fill(0);
    evidence.keyVerifier.fill(0);
    io.execute.mockResolvedValueOnce(resultSet({ attemptOrdinal: ordinal, observedAt }))
      .mockResolvedValueOnce(resultSet(success)).mockResolvedValueOnce(resultSet({ result: "failed", jobStatus: "retry" }));
    const reserve = await publisher.reserveAttempt();
    expect(reserve).toEqual({ attemptOrdinal: ordinal, observedAt });
    expect(reserve.observedAt).not.toBe(observedAt);
    expect(await publisher.publish(reserve.attemptOrdinal, payload())).toEqual(success);
    expect(await publisher.recordFailure(ordinal)).toEqual({ result: "failed", jobStatus: "retry" });
    expect(io.execute.mock.calls).toEqual([["settings.reserve_catalog_sag_v2_attempt"],
      ["settings.publish_catalog_sag_v2_revision"], ["settings.fail_catalog_sag_v2_attempt"]]);
    for (const req of io.requests) expect(req.input.mock.calls.slice(0, 11)).toEqual(constantPins);
    expect(io.requests[0].input.mock.calls).toHaveLength(11);
    expect(io.requests[1].input.mock.calls.slice(11)).toEqual([
      ["attemptOrdinal", sql.BigInt, BigInt(ordinal)], ["customerCount", sql.Int, 1], ["companyCount", sql.Int, 1],
      ["customers", sql.NVarChar(sql.MAX), expect.any(String)], ["companies", sql.NVarChar(sql.MAX), expect.any(String)],
    ]);
    expect(io.requests[2].input.mock.calls.slice(11)).toEqual([["attemptOrdinal", sql.BigInt, BigInt(ordinal)]]);
    expect(JSON.parse(io.requests[1].input.mock.calls[14][2])).toEqual([{ ...customer, token: "ae".repeat(32), licenseCodes: "AS" }]);
    expect(JSON.parse(io.requests[1].input.mock.calls[15][2])).toEqual([company]);
    expect(io.transaction).not.toHaveBeenCalled();
    expect(io.query).not.toHaveBeenCalled();
  });

  it("treats zero as explicit evidence and preserves unknown, unavailable and unmatched Company metadata", async () => {
    const io = fake();
    const publisher = io.publisher();
    io.execute.mockResolvedValue(resultSet(success));
    await publisher.publish(ordinal, payload([], []));
    expect(io.requests[0].input.mock.calls.slice(12)).toEqual([
      ["customerCount", sql.Int, 0], ["companyCount", sql.Int, 0],
      ["customers", sql.NVarChar(sql.MAX), "[]"], ["companies", sql.NVarChar(sql.MAX), "[]"],
    ]);
    const rows = [company, { companyRecordId: 2, customerRecordId: null, displayName: null, isAvailable: null }];
    await publisher.publish(ordinal, { customerCount: 1, companyCount: 2, customers: [
      { ...customer, issuer: null, documentType: null, licenseCodes: [] },
    ], companies: rows });
    expect(JSON.parse(io.requests[1].input.mock.calls[15][2])).toEqual(rows);
    expect(JSON.parse(io.requests[1].input.mock.calls[14][2])[0]).toMatchObject({ issuer: null, documentType: null, licenseCodes: "" });
  });

  it("rejects invalid claim and key proof before requesting any SQL, with no fallback pool", () => {
    const io = fake();
    for (const invalidPins of [{ ...claim, sourceId: "00000000-0000-0000-0000-000000000000" }, { ...claim, jobId: "not-an-id" },
      { ...claim, workerId: " " + claim.workerId }, { ...claim, leaseToken: "00000000-0000-0000-0000-000000000000" },
      { ...claim, environment: "qa " }, { ...claim, attempt: 0 }, { ...claim, attempt: 6 },
      { ...claim, bindingRevision: "a".repeat(18) }, { ...claim, profileRevision: "xx".repeat(8) },
      { ...claim, matchKeyVersion: 32768 }, { ...claim, actorId: "not-a-worker-field" }]) {
      expect(() => io.publisher(invalidPins as CatalogRefreshClaim)).toThrow(invalid);
    }
    expect(() => io.publisher(defaultClaim(), { ...proof(), vaultSecretVersion: Buffer.alloc(17) })).toThrow(invalid);
    expect(() => io.publisher(defaultClaim(), { ...proof(), keyVerifier: Buffer.alloc(31) })).toThrow(invalid);
    expect(() => createCatalogSagV2WorkerPublisher(undefined as never, { claim, keyProof: proof() })).toThrow(invalid);
    expect(io.request).not.toHaveBeenCalled();
  });

  it("rejects all secret, extra, malformed or duplicate rows and absent/mismatched counts before requesting SQL", async () => {
    const io = fake(), publisher = io.publisher();
    const getter = vi.fn(() => { throw new Error("private value"); });
    const accessor = { ...company };
    Object.defineProperty(accessor, "displayName", { get: getter, enumerable: true });
    for (const candidate of [{ ...payload(), companyCount: 0 }, { ...payload(), customerCount: undefined },
      { ...payload(), observedAt }, { ...payload(), companies: [{ ...company, StringConnection: "synthetic prohibited field" }] },
      { ...payload(), customers: [{ ...customer, documentNumber: "synthetic prohibited field" }] },
      { ...payload(), companies: [accessor] }, { ...payload(), companies: Array(1) },
      { ...payload(), companies: [{ ...company, customerRecordId: 2147483648 }] },
      { ...payload(), companies: [{ ...company, isAvailable: 0 }] },
      { ...payload(), companies: [{ ...company, displayName: " " }] },
      { ...payload(), customers: [{ ...customer, sourceRecordId: 1.5 }] },
      { ...payload(), customers: [{ ...customer, token: "ae".repeat(32) }] },
      { ...payload(), customers: [{ ...customer, issuer: null }] },
      { ...payload(), customers: [{ ...customer, domainCandidate: "https://tenant.example.invalid" }] },
      { ...payload(), customers: [{ ...customer, licenseCodes: ["S", "S"] }] },
      { ...payload(), customers: [{ ...customer, licenseCodes: ["S", "A"] }] },
      { ...payload(), customers: [{ ...customer, productionStartedOn: "2026-02-31" }] },
      { ...payload(), customerCount: 2, customers: [customer, customer] },
      { ...payload(), companyCount: 2, companies: [company, company] }]) {
      await expect(publisher.publish(ordinal, candidate as CatalogSagV2WorkerPublication)).rejects.toThrow(invalid);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(io.request).not.toHaveBeenCalled();
  });

  it("applies the combined row count and UTF-16 byte bound before RPC", async () => {
    const io = fake(), publisher = io.publisher();
    await expect(publisher.publish(ordinal, { customerCount: 60000, companyCount: 40001,
      customers: Array(60000), companies: Array(40001) })).rejects.toThrow(invalid);
    const companies = Array.from({ length: 16000 }, (_, i) => ({ ...company, companyRecordId: i + 1, displayName: "x".repeat(512) }));
    await expect(publisher.publish(ordinal, { customerCount: 0, companyCount: companies.length, customers: [], companies }))
      .rejects.toThrow(invalid);
    expect(io.request).not.toHaveBeenCalled();
    const under = companies.slice(0, 9500);
    io.execute.mockResolvedValueOnce(resultSet(success));
    await expect(publisher.publish(ordinal, { customerCount: 0, companyCount: under.length, customers: [], companies: under }))
      .resolves.toEqual(success);
    const boundBytes = Buffer.byteLength(io.requests[0].input.mock.calls[15][2], "utf16le");
    expect(boundBytes).toBeGreaterThan(8 * 1024 * 1024); // no separate 8 MiB cap per array
    const customers = Array.from({ length: 12000 }, (_, i) => ({ ...customer, sourceRecordId: i + 1 }));
    await expect(publisher.publish(ordinal, { customerCount: customers.length, companyCount: under.length, customers, companies: under }))
      .rejects.toThrow(invalid);
    expect(io.request).toHaveBeenCalledOnce();
  });

  it("preserves the full bigint range and rejects invalid ordinals before RPC", async () => {
    const io = fake(), publisher = io.publisher();
    for (const invalidOrdinal of [1, "", "0", "01", " 1", "-1", "1.1", "9223372036854775808"]) {
      await expect(publisher.publish(invalidOrdinal as string, payload())).rejects.toThrow(invalid);
      await expect(publisher.recordFailure(invalidOrdinal as string)).rejects.toThrow(invalid);
    }
    expect(io.request).not.toHaveBeenCalled();
    io.execute.mockResolvedValueOnce(resultSet({ result: "superseded", jobStatus: "cancelled" }));
    expect(await publisher.recordFailure("9223372036854775807")).toEqual({ result: "superseded", jobStatus: "cancelled" });
    expect(io.requests[0].input.mock.calls.at(-1)).toEqual(["attemptOrdinal", sql.BigInt, 9223372036854775807n]);
  });

  it("fails closed on driver errors and malformed or impossible post-commit replies", async () => {
    const io = fake(), publisher = io.publisher();
    io.execute.mockRejectedValueOnce(new Error("confidential driver info"));
    await expect(publisher.reserveAttempt()).rejects.toEqual(new Error(failed));
    for (const reserveReply of [resultSet(), resultSet({ attemptOrdinal: ordinal, observedAt: "not Date" }),
      resultSet({ attemptOrdinal: "01", observedAt }), resultSet({ attemptOrdinal: ordinal, observedAt: new Date(NaN) }),
      resultSet({ attemptOrdinal: ordinal, observedAt, secret: "never returned" })]) {
      io.execute.mockResolvedValueOnce(reserveReply);
      await expect(publisher.reserveAttempt()).rejects.toEqual(new Error(failed));
    }
    for (const invalidReply of [resultSet(success, success), { recordset: [success], recordsets: [[success], []] },
      resultSet({ ...success, secret: "never returned" }), resultSet({ result: "published", jobStatus: "cancelled" }),
      resultSet({ result: "failed", jobStatus: "retry" }), resultSet({ result: "superseded", jobStatus: "queued" })]) {
      io.execute.mockResolvedValueOnce(invalidReply);
      await expect(publisher.publish(ordinal, payload())).rejects.toEqual(new Error(failed));
    }
    io.execute.mockResolvedValueOnce(resultSet({ result: "failed", jobStatus: "failed" }));
    await expect(publisher.recordFailure(ordinal)).rejects.toEqual(new Error(failed));
    const fifth = io.publisher({ ...claim, attempt: 5 });
    io.execute.mockResolvedValueOnce(resultSet({ result: "failed", jobStatus: "failed" }));
    await expect(fifth.recordFailure(ordinal)).resolves.toEqual({ result: "failed", jobStatus: "failed" });
    for (const jobStatus of ["succeeded", "cancelled"]) {
      const outcome = { result: "superseded", jobStatus };
      io.execute.mockResolvedValueOnce(resultSet(outcome)).mockResolvedValueOnce(resultSet(outcome));
      await expect(publisher.publish(ordinal, payload())).resolves.toEqual(outcome);
      await expect(publisher.recordFailure(ordinal)).resolves.toEqual(outcome);
    }
  });
});
