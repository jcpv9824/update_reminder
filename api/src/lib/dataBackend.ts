export type DataBackend = "sql";

export function getDataBackend(env: NodeJS.ProcessEnv = process.env): DataBackend {
  const configured = env.DATA_BACKEND;
  if (!configured?.trim()) {
    throw new Error("Falta DATA_BACKEND. Configure explícitamente sql.");
  }
  const value = configured.trim().toLowerCase();
  if (value === "sql") return value;
  throw new Error("DATA_BACKEND debe ser sql.");
}

export function sqlReadsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  getDataBackend(env);
  return true;
}

export function sqlWritesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  getDataBackend(env);
  return true;
}

export function sqlSecurityRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  getDataBackend(env);
  if ((env.SQL_SECURITY_RUNTIME_ENABLED ?? "").trim().toLowerCase() !== "true") {
    throw new Error(
      "SQL_SECURITY_RUNTIME_ENABLED debe ser true cuando DATA_BACKEND=sql."
    );
  }
  return true;
}
