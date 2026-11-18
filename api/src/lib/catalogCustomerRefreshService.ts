import { refreshCatalogCustomerSource, type CatalogRefreshSink, type CatalogSagIdentityPolicy } from "./catalogCustomerRefresh";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import type { CatalogExternalSourceTransport } from "./catalogExternalSourceQueries";
import { createCatalogExternalSqlTransport } from "./catalogExternalSqlTransport";
import { readSqlCatalogSourceBindings, type SqlCatalogSourceBinding } from "./catalogSourceBindingsSqlRepository";
import { readStoredExternalDatabaseConnection } from "./integrationConnectionsSqlRepository";
import { getSecret } from "./keyVault";

type SourceResult = Readonly<{
  sourceId: string;
  outcome: Awaited<ReturnType<typeof refreshCatalogCustomerSource>> | "publication_failed";
}>;

const unavailableTransport: CatalogExternalSourceTransport = {
  async withConsistentRead() { throw new Error("catalog_source_unavailable"); },
};

const deps = {
  readBindings: readSqlCatalogSourceBindings,
  readProfile: readStoredExternalDatabaseConnection,
  readSecret: getSecret,
  createTransport: createCatalogExternalSqlTransport,
};

/** Server-only, bounded, independent reads. The caller must supply an authorized publisher. */
export async function runCatalogCustomerRefresh(options: {
  environment: CatalogEnvironment;
  sink: CatalogRefreshSink;
  matchKey: Buffer;
  matchKeyVersion: number;
  sagPolicy?: CatalogSagIdentityPolicy;
  signal?: AbortSignal;
}, io: typeof deps = deps): Promise<readonly SourceResult[]> {
  const { environment, signal } = options;
  if (!["qa", "production"].includes(environment) || !Buffer.isBuffer(options.matchKey) || options.matchKey.length < 32
    || !Number.isInteger(options.matchKeyVersion) || options.matchKeyVersion < 1 || options.matchKeyVersion > 32767) {
    throw new Error("catalog_refresh_config_invalid");
  }
  if (signal?.aborted) return [];
  const bindings = (await io.readBindings(environment)).filter(binding => binding.environment === environment &&
    binding.state === "active" && binding.canReadCurrentProfile);
  if (bindings.length > 32 || new Set(bindings.map(binding => binding.id.toLowerCase())).size !== bindings.length
    || bindings.filter(binding => binding.role === "sag-admin").length > 1) throw new Error("catalog_binding_set_invalid");

  const results: SourceResult[] = [];
  let next = 0;
  async function work() {
    while (!signal?.aborted && next < bindings.length) {
      const binding = bindings[next++];
      const observedAt = new Date();
      try {
        const outcome = await refreshCatalogCustomerSource({
          ...options, binding, bindingRevision: binding.bindingVersion,
          transport: () => loadCatalogSourceTransport(binding, io, signal), now: () => observedAt,
        });
        results.push({ sourceId: binding.id, outcome });
      } catch {
        // Pipeline failures are local to this source and carry no exception or configuration details.
        results.push({ sourceId: binding.id, outcome: "publication_failed" });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, bindings.length) }, work));
  return results;
}

export async function loadCatalogSourceTransport(
  binding: SqlCatalogSourceBinding, io: typeof deps = deps, signal?: AbortSignal,
): Promise<CatalogExternalSourceTransport> {
  if (signal?.aborted) return unavailableTransport;
  const timeout = AbortSignal.timeout(8_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let cancel: (() => void) | undefined;
  const cancelled = new Promise<CatalogExternalSourceTransport>(resolve => {
    cancel = () => resolve(unavailableTransport);
    if (deadline.aborted) cancel();
    else deadline.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([cancelled, (async () => {
      if (deadline.aborted) return unavailableTransport;
      const profile = await io.readProfile(binding.profileId);
      if (deadline.aborted || !profile || profile.id !== binding.profileId || profile.etag !== binding.profileRevision
        || !profile.active || profile.status !== "active" || !profile.encrypt
        || !profile.passwordConfigured || !profile.passwordSecretName) {
        return unavailableTransport;
      }
      const password = await io.readSecret(profile.passwordSecretName, deadline);
      if (deadline.aborted || !password) return unavailableTransport;
      return io.createTransport({ server: profile.serverHost, port: profile.serverPort, database: profile.databaseName,
        username: profile.username, password });
    })()]);
  } catch {
    return unavailableTransport;
  } finally {
    if (cancel) deadline.removeEventListener("abort", cancel);
  }
}
