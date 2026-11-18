import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { readSqlCatalogSourceBindings, CATALOG_ERP_ISSUER_SCOPE } from "./catalogSourceBindingsSqlRepository";
import { refreshCatalogCustomerSource, type CatalogSagIdentityPolicy } from "./catalogCustomerRefresh";
import { loadCatalogSourceTransport } from "./catalogCustomerRefreshService";
import { createSqlCatalogCustomerSnapshotPublisher, type CatalogPublicationOperator } from "./catalogCustomerSnapshotPublishSqlRepository";
import { getSqlPool } from "./sql";
import { getSecret } from "./keyVault";
import { buildCatalogMatchKeyEvidence } from "./catalogMatchKeyEvidence";
import type { CatalogRefreshClaim, CatalogRefreshSettings } from "./catalogRefreshQueueSqlRepository";
import type { SqlCatalogSourceBinding } from "./catalogSourceBindingsSqlRepository";
import type { CatalogRefreshSink } from "./catalogCustomerRefresh";

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

export function catalogRefreshEnabled(values: NodeJS.ProcessEnv = process.env): boolean {
  return values.PORTAL_CATALOG_AUTOMATION_ENABLED?.trim() === "true" && values.PORTAL_CATALOG_READ_ENABLED?.trim() === "true";
}

export function readCatalogRefreshConfiguration(values: NodeJS.ProcessEnv = process.env): CatalogRefreshSettings | null {
  const environment = values.PORTAL_SAG_ENVIRONMENT?.trim();
  const key = keyConfig(values);
  if (!catalogRefreshEnabled(values) || !key || (environment !== "qa" && environment !== "production")) return null;
  return { environment, matchKeyVersion: key.keyVersion, includeSag: parseCatalogSagPolicy(values.PORTAL_CATALOG_SAG_ISSUER_MAP) !== null };
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
  return publishSource(source, { id: input.actorId, environment: input.environment, sourceId: source.id,
    bindingRevision: source.bindingVersion, profileRevision: source.profileRevision, matchKeyVersion: cfg.keyVersion }, cfg, sagPolicy, io);
}

type OperatorPin = CatalogRefreshClaim & { kind: "worker" } | Omit<Extract<CatalogPublicationOperator, { id: string }>,
  "vaultSecretVersion" | "keyVerifier">;
type PublicationOutcome = Awaited<ReturnType<typeof publishSource>> | "stale";

/** Server-owned claim only. A job never uses credentials or an identity supplied by its requester. */
export async function publishClaimedCatalogSource(claim: CatalogRefreshClaim, io = deps,
  values: NodeJS.ProcessEnv = process.env): Promise<PublicationOutcome> {
  const config = readCatalogRefreshConfiguration(values);
  const cfg = keyConfig(values);
  if (!config || !cfg) return "not_configured";
  if (claim.environment !== config.environment || claim.matchKeyVersion !== config.matchKeyVersion) return "stale";
  const lookup = async () => (await io.readBindings(config.environment)).find(row => row.environment === config.environment &&
    row.id.toLowerCase() === claim.sourceId.toLowerCase() && row.bindingVersion === claim.bindingRevision &&
    row.profileRevision === claim.profileRevision && row.state === "active" && row.canReadCurrentProfile);
  const source = await lookup();
  if (!source) return "stale";
  const sagPolicy = source.role === "sag-admin" ? parseCatalogSagPolicy(values.PORTAL_CATALOG_SAG_ISSUER_MAP) : undefined;
  if (sagPolicy === null) return "stale";
  return publishSource(source, { ...claim, sourceId: source.id, kind: "worker" }, cfg, sagPolicy, io, lookup);
}

async function publishSource(source: SqlCatalogSourceBinding, operator: OperatorPin, cfg: NonNullable<ReturnType<typeof keyConfig>>,
  sagPolicy: CatalogSagIdentityPolicy | undefined, io: typeof deps, recheck?: () => Promise<SqlCatalogSourceBinding | undefined>) {
  const deadline = AbortSignal.timeout(40_000);
  const secret = await io.getSecret(cfg.name, AbortSignal.any([deadline, AbortSignal.timeout(5_000)]), cfg.version);
  if (!/^[a-f0-9]{64}$/i.test(secret) || deadline.aborted) return "not_configured" as const;
  const matchKey = Buffer.from(secret, "hex");
  try {
    const publisher = await io.publisher({ ...operator,
      ...buildCatalogMatchKeyEvidence(operator.environment, cfg.keyVersion, cfg.version, matchKey) });
    const observedAt = new Date();
    let reserved: string | undefined;
    const sink: CatalogRefreshSink = operator.kind === "worker" ? {
      reserveAttempt: async () => (reserved = await publisher.reserveAttempt()),
      publish: revision => publisher.publish(revision),
      recordFailure: attempt => publisher.recordFailure(attempt),
    } : publisher;
    const outcome = await refreshCatalogCustomerSource({ binding: source, environment: operator.environment,
      bindingRevision: source.bindingVersion, sink, matchKey, matchKeyVersion: cfg.keyVersion,
      sagPolicy, signal: deadline, now: () => observedAt, transport: async () => {
        // Reserve first. A changed binding must fail closed before opening the external connection.
        const chosen = recheck ? await recheck() : source;
        if (!chosen) throw new Error("catalog_refresh_stale_source");
        const transport = await io.loadTransport(chosen, undefined, deadline);
        if (!recheck) return transport;
        return { async withConsistentRead(queries, options) {
          if (!await recheck() || deadline.aborted) throw new Error("catalog_refresh_stale_or_expired");
          return transport.withConsistentRead(queries, options);
        } };
      } });
    // The generic reader does not record a cancelled deadline as an observation. For an admitted
    // worker attempt, record that failure while the (longer) publication lease is still valid.
    if (outcome === "cancelled" && reserved && operator.kind === "worker") {
      await publisher.recordFailure({ environment: operator.environment, sourceId: operator.sourceId,
        bindingRevision: operator.bindingRevision, profileRevision: operator.profileRevision,
        attemptOrdinal: reserved, matchKeyVersion: operator.matchKeyVersion, observedAt });
    }
    return outcome;
  } catch (error) {
    if (operator.kind === "worker" && error instanceof Error && error.message === "catalog_refresh_stale_source") return "stale" as const;
    throw error;
  } finally {
    matchKey.fill(0);
  }
}
