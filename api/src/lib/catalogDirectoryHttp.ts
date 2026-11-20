import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import {
  CatalogDirectoryError,
  buildCatalogCustomerDirectory,
  getCatalogCustomerDetail,
  type CatalogDirectoryInput,
  type CatalogDirectoryQuery,
} from "./catalogCustomerDirectory";

type Decision = { actorId: string } | { status: 401 | 403 };
export type CatalogDirectoryHttpDependencies = {
  enabled: () => boolean;
  authorize: (request: HttpRequest) => Promise<Decision>;
  readAllowedSourceIds: (actorId: string) => Promise<ReadonlySet<string>>;
  /** Trusted runtime flag only, never a query parameter. SQL rechecks the actor's SAG access. */
  includeSagDirectory?: () => boolean;
  readPublishedDirectory: (allowedSourceIds: ReadonlySet<string>, actorId?: string) => Promise<CatalogDirectoryInput>;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const states = new Set(["active", "inactive", "unverified", "all"]);
const presences = new Set(["in_web", "not_in_web", "unverified", "all"]);
const params = new Set(["sourceId", "state", "web", "search", "page", "pageSize"]);

function single(query: URLSearchParams, key: string): string | undefined {
  const values = query.getAll(key);
  if (values.length > 1) throw new CatalogDirectoryError("invalid_filter");
  return values[0];
}

function numeric(query: URLSearchParams, key: string, max: number): number | undefined {
  const value = single(query, key);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(n) || n > max) {
    throw new CatalogDirectoryError("invalid_filter");
  }
  return n;
}

export function parseCatalogDirectoryQuery(query: URLSearchParams): CatalogDirectoryQuery {
  if ([...query.keys()].some(key => !params.has(key))) throw new CatalogDirectoryError("invalid_filter");
  const requested = query.getAll("sourceId");
  if (requested.length > 50 || requested.some(id => !uuid.test(id))) throw new CatalogDirectoryError("invalid_filter");
  const state = single(query, "state");
  const web = single(query, "web");
  const search = single(query, "search");
  if (state !== undefined && !states.has(state) || web !== undefined && !presences.has(web)
    || search !== undefined && (search.length > 120 || /\p{C}/u.test(search))) {
    throw new CatalogDirectoryError("invalid_filter");
  }
  return {
    sourceIds: requested.length ? [...new Set(requested.map(id => id.toLowerCase()))] : undefined,
    state: state as CatalogDirectoryQuery["state"],
    web: web as CatalogDirectoryQuery["web"],
    search,
    page: numeric(query, "page", 2000),
    pageSize: numeric(query, "pageSize", 100),
  };
}

const response = (status: number, jsonBody: unknown): HttpResponseInit => ({
  status,
  headers: { "Cache-Control": "no-store" },
  jsonBody,
});
const notFound = () => response(404, { error: "No encontrado." });
const denied = () => response(403, { error: "No tiene permisos." });

export function createCatalogDirectoryHttp(deps: CatalogDirectoryHttpDependencies) {
  return async (request: HttpRequest, context: "list" | "detail"): Promise<HttpResponseInit> => {
    if (!deps.enabled()) return notFound();
    try {
      const auth = await deps.authorize(request);
      if ("status" in auth) {
        return auth.status === 401 ? response(401, { error: "No autenticado." }) : denied();
      }
      const inputQuery = context === "list" ? parseCatalogDirectoryQuery(request.query) : undefined;
      const id = request.params.id;
      if (context === "detail" && (!id || !uuid.test(id))) return notFound();
      const allowed = await deps.readAllowedSourceIds(auth.actorId);
      const includeSagDirectory = deps.includeSagDirectory?.() === true;
      if (!allowed.size && !includeSagDirectory) return denied();
      if (inputQuery?.sourceIds?.some(sourceId => !allowed.has(sourceId))) {
        return response(400, { error: "Filtro de catálogo inválido." });
      }
      const loaded = await deps.readPublishedDirectory(allowed, auth.actorId);
      // The authenticated scope overrides repository input even if the reader is miswired.
      const input: CatalogDirectoryInput = { ...loaded, allowedSourceIds: allowed,
        sagOnlyCustomers: includeSagDirectory ? loaded.sagOnlyCustomers : undefined };
      if (context === "list") return response(200, buildCatalogCustomerDirectory(input, inputQuery));
      const item = getCatalogCustomerDetail(input, id!.toLowerCase());
      return item ? response(200, item) : notFound();
    } catch (error) {
      if (error instanceof CatalogDirectoryError && error.code === "invalid_filter") {
        return response(400, { error: "Filtro de catálogo inválido." });
      }
      // No details from drivers or external sources. A fault is not an empty catalog.
      return response(503, { error: "El catálogo de clientes no está disponible." });
    }
  };
}
