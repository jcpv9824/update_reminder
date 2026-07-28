import type { ClaimedGuideJob } from "./guideBuilderSqlRepository";
import {
  claimSqlGuideJobs,
  completeSqlGuideJobAttempt,
  renewSqlGuideJobLease,
} from "./guideBuilderSqlRepository";
import { guideFeatureEnabled, guideWorkerEnabled } from "./guideBuilder";
import { createGuideProcessor, type GuideProcessorControl } from "./guideProcessor";

export type GuideJobProcessor = {
  process(job: ClaimedGuideJob, control: GuideProcessorControl): Promise<Record<string, unknown> | void>;
};

export type GuideWorkerDependencies = {
  enabled: boolean;
  claim: (workerId: string, batchSize: number, leaseSeconds: number) => Promise<ClaimedGuideJob[]>;
  renew?: typeof renewSqlGuideJobLease;
  complete: typeof completeSqlGuideJobAttempt;
  processor: GuideJobProcessor;
};

function controlledFailure(error: unknown): { code: string; summary: string } {
  const candidate = error as { code?: unknown };
  const code = typeof candidate.code === "string" && /^[a-z0-9_]{1,80}$/i.test(candidate.code)
    ? candidate.code
    : "guide_processing_failed";
  const summaries: Record<string, string> = {
    guide_lease_lost: "La concesión del trabajo expiró o la sesión fue cancelada.",
    invalid_video_signature: "La firma del video no es válida.",
    invalid_video_codec: "El codec del video no está permitido.",
    invalid_duration: "La duración del video no es válida.",
    invalid_video_shape: "La resolución o frecuencia del video no es válida.",
    guide_source_mismatch: "La fuente cargada no coincide con la declaración.",
    openai_not_configured: "El proveedor de IA no está configurado.",
    openai_invalid_output: "El proveedor de IA devolvió una respuesta inválida.",
    invalid_manual_structure: "El manual generado no cumple la estructura requerida.",
    unsafe_manual_output: "El manual generado contiene contenido inseguro.",
    guide_answer_round_limit: "La guía agotó las rondas de aclaración permitidas.",
  };
  return { code, summary: summaries[code] ?? "El procesamiento de la guía falló de forma controlada." };
}

export async function runGuideWorkerOnce(
  workerId: string,
  log: (message: string) => void,
  dependencies?: GuideWorkerDependencies,
): Promise<{ disabled: boolean; claimed: number; succeeded: number; failed: number }> {
  const resolved: GuideWorkerDependencies = dependencies ?? {
    enabled: guideFeatureEnabled() && guideWorkerEnabled(),
    claim: claimSqlGuideJobs,
    renew: renewSqlGuideJobLease,
    complete: completeSqlGuideJobAttempt,
    processor: createGuideProcessor(workerId),
  };
  if (!resolved.enabled) return { disabled: true, claimed: 0, succeeded: 0, failed: 0 };
  const jobs = await resolved.claim(workerId, 1, 600);
  let succeeded = 0;
  let failed = 0;
  for (const job of jobs) {
    const abortController = new AbortController();
    let leaseFailure: unknown;
    const heartbeat = async () => {
      if (!resolved.renew) return;
      try {
        await resolved.renew(job, workerId, 600);
      } catch (error) {
        leaseFailure = error;
        abortController.abort();
        throw error;
      }
    };
    const timer = setInterval(() => {
      void heartbeat().catch(() => undefined);
    }, 60_000);
    timer.unref();
    let metrics: Record<string, unknown> | void;
    try {
      await heartbeat();
      metrics = await resolved.processor.process(job, {
        workerId,
        signal: abortController.signal,
        heartbeat,
      });
      await heartbeat();
    } catch (error) {
      clearInterval(timer);
      if (leaseFailure) {
        failed++;
        continue;
      }
      const failure = controlledFailure(error);
      if (failure.code === "guide_lease_lost") {
        failed++;
        continue;
      }
      await resolved.complete(job, workerId, {
        ok: false,
        errorCode: failure.code,
        errorSummary: failure.summary,
      });
      failed++;
      continue;
    }
    clearInterval(timer);
    await resolved.complete(job, workerId, { ok: true, metrics: metrics ?? undefined });
    succeeded++;
  }
  log(`Trabajador de guías: reclamados=${jobs.length}; correctos=${succeeded}; fallidos=${failed}.`);
  return { disabled: false, claimed: jobs.length, succeeded, failed };
}
