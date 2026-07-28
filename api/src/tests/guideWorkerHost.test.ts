import { afterEach, describe, expect, it, vi } from "vitest";
import { runGuideWorkerHost } from "../workers/guideWorkerHost";

const originalMode = process.env.GUIDE_WORKER_HOST_MODE;
const originalMaximum = process.env.GUIDE_WORKER_MAX_JOBS_PER_EXECUTION;

afterEach(() => {
  if (originalMode === undefined) delete process.env.GUIDE_WORKER_HOST_MODE;
  else process.env.GUIDE_WORKER_HOST_MODE = originalMode;
  if (originalMaximum === undefined) delete process.env.GUIDE_WORKER_MAX_JOBS_PER_EXECUTION;
  else process.env.GUIDE_WORKER_MAX_JOBS_PER_EXECUTION = originalMaximum;
});

describe("guide worker host", () => {
  it("runs one bounded execution by default for a scheduled container job", async () => {
    delete process.env.GUIDE_WORKER_HOST_MODE;
    const runOnce = vi.fn().mockResolvedValue({ disabled: false, claimed: 0, succeeded: 0, failed: 0 });
    await runGuideWorkerHost({
      signal: new AbortController().signal,
      workerId: "worker-host-1",
      runOnce,
      cleanup: vi.fn().mockResolvedValue(0),
      expirePending: vi.fn().mockResolvedValue(0),
    });
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it("drains queued work until empty within the bounded execution", async () => {
    const runOnce = vi.fn()
      .mockResolvedValueOnce({ disabled: false, claimed: 1, succeeded: 1, failed: 0 })
      .mockResolvedValueOnce({ disabled: false, claimed: 1, succeeded: 1, failed: 0 })
      .mockResolvedValueOnce({ disabled: false, claimed: 0, succeeded: 0, failed: 0 });
    const cleanup = vi.fn().mockResolvedValue(0);
    const expirePending = vi.fn().mockResolvedValue(0);
    await runGuideWorkerHost({
      signal: new AbortController().signal,
      workerId: "worker-host-1",
      maxJobsPerExecution: 10,
      runOnce,
      cleanup,
      expirePending,
    });
    expect(runOnce).toHaveBeenCalledTimes(3);
    expect(expirePending).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("stops draining at the per-execution job cap", async () => {
    const runOnce = vi.fn().mockResolvedValue({
      disabled: false,
      claimed: 1,
      succeeded: 1,
      failed: 0,
    });
    await runGuideWorkerHost({
      signal: new AbortController().signal,
      workerId: "worker-host-1",
      maxJobsPerExecution: 2,
      runOnce,
      cleanup: vi.fn().mockResolvedValue(0),
      expirePending: vi.fn().mockResolvedValue(0),
    });
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it("does not run storage cleanup while the worker feature flags are disabled", async () => {
    delete process.env.GUIDE_WORKER_HOST_MODE;
    const cleanup = vi.fn().mockResolvedValue(0);
    await runGuideWorkerHost({
      signal: new AbortController().signal,
      workerId: "worker-host-1",
      runOnce: vi.fn().mockResolvedValue({
        disabled: true,
        claimed: 0,
        succeeded: 0,
        failed: 0,
      }),
      cleanup,
      expirePending: vi.fn().mockResolvedValue(0),
    });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("expires abandoned uploads before running delayed storage cleanup", async () => {
    const order: string[] = [];
    await runGuideWorkerHost({
      signal: new AbortController().signal,
      workerId: "worker-host-1",
      runOnce: vi.fn().mockResolvedValue({ disabled: false, claimed: 0, succeeded: 0, failed: 0 }),
      expirePending: vi.fn(async () => { order.push("expire"); return 1; }),
      cleanup: vi.fn(async () => { order.push("cleanup"); return 1; }),
    });
    expect(order).toEqual(["expire", "cleanup"]);
  });

  it("supports an explicitly continuous host that stops through AbortSignal", async () => {
    process.env.GUIDE_WORKER_HOST_MODE = "continuous";
    const controller = new AbortController();
    const runOnce = vi.fn(async () => {
      controller.abort();
      return { disabled: false, claimed: 0, succeeded: 0, failed: 0 };
    });
    await runGuideWorkerHost({
      signal: controller.signal,
      workerId: "worker-host-1",
      pollIntervalMs: 1_000,
      runOnce,
      cleanup: vi.fn().mockResolvedValue(0),
      expirePending: vi.fn().mockResolvedValue(0),
    });
    expect(runOnce).toHaveBeenCalledTimes(1);
  });
});
