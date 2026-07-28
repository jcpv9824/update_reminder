import { randomUUID } from "node:crypto";
import { runGuideWorkerOnce } from "../lib/guideWorker";
import {
  completeSqlCancelledGuideUploadCleanup,
  expireSqlPendingGuideUploads,
  readSqlCancelledGuideUploads,
} from "../lib/guideBuilderSqlRepository";
import { deletePrivateObjectIfUnreferenced } from "../lib/objectStorage";

export type GuideWorkerHostOptions = {
  signal: AbortSignal;
  workerId?: string;
  pollIntervalMs?: number;
  maxJobsPerExecution?: number;
  log?: (message: string) => void;
  runOnce?: typeof runGuideWorkerOnce;
  cleanup?: () => Promise<number>;
  expirePending?: () => Promise<number>;
};

async function cleanupCancelledUploads(): Promise<number> {
  const pending = await readSqlCancelledGuideUploads(5);
  let completed = 0;
  for (const item of pending) {
    const absent = await deletePrivateObjectIfUnreferenced(item.locator);
    if (absent) {
      await completeSqlCancelledGuideUploadCleanup(item.sessionId, item.locator);
      completed++;
    }
  }
  return completed;
}

function waitForNextPoll(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      done();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Durable worker-host loop. Deployment packaging owns the process topology;
 * this module intentionally has no import-time side effects.
 */
export async function runGuideWorkerHost(options: GuideWorkerHostOptions): Promise<void> {
  const workerId = options.workerId?.trim() || `guide-host-${randomUUID()}`;
  const pollIntervalMs = Math.max(1_000, Math.min(60_000, options.pollIntervalMs ?? 5_000));
  const log = options.log ?? (() => undefined);
  const runOnce = options.runOnce ?? runGuideWorkerOnce;
  const cleanup = options.cleanup ?? cleanupCancelledUploads;
  const expirePending = options.expirePending ?? (() => expireSqlPendingGuideUploads());
  const configuredMaximum = Number(process.env.GUIDE_WORKER_MAX_JOBS_PER_EXECUTION || "10");
  const maxJobsPerExecution = Math.max(
    1,
    Math.min(
      25,
      options.maxJobsPerExecution
        ?? (Number.isInteger(configuredMaximum) ? configuredMaximum : 10),
    ),
  );
  const continuous = process.env.GUIDE_WORKER_HOST_MODE === "continuous";
  let claimedThisExecution = 0;
  while (!options.signal.aborted) {
    const result = await runOnce(workerId, log);
    if (result.disabled) return;
    claimedThisExecution += result.claimed;
    if (!continuous && result.claimed > 0 && claimedThisExecution < maxJobsPerExecution) {
      continue;
    }
    if (!result.disabled) {
      const expired = await expirePending();
      if (expired > 0) log(`Trabajador de guías: cargas pendientes expiradas=${expired}.`);
      const cleaned = await cleanup();
      if (cleaned > 0) log(`Trabajador de guías: cargas canceladas limpiadas=${cleaned}.`);
    }
    if (!continuous) return;
    await waitForNextPoll(options.signal, pollIntervalMs);
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await runGuideWorkerHost({
      signal: controller.signal,
      log: (message) => process.stdout.write(`${message}\n`),
    });
  } catch {
    process.stderr.write("El host del trabajador de guías terminó con un error controlado.\n");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

if (require.main === module) {
  void main();
}
