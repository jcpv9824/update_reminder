import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { requireUser, loadUserProfile } from "../lib/auth";
import { canViewAuditLogs } from "../lib/permissions";
import { getContainer } from "../lib/cosmos";
import { forbidden, ok, serverError } from "../lib/http";
import { getPagination } from "../lib/pagination";
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
      const search = req.query.get("search")?.trim().toLowerCase();
      const fromDate = req.query.get("fromDate");
      const toDate = req.query.get("toDate");
      if (clientId) { conditions.push("c.clientId = @c"); parameters.push({ name: "@c", value: clientId }); }
      if (domainId) { conditions.push("c.domainId = @d"); parameters.push({ name: "@d", value: domainId }); }
      if (entityType) { conditions.push("c.entityType = @et"); parameters.push({ name: "@et", value: entityType }); }
      if (entityId) { conditions.push("c.entityId = @ei"); parameters.push({ name: "@ei", value: entityId }); }
      if (action) { conditions.push("c.action = @a"); parameters.push({ name: "@a", value: action }); }
      if (performedBy) { conditions.push("c.performedBy = @p"); parameters.push({ name: "@p", value: performedBy }); }
      if (search) {
        conditions.push(`(
          CONTAINS(LOWER(c.action), @search)
          OR CONTAINS(LOWER(c.entityType), @search)
          OR CONTAINS(LOWER(c.entityId), @search)
          OR (IS_DEFINED(c.clientName) AND CONTAINS(LOWER(c.clientName), @search))
          OR (IS_DEFINED(c.domainName) AND CONTAINS(LOWER(c.domainName), @search))
          OR (IS_DEFINED(c.performedByEmail) AND CONTAINS(LOWER(c.performedByEmail), @search))
          OR (IS_DEFINED(c.performedBy) AND CONTAINS(LOWER(c.performedBy), @search))
        )`);
        parameters.push({ name: "@search", value: search });
      }
      if (fromDate) { conditions.push("c.performedAt >= @f"); parameters.push({ name: "@f", value: fromDate }); }
      if (toDate) { conditions.push("c.performedAt <= @t"); parameters.push({ name: "@t", value: toDate }); }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const pagination = getPagination(req);
      if (pagination.enabled) {
        const offset = (pagination.page - 1) * pagination.pageSize;
        const [{ resources }, countResult] = await Promise.all([
          getContainer("auditLogs")
            .items.query<AuditLog>({
              query: `SELECT * FROM c ${where} ORDER BY c.performedAt DESC OFFSET @offset LIMIT @limit`,
              parameters: [...parameters, { name: "@offset", value: offset }, { name: "@limit", value: pagination.pageSize }],
            })
            .fetchAll(),
          getContainer("auditLogs")
            .items.query<{ count: number }>({ query: `SELECT VALUE COUNT(1) FROM c ${where}`, parameters })
            .fetchAll(),
        ]);
        return ok({ items: resources, page: pagination.page, pageSize: pagination.pageSize, total: (countResult.resources as any[])[0] ?? 0 });
      }
      const { resources } = await getContainer("auditLogs")
        .items.query<AuditLog>({ query: `SELECT TOP 500 * FROM c ${where} ORDER BY c.performedAt DESC`, parameters })
        .fetchAll();
      return ok(resources);
    } catch (e) {
      return serverError(e);
    }
  },
});
