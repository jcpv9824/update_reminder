export type DataBackend = "cosmos" | "sql" | "dual-read";

export function getDataBackend(env: NodeJS.ProcessEnv = process.env): DataBackend {
  const value = (env.DATA_BACKEND ?? "cosmos").trim().toLowerCase();
  if (value === "cosmos" || value === "sql" || value === "dual-read") return value;
  throw new Error("DATA_BACKEND debe ser cosmos, sql o dual-read.");
}

export function sqlReadsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getDataBackend(env) !== "cosmos";
}

export function sqlWritesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getDataBackend(env) === "sql";
}

export function sqlSecurityRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // This is an independent fail-closed rollout gate. Keep it false until the
  // complete SQL login/password/audit/outbox transaction is certified.
  return getDataBackend(env) === "sql"
    && (env.SQL_SECURITY_RUNTIME_ENABLED ?? "false").trim().toLowerCase() === "true";
}

export function assertCosmosRuntimeMutation(feature: string, env: NodeJS.ProcessEnv = process.env): void {
  if (getDataBackend(env) === "sql") {
    throw Object.assign(new Error(`${feature} aún no está habilitado para escritura SQL.`), { status: 503 });
  }
}
