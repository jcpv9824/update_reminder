import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { requireUser, loadUserProfile } from "../lib/auth";
import { canViewAuditLogs } from "../lib/managementAccess";
import { getContainer } from "../lib/cosmos";
import { getDataBackend } from "../lib/dataBackend";
import { forbidden, ok, serverError } from "../lib/http";
import { getPagination, type PageResult } from "../lib/pagination";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { readSqlAuditLogs, type AuditLogFilters } from "../lib/auditLogsSqlRepository";
import type { AuditLog } from "../types/models";

async function readCosmosAuditLogs(
  filters: AuditLogFilters,
  pagination: { enabled: boolean; page: number; pageSize: number }
): Promise<AuditLog[] | PageResult<AuditLog>> {
  const conditions: string[] = [];
  const parameters: { name: string; value: any }[] = [];
  if (filters.clientId) { conditions.push("c.clientId = @c"); parameters.push({ name: "@c", value: filters.clientId }); }
  if (filters.domainId) { conditions.push("c.domainId = @d"); parameters.push({ name: "@d", value: filters.domainId }); }
  if (filters.entityType) { conditions.push("c.entityType = @et"); parameters.push({ name: "@et", value: filters.entityType }); }
  if (filters.entityId) { conditions.push("c.entityId = @ei"); parameters.push({ name: "@ei", value: filters.entityId }); }
  if (filters.action) { conditions.push("c.action = @a"); parameters.push({ name: "@a", value: filters.action }); }
  if (filters.performedBy) { conditions.push("c.performedBy = @p"); parameters.push({ name: "@p", value: filters.performedBy }); }
  if (filters.search) {
    conditions.push(`(
      CONTAINS(LOWER(c.action), @search)
      OR CONTAINS(LOWER(c.entityType), @search)
      OR CONTAINS(LOWER(c.entityId), @search)
      OR (IS_DEFINED(c.clientName) AND CONTAINS(LOWER(c.clientName), @search))
      OR (IS_DEFINED(c.domainName) AND CONTAINS(LOWER(c.domainName), @search))
      OR (IS_DEFINED(c.performedByEmail) AND CONTAINS(LOWER(c.performedByEmail), @search))
      OR (IS_DEFINED(c.performedBy) AND CONTAINS(LOWER(c.performedBy), @search))
    )`);
    parameters.push({ name: "@search", value: filters.search });
  }
  if (filters.fromDate) { conditions.push("c.performedAt >= @f"); parameters.push({ name: "@f", value: filters.fromDate }); }
  if (filters.toDate) { conditions.push("c.performedAt <= @t"); parameters.push({ name: "@t", value: filters.toDate }); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
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
        .items.query<number>({ query: `SELECT VALUE COUNT(1) FROM c ${where}`, parameters })
        .fetchAll(),
    ]);
    return { items: resources, page: pagination.page, pageSize: pagination.pageSize, total: countResult.resources[0] ?? 0 };
  }
  const { resources } = await getContainer("auditLogs")
    .items.query<AuditLog>({ query: `SELECT TOP 500 * FROM c ${where} ORDER BY c.performedAt DESC`, parameters })
    .fetchAll();
  return resources;
}

function resultCount(result: AuditLog[] | PageResult<AuditLog>): number {
  return Array.isArray(result) ? result.length : result.total;
}

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
      const backend = getDataBackend();
      if (backend === "sql") return ok(await readSqlAuditLogs(filters, pagination));
      const primary = await readCosmosAuditLogs(filters, pagination);
      if (backend === "dual-read") {
        const shadow = await readSqlAuditLogs(filters, pagination);
        if (resultCount(primary) !== resultCount(shadow)) console.warn("Audit Logs dual-read parity mismatch.");
      }
      return ok(primary);
    } catch (e) {
      return serverError(e);
    }
  },
});
