import { app } from "@azure/functions";
import { requireUser, loadUserProfile } from "../lib/auth";
import { createCatalogDirectoryHttp } from "../lib/catalogDirectoryHttp";
import { readAuthorizedCatalogSourceIds } from "../lib/catalogSourceAccessSqlRepository";
import { readSqlCatalogCustomerSnapshots } from "../lib/catalogCustomerSnapshotsSqlRepository";
import { createCatalogCustomerInventoryHttp } from "../lib/catalogCustomerInventoryHttp";
import { readSqlCatalogSagCustomerEvidence } from "../lib/catalogSagCustomerEvidenceSqlRepository";
import { canViewClients, canViewDomains, canViewLicensingOption } from "../lib/managementAccess";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import type { CatalogEnvironment } from "../lib/catalogSourceConfiguration";

function environment(): CatalogEnvironment {
  const configured = process.env.PORTAL_SAG_ENVIRONMENT?.trim();
  if (configured === "qa" || configured === "production") return configured;
  throw new Error("Catalog environment not provided.");
}

function matchKeyVersion(): number {
  const raw = process.env.PORTAL_CATALOG_MATCH_KEY_VERSION ?? "";
  const value = Number(raw);
  if (!/^[1-9][0-9]{0,4}$/.test(raw) || !Number.isSafeInteger(value) || value > 32767) {
    throw new Error("Catalog match key version not provided.");
  }
  return value;
}

const directory = createCatalogDirectoryHttp({
  enabled: () => process.env.PORTAL_CATALOG_READ_ENABLED?.trim() === "true",
  authorize: async request => {
    try {
      const actor = await loadUserProfile(await requireUser(request));
      if (!actor || !canViewClients(actor, await loadRoleDefinitions())) return { status: 403 };
      return { actorId: actor.id };
    } catch (error) {
      const status = (error as { status?: unknown } | null)?.status;
      if (status === 401 || status === 403) return { status };
      throw error;
    }
  },
  readAllowedSourceIds: actorId => readAuthorizedCatalogSourceIds({ actorId, environment: environment() }),
  readPublishedDirectory: allowedSourceIds => readSqlCatalogCustomerSnapshots({
    allowedSourceIds,
    environment: environment(),
    matchKeyVersion: matchKeyVersion(),
  }),
});

app.http("catalogCustomersList", {
  route: "catalog/customers",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: request => directory(request, "list"),
});

app.http("catalogCustomerDetail", {
  route: "catalog/customers/{id}",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: request => directory(request, "detail"),
});

const inventory = createCatalogCustomerInventoryHttp({
  enabled: () => process.env.PORTAL_CATALOG_READ_ENABLED?.trim() === "true",
  authorize: async (request, view) => {
    try {
      const actor = await loadUserProfile(await requireUser(request));
      if (!actor) return { status: 403 };
      const roles = (await loadRoleDefinitions()).filter(role => role.active !== false);
      if (!canViewClients(actor, roles) || (view === "domains" ? !canViewDomains(actor, roles)
        : !canViewLicensingOption(actor, roles))) return { status: 403 };
      return { actorId: actor.id };
    } catch (error) {
      const status = (error as { status?: unknown } | null)?.status;
      if (status === 401 || status === 403) return { status };
      throw error;
    }
  },
  readAllowedSourceIds: actorId => readAuthorizedCatalogSourceIds({ actorId, environment: environment() }),
  readEvidence: (customerId, allowedSourceIds) => readSqlCatalogSagCustomerEvidence({
    customerId, allowedSourceIds, environment: environment(), matchKeyVersion: matchKeyVersion(),
  }),
});

for (const view of ["domains", "licenses"] as const) {
  app.http(`catalogCustomerInventory_${view}`, {
    route: `catalog/customers/{id}/${view}`, methods: ["GET"], authLevel: "anonymous",
    handler: request => inventory(request, view),
  });
}
