import { describe, expect, it, vi } from "vitest";
import { runCatalogRefreshTick } from "../lib/catalogRefreshWorker";
import type { CatalogRefreshClaim } from "../lib/catalogRefreshQueueSqlRepository";

const config = { PORTAL_CATALOG_AUTOMATION_ENABLED: "true", PORTAL_CATALOG_READ_ENABLED: "true",
  PORTAL_SAG_ENVIRONMENT: "qa", PORTAL_CATALOG_MATCH_KEY_VERSION: "2",
  PORTAL_CATALOG_MATCH_KEY_SECRET_NAME: "synthetic-key", PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION: "0".repeat(32),
  PORTAL_CATALOG_GENERATION_MODE: "catalog" };
const sagConfig = { ...config, PORTAL_CATALOG_SAG_V2_ENABLED: "true",
  PORTAL_CATALOG_SAG_ISSUER_MAP: '[{"countryId":1,"issuerScope":"CO:NIT"}]',
  SQL_DATABASE: "PortalSAGWeb-TEST", SQL_SERVER_HOST: "qa.sagweb.co,54103",
  PORTAL_CATALOG_SAG_V2_PUBLISHER_USERNAME: "publisher-fixture",
  PORTAL_CATALOG_SAG_V2_PUBLISHER_PASSWORD_SECRET_NAME: "publisher-fixture-ref",
  PORTAL_CATALOG_SAG_V2_PUBLISHER_PASSWORD_SECRET_VERSION: "ab".repeat(16) };
const claim = (i: number): CatalogRefreshClaim => ({ jobId: `10000000-0000-4000-8000-00000000000${i}`,
  leaseToken: `20000000-0000-4000-8000-00000000000${i}`, workerId: "30000000-0000-4000-8000-000000000000",
  sourceId: `40000000-0000-4000-8000-00000000000${i}`, attempt: 1, environment: "qa",
  bindingRevision: "ab".repeat(8), profileRevision: "bc".repeat(8), matchKeyVersion: 2 });
const legacy = (i: number) => ({ kind: "legacy" as const, claim: claim(i) });
const sagV2 = (i: number) => ({ kind: "sag-v2" as const, claim: claim(i) });
const mocks = () => {
  const publishSagV2 = vi.fn();
  return { enqueueDue: vi.fn().mockResolvedValue(2), claim: vi.fn().mockResolvedValue([]),
  publish: vi.fn().mockResolvedValue("published"), complete: vi.fn().mockResolvedValue(true),
  publishSagV2, prepareSagV2: vi.fn().mockResolvedValue({ isCurrent: () => true, publish: publishSagV2 }),
  generate: vi.fn().mockResolvedValue({ status: "evaluated" }), cutoff: vi.fn().mockResolvedValue(null),
  now: vi.fn().mockReturnValue(new Date("2026-11-19T04:59:00Z")) };
};

describe("durable catalog refresh tick", () => {
  it.each([{ PORTAL_CATALOG_AUTOMATION_ENABLED: undefined }, { PORTAL_CATALOG_READ_ENABLED: "false" },
    { PORTAL_SAG_ENVIRONMENT: undefined }, { PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION: undefined }])(
    "does not perform job, publisher or generation IO when disabled or misconfigured", async override => {
      const io = mocks();
      await runCatalogRefreshTick(io, { ...config, ...override });
      for (const fn of [io.enqueueDue, io.claim, io.publish, io.complete, io.generate, io.cutoff]) expect(fn).not.toHaveBeenCalled();
    });

  it("claims in two bounded independent waves, isolates a failed source and runs today's cutoff even without jobs", async () => {
    const io = mocks();
    io.claim.mockResolvedValueOnce([legacy(1), legacy(2)]).mockResolvedValueOnce([legacy(3), legacy(4)]);
    let active = 0, peak = 0;
    io.publish.mockImplementation(async (job: CatalogRefreshClaim) => {
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      if (job.jobId.endsWith("1")) throw new Error("must not be surfaced");
      if (job.jobId.endsWith("3")) return "stale";
      return "published";
    });
    const result = await runCatalogRefreshTick(io, config);
    expect(peak).toBe(2);
    expect(io.claim).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ claimed: 4, published: 2, failed: 1, cancelled: 1 });
    expect(io.complete.mock.calls.map(([, outcome]) => outcome).sort()).toEqual(["retry", "stale"]);
    expect(io.generate.mock.calls[0]?.[0]).toEqual({ trigger: "refresh", body: { date: "2026-11-18" } });
    expect(io.cutoff).toHaveBeenCalledOnce();

    io.now.mockReturnValue(new Date("2026-11-19T05:00:00Z"));
    io.generate.mockRejectedValueOnce(new Error("must not stop cutoff"));
    expect(await runCatalogRefreshTick(io, config)).toMatchObject({ claimed: 0, generation: "failed" });
    expect(io.generate.mock.calls[1]?.[0]).toEqual({ trigger: "refresh", body: { date: "2026-11-19" } });
    expect(io.cutoff).toHaveBeenCalledTimes(2);
  });

  it("refreshes sources in legacy generation mode without calling either catalog task path", async () => {
    const io = mocks();
    await runCatalogRefreshTick(io, { ...config, PORTAL_CATALOG_GENERATION_MODE: "legacy" });
    expect(io.enqueueDue).toHaveBeenCalledOnce();
    expect(io.generate).not.toHaveBeenCalled();
    expect(io.cutoff).not.toHaveBeenCalled();
  });

  it("records a pre-cutoff observation before the next wave and never backdates an after-cutoff publication", async () => {
    const io = mocks();
    const sequence: string[] = [];
    io.claim.mockResolvedValueOnce([legacy(1)]).mockResolvedValueOnce([legacy(2)]);
    io.publish.mockImplementation(async (job: CatalogRefreshClaim) => {
      sequence.push(`commit ${job.attempt}:${job.sourceId.at(-1)}`);
      io.now.mockReturnValue(new Date(job.sourceId.endsWith("1") ? "2026-11-19T04:59:38Z" : "2026-11-19T05:00:10Z"));
      return "published";
    });
    io.generate.mockImplementation(async ({ body }) => {
      sequence.push(`observe ${body.date}`);
      return { status: body.date === "2026-11-18" ? "unverified" : "evaluated" };
    });
    expect(await runCatalogRefreshTick(io, config)).toMatchObject({ published: 2, unverifiedDays: 1, generation: "evaluated" });
    expect(sequence).toEqual(["commit 1:1", "observe 2026-11-18", "commit 1:2", "observe 2026-11-19"]);
    expect(io.cutoff).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ outcome: "published", queue: "settled", jobStatus: "succeeded" }, "published"],
    [{ outcome: "superseded", queue: "settled", jobStatus: "succeeded" }, "superseded"],
    [{ outcome: "superseded", queue: "settled", jobStatus: "cancelled" }, "cancelled"],
    [{ outcome: "failed-recorded", queue: "settled", jobStatus: "retry" }, "failed"],
    [{ outcome: "failed-recorded", queue: "settled", jobStatus: "failed" }, "failed"],
    [{ outcome: "unconfirmed", queue: "lease-recovery" }, "deferred"],
    [{ outcome: "stale", queue: "fenced-stale" }, "deferred"],
    [{ outcome: "cancelled", queue: "untouched" }, "deferred"],
    [{ outcome: "ineligible", queue: "untouched" }, "deferred"],
  ] as const)("never compensates a SAG v2 claim after result %j", async (result, count) => {
    const io = mocks();
    const env = sagConfig;
    io.claim.mockResolvedValueOnce([sagV2(1)]);
    io.publishSagV2.mockResolvedValue(result);
    expect(await runCatalogRefreshTick(io, env)).toMatchObject({ claimed: 1, [count]: 1 });
    expect(io.publishSagV2).toHaveBeenCalledExactlyOnceWith(claim(1), env);
    expect(io.prepareSagV2.mock.invocationCallOrder[0]).toBeLessThan(io.claim.mock.invocationCallOrder[0]);
    expect(io.claim).toHaveBeenCalledWith(expect.objectContaining({ includeSagV2: true }), expect.any(String), 2);
    expect(io.publish).not.toHaveBeenCalled();
    expect(io.complete).not.toHaveBeenCalled();
  });

  it.each(["disabled", "missing-handler", "throws"])("defers a pinned SAG v2 claim (%s) without interrupting legacy refresh", async state => {
    const io = mocks();
    io.claim.mockResolvedValueOnce([sagV2(1), legacy(2)]);
    io.publishSagV2.mockRejectedValue(new Error("synthetic private error"));
    const env = { ...sagConfig, PORTAL_CATALOG_SAG_V2_ENABLED: state === "disabled" ? undefined : "true" };
    const { prepareSagV2, publishSagV2, ...legacyOnly } = io;
    const result = await runCatalogRefreshTick(state === "missing-handler" ? legacyOnly : io, env);
    expect(result).toMatchObject({ claimed: 2, published: 1, deferred: 1 });
    expect(io.publish).toHaveBeenCalledExactlyOnceWith(claim(2), env);
    expect(io.complete).not.toHaveBeenCalled();
    expect(publishSagV2).toHaveBeenCalledTimes(state === "throws" ? 1 : 0);
    expect(JSON.stringify(result)).not.toContain("synthetic private error");
  });

  it("keeps legacy ERP working when the dedicated pool does not become ready", async () => {
    const io = mocks();
    io.prepareSagV2.mockRejectedValueOnce(new Error("synthetic readiness detail"));
    io.claim.mockResolvedValueOnce([legacy(1)]);
    const result = await runCatalogRefreshTick(io, sagConfig);
    expect(result).toMatchObject({ published: 1 });
    expect(io.prepareSagV2).toHaveBeenCalledExactlyOnceWith(sagConfig);
    expect(io.enqueueDue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ includeSagV2: false }));
    expect(io.claim).toHaveBeenCalledWith(expect.objectContaining({ includeSagV2: false }), expect.any(String), 2);
    expect(io.publishSagV2).not.toHaveBeenCalled();
  });

  it("does not prepare the pool with an incomplete v2 configuration", async () => {
    const io = mocks();
    await runCatalogRefreshTick(io, { ...sagConfig, SQL_SERVER_HOST: undefined });
    expect(io.prepareSagV2).not.toHaveBeenCalled();
    expect(io.claim).toHaveBeenCalledWith(expect.objectContaining({ includeSagV2: false }), expect.any(String), 2);
  });

  it("never treats a malformed claim envelope as legacy work", async () => {
    const io = mocks();
    io.claim.mockResolvedValueOnce([claim(1), { kind: "unknown", claim: claim(2) }, null,
      { kind: "legacy" }, { kind: "sag-v2", claim: { ...claim(3), bindingRevision: "invalid" } },
      { kind: "legacy", claim: claim(4), untrusted: true }]);
    expect(await runCatalogRefreshTick(io, { ...config, PORTAL_CATALOG_SAG_V2_ENABLED: "true" }))
      .toMatchObject({ claimed: 6, deferred: 6 });
    for (const fn of [io.publish, io.publishSagV2, io.complete]) expect(fn).not.toHaveBeenCalled();
  });
});
