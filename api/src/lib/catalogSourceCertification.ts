import type { CurrentUser } from "../types/models";
import { loadCatalogSourceTransport } from "./catalogCustomerRefreshService";
import { verifyCatalogExternalSource, type CatalogExternalContract } from "./catalogExternalSourceQueries";
import { readSqlCatalogSourceBindings } from "./catalogSourceBindingsSqlRepository";
import { activateSqlCatalogSource } from "./catalogSourceActivationSqlRepository";
import type { CatalogEnvironment, CatalogSourceVerification } from "./catalogSourceConfiguration";

const dependencies = {
  readBindings: readSqlCatalogSourceBindings,
  loadTransport: loadCatalogSourceTransport,
  verify: verifyCatalogExternalSource,
  activate: activateSqlCatalogSource,
};

export async function certifySavedCatalogSource(input: {
  environment: CatalogEnvironment;
  sourceId: string;
  action: "verify" | "activate";
  actor: CurrentUser;
  signal?: AbortSignal;
}, io: typeof dependencies = dependencies): Promise<
  "missing" | "ineligible" | "not_read_only" | "unavailable" | "verified" | "activated" | "superseded" | "conflict"
> {
  const { environment, sourceId, actor, action, signal } = input;
  if (signal?.aborted) return "unavailable";
  const source = (await io.readBindings(environment)).find(row =>
    row.id.toLowerCase() === sourceId.toLowerCase() && row.environment === environment);
  if (!source) return "missing";
  if (!(source.state === "draft" || (source.state === "active" && (action === "verify" || !source.canReadCurrentProfile)))
    || !/^[a-f0-9]{16}$/i.test(source.bindingVersion)
    || !/^[a-f0-9]{16}$/i.test(source.profileRevision)) return "ineligible";
  const contract: CatalogExternalContract = source.role === "erp-customers" ? "erp_v1" : "sag_admin_v1";
  if (source.contractVersion !== contract) return "ineligible";
  const result = await io.verify(await io.loadTransport(source, undefined, signal), contract, signal);
  if (signal?.aborted) return "unavailable";
  if (result !== "verified") return result;
  const evidence: CatalogSourceVerification = {
    bindingId: source.id, bindingVersion: source.bindingVersion,
    profileId: source.profileId, profileRevision: source.profileRevision, contractVersion: source.contractVersion,
    role: source.role, environment, tlsValidated: true, canSelectApprovedProjection: true,
    hasElevatedOrWriteAccess: false, contractValid: true, checkedAtMs: Date.now(),
  };
  if (action === "activate") return io.activate(source, evidence, actor);
  const current = (await io.readBindings(environment)).find(row => row.id === source.id && row.environment === environment);
  return current?.state === source.state && current.bindingVersion === source.bindingVersion
    && current.profileRevision === source.profileRevision ? "verified" : "superseded";
}
