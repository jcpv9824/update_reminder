import { app } from "@azure/functions";
import { loadUserProfile, requireUser } from "../lib/auth";
import { createCatalogRefreshHttp } from "../lib/catalogRefreshHttp";
import { enqueueCatalogRefreshRequest, readCatalogRefreshStatus } from "../lib/catalogRefreshQueueSqlRepository";
import { catalogRefreshEnabled, readCatalogRefreshConfiguration } from "../lib/catalogSourcePublication";
import { canViewClients, canViewDatabases, canViewDomains, canViewLicensingOption } from "../lib/managementAccess";
import { enforceRequestRateLimit, RATE_LIMIT_POLICIES } from "../lib/rateLimit";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { catalogFullReadEnabled } from "../lib/catalogReadScope";

const handle = createCatalogRefreshHttp({
  enabled: catalogRefreshEnabled,
  configuration: readCatalogRefreshConfiguration,
  async authorize(request) {
    try {
      const actor = await loadUserProfile(await requireUser(request));
      if (!actor) return { status: 403 };
      const roles = (await loadRoleDefinitions()).filter(role => role.active !== false);
      const allowed = catalogFullReadEnabled()
        ? [canViewClients, canViewDatabases, canViewDomains, canViewLicensingOption].some(check => check(actor, roles))
        : canViewClients(actor, roles);
      if (!allowed) return { status: 403 };
      return { actorId: actor.id };
    } catch (error) {
      const status = (error as { status?: unknown } | null)?.status;
      if (status === 401 || status === 403) return { status };
      throw error;
    }
  },
  rateLimit: (request, actorId, method) => enforceRequestRateLimit(request, `catalog_refresh_${method}`, actorId,
    method === "request" ? RATE_LIMIT_POLICIES.catalogRefreshRequest : RATE_LIMIT_POLICIES.catalogRefreshStatus),
  enqueue: enqueueCatalogRefreshRequest,
  status: readCatalogRefreshStatus,
});

app.http("requestCatalogRefresh", { route: "catalog/refresh", methods: ["POST"], authLevel: "anonymous",
  handler: request => handle(request, "request") });
app.http("readCatalogRefreshStatus", { route: "catalog/refresh/status", methods: ["GET"], authLevel: "anonymous",
  handler: request => handle(request, "status") });
