import type { CurrentUser } from "../types/models";
import { loadCatalogSourceTransport } from "./catalogCustomerRefreshService";
import { readCatalogSagDiscoveryV2, verifyCatalogExternalSource } from "./catalogExternalSourceQueries";
import { readSqlCatalogSourceBindings } from "./catalogSourceBindingsSqlRepository";
import { activateSqlCatalogSource } from "./catalogSourceActivationSqlRepository";
import type { CatalogEnvironment, CatalogSourceVerification } from "./catalogSourceConfiguration";
import { catalogSagV2ConfigurationPin, prepareCatalogSagV2Publication } from "./catalogSagV2PublicationRuntime";
import { readCatalogRefreshConfiguration } from "./catalogSourcePublication";

const dependencies = {
  readBindings: readSqlCatalogSourceBindings,
  loadTransport: loadCatalogSourceTransport,
  verify: verifyCatalogExternalSource,
  discover: readCatalogSagDiscoveryV2,
  async publisherReady(values: NodeJS.ProcessEnv) { return !!await prepareCatalogSagV2Publication(values); },
  activate: activateSqlCatalogSource,
};

export async function certifySavedCatalogSource(input: {
  environment: CatalogEnvironment;
  sourceId: string;
  action: "verify" | "activate";
  actor: CurrentUser;
  signal?: AbortSignal;
  authorizeActivation?: () => Promise<boolean>;
}, io: typeof dependencies = dependencies, values: NodeJS.ProcessEnv = process.env): Promise<
  "missing" | "ineligible" | "not_read_only" | "unavailable" | "verified" | "activated" | "superseded" | "conflict" | "forbidden"
> {
  const { environment, sourceId, actor, action, signal } = input;
  if (signal?.aborted) return "unavailable";
  const source = (await io.readBindings(environment)).find(row =>
    row.id.toLowerCase() === sourceId.toLowerCase() && row.environment === environment);
  if (!source) return "missing";
  if (!(source.state === "draft" || (source.state === "active" && (action === "verify" || !source.canReadCurrentProfile)))
    || !/^[a-f0-9]{16}$/i.test(source.bindingVersion)
    || !/^[a-f0-9]{16}$/i.test(source.profileRevision)) return "ineligible";
  const contract = source.contractVersion;
  const isV2 = source.role === "sag-admin" && contract === "sag_admin_v2";
  if (!isV2 && !(source.role === "erp-customers" && contract === "erp_v1") &&
      !(source.role === "sag-admin" && contract === "sag_admin_v1")) return "ineligible";
  const pin = isV2 ? catalogSagV2ConfigurationPin(values) : null;
  if (isV2 && (!pin || readCatalogRefreshConfiguration(values)?.environment !== environment)) return "ineligible";
  if (signal?.aborted) return "unavailable";
  const transport = await io.loadTransport(source, undefined, signal);
  if (signal?.aborted) return "unavailable";
  let result: "verified" | "not_read_only" | "unavailable";
  if (isV2) {
    const discovery = await io.discover(transport, { signal });
    result = discovery.status === "complete" ? "verified" :
      discovery.reason === "write_access" ? "not_read_only" : "unavailable";
  } else {
    if (contract !== "erp_v1" && contract !== "sag_admin_v1") return "ineligible";
    result = await io.verify(transport, contract, signal);
  }
  if (signal?.aborted) return "unavailable";
  if (result !== "verified") return result;
  const currentPolicy = () => !isV2 || catalogSagV2ConfigurationPin(values) === pin;
  if (!currentPolicy()) return "superseded";
  const evidence: CatalogSourceVerification = {
    bindingId: source.id, bindingVersion: source.bindingVersion,
    profileId: source.profileId, profileRevision: source.profileRevision, contractVersion: source.contractVersion,
    role: source.role, environment, tlsValidated: true, canSelectApprovedProjection: true,
    hasElevatedOrWriteAccess: false, contractValid: true, checkedAtMs: Date.now(),
  };
  if (action === "activate") {
    if (isV2 && !await io.publisherReady(values)) return "unavailable";
    if (input.authorizeActivation ? !await input.authorizeActivation() : isV2) return "forbidden";
    if (signal?.aborted) return "unavailable";
    if (!currentPolicy()) return "superseded";
    return io.activate(source, evidence, actor);
  }
  const current = (await io.readBindings(environment)).find(row => row.id === source.id && row.environment === environment);
  if (signal?.aborted) return "unavailable";
  return currentPolicy() && current?.state === source.state && current.bindingVersion === source.bindingVersion
    && current.profileRevision === source.profileRevision ? "verified" : "superseded";
}
