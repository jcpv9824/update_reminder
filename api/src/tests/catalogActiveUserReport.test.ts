import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CATALOG_ACTIVE_USERS_UNAVAILABLE,
  collectCatalogActiveUserReport,
  type CatalogActiveUserReportLink,
  type CatalogActiveUserTarget,
} from "../lib/catalogActiveUserReport";

const target = (id: string, serverGroupId = "host-group-a"): CatalogActiveUserTarget => ({
  physicalDatabaseId: id,
  reportingProfileId: "report-only-" + id,
  serverGroupId,
});

const link = (id: string, destination: CatalogActiveUserTarget | null): CatalogActiveUserReportLink => ({
  clientId: "client-" + id,
  clientName: "Cliente " + id,
  databaseLinkId: "link-" + id,
  databaseAlias: "Base " + id,
  target: destination,
});

describe("catalog active-user report collector", () => {
  afterEach(() => vi.useRealTimers());

  it("queries one physical database once and reuses it for every allowed client link", async () => {
    const shared = target("shared-db");
    const read = vi.fn(async () => 7);
    const result = await collectCatalogActiveUserReport([link("A", shared), link("B", shared)], read);

    expect(read).toHaveBeenCalledExactlyOnceWith(shared, expect.any(AbortSignal));
    expect(result.rows).toEqual([
      expect.objectContaining({ clientName: "Cliente A", databaseAlias: "Base A", activeUsers: 7 }),
      expect.objectContaining({ clientName: "Cliente B", databaseAlias: "Base B", activeUsers: 7 }),
    ]);
    expect(result.rows[0].checkedAt).toBe(result.rows[1].checkedAt);
    expect(result.summary).toEqual({
      activeUsers: 7, physicalDatabases: 1, verifiedCounts: 1, unverifiedLinks: 0, partial: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/shared-db|host-group-a|report-only|reportingProfileId/);
  });

  it("distinguishes a successful zero, a failed query, and an unverified link without leaking errors", async () => {
    const read = vi.fn(async ({ physicalDatabaseId }: CatalogActiveUserTarget) => {
      if (physicalDatabaseId === "blocked") throw new Error("internal-failure-with-sensitive-context");
      return 0;
    });
    const result = await collectCatalogActiveUserReport([
      link("zero", target("empty")), link("failed", target("blocked")), link("unknown", null),
    ], read);

    expect(read).toHaveBeenCalledTimes(2);
    expect(result.rows[0]).toMatchObject({ status: "available", activeUsers: 0 });
    for (const row of result.rows.slice(1)) {
      expect(row).toMatchObject({ status: "unavailable", activeUsers: null, message: CATALOG_ACTIVE_USERS_UNAVAILABLE });
    }
    expect(result.summary).toEqual({
      activeUsers: 0, physicalDatabases: 2, verifiedCounts: 1, unverifiedLinks: 1, partial: true,
    });
    expect(JSON.stringify(result)).not.toContain("internal-failure-with-sensitive-context");
  });

  it("fails closed on conflicting registry mappings and malformed aggregate values", async () => {
    const conflicting = target("shared");
    const read = vi.fn(async () => -1);
    const result = await collectCatalogActiveUserReport([
      link("original", conflicting), link("conflict", { ...conflicting, reportingProfileId: "other" }),
      link("different", target("returns-invalid")),
    ], read);
    expect(read).toHaveBeenCalledExactlyOnceWith(target("returns-invalid"), expect.any(AbortSignal));
    expect(result.rows.every(row => row.status === "unavailable")).toBe(true);
    expect(result.summary).toMatchObject({ activeUsers: null, physicalDatabases: 2, verifiedCounts: 0, partial: true });
  });

  it("limits concurrent reads overall and per server while allowing another server to progress", async () => {
    vi.useFakeTimers();
    const calls = new Map<string, number>();
    let concurrent = 0;
    let peak = 0;
    let peakPerServer = 0;
    const read = vi.fn(async ({ serverGroupId }: CatalogActiveUserTarget) => {
      peak = Math.max(++concurrent, peak);
      const count = (calls.get(serverGroupId) ?? 0) + 1;
      peakPerServer = Math.max(count, peakPerServer);
      calls.set(serverGroupId, count);
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      calls.set(serverGroupId, (calls.get(serverGroupId) ?? 1) - 1);
      concurrent--;
      return 1;
    });

    const run = collectCatalogActiveUserReport([
      link("a1", target("a1")), link("a2", target("a2")), link("b", target("b", "host-group-b")),
      link("c", target("c", "host-group-c")),
    ], read, { maxConcurrent: 2, maxConcurrentPerServer: 1 });

    await vi.advanceTimersByTimeAsync(0);
    expect(read.mock.calls.map(([item]) => item.physicalDatabaseId)).toEqual(["a1", "b"]);
    await vi.runAllTimersAsync();
    expect((await run).summary).toMatchObject({ activeUsers: 4, partial: false });
    expect(peak).toBe(2);
    expect(peakPerServer).toBe(1);
  });

  it("cancels a timed-out read and does not release its slot if the reader ignores cancellation", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const read = vi.fn(async (destination: CatalogActiveUserTarget, signal: AbortSignal) => {
      signals.push(signal);
      if (destination.physicalDatabaseId === "hanging") return new Promise<number>(() => {});
      return 3;
    });
    const run = collectCatalogActiveUserReport([
      link("hanging", target("hanging")), link("not-started", target("same-host")),
      link("other", target("other", "host-group-b")),
    ], read, { maxConcurrent: 2, maxConcurrentPerServer: 1, perDatabaseTimeoutMs: 20, reportTimeoutMs: 60 });

    await vi.advanceTimersByTimeAsync(25);
    expect(signals[0].aborted).toBe(true);
    expect(read.mock.calls.map(([item]) => item.physicalDatabaseId)).toEqual(["hanging", "other"]);
    await vi.advanceTimersByTimeAsync(35);
    const result = await run;
    expect(result.rows.map(row => row.activeUsers)).toEqual([null, null, 3]);
    expect(result.summary).toMatchObject({ activeUsers: 3, verifiedCounts: 1, partial: true });
  });

  it("does not start reads if the caller already cancelled the report", async () => {
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn(async () => 4);
    const result = await collectCatalogActiveUserReport([link("cancelled", target("cancelled"))], read, {
      signal: controller.signal,
    });
    expect(read).not.toHaveBeenCalled();
    expect(result.rows[0]).toMatchObject({ status: "unavailable", activeUsers: null });
  });

  it("continues to the next base on a server when a timed-out reader closes", async () => {
    vi.useFakeTimers();
    const run = collectCatalogActiveUserReport([
      link("timed-out", target("slow")), link("healthy", target("next-base")),
    ], async (destination, signal) => {
      if (destination.physicalDatabaseId !== "slow") return 2;
      return new Promise<number>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("private timeout cause")), { once: true });
      });
    }, { maxConcurrentPerServer: 1, perDatabaseTimeoutMs: 20, reportTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(21);
    expect((await run).rows.map(row => row.activeUsers)).toEqual([null, 2]);
  });

  it("keeps successful counts and aborts in-flight work when the caller cancels", async () => {
    const report = new AbortController();
    let inFlight: AbortSignal | undefined;
    const run = collectCatalogActiveUserReport([
      link("complete", target("complete")), link("ongoing", target("ongoing", "host-group-b")),
    ], async (destination, signal) => {
      if (destination.physicalDatabaseId === "complete") return 11;
      inFlight = signal;
      return new Promise<number>(() => {});
    }, { signal: report.signal });
    await new Promise<void>(resolve => setImmediate(resolve));
    report.abort();
    expect(inFlight?.aborted).toBe(true);
    const result = await run;
    expect(result.rows.map(row => row.activeUsers)).toEqual([11, null]);
    expect(result.summary).toMatchObject({ activeUsers: 11, verifiedCounts: 1, partial: true });
  });
});
