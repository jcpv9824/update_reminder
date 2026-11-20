/** Domain-only inputs. Repositories supply published revisions and trusted authorization. */
export type CatalogRevisionState = "verified" | "stale" | "unavailable";
export type CatalogCustomerState = "active" | "inactive" | "unverified";
export type CatalogWebPresence = "in_web" | "not_in_web" | "unverified";

export interface CatalogDocumentScope {
  /** Issuing jurisdiction, never the source's country inferred from its host. */
  issuer: string;
  type: string;
}

export interface CatalogDocument extends CatalogDocumentScope {
  number: string;
}

export interface CatalogErpCustomer {
  sourceCustomerId: string;
  /** Stable opaque local ID, not a raw document or a computed public hash. */
  customerId: string;
  /** Null unless issuer, type and number are verified for this record. */
  document: CatalogDocument | null;
  officialName: string | null;
  activeCode: string | null;
  /** Populated only by the authenticated read-side document projection. */
  displayDocument?: string | null;
}

export interface CatalogErpRevision {
  sourceId: string;
  label: string;
  priority: number;
  state: CatalogRevisionState;
  verifiedAt: string | null;
  /** Published rows or last-known rows for a stale source. */
  customers: readonly CatalogErpCustomer[];
}

export interface CatalogSagRevision {
  state: CatalogRevisionState;
  verifiedAt: string | null;
  documents: readonly CatalogDocument[];
  /** Only a complete, authoritative revision for a scope can certify absence there. */
  completeScopes: readonly CatalogDocumentScope[];
  /** A number with unresolved issuer/type cannot safely be declared absent. */
  unresolvedNumbers?: readonly string[];
}

export interface CatalogDirectoryInput {
  erp: readonly CatalogErpRevision[];
  sag: CatalogSagRevision;
  allowedSourceIds: ReadonlySet<string>;
  preferredSourceByCustomer?: ReadonlyMap<string, string>;
  /** SQL-authorized, fresh V2 orphans only. Never inferred by comparing visible ERP rows. */
  sagOnlyCustomers?: readonly Readonly<{ customerId: string; name: string; displayDocument?: string | null }>[];
  sagOnlyDocumentReferences?: ReadonlyMap<string, Readonly<{ sourceId: string; recordId: number; token: string }>>;
  showDocuments?: boolean;
  partial?: boolean;
}

export interface CatalogDirectoryQuery {
  sourceIds?: readonly string[];
  state?: CatalogCustomerState | "active_or_unverified" | "all";
  web?: CatalogWebPresence | "all";
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface CatalogSourceSummary {
  sourceId: string;
  label: string;
  revisionState: CatalogRevisionState;
  verifiedAt: string | null;
}

export interface CatalogCustomerSource extends CatalogSourceSummary {
  state: CatalogCustomerState;
}

export interface CatalogCustomerSummary {
  id: string;
  /** Business identifier, never the opaque route ID or comparison token. */
  displayDocument?: string | null;
  name: string;
  state: CatalogCustomerState;
  web: CatalogWebPresence;
  sources: CatalogCustomerSource[];
  stateVaries: boolean;
  requiresReconciliation: boolean;
  sagOnly?: boolean;
}

export interface CatalogDirectoryPage {
  items: CatalogCustomerSummary[];
  sources: CatalogSourceSummary[];
  sag: Pick<CatalogSagRevision, "state" | "verifiedAt">;
  partial: boolean;
  total: number;
  page: number;
  pageSize: number;
}

export class CatalogDirectoryError extends Error {
  constructor(readonly code: "invalid_filter" | "inconsistent_revision") {
    super(code === "invalid_filter" ? "Filtro de catálogo inválido." : "Revisión de catálogo inconsistente.");
    this.name = "CatalogDirectoryError";
  }
}

const collator = new Intl.Collator("es", { sensitivity: "base" });
const compareOrdinal = (a: string, b: string): number => a === b ? 0 : a < b ? -1 : 1;
const compareLabel = (a: string, b: string): number => collator.compare(a, b) || compareOrdinal(a, b);
const normalizedSearch = (value: string): string => value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("es").trim();

function scopeKey(scope: CatalogDocumentScope): string | null {
  const issuer = scope.issuer.trim().toUpperCase();
  const type = scope.type.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(issuer) || !/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(type)) return null;
  return JSON.stringify([issuer, type]);
}

/** Internal comparison only. Never put this key in an HTTP response, log or public ID. */
export function catalogDocumentKey(document: CatalogDocument): string | null {
  const scope = scopeKey(document);
  const number = document.number.trim();
  if (!scope || !number || number.length > 128 || /\p{C}/u.test(number)) return null;
  // No universal normalization of leading zeros, digits, punctuation or letter case.
  return JSON.stringify([scope, number]);
}

function publicSource(source: CatalogErpRevision): CatalogSourceSummary {
  return { sourceId: source.sourceId, label: source.label, revisionState: source.state, verifiedAt: source.verifiedAt };
}

function positiveInt(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new CatalogDirectoryError("invalid_filter");
  return value;
}

interface Membership {
  source: CatalogErpRevision;
  customer: CatalogErpCustomer;
  documentKey: string | null;
  state: CatalogCustomerState;
}

function memberState(source: CatalogErpRevision, code: string | null): CatalogCustomerState {
  if (source.state !== "verified") return "unverified";
  switch (code?.trim().toUpperCase()) {
    case "S": return "active";
    case "N": return "inactive";
    default: return "unverified";
  }
}

function buildCatalogCustomerDirectoryPage(input: CatalogDirectoryInput, query: CatalogDirectoryQuery, targetId?: string): CatalogDirectoryPage {
  const permitted = input.erp.filter(source => input.allowedSourceIds.has(source.sourceId));
  const bySourceId = new Map<string, CatalogErpRevision>();
  for (const source of permitted) {
    if (bySourceId.has(source.sourceId) || !source.sourceId || !Number.isFinite(source.priority)) {
      throw new CatalogDirectoryError("inconsistent_revision");
    }
    bySourceId.set(source.sourceId, source);
  }

  const page = positiveInt(query.page, 1, 1_000_000);
  const pageSize = positiveInt(query.pageSize, 50, 100);
  const state = query.state ?? "active";
  const web = query.web ?? "in_web";
  if (!["active", "inactive", "unverified", "active_or_unverified", "all"].includes(state) ||
      !["in_web", "not_in_web", "unverified", "all"].includes(web)) {
    throw new CatalogDirectoryError("invalid_filter");
  }

  const selected = query.sourceIds ? [...new Set(query.sourceIds)].map(id => {
    const source = bySourceId.get(id);
    if (!source) throw new CatalogDirectoryError("invalid_filter");
    return source;
  }) : permitted;
  const search = normalizedSearch(query.search ?? "");
  if (search.length > 200) throw new CatalogDirectoryError("invalid_filter");
  const incompleteErp = selected.some(source => source.state !== "verified");
  const matchesState = (value: CatalogCustomerState) => state === "all" || state === value ||
    (state === "active_or_unverified" && value !== "inactive");
  const matchesSearch = (name: string, id: string, displayDocument: string | null) => !search ||
    normalizedSearch(name).includes(search) || (!input.showDocuments && normalizedSearch(id).includes(search)) ||
    (displayDocument !== null && normalizedSearch(displayDocument).replace(/\s/gu, "").includes(search.replace(/\s/gu, "")));

  const byCustomerId = new Map<string, Membership[]>();
  const idsByDocument = new Map<string, Set<string>>();
  for (const source of selected) {
    const localIds = new Set<string>();
    for (const customer of source.customers) {
      if (!customer.sourceCustomerId || !customer.customerId || localIds.has(customer.sourceCustomerId)) {
        throw new CatalogDirectoryError("inconsistent_revision");
      }
      localIds.add(customer.sourceCustomerId);
      const documentKey = customer.document ? catalogDocumentKey(customer.document) : null;
      const members = byCustomerId.get(customer.customerId) ?? [];
      members.push({ source, customer, documentKey, state: memberState(source, customer.activeCode) });
      byCustomerId.set(customer.customerId, members);
      if (documentKey) {
        const ids = idsByDocument.get(documentKey) ?? new Set<string>();
        ids.add(customer.customerId);
        idsByDocument.set(documentKey, ids);
      }
    }
  }

  const verifiedWebKeys = new Set<string>();
  const completeScopes = new Set<string>();
  const ambiguousWebNumbers = new Set(input.sag.unresolvedNumbers?.map(value => value.trim()));
  if (input.sag.state === "verified") {
    for (const document of input.sag.documents) {
      const key = catalogDocumentKey(document);
      if (key) verifiedWebKeys.add(key);
      else if (document.number.trim()) ambiguousWebNumbers.add(document.number.trim());
    }
    for (const scope of input.sag.completeScopes) {
      const key = scopeKey(scope);
      if (key) completeScopes.add(key);
    }
  }

  const items: CatalogCustomerSummary[] = [];
  for (const [id, memberships] of byCustomerId) {
    if (targetId !== undefined && id !== targetId) continue;
    const primary = memberships[0];
    const documentKey = primary.documentKey;
    if (memberships.some(member => member.customer.document?.number.trim() === id)) {
      // Catch accidental reuse of the source document as a public ID.
      throw new CatalogDirectoryError("inconsistent_revision");
    }
    if (memberships.length > 1 && (!documentKey || memberships.some(member => member.documentKey !== documentKey))) {
      // The repository must reconcile or split this opaque ID; silently merging it leaks identity/state.
      throw new CatalogDirectoryError("inconsistent_revision");
    }

    const preferred = input.preferredSourceByCustomer?.get(id);
    const officialNames = memberships.filter(member => member.customer.officialName?.trim());
    officialNames.sort((a, b) => Number(b.source.sourceId === preferred) - Number(a.source.sourceId === preferred) ||
      a.source.priority - b.source.priority || compareOrdinal(a.source.sourceId, b.source.sourceId) ||
      compareOrdinal(a.customer.sourceCustomerId, b.customer.sourceCustomerId));
    const name = officialNames[0]?.customer.officialName?.trim();
    const documents = new Set(memberships.flatMap(member => member.customer.displayDocument ? [member.customer.displayDocument] : []));
    const displayDocument = input.showDocuments && documents.size === 1 ? [...documents][0] : null;
    if (!name || !matchesSearch(name, id, displayDocument)) continue;

    const memberStates = new Set(memberships.map(member => member.state));
    const customerState: CatalogCustomerState = memberStates.has("active") ? "active" :
      !incompleteErp && memberStates.size === 1 && memberStates.has("inactive") ? "inactive" : "unverified";
    const ambiguousIdentity = !documentKey || (idsByDocument.get(documentKey)?.size ?? 0) !== 1 ||
      new Set(memberships.map(member => member.source.sourceId)).size !== memberships.length;
    let presence: CatalogWebPresence = "unverified";
    if (input.sag.state === "verified" && !ambiguousIdentity && documentKey && primary.customer.document) {
      const doc = primary.customer.document;
      if (verifiedWebKeys.has(documentKey)) presence = "in_web";
      else if (!ambiguousWebNumbers.has(doc.number.trim()) && completeScopes.has(scopeKey(doc) ?? "")) presence = "not_in_web";
    }
    if (!matchesState(customerState) || (web !== "all" && presence !== web)) continue;

    const sources = new Map<string, CatalogCustomerSource>();
    for (const member of memberships) {
      const previous = sources.get(member.source.sourceId);
      sources.set(member.source.sourceId, { ...publicSource(member.source),
        state: previous && previous.state !== member.state ? "unverified" : member.state });
    }
    items.push({ id, name, state: customerState, web: presence, ...(input.showDocuments && { displayDocument }),
      sources: [...sources.values()].sort((a, b) => compareLabel(a.label, b.label) || compareOrdinal(a.sourceId, b.sourceId)),
      stateVaries: memberStates.has("active") && memberStates.has("inactive"),
      requiresReconciliation: ambiguousIdentity || new Set(officialNames.map(member => member.customer.officialName?.trim())).size > 1 });
  }

  if (input.sag.state === "verified" && query.sourceIds === undefined &&
      matchesState("unverified") && (web === "in_web" || web === "all")) {
    const orphanIds = new Set<string>();
    for (const orphan of input.sagOnlyCustomers ?? []) {
      if (!orphan.customerId || !orphan.name.trim() || byCustomerId.has(orphan.customerId) || orphanIds.has(orphan.customerId)) {
        throw new CatalogDirectoryError("inconsistent_revision");
      }
      orphanIds.add(orphan.customerId);
      if (targetId !== undefined && orphan.customerId !== targetId) continue;
      const displayDocument = input.showDocuments ? orphan.displayDocument ?? null : null;
      if (!matchesSearch(orphan.name, orphan.customerId, displayDocument)) continue;
      items.push({ id: orphan.customerId, name: orphan.name.trim(), state: "unverified", web: "in_web",
        ...(input.showDocuments && { displayDocument }),
        sources: [], stateVaries: false, requiresReconciliation: false, sagOnly: true });
    }
  }
  items.sort((a, b) => compareLabel(a.name, b.name) || compareOrdinal(a.id, b.id));
  return { items: items.slice((page - 1) * pageSize, page * pageSize),
    sources: permitted.map(publicSource).sort((a, b) => compareLabel(a.label, b.label) || compareOrdinal(a.sourceId, b.sourceId)),
    sag: { state: input.sag.state, verifiedAt: input.sag.verifiedAt },
    partial: input.partial === true || incompleteErp || input.sag.state !== "verified", total: items.length, page, pageSize };
}

export function buildCatalogCustomerDirectory(input: CatalogDirectoryInput, query: CatalogDirectoryQuery = {}): CatalogDirectoryPage {
  return buildCatalogCustomerDirectoryPage(input, query);
}

/** Detail is calculated across all authorized ERP sources, regardless of the list's filters. */
export function getCatalogCustomerDetail(input: CatalogDirectoryInput, customerId: string): CatalogCustomerSummary | null {
  if (!customerId.trim() || customerId.length > 256) return null;
  const { items } = buildCatalogCustomerDirectoryPage(input, { state: "all", web: "all", pageSize: 1 }, customerId);
  return items[0] ?? null;
}
