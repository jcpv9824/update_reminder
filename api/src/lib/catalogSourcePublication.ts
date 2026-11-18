import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { readSqlCatalogSourceBindings, CATALOG_ERP_ISSUER_SCOPE } from "./catalogSourceBindingsSqlRepository";
import { refreshCatalogCustomerSource, type CatalogSagIdentityPolicy } from "./catalogCustomerRefresh";
import { loadCatalogSourceTransport } from "./catalogCustomerRefreshService";
import { createSqlCatalogCustomerSnapshotPublisher, type CatalogPublicationOperator } from "./catalogCustomerSnapshotPublishSqlRepository";
import { getSqlPool } from "./sql";
import { getSecret } from "./keyVault";
import { buildCatalogMatchKeyEvidence } from "./catalogMatchKeyEvidence";

const deps = { readBindings: readSqlCatalogSourceBindings, getSecret, loadTransport: loadCatalogSourceTransport,
  async publisher(operator: CatalogPublicationOperator) { return createSqlCatalogCustomerSnapshotPublisher(await getSqlPool(), { operator }); } };

function keyConfig(values: NodeJS.ProcessEnv) {
  const keyVersion = values.PORTAL_CATALOG_MATCH_KEY_VERSION?.trim() ?? "";
  const name = values.PORTAL_CATALOG_MATCH_KEY_SECRET_NAME?.trim() ?? "";
  const version = values.PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION?.trim() ?? "";
  if (!/^[1-9][0-9]{0,4}$/.test(keyVersion) || Number(keyVersion) > 32767 ||
      !/^[A-Za-z0-9-]{1,127}$/.test(name) || !/^[a-f0-9]{32}$/i.test(version)) return null;
  return { name, version, keyVersion: Number(keyVersion) };
}

/** Deployment-owned data only. Do not infer country from the document or assume absence coverage. */
export function parseCatalogSagPolicy(raw: string | undefined): CatalogSagIdentityPolicy | null {
  if (!raw || raw.length > 12_000) return null;
  try {
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 250) return null;
    const map = new Map<number, string>();
    for (const item of rows) {
      if (!item || typeof item !== "object" || Object.keys(item).length !== 2 ||
          !Number.isSafeInteger(item.countryId) || item.countryId < 1 || item.countryId > 2147483647 ||
          typeof item.issuerScope !== "string" || !CATALOG_ERP_ISSUER_SCOPE.test(item.issuerScope) || map.has(item.countryId)) return null;
      map.set(item.countryId, item.issuerScope);
    }
    // Positive matches only until a separate coverage certification authorizes negatives.
    return { scopesByCountry: map, completeScopes: [] };
  } catch { return null; }
}

/** Exact source only. No user-controlled profile, host, key, mapping, or environment override. */
export async function publishSavedCatalogSource(input: { environment: CatalogEnvironment; sourceId: string; actorId: string },
  io = deps, values: NodeJS.ProcessEnv = process.env) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.sourceId) ||
    !["qa", "production"].includes(input.environment) || !input.actorId.trim()) return "ineligible" as const;
  const source = (await io.readBindings(input.environment)).find(row => row.environment === input.environment &&
    row.id.toLowerCase() === input.sourceId.toLowerCase());
  if (!source) return "missing" as const;
  if (source.state !== "active" || !source.canReadCurrentProfile) return "ineligible" as const;
  const cfg = keyConfig(values);
  const sagPolicy = source.role === "sag-admin" ? parseCatalogSagPolicy(values.PORTAL_CATALOG_SAG_ISSUER_MAP) : undefined;
  if (!cfg || sagPolicy === null) return "not_configured" as const;
  const deadline = AbortSignal.timeout(40_000);
  const secret = await io.getSecret(cfg.name, AbortSignal.any([deadline, AbortSignal.timeout(5_000)]), cfg.version);
  if (!/^[a-f0-9]{64}$/i.test(secret) || deadline.aborted) return "not_configured" as const;
  const matchKey = Buffer.from(secret, "hex");
  try {
    const sink = await io.publisher({ id: input.actorId, environment: input.environment, sourceId: source.id,
      bindingRevision: source.bindingVersion, profileRevision: source.profileRevision, matchKeyVersion: cfg.keyVersion,
      ...buildCatalogMatchKeyEvidence(input.environment, cfg.keyVersion, cfg.version, matchKey) });
    return await refreshCatalogCustomerSource({ binding: source, environment: input.environment, bindingRevision: source.bindingVersion,
      sink, matchKey, matchKeyVersion: cfg.keyVersion,
      sagPolicy, signal: deadline, transport: () => io.loadTransport(source, undefined, deadline) });
  } finally {
    matchKey.fill(0);
  }
}
