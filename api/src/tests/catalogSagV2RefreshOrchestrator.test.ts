import { describe, expect, it, vi } from "vitest";
import { catalogDocumentNumberToken } from "../lib/catalogCustomerRefresh";
import { buildCatalogMatchKeyEvidence, type CatalogMatchKeyEvidence } from "../lib/catalogMatchKeyEvidence";
import type { CatalogExternalReadStatement, CatalogExternalSourceTransport, CatalogSagCompanyTargetObservation } from "../lib/catalogExternalSourceQueries";
import type { SqlCatalogSourceBinding } from "../lib/catalogSourceBindingsSqlRepository";
import type { CatalogRefreshClaim } from "../lib/catalogRefreshQueueSqlRepository";
import type { CatalogSagV2FailureResult, CatalogSagV2PublishResult, CatalogSagV2Reservation,
  CatalogSagV2WorkerPublication } from "../lib/catalogSagV2WorkerPublisher";
import { runCatalogSagV2Refresh, type CatalogSagV2RefreshInput } from "../lib/catalogSagV2RefreshOrchestrator";

const baseClaim: CatalogRefreshClaim = {
  jobId: "12345678-1111-4111-8111-111111111111", workerId: "12345678-2222-4222-8222-222222222222",
  sourceId: "12345678-3333-4333-8333-333333333333", leaseToken: "12345678-4444-4444-8444-444444444444",
  attempt: 1, environment: "qa", bindingRevision: "0123456789abcdef", profileRevision: "fedcba9876543210", matchKeyVersion: 2,
};
const baseBinding: SqlCatalogSourceBinding = {
  id: baseClaim.sourceId, profileId: "synthetic-profile", label: "Synthetic source", role: "sag-admin", environment: "qa",
  state: "active", profileRevision: baseClaim.profileRevision, bindingVersion: baseClaim.bindingRevision,
  contractVersion: "sag_admin_v2", canReadCurrentProfile: true,
};
const candidateDate = "2026-11-18";
const vaultSecretVersion = "AaBbCcDdEeFf00112233445566778899";
const row = (sourceRecordId: number, reportedCountryId: number | null, documentNumber: string | null) => ({
  sourceRecordId, documentNumber, reportedCountryId, environment: "production", licensedModules: " S, A,S ",
  domainCandidate: "TENANT.example.test", testStartedOn: null, productionStartedOn: candidateDate, demoStartedOn: null,
});
const companies = [
  { companyRecordId: 1, customerRecordId: null, displayName: "Synthetic A", isAvailable: false },
  { companyRecordId: 2, customerRecordId: 999, displayName: null, isAvailable: null },
];
const sensitiveError = () => new Error("synthetic-private-driver-message");
const unconfirmed = { outcome: "unconfirmed", queue: "lease-recovery" };
const stale = { outcome: "stale", queue: "fenced-stale" };

function harness(observedAt = new Date("2026-11-18T05:00:00.000Z")) {
  const raw: Partial<Record<CatalogExternalReadStatement["tag"], readonly unknown[]>> = {
    schema: [{ compatible: true, readOnly: true }], counts: [{ customerCount: "3", companyCount: "2" }],
    customerPage: [row(1, 1, " 123-4 "), row(2, 999, "ABC"), row(3, 1, "malformed\u0000document")],
    companyPage: companies.map(row => ({ ...row, targetState: "unverified", targetHost: null, targetPort: null, targetDatabaseName: null })),
  };
  const events: string[] = [];
  const claim = { ...baseClaim };
  const matchKey = Buffer.alloc(32, 61);
  const scope = { issuer: "CO", documentType: "NIT" };
  const scopesByCountry = new Map([[1, scope]]);
  const controller = new AbortController();
  const input = { claim, matchKey, vaultSecretVersion, scopesByCountry, signal: controller.signal };
  const readPinnedSource = vi.fn(async (_claim: CatalogRefreshClaim, _signal: AbortSignal):
      Promise<SqlCatalogSourceBinding | null> => {
    events.push("recheck"); return { ...baseBinding };
  });
  const select = vi.fn(async (request: CatalogExternalReadStatement) => {
    events.push(request.tag);
    const value = raw[request.tag];
    if (!value) throw sensitiveError();
    return value;
  });
  const transport: CatalogExternalSourceTransport = {
    withConsistentRead(options, work) {
      events.push("snapshot");
      expect(options.contract).toBe("sag_admin_v2_targets");
      return work({ consistency: "verified", select });
    },
  };
  const loadTransport = vi.fn(async (_binding: SqlCatalogSourceBinding, _signal: AbortSignal) => {
    events.push("transport"); return transport;
  });
  const reserveAttempt = vi.fn(async (): Promise<CatalogSagV2Reservation> => {
    events.push("reserve"); return { attemptOrdinal: "908", observedAt };
  });
  const publish = vi.fn(async (_ordinal: string, _body: CatalogSagV2WorkerPublication,
    _targets: readonly CatalogSagCompanyTargetObservation[]): Promise<CatalogSagV2PublishResult> => {
    events.push("publish"); return { result: "published", jobStatus: "succeeded" };
  });
  const recordFailure = vi.fn(async (_ordinal: string): Promise<CatalogSagV2FailureResult> => {
    events.push("fail"); return { result: "failed", jobStatus: "retry" };
  });
  const publisherFor = vi.fn((_claim: CatalogRefreshClaim, _keyProof: CatalogMatchKeyEvidence) =>
    ({ reserveAttempt, publishWithTargets: publish, recordFailure }));
  const io = { readPinnedSource, loadTransport, publisherFor };
  return { input, io, raw, claim, matchKey, scope, scopesByCountry, controller, events, select, reserveAttempt, publish, recordFailure };
}

describe("SAG v2 dedicated refresh worker", () => {
  it("uses bounded v2 SNAPSHOT and the reserved stamp, with exact protected rows and all companies", async () => {
    const h = harness();
    expect(await runCatalogSagV2Refresh(h.input, h.io)).toEqual({ outcome: "published", queue: "settled", jobStatus: "succeeded" });
    expect(h.events).toEqual(["recheck", "reserve", "recheck", "transport", "recheck", "snapshot",
      "recheck", "schema", "recheck", "counts", "recheck", "customerPage", "recheck", "companyPage", "recheck", "recheck", "publish"]);
    const [[ordinal, body, targets]] = h.publish.mock.calls;
    expect(ordinal).toBe("908");
    expect(Object.keys(body).sort()).toEqual(["companies", "companyCount", "customerCount", "customers"].sort());
    expect(body.companies).toEqual(companies);
    expect(targets).toEqual(companies.map(row => ({ companyRecordId: row.companyRecordId, state: "unverified", locationToken: null })));
    expect([body.customerCount, body.companyCount]).toEqual([3, 2]);
    const [known, unknown, malformed] = body.customers;
    expect(known).toEqual({ sourceRecordId: 1, issuer: "CO", documentType: "NIT",
      token: catalogDocumentNumberToken(h.matchKey, "qa", "123-4"), domainCandidate: "tenant.example.test",
      environmentKind: "production", licenseCodes: ["A", "S"], testStartedOn: null, productionStartedOn: candidateDate, demoStartedOn: null });
    expect(unknown).toMatchObject({ sourceRecordId: 2, issuer: null, documentType: null,
      token: catalogDocumentNumberToken(h.matchKey, "qa", "ABC") });
    expect(malformed).toMatchObject({ sourceRecordId: 3, issuer: null, documentType: null, token: null });
    expect(body.customers.every(c => !Object.hasOwn(c, "documentNumber") && !Object.hasOwn(c, "reportedCountryId"))).toBe(true);
    expect(h.recordFailure).not.toHaveBeenCalled();
  });

  it("uses Bogotá's previous business day immediately before 05:00 UTC", async () => {
    const h = harness(new Date("2026-11-18T04:59:59.999Z"));
    await runCatalogSagV2Refresh(h.input, h.io);
    expect(h.publish.mock.calls[0][1].customers[0].productionStartedOn).toBeNull();
  });

  it("binds proof and tokens to the same copied key, claim and configured vault version before its initial await", async () => {
    const h = harness();
    const expected = catalogDocumentNumberToken(h.matchKey, "qa", "123-4");
    const expectedProof = buildCatalogMatchKeyEvidence("qa", h.claim.matchKeyVersion, vaultSecretVersion, h.matchKey);
    const run = runCatalogSagV2Refresh(h.input, h.io);
    h.claim.jobId = "00000000-0000-0000-0000-000000000000";
    h.claim.matchKeyVersion++;
    h.matchKey.fill(19);
    h.input.vaultSecretVersion = "ffff0000ffff0000ffff0000ffff0000";
    h.scope.issuer = "XX";
    h.scopesByCountry.clear();
    expect(await run).toMatchObject({ outcome: "published" });
    expect(h.publish.mock.calls[0][1].customers[0]).toMatchObject({ token: expected, issuer: "CO", documentType: "NIT" });
    expect(h.io.publisherFor).toHaveBeenCalledExactlyOnceWith(baseClaim, expectedProof);
    expect(h.matchKey.equals(Buffer.alloc(32, 19))).toBe(true);
  });

  it.each(["", "short", vaultSecretVersion + "\n", "x".repeat(32), 42])("rejects a malformed vault version before any I/O: %j", async version => {
    const h = harness();
    const input = { ...h.input, vaultSecretVersion: version } as CatalogSagV2RefreshInput;
    const result = await runCatalogSagV2Refresh(input, h.io);
    expect(result).toEqual({ outcome: "ineligible", queue: "untouched" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(h.io.readPinnedSource).not.toHaveBeenCalled();
    expect(h.io.publisherFor).not.toHaveBeenCalled();
  });

  it("refuses externally supplied proof and lets the factory reject a mismatching internally derived verifier before RPC", async () => {
    const h = harness();
    const otherProof = buildCatalogMatchKeyEvidence("qa", h.claim.matchKeyVersion, vaultSecretVersion, Buffer.alloc(32, 20));
    const tampered = { ...h.input, keyProof: otherProof };
    expect(await runCatalogSagV2Refresh(tampered, h.io)).toEqual({ outcome: "ineligible", queue: "untouched" });
    expect(h.io.readPinnedSource).not.toHaveBeenCalled();
    h.io.publisherFor.mockImplementationOnce((_claim, proof) => {
      if (!otherProof.keyVerifier.equals(proof?.keyVerifier ?? Buffer.alloc(32))) throw sensitiveError();
      return { reserveAttempt: h.reserveAttempt, publishWithTargets: h.publish, recordFailure: h.recordFailure };
    });
    expect(await runCatalogSagV2Refresh(h.input, h.io)).toEqual(unconfirmed);
    expect(h.io.loadTransport).not.toHaveBeenCalled();
    expect(h.reserveAttempt).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.recordFailure).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...baseClaim, jobId: "not-a-guid" }, Buffer.alloc(32), new Map()],
    [baseClaim, Buffer.alloc(31), new Map()],
    [baseClaim, Buffer.alloc(32), new Map([[-1, { issuer: "CO", documentType: "NIT" }]])],
    [baseClaim, Buffer.alloc(32), new Map([[1, { issuer: "co", documentType: "NIT" }]])],
    [baseClaim, Buffer.alloc(32), new Map([[1, { issuer: "CO", documentType: "NIT", extra: "invalid" }]])],
  ])("rejects malformed arguments before invoking any dependency", async (claim, matchKey, scopesByCountry) => {
    const h = harness();
    expect(await runCatalogSagV2Refresh({ ...h.input, claim, matchKey, scopesByCountry }, h.io)).toEqual({
      outcome: "ineligible", queue: "untouched",
    });
    expect(h.io.readPinnedSource).not.toHaveBeenCalled();
    expect(h.io.publisherFor).not.toHaveBeenCalled();
  });

  it.each([
    null, { contractVersion: "sag_admin_v1" }, { role: "erp-customers" }, { state: "draft" }, { environment: "production" },
    { bindingVersion: "0123456789000000" }, { profileRevision: "0123456789000000" }, { canReadCurrentProfile: false },
  ] as const)("never reserves or falls back on known wrong source: %j", async (patch) => {
    const h = harness();
    h.io.readPinnedSource.mockResolvedValue(patch ? { ...baseBinding, ...patch } : null);
    expect(await runCatalogSagV2Refresh(h.input, h.io)).toEqual(stale);
    expect(h.io.publisherFor).not.toHaveBeenCalled();
    expect(h.io.loadTransport).not.toHaveBeenCalled();
  });

  it.each([2, 3, 6, 8, 9])("stops on known stale authority at recheck %i, without attempting a failure write", async (at) => {
    const h = harness();
    let checks = 0;
    h.io.readPinnedSource.mockImplementation(async () => {
      checks++;
      return { ...baseBinding, ...(checks === at ? { profileId: "changed-profile" } : {}) };
    });
    expect(await runCatalogSagV2Refresh(h.input, h.io)).toEqual(stale);
    expect(h.reserveAttempt).toHaveBeenCalledOnce();
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.recordFailure).not.toHaveBeenCalled();
    expect(checks).toBe(at);
    if (at === 2) expect(h.io.loadTransport).not.toHaveBeenCalled();
    if (at === 3) expect(h.events).not.toContain("snapshot");
    if (at === 6) expect(h.events).not.toContain("customerPage");
  });

  it("does not guess stale authority or load credentials if a recheck is unconfirmed", async () => {
    const h = harness();
    h.io.readPinnedSource.mockResolvedValueOnce(baseBinding).mockRejectedValueOnce(sensitiveError());
    expect(await runCatalogSagV2Refresh(h.input, h.io)).toEqual(unconfirmed);
    expect(h.io.loadTransport).not.toHaveBeenCalled();
    expect(h.recordFailure).not.toHaveBeenCalled();
  });

  it.each(["second collection incomplete", "transport load rejected"] as const)("records one fenced failure: %s", async reason => {
    const h = harness();
    if (reason === "second collection incomplete") h.raw.companyPage = companies.slice(0, 1);
    else h.io.loadTransport.mockRejectedValueOnce(sensitiveError());
    expect(await runCatalogSagV2Refresh(h.input, h.io)).toEqual({
      outcome: "failed-recorded", queue: "settled", jobStatus: "retry",
    });
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.recordFailure).toHaveBeenCalledExactlyOnceWith("908");
    expect(h.events.slice(-2)).toEqual(["recheck", "fail"]);
  });

  it("cancels without writing before reserve and uses one fenced cleanup after reserve", async () => {
    const before = harness();
    before.controller.abort(sensitiveError());
    expect(await runCatalogSagV2Refresh(before.input, before.io)).toEqual({ outcome: "cancelled", queue: "untouched" });
    expect(before.io.readPinnedSource).not.toHaveBeenCalled();
    const after = harness();
    after.reserveAttempt.mockImplementationOnce(async () => {
      after.controller.abort(sensitiveError());
      return { attemptOrdinal: "908", observedAt: new Date() };
    });
    expect(await runCatalogSagV2Refresh(after.input, after.io)).toEqual({
      outcome: "failed-recorded", queue: "settled", jobStatus: "retry",
    });
    expect(after.io.loadTransport).not.toHaveBeenCalled();
    expect(after.recordFailure).toHaveBeenCalledExactlyOnceWith("908");
  });

  it("does not let cancellation during publication obscure a confirmed outcome", async () => {
    const h = harness();
    h.publish.mockImplementationOnce(async () => {
      h.controller.abort(sensitiveError());
      return { result: "superseded", jobStatus: "cancelled" };
    });
    expect(await runCatalogSagV2Refresh(h.input, h.io)).toEqual({
      outcome: "superseded", queue: "settled", jobStatus: "cancelled",
    });
    expect(h.recordFailure).not.toHaveBeenCalled();
  });

  it("does not start a page when a recheck resolves after cancellation", async () => {
    const h = harness();
    let enter!: () => void;
    let release!: (source: SqlCatalogSourceBinding) => void;
    const waiting = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<SqlCatalogSourceBinding>(resolve => { release = resolve; });
    let checks = 0;
    h.io.readPinnedSource.mockImplementation(async () => {
      if (++checks === 6) { enter(); return held; }
      return baseBinding;
    });
    const run = runCatalogSagV2Refresh(h.input, h.io);
    await waiting;
    h.controller.abort(sensitiveError());
    release(baseBinding);
    expect(await run).toMatchObject({ outcome: "failed-recorded", queue: "settled" });
    expect(h.events).not.toContain("customerPage");
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.recordFailure).toHaveBeenCalledExactlyOnceWith("908");
  });

  it.each(["reserve", "publish", "fail"] as const)("never retries on unconfirmed %s; it leaves recovery to the lease", async (phase) => {
    const h = harness();
    if (phase === "reserve") h.reserveAttempt.mockRejectedValueOnce(sensitiveError());
    if (phase === "publish") h.publish.mockRejectedValueOnce(sensitiveError());
    if (phase === "fail") {
      h.raw.companyPage = [];
      h.recordFailure.mockRejectedValueOnce(sensitiveError());
    }
    expect(await runCatalogSagV2Refresh(h.input, h.io)).toEqual(unconfirmed);
    expect(h.reserveAttempt).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledTimes(phase === "publish" ? 1 : 0);
    expect(h.recordFailure).toHaveBeenCalledTimes(phase === "fail" ? 1 : 0);
    if (phase === "reserve") expect(h.io.loadTransport).not.toHaveBeenCalled();
  });

  it("rejects an invalid reservation stamp without opening the source or inventing a failure ordinal", async () => {
    const h = harness();
    h.reserveAttempt.mockResolvedValueOnce({ attemptOrdinal: "0", observedAt: new Date("invalid") });
    expect(await runCatalogSagV2Refresh(h.input, h.io)).toEqual(unconfirmed);
    expect(h.io.loadTransport).not.toHaveBeenCalled();
    expect(h.recordFailure).not.toHaveBeenCalled();
  });

  it("does not compensate a write returning contradictory confirmation", async () => {
    const h = harness();
    h.publish.mockResolvedValueOnce({ result: "published", jobStatus: "cancelled" } as unknown as CatalogSagV2PublishResult);
    expect(await runCatalogSagV2Refresh(h.input, h.io)).toEqual(unconfirmed);
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.recordFailure).not.toHaveBeenCalled();
  });

  it("leaves a confirmed terminal failure settled on the final allowed attempt", async () => {
    const h = harness();
    h.claim.attempt = 5;
    h.raw.companyPage = [];
    h.recordFailure.mockImplementationOnce(async () => {
      h.controller.abort(sensitiveError());
      return { result: "failed", jobStatus: "failed" };
    });
    expect(await runCatalogSagV2Refresh(h.input, h.io)).toEqual({
      outcome: "failed-recorded", queue: "settled", jobStatus: "failed",
    });
    expect(h.recordFailure).toHaveBeenCalledOnce();
    expect(h.publish).not.toHaveBeenCalled();
  });
});
