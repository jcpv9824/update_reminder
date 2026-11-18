import { app } from "@azure/functions";
import { runCatalogRefreshTick } from "../lib/catalogRefreshWorker";

app.timer("processCatalogRefresh", {
  schedule: "0 * * * * *",
  handler: async (_timer, context) => {
    const result = await runCatalogRefreshTick();
    if (result) context.log("catalog_refresh_tick", result);
  },
});
