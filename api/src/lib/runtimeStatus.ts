import { getDataBackend, sqlReadsEnabled, sqlSecurityRuntimeEnabled } from "./dataBackend";
import { maintenanceModeEnabled } from "./maintenanceMode";
import { assertSqlRuntimeReady } from "./sql";

export const TIMER_FUNCTION_NAMES = [
  "generateDailyUpdateTasks",
  "sendScheduledReminders",
  "sendOverdueAlerts",
  "sendAdministrativeReminders",
  "sendBlockedReminders",
  "processEmailOutbox",
] as const;

export type TimerDisableState = "all" | "none" | "partial";

export type RuntimeStatus = {
  backend: "sql";
  sqlConnected: boolean;
  sqlSecurityEnabled: boolean;
  maintenanceMode: boolean;
  timersExpectedDisabled: boolean;
  timerDisableState: TimerDisableState;
};

export function loadTimerDisableState(
  env: NodeJS.ProcessEnv = process.env,
): TimerDisableState {
  const disabledCount = TIMER_FUNCTION_NAMES.filter((name) => (
    (env[`AzureWebJobs.${name}.Disabled`] ?? "").trim().toLowerCase() === "true"
  )).length;
  if (disabledCount === 0) return "none";
  if (disabledCount === TIMER_FUNCTION_NAMES.length) return "all";
  return "partial";
}

export async function loadRuntimeStatus(
  env: NodeJS.ProcessEnv = process.env,
  verifySql: () => Promise<void> = assertSqlRuntimeReady,
): Promise<RuntimeStatus> {
  const backend = getDataBackend(env);
  const maintenanceMode = maintenanceModeEnabled(env);
  await verifySql();
  return {
    backend,
    sqlConnected: true,
    sqlSecurityEnabled: sqlSecurityRuntimeEnabled(env),
    maintenanceMode,
    timersExpectedDisabled: maintenanceMode,
    timerDisableState: loadTimerDisableState(env),
  };
}
