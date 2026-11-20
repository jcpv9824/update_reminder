import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { CatalogDirectoryError, type CatalogDirectoryQuery } from "./catalogCustomerDirectory";
import { parseCatalogDirectoryQuery } from "./catalogDirectoryHttp";
import { catalogLicenseDisplayNames } from "./catalogLicenseDisplayNames";
import type { CatalogMasterView } from "./catalogMasterInventoryHttp";

export type CatalogObservedInventoryV2Tab = "available" | "customers" | "licenseCustomers";
export type CatalogObservedInventoryV2Query = Readonly<CatalogDirectoryQuery & {
  view: CatalogMasterView;
  actorId: string;
  allowedSourceIds: ReadonlySet<string>;
  page: number;
  pageSize: number;
  environmentFilter?: "production" | "test" | "demo" | "unknown";
  tab?: CatalogObservedInventoryV2Tab;
  code?: string;
}>;

export type CatalogObservedInventoryV2Item = Readonly<{
  id: string;
  customerId?: string;
  customerName?: string;
  name?: string;
  environment?: "production" | "test" | "demo" | "unknown";
  detail?: string;
  code?: string;
  licenses?: readonly string[];
}>;
export type CatalogObservedInventoryV2Result = Readonly<{
  state: "verified" | "partial" | "unavailable";
  total: number;
  items: readonly CatalogObservedInventoryV2Item[];
  sources?: readonly Readonly<{ id: string; label: string }>[];
}>;

type Access = { actorId: string } | { status: 401 | 403 };
const invalid = (): never => { throw new CatalogDirectoryError("invalid_filter"); };
const envs = new Set(["production", "test", "demo", "unknown"]);
const tabs = new Set(["available", "customers", "licenseCustomers"]);
const respond = (status: number, jsonBody: unknown): HttpResponseInit =>
  ({ status, jsonBody, headers: { "Cache-Control": "no-store" } });

function parse(query: URLSearchParams, view: CatalogMasterView) {
  const check = new URLSearchParams(query);
  function take(key: string) {
    const found = check.getAll(key);
    if (found.length > 1) return invalid();
    check.delete(key);
    return found[0];
  }
  if (take("v") !== "2") return invalid();
  const environment = take("environment"), rawTab = take("tab"), code = take("code");
  const tab = view === "licenses" ? rawTab ?? "available" : undefined;
  if (view === "licenses") {
    if (environment !== undefined || !tabs.has(tab!) ||
      (tab === "licenseCustomers" ? !code || !Object.hasOwn(catalogLicenseDisplayNames, code) : code !== undefined)) return invalid();
    if (tab === "available" && [...check.keys()].some(key => !["page", "pageSize"].includes(key))) return invalid();
  } else if (rawTab !== undefined || code !== undefined ||
    (environment !== undefined && !envs.has(environment)) ||
    [...check.keys()].some(key => !["page", "pageSize", "search"].includes(key))) return invalid();
  const filters = parseCatalogDirectoryQuery(check);
  const search = filters.search?.trim();
  return { ...filters, search, page: filters.page ?? 1, pageSize: filters.pageSize ?? 25,
    environmentFilter: environment as CatalogObservedInventoryV2Query["environmentFilter"],
    tab: tab as CatalogObservedInventoryV2Tab | undefined, code };
}

export function createCatalogObservedInventoryV2Http(deps: {
  authorize(request: HttpRequest, view: CatalogMasterView): Promise<Access>;
  readSources(actorId: string): Promise<ReadonlySet<string>>;
  read(args: CatalogObservedInventoryV2Query): Promise<CatalogObservedInventoryV2Result>;
}) {
  return async (request: HttpRequest, view: CatalogMasterView): Promise<HttpResponseInit> => {
    try {
      const auth = await deps.authorize(request, view);
      if ("status" in auth) return respond(auth.status, { error: auth.status === 401 ? "No autenticado." : "No tiene permisos." });
      const filters = parse(request.query, view);
      const allowedSourceIds = await deps.readSources(auth.actorId);
      if (filters.sourceIds?.some(id => !allowedSourceIds.has(id))) return invalid();
      const result = await deps.read({ ...filters, view, actorId: auth.actorId, allowedSourceIds });
      // Explicit projection: match tokens, grant IDs and raw documents are not part of this API.
      const items = result.items.map(row => view !== "licenses"
        ? { id: row.id, customerId: row.customerId, customerName: row.customerName,
          name: row.name, environment: row.environment, ...(row.detail ? { detail: row.detail } : {}) }
        : filters.tab === "available" ? { id: row.id, code: row.code, name: row.name }
        : { id: row.id, customerId: row.customerId, customerName: row.customerName,
          ...(filters.tab === "customers" ? { licenses: row.licenses } : {}) });
      return respond(200, { items, total: result.total, state: result.state, page: filters.page, pageSize: filters.pageSize,
        ...(result.sources ? { sources: result.sources.map(({ id, label }) => ({ id, label })) } : {}) });
    } catch (error) {
      if (error instanceof CatalogDirectoryError && error.code === "invalid_filter") {
        return respond(400, { error: "Consulta de inventario inválida." });
      }
      return respond(503, { error: "No se pudo consultar el inventario del catálogo." });
    }
  };
}
