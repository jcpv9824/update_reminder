import { describe, expect, it, vi } from "vitest";
import { runCatalogRefreshTick } from "../lib/catalogRefreshWorker";
import type { CatalogRefreshClaim } from "../lib/catalogRefreshQueueSqlRepository";

const config = { PORTAL_CATALOG_AUTOMATION_ENABLED: "true", PORTAL_CATALOG_READ_ENABLED: "true",
  PORTAL_SAG_ENVIRONMENT: "qa", PORTAL_CATALOG_MATCH_KEY_VERSION: "2",
  PORTAL_CATALOG_MATCH_KEY_SECRET_NAME: "synthetic-key", PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION: "0".repeat(32),
  PORTAL_CATALOG_GENERATION_MODE: "catalog" };
const claim = (i: number): CatalogRefreshClaim => ({ jobId: `10000000-0000-4000-8000-00000000000${i}`,
  leaseToken: `20000000-0000-4000-8000-00000000000${i}`, workerId: "30000000-0000-4000-8000-000000000000",
  sourceId: `40000000-0000-4000-8000-00000000000${i}`, attempt: 1, environment: "qa",
  bindingRevision: "ab".repeat(8), profileRevision: "bc".repeat(8), matchKeyVersion: 2 });
const mocks = () => ({ enqueueDue: vi.fn().mockResolvedValue(2), claim: vi.fn().mockResolvedValue([]),
  publish: vi.fn().mockResolvedValue("published"), complete: vi.fn().mockResolvedValue(true),
  generate: vi.fn().mockResolvedValue({ status: "evaluated" }), cutoff: vi.fn().mockResolvedValue(null),
  now: vi.fn().mockReturnValue(new Date("2026-11-19T04:59:00Z")) });

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
    io.claim.mockResolvedValueOnce([claim(1), claim(2)]).mockResolvedValueOnce([claim(3), claim(4)]);
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
    io.claim.mockResolvedValueOnce([claim(1)]).mockResolvedValueOnce([claim(2)]);
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
});
