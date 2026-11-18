import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import type { CatalogSagInventoryEvidence } from "./catalogSagInventoryEvidence";

export type InventoryView = "domains" | "licenses";
export type CatalogCustomerInventoryEvidence = {
  state: "verified" | "stale" | "unavailable";
  verifiedAt: string | null;
  items: readonly CatalogSagInventoryEvidence[];
};
type Decision = { actorId: string } | { status: 401 | 403 };
type Env = CatalogSagInventoryEvidence["environment"];
const environmentOrder: readonly Env[] = ["production", "test", "demo", "unknown"];
const opaqueId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function domainProjection(source: CatalogCustomerInventoryEvidence) {
  const hosts = new Map<string, Map<Env, Set<string>>>();
  let partial = source.state !== "verified";
  for (const item of source.items) {
    if (!item.domainCandidate) { partial = true; continue; }
    const observations = hosts.get(item.domainCandidate) ?? new Map<Env, Set<string>>();
    const dates = observations.get(item.environment) ?? new Set<string>();
    const started = item.environment === "production" ? item.productionStartedOn
      : item.environment === "test" ? item.testStartedOn : item.environment === "demo" ? item.demoStartedOn : null;
    if (started) dates.add(started);
    if (item.environment === "unknown") partial = true;
    observations.set(item.environment, dates);
    hosts.set(item.domainCandidate, observations);
  }
  const items = [...hosts.entries()].sort(([a], [b]) => a.localeCompare(b, "en")).map(([host, entries]) => ({
    host,
    observations: environmentOrder.filter(environment => entries.has(environment)).map(environment => {
      const values = [...entries.get(environment)!];
      if (values.length > 1) partial = true;
      return { environment, startedOn: values.length === 1 ? values[0] : null };
    }),
  }));
  return { partial, items };
}

function licenseProjection(source: CatalogCustomerInventoryEvidence) {
  const codes = new Map<string, Set<Env>>();
  let partial = source.state !== "verified";
  for (const item of source.items) {
    if (item.environment === "unknown" || item.licenseCodes === null) partial = true;
    if (!item.licenseCodes) continue;
    for (const code of item.licenseCodes) {
      const environments = codes.get(code) ?? new Set<Env>();
      environments.add(item.environment);
      codes.set(code, environments);
    }
  }
  const items = [...codes.keys()].sort().map(code => ({
    code, environments: environmentOrder.filter(environment => codes.get(code)!.has(environment)),
  }));
  return { partial, items };
}

const json = (status: number, jsonBody: unknown): HttpResponseInit => ({
  status, jsonBody, headers: { "Cache-Control": "no-store" },
});
const absent = () => json(404, { error: "No encontrado." });

export function createCatalogCustomerInventoryHttp(deps: {
  enabled: () => boolean;
  authorize: (request: HttpRequest, view: InventoryView) => Promise<Decision>;
  readAllowedSourceIds: (actorId: string) => Promise<ReadonlySet<string>>;
  readEvidence: (customerId: string, allowedSourceIds: ReadonlySet<string>) => Promise<CatalogCustomerInventoryEvidence | null>;
}) {
  return async (request: HttpRequest, view: InventoryView): Promise<HttpResponseInit> => {
    if (!deps.enabled()) return absent();
    try {
      const actor = await deps.authorize(request, view);
      if ("status" in actor) return json(actor.status, { error: actor.status === 401 ? "No autenticado." : "No tiene permisos." });
      const id = request.params.id;
      if (!id || !opaqueId.test(id)) return absent();
      if ([...request.query.keys()].length) return json(400, { error: "La consulta no admite parámetros." });
      const allowedSourceIds = await deps.readAllowedSourceIds(actor.actorId);
      if (!allowedSourceIds.size) return absent();
      const source = await deps.readEvidence(id.toLowerCase(), allowedSourceIds);
      if (!source) return absent();
      if (source.state === "unavailable") return json(200, { state: "unavailable", verifiedAt: null, partial: true, items: [] });
      const output = view === "domains" ? domainProjection(source) : licenseProjection(source);
      return json(200, { state: source.state, verifiedAt: source.verifiedAt, ...output });
    } catch {
      return json(503, { error: "No se pudo consultar la evidencia del catálogo." });
    }
  };
}
