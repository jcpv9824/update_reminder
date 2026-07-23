import { getDataBackend, sqlReadsEnabled, sqlSecurityRuntimeEnabled } from "./dataBackend";
import { assertSqlRuntimeReady } from "./sql";

export type RuntimeStatus = {
  backend: "cosmos" | "dual-read" | "sql";
  sqlConnected: boolean;
  sqlSecurityEnabled: boolean;
  timersExpectedDisabled: boolean;
};

export async function loadRuntimeStatus(
  env: NodeJS.ProcessEnv = process.env,
  verifySql: () => Promise<void> = assertSqlRuntimeReady,
): Promise<RuntimeStatus> {
  const backend = getDataBackend(env);
  if (sqlReadsEnabled(env)) await verifySql();
  return {
    backend,
    sqlConnected: sqlReadsEnabled(env),
    sqlSecurityEnabled: sqlSecurityRuntimeEnabled(env),
    timersExpectedDisabled: backend !== "sql",
  };
}
