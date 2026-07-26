import { describe, expect, it, vi } from "vitest";
import { runGuideWorkerOnce } from "../lib/guideWorker";
import type { ClaimedGuideJob } from "../lib/guideBuilderSqlRepository";

const job: ClaimedGuideJob = {
  jobKey: 1,
  jobId: "guide_job_1",
  sessionKey: 2,
  sessionId: "guide_session_1",
  jobType: "initial_process",
  inputVersion: 0,
  attemptNo: 1,
};

describe("guide worker lease adapter", () => {
  it("does not claim work when the feature flag is disabled", async () => {
    const claim = vi.fn();
    const result = await runGuideWorkerOnce("worker-1", vi.fn(), {
      enabled: false,
      claim,
      complete: vi.fn(),
      processor: { process: vi.fn() },
    });
    expect(result).toEqual({ disabled: true, claimed: 0, succeeded: 0, failed: 0 });
    expect(claim).not.toHaveBeenCalled();
  });

  it("completes an injected processor result without requiring ffmpeg or OpenAI", async () => {
    const complete = vi.fn().mockResolvedValue(undefined);
    const result = await runGuideWorkerOnce("worker-1", vi.fn(), {
      enabled: true,
      claim: vi.fn().mockResolvedValue([job]),
      complete,
      processor: { process: vi.fn().mockResolvedValue({ frames: 3 }) },
    });
    expect(result).toEqual({ disabled: false, claimed: 1, succeeded: 1, failed: 0 });
    expect(complete).toHaveBeenCalledWith(job, "worker-1", { ok: true, metrics: { frames: 3 } });
  });

  it("records only a controlled failure summary from an injected processor", async () => {
    const complete = vi.fn().mockResolvedValue(undefined);
    await runGuideWorkerOnce("worker-1", vi.fn(), {
      enabled: true,
      claim: vi.fn().mockResolvedValue([job]),
      complete,
      processor: { process: vi.fn().mockRejectedValue(Object.assign(new Error("ffmpeg missing"), { code: "media_host_unproven" })) },
    });
    expect(complete).toHaveBeenCalledWith(job, "worker-1", {
      ok: false,
      errorCode: "media_host_unproven",
      errorSummary: "ffmpeg missing",
    });
  });
});
