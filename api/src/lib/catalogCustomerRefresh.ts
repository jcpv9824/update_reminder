import { createHmac } from "node:crypto";
import { readCatalogExternalSource, type CatalogExternalSourceTransport } from "./catalogExternalSourceQueries";
import type { CatalogEnvironment, CatalogSourceBinding } from "./catalogSourceConfiguration";
import { normalizeCatalogSagInventoryEvidence, type CatalogSagInventoryEvidence } from "./catalogSagInventoryEvidence";

type Stamp = Readonly<{
  environment: CatalogEnvironment;
  sourceId: string;
  profileRevision: string;
  bindingRevision: string;
  attemptOrdinal: string;
  matchKeyVersion: number;
  observedAt: Date;
}>;

export type CatalogRefreshRow = Readonly<{
  sourceRecordId: number;
  issuerScope: string | null;
  matchToken: Buffer | null;
  name: string | null;
  activeCode: "S" | "N" | null;
  sagEvidence?: CatalogSagInventoryEvidence;
}>;

export type CatalogRefreshPublication = Stamp & Readonly<{
  role: CatalogSourceBinding["role"];
  rows: readonly CatalogRefreshRow[];
  completeScopes: readonly string[];
  includesSagInventory?: boolean;
}>;

export interface CatalogRefreshSink {
  reserveAttempt(): Promise<string>;
  publish(revision: CatalogRefreshPublication): Promise<"published" | "superseded">;
  recordFailure(attempt: Stamp): Promise<void>;
}

export function catalogDocumentNumberToken(key: Buffer, environment: CatalogEnvironment, document: string): Buffer | null {
  if (!Buffer.isBuffer(key) || key.length < 32 || !["qa", "production"].includes(environment)) {
    throw new Error("invalid_catalog_match_key");
  }
  const exact = document.trim();
  if (!exact || exact.length > 128 || /\p{C}/u.test(exact)) return null;
  return createHmac("sha256", key)
    .update(`portal-sag/customer-document-number/v1\0${environment}\0${exact}`, "utf8").digest();
}

const issuerScope = /^[A-Z]{2}:[A-Z][A-Z0-9_-]{0,31}$/;
const bindingId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const rowVersion = /^[0-9a-f]{16}$/i;
const bogotaDay = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit",
});

/** Trust is supplied by reviewed source configuration, never guessed from the number. */
export interface CatalogSagIdentityPolicy {
  readonly scopesByCountry: ReadonlyMap<number, string>;
  readonly completeScopes: readonly string[];
}

type RefreshOutcome = "published" | "superseded" | "unavailable" | "cancelled" | "ineligible";

/** Admit exactly one active binding. External rows never cross into the publisher verbatim. */
export async function refreshCatalogCustomerSource(args: {
  binding: CatalogSourceBinding;
  bindingRevision: string;
  environment: CatalogEnvironment;
  transport: CatalogExternalSourceTransport | (() => Promise<CatalogExternalSourceTransport>);
  sink: CatalogRefreshSink;
  matchKey: Buffer;
  matchKeyVersion: number;
  sagPolicy?: CatalogSagIdentityPolicy;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<RefreshOutcome> {
  const { binding, environment, signal, sink, matchKey, matchKeyVersion, sagPolicy } = args;
  if (signal?.aborted) return "cancelled";
  const observedAt = (args.now ?? (() => new Date()))();
  if (binding.state !== "active" || binding.environment !== environment || !bindingId.test(binding.id)
    || !rowVersion.test(binding.profileRevision) || !rowVersion.test(args.bindingRevision)
    || !Buffer.isBuffer(matchKey) || matchKey.length < 32
    || !Number.isInteger(matchKeyVersion) || matchKeyVersion < 1 || matchKeyVersion > 32767
    || !Number.isFinite(observedAt.valueOf()) || !["qa", "production"].includes(environment)) return "ineligible";
  const erpScope = binding.role === "erp-customers" && binding.contractVersion === "erp_v1" &&
    binding.issuerScope && issuerScope.test(binding.issuerScope) ? binding.issuerScope : null;
  const isSag = binding.role === "sag-admin" && binding.contractVersion === "sag_admin_v1";
  if (!erpScope && !isSag) return "ineligible";
  const scopesByCountry = isSag ? new Map(sagPolicy?.scopesByCountry) : new Map<number, string>();
  const trustedScopes = new Set(scopesByCountry.values());
  const completeScopes = isSag ? [...new Set(sagPolicy?.completeScopes)] : [];
  if ([...trustedScopes].some(scope => !issuerScope.test(scope))
    || completeScopes.some(scope => !trustedScopes.has(scope))) return "ineligible";
  const attemptOrdinal = await sink.reserveAttempt();
  if (signal?.aborted) return "cancelled";
  if (!/^[1-9][0-9]{0,18}$/.test(attemptOrdinal) || BigInt(attemptOrdinal) > 9223372036854775807n) {
    throw new Error("invalid_catalog_attempt");
  }
  const stamp = { environment, sourceId: binding.id, profileRevision: binding.profileRevision,
    bindingRevision: args.bindingRevision, attemptOrdinal, matchKeyVersion, observedAt };
  const unavailable = async (): Promise<RefreshOutcome> => {
    if (signal?.aborted) return "cancelled";
    await sink.recordFailure(stamp);
    return "unavailable";
  };
  const token = (document: string | null) => document === null ? null :
    catalogDocumentNumberToken(matchKey, environment, document);
  const transport = typeof args.transport === "function" ? await args.transport() : args.transport;
  if (signal?.aborted) return "cancelled";

  if (erpScope) {
    const result = await readCatalogExternalSource(transport, "erp_v1", { signal });
    if (result.status !== "complete") return unavailable();
    const rows = result.records.map((row): CatalogRefreshRow => {
      const matchToken = token(row.documentNumber);
      return { sourceRecordId: row.sourceRecordId, issuerScope: matchToken ? erpScope : null, matchToken,
        name: row.officialName, activeCode: row.activeCode };
    });
    if (signal?.aborted) return "cancelled";
    return sink.publish({ ...stamp, role: binding.role, rows, completeScopes: [] });
  }
  const result = await readCatalogExternalSource(transport, "sag_admin_v1", { signal });
  if (result.status !== "complete") return unavailable();
  const asOfDate = bogotaDay.format(observedAt);
  const rows = result.records.map((row): CatalogRefreshRow => {
    const matchToken = token(row.documentNumber);
    const scope = matchToken && row.reportedCountryId !== null
      ? scopesByCountry.get(row.reportedCountryId) ?? null : null;
    return { sourceRecordId: row.sourceRecordId, issuerScope: scope, matchToken, name: null, activeCode: null,
      sagEvidence: normalizeCatalogSagInventoryEvidence(row, asOfDate) };
  });
  if (signal?.aborted) return "cancelled";
  // Unmapped SAG rows cannot support a negative membership claim for any issuer.
  return sink.publish({ ...stamp, role: binding.role, rows, includesSagInventory: true,
    completeScopes: rows.some(row => !row.issuerScope) ? [] : completeScopes });
}
