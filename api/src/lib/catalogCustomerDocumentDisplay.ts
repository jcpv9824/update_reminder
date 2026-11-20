import type { CatalogDirectoryInput } from "./catalogCustomerDirectory";
import { catalogDocumentNumberToken } from "./catalogCustomerRefresh";
import { loadCatalogSourceTransport } from "./catalogCustomerRefreshService";
import { readCatalogExternalSource } from "./catalogExternalSourceQueries";
import { readSqlCatalogSourceBindings, type SqlCatalogSourceBinding } from "./catalogSourceBindingsSqlRepository";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";
import { getSecret } from "./keyVault";

type DocumentRows = ReadonlyMap<number, Readonly<{ document: string; token: string }>>;
type RawDocument = Readonly<{ sourceRecordId: number; documentNumber: string | null }>;
type MatchKeyPin = Readonly<{ name: string; version: string; keyVersion: number }>;
type Io = {
  bindings: typeof readSqlCatalogSourceBindings;
  secret: typeof getSecret;
  read: (binding: SqlCatalogSourceBinding, signal: AbortSignal) => Promise<readonly RawDocument[] | null>;
  now: () => number;
};

const io: Io = { bindings: readSqlCatalogSourceBindings, secret: getSecret, now: Date.now,
  async read(binding, signal) {
    const transport = await loadCatalogSourceTransport(binding, undefined, signal);
    const result = await readCatalogExternalSource(transport,
      binding.role === "erp-customers" ? "erp_v1" : "sag_admin_v1",
      { pageSize: 1000, signal });
    return result.status === "complete" ? result.records : null;
  },
};

/** Ephemeral only: do not persist original documents, put them in URLs, or use them as route IDs. */
export function createCatalogCustomerDocumentDisplay(deps: Io = io) {
  const cache = new Map<string, { expires: number; result: Promise<DocumentRows | null> }>();
  let reads = 0;
  function load(binding: SqlCatalogSourceBinding, pin: MatchKeyPin): Promise<DocumentRows | null> {
    const now = deps.now();
    for (const [key, entry] of cache) if (entry.expires <= now) cache.delete(key);
    const key = JSON.stringify([binding.environment, binding.id, binding.role, binding.bindingVersion, binding.profileRevision,
      pin.name, pin.version, pin.keyVersion]);
    const existing = cache.get(key);
    if (existing) return existing.result;
    if (cache.size >= 32 || reads >= 2) return Promise.resolve(null);
    const entry = { expires: Number.POSITIVE_INFINITY, result: Promise.resolve<DocumentRows | null>(null) };
    reads++;
    entry.result = Promise.resolve().then(async () => {
      const deadline = AbortSignal.timeout(55_000);
      const cancelled = new AbortController();
      const observed = await Promise.allSettled([
        deps.read(binding, AbortSignal.any([deadline, cancelled.signal])),
        deps.secret(pin.name, AbortSignal.any([deadline, AbortSignal.timeout(4_000)]), pin.version).then(value => {
          if (!/^[a-f0-9]{64}$/i.test(value)) cancelled.abort();
          return value;
        }, () => { cancelled.abort(); return ""; }),
      ] as const);
      const rows = observed[0].status === "fulfilled" ? observed[0].value : null;
      const encoded = observed[1].status === "fulfilled" ? observed[1].value : "";
      if (!rows || rows.length > 50_000 || !/^[a-f0-9]{64}$/i.test(encoded) || deadline.aborted) return null;
      const matchKey = Buffer.from(encoded, "hex");
      try {
        const documents = new Map<number, { document: string; token: string }>();
        for (const row of rows) {
          const document = row.documentNumber?.trim();
          const token = document ? catalogDocumentNumberToken(matchKey, binding.environment, document) : null;
          if (document && token) documents.set(row.sourceRecordId, { document, token: `hmac:${token.toString("hex")}` });
        }
        return documents;
      } finally {
        matchKey.fill(0);
      }
    }).catch(() => null).then(result => {
      reads--;
      const maxAge = result ? 300_000 : 10_000;
      entry.expires = deps.now() + maxAge;
      setTimeout(() => { if (cache.get(key) === entry) cache.delete(key); }, maxAge).unref();
      return result;
    });
    cache.set(key, entry);
    return entry.result;
  }

  return async (input: CatalogDirectoryInput, environment: CatalogEnvironment, keyVersion: number,
    requestedSourceIds?: readonly string[], values: NodeJS.ProcessEnv = process.env): Promise<CatalogDirectoryInput> => {
    const result = { ...input, showDocuments: true };
    const selected = requestedSourceIds ? new Set(requestedSourceIds) : input.allowedSourceIds;
    const erp = new Set(input.erp.filter(source => input.allowedSourceIds.has(source.sourceId) &&
      selected.has(source.sourceId) && source.customers.some(row => row.document?.number.startsWith("hmac:")))
      .map(source => source.sourceId));
    const sag = new Set(requestedSourceIds === undefined ? (input.sagOnlyCustomers ?? []).flatMap(row => {
      const ref = input.sagOnlyDocumentReferences?.get(row.customerId);
      return ref ? [ref.sourceId] : [];
    }) : []);
    if (!erp.size && !sag.size) return result;
    const name = values.PORTAL_CATALOG_MATCH_KEY_SECRET_NAME ?? "";
    const version = values.PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION ?? "";
    if (!/^[A-Za-z0-9-]{1,127}$/.test(name) || !/^[a-f0-9]{32}$/i.test(version) ||
        values.PORTAL_CATALOG_MATCH_KEY_VERSION !== String(keyVersion)) return { ...result, partial: true };
    try {
      const bindings = await deps.bindings(environment);
      const approved = bindings.filter(b => b.environment === environment && b.state === "active" && b.canReadCurrentProfile &&
        ((b.role === "erp-customers" && b.contractVersion === "erp_v1" && erp.has(b.id.toLowerCase())) ||
         (b.role === "sag-admin" && b.contractVersion === "sag_admin_v2" && sag.has(b.id.toLowerCase()))));
      if (new Set(approved.map(b => b.id.toLowerCase())).size !== approved.length) return { ...result, partial: true };
      const observations = new Map(await Promise.all(approved.map(async b =>
        [b.id.toLowerCase(), await load(b, { name, version, keyVersion })] as const)));
      let missing = observations.size !== erp.size + sag.size || [...observations.values()].some(x => x === null);
      const documentFor = (sourceId: string, recordId: number, token: string | undefined) => {
        if (!token || !/^hmac:[a-f0-9]{64}$/.test(token)) return null;
        const candidate = observations.get(sourceId)?.get(recordId);
        if (candidate?.token === token) return candidate.document;
        missing = true;
        return null;
      };
      result.erp = input.erp.map(source => !erp.has(source.sourceId) ? source : { ...source, customers:
        source.customers.map(row => ({ ...row, displayDocument: documentFor(source.sourceId, Number(row.sourceCustomerId), row.document?.number) })) });
      if (sag.size) result.sagOnlyCustomers = input.sagOnlyCustomers?.map(row => {
        const ref = input.sagOnlyDocumentReferences?.get(row.customerId);
        return ref ? { ...row, displayDocument: documentFor(ref.sourceId, ref.recordId, ref.token) } : row;
      });
      result.partial = input.partial === true || missing;
      return result;
    } catch {
      return { ...result, partial: true };
    }
  };
}

export const addCatalogCustomerDocuments = createCatalogCustomerDocumentDisplay();
