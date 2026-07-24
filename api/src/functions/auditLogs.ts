import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { requireUser, loadUserProfile } from "../lib/auth";
import { canViewAuditLogs } from "../lib/managementAccess";
import { forbidden, ok, serverError } from "../lib/http";
import { getPagination } from "../lib/pagination";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { readSqlAuditLogs, type AuditLogFilters } from "../lib/auditLogsSqlRepository";

app.http("auditLogsList", {
  route: "audit-logs",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => {
    try {
      const auth = await requireUser(req);
      const user = await loadUserProfile(auth);
      if (!user) return forbidden();
      if (!canViewAuditLogs(user, await loadRoleDefinitions())) return forbidden();

      const filters: AuditLogFilters = {
        clientId: req.query.get("clientId") ?? undefined,
        domainId: req.query.get("domainId") ?? undefined,
        entityType: req.query.get("entityType") ?? undefined,
        entityId: req.query.get("entityId") ?? undefined,
        action: req.query.get("action") ?? undefined,
        performedBy: req.query.get("performedBy") ?? undefined,
        search: req.query.get("search")?.trim().toLowerCase() || undefined,
        fromDate: req.query.get("fromDate") ?? undefined,
        toDate: req.query.get("toDate") ?? undefined,
      };
      const pagination = getPagination(req);
      return ok(await readSqlAuditLogs(filters, pagination));
    } catch (e) {
      return serverError(e);
    }
  },
});
