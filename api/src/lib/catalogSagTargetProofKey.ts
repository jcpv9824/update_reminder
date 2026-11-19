import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { getSecret } from "./keyVault";

const keyReadTimeoutMs = 3_000;

/** Server only. The caller owns the returned buffer and must wipe it in finally. */
export async function loadCatalogSagTargetProofKey(environment: CatalogEnvironment, matchKeyVersion: unknown,
  config: NodeJS.ProcessEnv = process.env, notAfterMs = Number.POSITIVE_INFINITY): Promise<Buffer | null> {
  const realm = config.PORTAL_SAG_ENVIRONMENT;
  const versionText = config.PORTAL_CATALOG_MATCH_KEY_VERSION;
  const name = config.PORTAL_CATALOG_MATCH_KEY_SECRET_NAME;
  const secretVersion = config.PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION;
  if ((environment !== "qa" && environment !== "production") || realm !== environment ||
    typeof matchKeyVersion !== "number" || !Number.isInteger(matchKeyVersion) ||
    matchKeyVersion < 1 || matchKeyVersion > 32767 || versionText !== String(matchKeyVersion) ||
    typeof name !== "string" || !/^[A-Za-z0-9-]{1,127}(?![\s\S])/.test(name) ||
    typeof secretVersion !== "string" || secretVersion.length !== 32 || !/^[a-f0-9]{32}$/i.test(secretVersion)) return null;

  const began = Date.now();
  const wait = Math.min(keyReadTimeoutMs, notAfterMs - began);
  if (!Number.isFinite(wait) || wait <= 0) return null;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      new Promise<null>(resolve => {
        timeout = setTimeout(() => { controller.abort(); resolve(null); }, wait);
      }),
      getSecret(name, controller.signal, secretVersion),
    ]);
    if (controller.signal.aborted || Date.now() >= began + wait ||
      typeof value !== "string" || value.length !== 64 || !/^[a-f0-9]{64}$/i.test(value)) return null;
    return Buffer.from(value, "hex");
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
