import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { requireUser, loadUserProfile } from "../lib/auth";
import { canViewAuditLogs } from "../lib/permissions";
import { getContainer } from "../lib/cosmos";
import { forbidden, ok, serverError } from "../lib/http";
import type { AuditLog } from "../types/models";

app.http("auditLogsList", {
  route: "audit-logs",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => {
    try {
      const auth = await requireUser(req);
      const user = await loadUserProfile(auth);
      if (!user) return forbidden();
      if (!canViewAuditLogs(user)) return forbidden();

      const conditions: string[] = [];
      const parameters: { name: string; value: any }[] = [];
      const clientId = req.query.get("clientId");
      const domainId = req.query.get("domainId");
      const entityType = req.query.get("entityType");
      const entityId = req.query.get("entityId");
      const action = req.query.get("action");
      const performedBy = req.query.get("performedBy");
      const fromDate = req.query.get("fromDate");
      const toDate = req.query.get("toDate");
      if (clientId) { conditions.push("c.clientId = @c"); parameters.push({ name: "@c", value: clientId }); }
      if (domainId) { conditions.push("c.domainId = @d"); parameters.push({ name: "@d", value: domainId }); }
      if (entityType) { conditions.push("c.entityType = @et"); parameters.push({ name: "@et", value: entityType }); }
      if (entityId) { conditions.push("c.entityId = @ei"); parameters.push({ name: "@ei", value: entityId }); }
      if (action) { conditions.push("c.action = @a"); parameters.push({ name: "@a", value: action }); }
      if (performedBy) { conditions.push("c.performedBy = @p"); parameters.push({ name: "@p", value: performedBy }); }
      if (fromDate) { conditions.push("c.performedAt >= @f"); parameters.push({ name: "@f", value: fromDate }); }
      if (toDate) { conditions.push("c.performedAt <= @t"); parameters.push({ name: "@t", value: toDate }); }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const { resources } = await getContainer("auditLogs")
        .items.query<AuditLog>({ query: `SELECT TOP 500 * FROM c ${where} ORDER BY c.performedAt DESC`, parameters })
        .fetchAll();
      return ok(resources);
    } catch (e) {
      return serverError(e);
    }
  },
});
