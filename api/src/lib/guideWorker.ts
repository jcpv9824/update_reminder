import type { ClaimedGuideJob } from "./guideBuilderSqlRepository";
import {
  claimSqlGuideJobs,
  completeSqlGuideJobAttempt,
} from "./guideBuilderSqlRepository";
import { guideWorkerEnabled } from "./guideBuilder";

export type GuideJobProcessor = {
  process(job: ClaimedGuideJob): Promise<Record<string, unknown> | void>;
};

export type GuideWorkerDependencies = {
  enabled: boolean;
  claim: (workerId: string, batchSize: number, leaseSeconds: number) => Promise<ClaimedGuideJob[]>;
  complete: typeof completeSqlGuideJobAttempt;
  processor: GuideJobProcessor;
};

const blockedProcessor: GuideJobProcessor = {
  async process() {
    throw Object.assign(
      new Error("El host de producción para ffmpeg/OpenAI aún no ha sido certificado."),
      { code: "worker_host_unproven" },
    );
  },
};

export async function runGuideWorkerOnce(
  workerId: string,
  log: (message: string) => void,
  dependencies: GuideWorkerDependencies = {
    enabled: guideWorkerEnabled(),
    claim: claimSqlGuideJobs,
    complete: completeSqlGuideJobAttempt,
    processor: blockedProcessor,
  },
): Promise<{ disabled: boolean; claimed: number; succeeded: number; failed: number }> {
  if (!dependencies.enabled) return { disabled: true, claimed: 0, succeeded: 0, failed: 0 };
  const jobs = await dependencies.claim(workerId, 1, 600);
  let succeeded = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      const metrics = await dependencies.processor.process(job);
      await dependencies.complete(job, workerId, { ok: true, metrics: metrics ?? undefined });
      succeeded++;
    } catch (error) {
      const candidate = error as { code?: string; message?: string };
      await dependencies.complete(job, workerId, {
        ok: false,
        errorCode: candidate.code ?? "guide_processing_failed",
        errorSummary: candidate.message ?? "Falló el procesamiento de la guía.",
      });
      failed++;
    }
  }
  log(`Trabajador de guías: reclamados=${jobs.length}; correctos=${succeeded}; fallidos=${failed}.`);
  return { disabled: false, claimed: jobs.length, succeeded, failed };
}
