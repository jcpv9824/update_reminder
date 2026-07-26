import { randomUUID } from "node:crypto";
import { app, type InvocationContext, type Timer } from "@azure/functions";
import { runGuideWorkerOnce } from "../lib/guideWorker";

app.timer("processGuideJobs", {
  schedule: "0 */1 * * * *",
  runOnStartup: false,
  handler: async (_timer: Timer, context: InvocationContext) => {
    try {
      await runGuideWorkerOnce(`guide-worker-${randomUUID()}`, (message) => context.log(message));
    } catch (error) {
      context.error("Error en processGuideJobs", error);
    }
  },
});
