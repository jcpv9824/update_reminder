import type { HttpRequest, HttpResponseInit } from "@azure/functions";

export type CatalogMasterView = "domains" | "databases" | "licenses";
export type CatalogMasterInventoryRow = Readonly<{
  id: string; customerName: string; name: string;
  environment: "production" | "test" | "demo" | "unknown"; detail?: string;
}>;
export type CatalogMasterInventoryQuery = Readonly<{ view: CatalogMasterView; page: number; pageSize: number; actorId: string;
  allowedSourceIds: ReadonlySet<string> }>;
export type CatalogMasterInventoryResult = Readonly<{
  items: readonly CatalogMasterInventoryRow[]; state: "verified" | "partial" | "unavailable"; total: number;
}>;
const json = (status: number, jsonBody: unknown): HttpResponseInit => ({ status, jsonBody, headers: { "Cache-Control": "no-store" } });
const integer = (value: string | null, fallback: number, max: number) => value === null ? fallback
  : /^[1-9]\d{0,6}$/.test(value) && Number(value) <= max ? Number(value) : 0;

export function createCatalogMasterInventoryHttp(deps: {
  enabled: () => boolean;
  authorize: (request: HttpRequest, view: CatalogMasterView) => Promise<{ actorId: string } | { status: 401 | 403 }>;
  readSources: (actorId: string) => Promise<ReadonlySet<string>>;
  read: (query: CatalogMasterInventoryQuery) => Promise<CatalogMasterInventoryResult>;
}) {
  return async (request: HttpRequest, view: CatalogMasterView): Promise<HttpResponseInit> => {
    if (!deps.enabled()) return json(404, { error: "No encontrado." });
    try {
      const auth = await deps.authorize(request, view);
      if ("status" in auth) return json(auth.status, { error: auth.status === 401 ? "No autenticado." : "No tiene permisos." });
      const keys = [...request.query.keys()];
      const page = integer(request.query.get("page"), 1, 10000);
      const pageSize = integer(request.query.get("pageSize"), 25, 100);
      if (!page || !pageSize || new Set(keys).size !== keys.length || keys.some(key => key !== "page" && key !== "pageSize")) {
        return json(400, { error: "Consulta de inventario inválida." });
      }
      const allowedSourceIds = await deps.readSources(auth.actorId);
      const result = allowedSourceIds.size ? await deps.read({ view, page, pageSize, actorId: auth.actorId, allowedSourceIds })
        : { state: "unavailable", total: 0, items: [] } as const;
      const items = result.items.map(({ id, customerName, name, environment, detail }) =>
        ({ id, customerName, name, environment, ...(detail ? { detail } : {}) }));
      return json(200, { items, state: result.state, total: result.total, page, pageSize });
    } catch {
      return json(503, { error: "No se pudo consultar el inventario del catálogo." });
    }
  };
}
