import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { catalogLicenseDisplayNames } from "./catalogLicenseDisplayNames";

export type CatalogScheduleChoiceKind = "customer" | "domain" | "database" | "license";
export type CatalogScheduleChoiceEnvironment = "production" | "test" | "demo";
export type CatalogScheduleChoice = Readonly<{
  id: string;
  customerId: string;
  customerName: string;
  domain?: string;
  database?: string;
  environment?: CatalogScheduleChoiceEnvironment;
  eligibility: "observed_only";
}>;
type ChoiceFilters = Readonly<{
  kind: CatalogScheduleChoiceKind;
  page: number;
  pageSize: number;
  search?: string;
  customerId?: string;
  domain?: string;
  database?: string;
  environment?: CatalogScheduleChoiceEnvironment;
  moduleCode?: string;
}>;
export type CatalogScheduleChoicesQuery = ChoiceFilters & Readonly<{
  actorId: string;
  allowedSourceIds: ReadonlySet<string>;
}>;
export type CatalogScheduleLicenseOption = Readonly<{ code: keyof typeof catalogLicenseDisplayNames; name: string }>;
export type CatalogScheduleChoicesResult = Readonly<{
  state: "verified" | "partial" | "unavailable";
  total: number;
  items: readonly CatalogScheduleChoice[];
  /** Observed catalog choices only; never operational module approval IDs. */
  licenseOptions?: readonly CatalogScheduleLicenseOption[];
}>;

const kinds = new Set<CatalogScheduleChoiceKind>(["customer", "domain", "database", "license"]);
const environments = new Set<CatalogScheduleChoiceEnvironment>(["production", "test", "demo"]);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export function isCatalogScheduleChoiceUuid(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && uuid.test(value);
}
export function isCatalogScheduleChoiceText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength &&
    value === value.trim() && !/\p{C}/u.test(value);
}
export function isCatalogScheduleChoiceDomain(value: unknown): value is string {
  if (!isCatalogScheduleChoiceText(value, 253) || /[^a-z0-9.-]/.test(value)) return false;
  const labels = value.split(".");
  return labels.length > 1 && /[a-z]/.test(labels[labels.length - 1]) &&
    labels.every(label => label.length > 0 && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-"));
}
export function isCatalogScheduleChoiceDatabase(value: unknown): value is string {
  return isCatalogScheduleChoiceText(value, 128) && /^[A-Za-z0-9_. -]+$/.test(value) && /[A-Za-z0-9]/.test(value);
}
export function isCatalogScheduleChoiceEnvironment(value: unknown): value is CatalogScheduleChoiceEnvironment {
  return typeof value === "string" && environments.has(value as CatalogScheduleChoiceEnvironment);
}
export function isCatalogScheduleChoiceModule(value: unknown): value is keyof typeof catalogLicenseDisplayNames {
  return typeof value === "string" && Object.hasOwn(catalogLicenseDisplayNames, value);
}
export function parseCatalogScheduleLicenseOption(value: unknown): CatalogScheduleLicenseOption | null {
  if (!value || typeof value !== "object" || !("code" in value) || !("name" in value)) return null;
  const { code, name } = value;
  if (!isCatalogScheduleChoiceModule(code)) return null;
  const approvedName = catalogLicenseDisplayNames[code];
  return name === approvedName ? { code, name: approvedName } : null;
}

export function validCatalogScheduleChoiceFilters(input: ChoiceFilters): boolean {
  const { kind, page, pageSize, search, customerId, domain, database, environment, moduleCode } = input;
  const scopedTarget = (kind === "domain" || kind === "database") && Boolean(customerId && environment);
  return kinds.has(kind) && Number.isInteger(page) && page >= 1 && page <= 2000 &&
    Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 100 &&
    (search === undefined || isCatalogScheduleChoiceText(search, 120)) &&
    (customerId === undefined || (kind !== "license" && isCatalogScheduleChoiceUuid(customerId))) &&
    (environment === undefined || ((kind === "domain" || kind === "database") && isCatalogScheduleChoiceEnvironment(environment))) &&
    (domain === undefined || (scopedTarget && isCatalogScheduleChoiceDomain(domain))) &&
    (database === undefined || (kind === "database" && scopedTarget && domain !== undefined && isCatalogScheduleChoiceDatabase(database))) &&
    (moduleCode === undefined || (kind !== "license" && isCatalogScheduleChoiceModule(moduleCode)));
}

class InvalidCatalogScheduleChoices extends Error {}
const invalid = (): never => { throw new InvalidCatalogScheduleChoices(); };
function parseKind(value: unknown): CatalogScheduleChoiceKind {
  if (!kinds.has(value as CatalogScheduleChoiceKind)) return invalid();
  return value as CatalogScheduleChoiceKind;
}
export function parseCatalogScheduleChoiceFilters(params: URLSearchParams): ChoiceFilters {
  const keys = new Set(["kind", "page", "pageSize", "search", "customerId", "domain", "database", "environment", "moduleCode"]);
  if ([...params.keys()].some(key => !keys.has(key) || params.getAll(key).length !== 1)) return invalid();
  const read = (key: string) => params.get(key) ?? undefined;
  const number = (key: string, fallback: number) => {
    const val = read(key);
    if (val === undefined) return fallback;
    if (!/^[1-9][0-9]{0,3}$/.test(val)) return invalid();
    return Number(val);
  };
  const environment = read("environment"), search = read("search")?.trim();
  if (environment !== undefined && !isCatalogScheduleChoiceEnvironment(environment)) return invalid();
  const filters = {
    kind: parseKind(read("kind")), page: number("page", 1), pageSize: number("pageSize", 25),
    ...(search ? { search } : {}),
    ...(read("customerId") !== undefined ? { customerId: read("customerId") } : {}),
    ...(read("domain") !== undefined ? { domain: read("domain") } : {}),
    ...(read("database") !== undefined ? { database: read("database") } : {}),
    ...(environment !== undefined ? { environment } : {}),
    ...(read("moduleCode") !== undefined ? { moduleCode: read("moduleCode") } : {}),
  };
  if (!validCatalogScheduleChoiceFilters(filters)) return invalid();
  return filters;
}

export function createCatalogScheduleChoicesHttp(deps: {
  authorize(request: HttpRequest, kind: CatalogScheduleChoiceKind, requiresLicensing: boolean):
    Promise<{ actorId: string } | { status: 401 | 403 }>;
  readSources(actorId: string): Promise<ReadonlySet<string>>;
  read(query: CatalogScheduleChoicesQuery): Promise<CatalogScheduleChoicesResult>;
}) {
  const respond = (status: number, jsonBody: unknown): HttpResponseInit => ({
    status, jsonBody, headers: { "Cache-Control": "no-store" },
  });
  return async (request: HttpRequest): Promise<HttpResponseInit> => {
    try {
      const kind = parseKind(request.query.get("kind"));
      const auth = await deps.authorize(request, kind, kind === "license" || request.query.has("moduleCode"));
      if ("status" in auth) return respond(auth.status, { error: auth.status === 401 ? "No autenticado." : "No tiene permisos." });
      const query = parseCatalogScheduleChoiceFilters(request.query);
      const result = await deps.read({ ...query, actorId: auth.actorId, allowedSourceIds: await deps.readSources(auth.actorId) });
      if (query.kind === "license") {
        const options = result.licenseOptions?.map(parseCatalogScheduleLicenseOption);
        if (!options || result.items.length || options.some(option => option === null)) {
          return respond(503, { error: "No se pudo consultar el catálogo de programación." });
        }
        return respond(200, { state: result.state, total: result.total, items: [], licenseOptions: options,
          page: query.page, pageSize: query.pageSize });
      }
      const items = result.items.map(item => ({
        id: item.id, customerId: item.customerId, customerName: item.customerName,
        ...(item.domain !== undefined ? { domain: item.domain } : {}),
        ...(item.database !== undefined ? { database: item.database } : {}),
        ...(item.environment !== undefined ? { environment: item.environment } : {}),
        eligibility: "observed_only" as const,
      }));
      return respond(200, { state: result.state, total: result.total, items, page: query.page, pageSize: query.pageSize });
    } catch (error) {
      if (error instanceof InvalidCatalogScheduleChoices) return respond(400, { error: "Consulta de programación inválida." });
      return respond(503, { error: "No se pudo consultar el catálogo de programación." });
    }
  };
}
