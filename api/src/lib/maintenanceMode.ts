import type { HttpResponseInit } from "@azure/functions";

export type MaintenanceAction = "allow" | "block-http" | "block-timer";

type MaintenanceInvocation = {
  env?: NodeJS.ProcessEnv;
  triggerType: string;
  method?: string;
};

const READ_ONLY_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function maintenanceModeEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (env.PORTAL_MAINTENANCE_MODE ?? "").trim().toLowerCase() === "true";
}

export function maintenanceAction({
  env = process.env,
  triggerType,
  method,
}: MaintenanceInvocation): MaintenanceAction {
  if (!maintenanceModeEnabled(env)) return "allow";
  if (triggerType === "timerTrigger") return "block-timer";
  if (triggerType !== "httpTrigger") return "allow";
  return READ_ONLY_HTTP_METHODS.has((method ?? "").trim().toUpperCase())
    ? "allow"
    : "block-http";
}

export function maintenanceUnavailableResponse(): HttpResponseInit {
  return {
    status: 503,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": "300",
    },
    jsonBody: {
      error: "El portal está temporalmente en mantenimiento.",
      code: "PORTAL_MAINTENANCE",
    },
  };
}
