import { app } from "@azure/functions";
import { cleanupPendingChecklistEvidence } from "../lib/checklistEvidenceCleanup";
import { createChecklistEvidenceCleanupStore } from "../lib/checklistEvidenceSqlRepository";
import { checklistEvidenceStorage } from "../lib/checklistEvidenceStorage";
/** Explicit root registration, no run-on-startup, per-row SQL leases allow
 * safe restarts/multiple hosts. This never removes saved evidence bytes. */
export function registerChecklistEvidenceSweep(): void {
  app.timer("checklistEvidenceSweep", { schedule: "0 */15 * * * *", runOnStartup: false, useMonitor: true,
    handler: async (_timer, context) => {
      try {
        const result = await cleanupPendingChecklistEvidence({ store: createChecklistEvidenceCleanupStore(), storage: checklistEvidenceStorage, now: () => new Date() });
        context.log("Limpieza de evidencias pendientes de checklist.", result);
      } catch { context.error("No se pudo completar la limpieza de evidencias pendientes de checklist."); }
    },
  });
}
