import { publishClaimedCatalogSagV2 } from "./catalogSagV2ClaimedPublication";
import { createCatalogSagV2PublisherPoolLoader, readCatalogSagV2PublisherPoolSettings } from "./catalogSagV2PublisherPool";
import { readCatalogRefreshConfiguration } from "./catalogSourcePublication";
import { readSqlCatalogSourceBindingForClaim } from "./catalogSourceBindingsSqlRepository";
import { loadCatalogSourceTransport } from "./catalogCustomerRefreshService";
import { getSecret } from "./keyVault";
import type { CatalogRefreshClaim } from "./catalogRefreshQueueSqlRepository";
import type { CatalogSagV2RefreshOutcome } from "./catalogSagV2RefreshOrchestrator";

export type PreparedCatalogSagV2Publication = Readonly<{
  isCurrent(env: NodeJS.ProcessEnv): boolean;
  publish(claim: CatalogRefreshClaim, env: NodeJS.ProcessEnv): Promise<CatalogSagV2RefreshOutcome>;
}>;

// Environment changes in Azure restart the host. Never retire another tick's
// in-flight writer as a side effect of seeing a changed flag or configuration.
const loaders = new Map<string, Readonly<{
  loader: ReturnType<typeof createCatalogSagV2PublisherPoolLoader>;
  credentialMatches(env: NodeJS.ProcessEnv): boolean;
}>>();

function pins(env: NodeJS.ProcessEnv) {
  const queue = readCatalogRefreshConfiguration(env);
  if (queue?.includeSagV2 !== true) return null;
  const pool = readCatalogSagV2PublisherPoolSettings(env);
  if (!pool || pool.environment !== queue.environment) return null;
  const poolKey = JSON.stringify(pool);
  const policyKey = JSON.stringify([poolKey, queue.matchKeyVersion, env.PORTAL_CATALOG_MATCH_KEY_SECRET_NAME,
    env.PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION, env.PORTAL_CATALOG_SAG_ISSUER_MAP]);
  return { pool, poolKey, policyKey };
}

/** Internal comparison token only; never include this value in HTTP or telemetry. */
export const catalogSagV2ConfigurationPin = (env: NodeJS.ProcessEnv) => pins(env)?.policyKey ?? null;

/** Ready means checked on the isolated connection for the selected mode, not just configured. */
export async function prepareCatalogSagV2Publication(env: NodeJS.ProcessEnv): Promise<PreparedCatalogSagV2Publication | null> {
  const initial = pins(env);
  if (!initial) return null;
  let entry = loaders.get(initial.poolKey);
  if (!entry) {
    if (loaders.size >= 2) return null;
    // Never serialize or hash the owner credential into a cache/policy key.
    // Rotation requires host restart; until then reject drift without retiring
    // another in-flight tick or silently reusing its old authenticated pool.
    const ownerPassword = initial.pool.mode === "portal-owner" ? env.SQL_PASSWORD : undefined;
    entry = Object.freeze({ loader: createCatalogSagV2PublisherPoolLoader(env),
      credentialMatches: (current: NodeJS.ProcessEnv) => initial.pool.mode !== "portal-owner" || current.SQL_PASSWORD === ownerPassword });
    loaders.set(initial.poolKey, entry);
  }
  const selected = entry;
  const isCurrent = (current: NodeJS.ProcessEnv) => pins(current)?.policyKey === initial.policyKey && selected.credentialMatches(current);
  try {
    if (!isCurrent(env)) return null;
    const pool = await selected.loader.get();
    if (!isCurrent(env)) return null;
    return Object.freeze({ isCurrent,
      async publish(claim: CatalogRefreshClaim, current: NodeJS.ProcessEnv): Promise<CatalogSagV2RefreshOutcome> {
        if (!isCurrent(current)) return { outcome: "ineligible", queue: "untouched" };
        return publishClaimedCatalogSagV2(claim, {
          readBindings: readSqlCatalogSourceBindingForClaim,
          getSecret,
          loadTransport: (binding, signal) => loadCatalogSourceTransport(binding, undefined, signal),
          async getDedicatedPool(environment) {
            if (environment !== initial.pool.environment || !isCurrent(current)) throw new Error("catalog_sag_v2_publisher_unavailable");
            return pool;
          },
        }, current);
      },
    });
  } catch { return null; }
}
