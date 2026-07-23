import { app } from "@azure/functions";
import {
  maintenanceAction,
  maintenanceUnavailableResponse,
} from "./maintenanceMode";

app.hook.preInvocation((context) => {
  const input = context.inputs[0] as { method?: unknown } | undefined;
  const method = typeof input?.method === "string" ? input.method : undefined;
  const action = maintenanceAction({
    triggerType: context.invocationContext.options.trigger.type,
    method,
  });

  if (action === "block-http") {
    context.functionHandler = async () => maintenanceUnavailableResponse();
    return;
  }

  if (action === "block-timer") {
    context.functionHandler = async () => {
      context.invocationContext.log("Timer skipped because portal maintenance mode is active.");
    };
  }
});
