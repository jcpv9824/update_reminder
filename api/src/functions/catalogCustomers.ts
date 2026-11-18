import { app } from "@azure/functions";
import { requireUser, loadUserProfile } from "../lib/auth";
import { createCatalogDirectoryHttp } from "../lib/catalogDirectoryHttp";
import { readAuthorizedCatalogSourceIds } from "../lib/catalogSourceAccessSqlRepository";
import { readSqlCatalogCustomerSnapshots } from "../lib/catalogCustomerSnapshotsSqlRepository";
import { canViewClients } from "../lib/managementAccess";
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
  if (!/^[1-9][0-9]{0,8}$/.test(raw) || !Number.isSafeInteger(value)) {
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
