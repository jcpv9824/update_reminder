/** Preserve the existing full-catalog contract independently of Clients rollout. */
export const catalogFullReadEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.PORTAL_CATALOG_READ_ENABLED?.trim() === "true";

/** Clients-only never grants inventory, task, credential or report access.
 * Refresh writes additionally require the separate automation flag. */
export const catalogClientsReadEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  catalogFullReadEnabled(env) || env.PORTAL_CATALOG_CLIENTS_READ_ENABLED === "true";
