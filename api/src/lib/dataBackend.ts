export type DataBackend = "cosmos" | "sql" | "dual-read";

export function getDataBackend(env: NodeJS.ProcessEnv = process.env): DataBackend {
  const configured = env.DATA_BACKEND;
  if (!configured?.trim()) {
    throw new Error("Falta DATA_BACKEND. Configure explícitamente sql; no existe fallback automático a Cosmos.");
  }
  const value = configured.trim().toLowerCase();
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
  if (getDataBackend(env) !== "sql") return false;
  if ((env.SQL_SECURITY_RUNTIME_ENABLED ?? "").trim().toLowerCase() !== "true") {
    throw new Error(
      "SQL_SECURITY_RUNTIME_ENABLED debe ser true cuando DATA_BACKEND=sql; no se permite volver a seguridad Cosmos."
    );
  }
  return true;
}

export function assertCosmosRuntimeMutation(feature: string, env: NodeJS.ProcessEnv = process.env): void {
  if (getDataBackend(env) === "sql") {
    throw Object.assign(new Error(`${feature} aún no está habilitado para escritura SQL.`), { status: 503 });
  }
}
