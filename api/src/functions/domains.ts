import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { getDataBackend } from "../lib/dataBackend";
import { cancelPendingTasksForDomain } from "../lib/taskCleanup";
import { badRequest, conflict, created, forbidden, notFound, ok, serverError } from "../lib/http";
import {
  canCreateDomain,
  canDeactivateDomain,
  canDeleteDomain,
  canEditDomain,
  canReactivateDomain,
  canViewDomains,
  canViewRelatedDomainDatabases,
} from "../lib/managementAccess";
import { getPagination, paginateArray, type PageResult } from "../lib/pagination";
import { matchesDomainSearch } from "../lib/listSearch";
import { hasDuplicateDomainUrl } from "../lib/duplicateValidation";
import { isAllowedEnvironment } from "../lib/environments";
import { isValidHttpsDomain } from "../lib/inputValidation";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { toPublicDatabase } from "../lib/publicDtos";
import { readSqlDomains, readSqlPublicDatabases, type DomainFilters } from "../lib/coreMastersSqlRepository";
import { createSqlDomain, setSqlDomainStatus, updateSqlDomain } from "../lib/domainsSqlWriteRepository";
import { deleteSqlCoreCascade } from "../lib/coreCascadeSqlRepository";
import type { ClientRecord, DatabaseRecord, DomainRecord, UpdateSchedule, UpdateTask } from "../types/models";

async function getUserOrFail(req: HttpRequest) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  return profile;
}

function resultCount<T>(result: T[] | PageResult<T>): number {
  return Array.isArray(result) ? result.length : result.total;
}

async function readDomain(id: string): Promise<DomainRecord | null> {
  const backend = getDataBackend();
  if (backend === "sql") {
    const result = await readSqlDomains({ sourceId: id }, { enabled: false, page: 1, pageSize: 1 });
    return Array.isArray(result) ? result[0] ?? null : result.items[0] ?? null;
  }
  const { resources } = await getContainer("domains")
    .items.query<DomainRecord>({ query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: id }] })
    .fetchAll();
  if (backend === "dual-read") {
    const shadow = await readSqlDomains({ sourceId: id }, { enabled: false, page: 1, pageSize: 1 });
    if (Boolean(resources[0]) !== (resultCount(shadow) > 0)) console.warn("Domain detail dual-read parity mismatch.");
  }
  return resources[0] ?? null;
}

const DomainSchema = z.object({
  clientId: z.string().min(1, "El cliente es obligatorio."),
  domainName: z.string().min(1, "El dominio es obligatorio."),
  environment: z.string().refine(isAllowedEnvironment, "El ambiente debe ser Producción, Pruebas o Demo."),
  currentWebVersion: z.string().optional(),
  assignedUpdaterIds: z.array(z.string()).default([]),
  notes: z.string().optional(),
  frequency: z.any().optional(),
});

app.http("domainsList", {
  route: "domains",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canViewDomains(user, roleDefinitions)) return forbidden();
      const clientId = req.query.get("clientId");
      const status = req.query.get("status");
      const environment = req.query.get("environment");
      const search = req.query.get("search");
      const responsable = req.query.get("responsable");
      const recurring = req.query.get("recurring");
      const includeDeleted = req.query.get("includeDeleted") === "true";
      const canReadDeleted = canDeleteDomain(user, roleDefinitions) || canReactivateDomain(user, roleDefinitions);
      const pagination = getPagination(req);
      const sqlFilters: DomainFilters = {
        clientId: clientId ?? undefined,
        status: status ?? undefined,
        environment: environment ?? undefined,
        search: search?.trim().toLowerCase() || undefined,
        responsable: responsable ?? undefined,
        recurring: recurring === "with" || recurring === "without" ? recurring : undefined,
        excludeDeleted: !canReadDeleted || (!includeDeleted && !status),
      };
      const backend = getDataBackend();
      if (backend === "sql") return ok(await readSqlDomains(sqlFilters, pagination));
      const container = getContainer("domains");
      const querySpec = clientId
        ? { query: "SELECT * FROM c WHERE c.clientId = @c", parameters: [{ name: "@c", value: clientId }] }
        : { query: "SELECT * FROM c" };
      const { resources } = await container.items.query<DomainRecord>(querySpec).fetchAll();
      let items = resources;
      if (!canDeleteDomain(user, roleDefinitions) && !canReactivateDomain(user, roleDefinitions)) items = items.filter((domain) => domain.status !== "deleted");
      if (!includeDeleted && !status) items = items.filter((d) => d.status !== "deleted");
      if (status) items = items.filter((d) => d.status === status);
      if (environment) items = items.filter((d) => d.environment === environment);
      if (search) items = items.filter((d) => matchesDomainSearch(d, search));
      if (responsable) items = items.filter((d) => d.assignedUpdaterIds.includes(responsable));
      if (recurring === "with" || recurring === "without") {
        const { resources: schedules } = await getContainer("updateSchedules").items
          .query<UpdateSchedule>({ query: "SELECT * FROM c WHERE c.targetType = 'domain' AND c.active = true" })
          .fetchAll();
        const recurrentDomainIds = new Set(
          schedules
            .filter((schedule) => schedule.origin === "domain_default")
            .flatMap((schedule) => [schedule.domainId, ...(schedule.targetIds ?? [])].filter(Boolean) as string[])
        );
        items = items.filter((domain) => recurring === "with" ? recurrentDomainIds.has(domain.id) : !recurrentDomainIds.has(domain.id));
      }
      const primary = pagination.enabled ? paginateArray(items, pagination.page, pagination.pageSize) : items;
      if (backend === "dual-read") {
        const shadow = await readSqlDomains(sqlFilters, pagination);
        if (resultCount(primary) !== resultCount(shadow)) console.warn("Domains dual-read parity mismatch.");
      }
      return ok(primary);
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("domainsCreate", {
  route: "domains",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canCreateDomain(user, roleDefinitions)) return forbidden();
      const body = await req.json();
      const parsed = DomainSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      if (!isAllowedEnvironment(parsed.data.environment)) return badRequest("El ambiente debe ser Producción, Pruebas o Demo.");
      if (!isValidHttpsDomain(parsed.data.domainName)) return badRequest("El dominio debe iniciar con https://");
      if (getDataBackend() === "sql") {
        const record = await createSqlDomain(
          `domain_${randomUUID()}`,
          parsed.data.clientId,
          parsed.data,
          { id: user.id, email: user.email },
        );
        return created(record);
      }
      const { resources: existingDomains } = await getContainer("domains").items.readAll<DomainRecord>().fetchAll();
      if (hasDuplicateDomainUrl(existingDomains, parsed.data.domainName)) return conflict("Ya existe un dominio con esta URL.");
      const { resource: client } = await getContainer("clients").item(parsed.data.clientId, parsed.data.clientId).read<ClientRecord>();
      if (!client) return badRequest("Cliente no encontrado.");
      const now = new Date().toISOString();
      const record: DomainRecord = {
        id: `domain_${randomUUID()}`,
        clientId: client.id,
        clientName: client.name,
        domainName: parsed.data.domainName.trim(),
        environment: parsed.data.environment,
        currentWebVersion: parsed.data.currentWebVersion?.trim(),
        assignedUpdaterIds: parsed.data.assignedUpdaterIds,
        status: "active",
        notes: parsed.data.notes?.trim(),
        createdAt: now,
        createdBy: user.id,
        updatedAt: now,
        updatedBy: user.id,
        lastUpdatedAt: null,
        lastUpdatedBy: null,
      };
      await getContainer("domains").items.create(record);
      await writeAuditLog({
        entityType: "domain",
        entityId: record.id,
        clientId: client.id,
        clientName: client.name,
        domainId: record.id,
        domainName: record.domainName,
        action: "domain_created",
        performedBy: user.id,
        performedByEmail: user.email,
        after: record,
      });
      // Nota: las actualizaciones programadas ya NO se crean desde el dominio.
      // Se configuran únicamente en la sección "Actualizaciones programadas".
      return created(record);
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("domainsGet", {
  route: "domains/{id}",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canViewDomains(user, roleDefinitions)) return forbidden();
      const id = req.params.id;
      const domain = await readDomain(id);
      if (!domain) return notFound("Dominio no encontrado.");
      if (domain.status === "deleted" && !canDeleteDomain(user, roleDefinitions) && !canReactivateDomain(user, roleDefinitions)) return forbidden("No tiene permisos para consultar este dominio.");
      return ok(domain);
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("domainsDatabases", {
  route: "domains/{id}/databases",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canViewRelatedDomainDatabases(user, roleDefinitions)) return forbidden();
      const id = req.params.id;
      const includeDeleted = req.query.get("includeDeleted") === "true" && (canDeleteDomain(user, roleDefinitions) || canReactivateDomain(user, roleDefinitions));
      const domain = await readDomain(id);
      if (!domain || (!includeDeleted && domain.status === "deleted")) return notFound("Dominio no encontrado.");
      const backend = getDataBackend();
      if (backend === "sql") {
        return ok(await readSqlPublicDatabases(
          { domainId: id, visibility: includeDeleted ? "all" : "active" },
          { enabled: false, page: 1, pageSize: 100 }
        ));
      }
      const { resources } = await getContainer("databases")
        .items.query<DatabaseRecord>({
          query: includeDeleted
            ? "SELECT * FROM c WHERE c.domainId = @d"
            : "SELECT * FROM c WHERE c.domainId = @d AND c.status != 'deleted' AND c.status != 'inactive'",
          parameters: [{ name: "@d", value: id }],
        })
        .fetchAll();
      const primary = resources.map(toPublicDatabase);
      if (backend === "dual-read") {
        const shadow = await readSqlPublicDatabases(
          { domainId: id, visibility: includeDeleted ? "all" : "active" },
          { enabled: false, page: 1, pageSize: 100 }
        );
        if (resultCount(primary) !== resultCount(shadow)) console.warn("Domain databases dual-read parity mismatch.");
      }
      return ok(primary);
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("domainsUpdate", {
  route: "domains/{id}",
  methods: ["PUT"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canEditDomain(user, roleDefinitions)) return forbidden();
      const id = req.params.id;
      const body = await req.json() as any;
      if (typeof body.environment === "string" && !isAllowedEnvironment(body.environment)) return badRequest("El ambiente debe ser Producción, Pruebas o Demo.");
      if (typeof body.domainName === "string" && !isValidHttpsDomain(body.domainName)) return badRequest("El dominio debe iniciar con https://");
      if (getDataBackend() === "sql") {
        const updated = await updateSqlDomain(id, {
          ...(typeof body.domainName === "string" ? { domainName: body.domainName } : {}),
          ...(typeof body.environment === "string" ? { environment: body.environment } : {}),
          ...(typeof body.currentWebVersion === "string" ? { currentWebVersion: body.currentWebVersion } : {}),
          ...(Array.isArray(body.assignedUpdaterIds) ? { assignedUpdaterIds: body.assignedUpdaterIds } : {}),
          ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
        }, { id: user.id, email: user.email });
        return updated ? ok(updated) : notFound("Dominio no encontrado.");
      }
      const container = getContainer("domains");
      const { resources } = await container
        .items.query<DomainRecord>({ query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: id }] })
        .fetchAll();
      if (!resources.length) return notFound("Dominio no encontrado.");
      const existing = resources[0];
      if (typeof body.domainName === "string") {
        const { resources: existingDomains } = await container.items.readAll<DomainRecord>().fetchAll();
        if (hasDuplicateDomainUrl(existingDomains, body.domainName, id)) return conflict("Ya existe un dominio con esta URL.");
      }
      const before = { ...existing };
      const updated: DomainRecord = {
        ...existing,
        ...(typeof body.domainName === "string" ? { domainName: body.domainName.trim() } : {}),
        ...(typeof body.environment === "string" ? { environment: body.environment } : {}),
        ...(typeof body.currentWebVersion === "string" ? { currentWebVersion: body.currentWebVersion.trim() } : {}),
        ...(Array.isArray(body.assignedUpdaterIds) ? { assignedUpdaterIds: body.assignedUpdaterIds } : {}),
        ...(typeof body.notes === "string" ? { notes: body.notes.trim() } : {}),
        updatedAt: new Date().toISOString(),
        updatedBy: user.id,
      };
      await container.item(id, existing.clientId).replace(updated);
      await writeAuditLog({
        entityType: "domain",
        entityId: id,
        clientId: existing.clientId,
        clientName: existing.clientName,
        domainId: id,
        domainName: updated.domainName,
        action: "domain_updated",
        performedBy: user.id,
        performedByEmail: user.email,
        before,
        after: updated,
      });
      // La frecuencia embebida del dominio fue retirada. Las actualizaciones
      // de dominios y bases se programan desde "Actualizaciones programadas",
      // usando alcance manual o por licenciamiento.
      return ok(updated);
    } catch (e) {
      return serverError(e);
    }
  },
});

async function setDomainStatus(req: HttpRequest, action: "domain_deactivated" | "domain_reactivated", status: "inactive" | "active"): Promise<HttpResponseInit> {
  const user = await getUserOrFail(req);
  const roleDefinitions = await loadRoleDefinitions();
  const allowed = status === "active" ? canReactivateDomain(user, roleDefinitions) : canDeactivateDomain(user, roleDefinitions);
  if (!allowed) return forbidden();
  const id = req.params.id;
  if (getDataBackend() === "sql") {
    const result = await setSqlDomainStatus(
      id,
      status,
      action,
      { id: user.id, email: user.email },
      status === "inactive" ? "target_domain_inactive" : undefined,
    );
    return result ? ok(result.domain) : notFound("Dominio no encontrado.");
  }
  const container = getContainer("domains");
  const { resources } = await container
    .items.query<DomainRecord>({ query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: id }] })
    .fetchAll();
  if (!resources.length) return notFound("Dominio no encontrado.");
  const existing = resources[0];
  existing.status = status;
  existing.updatedAt = new Date().toISOString();
  existing.updatedBy = user.id;
  await container.item(id, existing.clientId).replace(existing);
  const obsoletedTasks = status === "inactive"
    ? await cancelPendingTasksForDomain(id, user, "target_domain_inactive")
    : 0;
  await writeAuditLog({
    entityType: "domain", entityId: id, clientId: existing.clientId, clientName: existing.clientName,
    domainId: id, domainName: existing.domainName,
    action, performedBy: user.id, performedByEmail: user.email, metadata: { obsoletedTasks }, after: existing,
  });
  return ok(existing);
}

app.http("domainsDeactivate", { route: "domains/{id}/deactivate", methods: ["POST"], authLevel: "anonymous", handler: (req) => setDomainStatus(req, "domain_deactivated", "inactive").catch(serverError) });
app.http("domainsReactivate", { route: "domains/{id}/reactivate", methods: ["POST"], authLevel: "anonymous", handler: (req) => setDomainStatus(req, "domain_reactivated", "active").catch(serverError) });

// Eliminación física con verificación de integridad.
app.http("domainsDelete", {
  route: "domains/{id}",
  methods: ["DELETE"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      if (!canDeleteDomain(user, roleDefinitions)) return forbidden();
      const id = req.params.id;
      const cascade = req.query.get("cascade") === "true";
      if (getDataBackend() === "sql") {
        const result = await deleteSqlCoreCascade("domain", id, cascade, { id: user.id, email: user.email });
        if (!result.found) return notFound("Dominio no encontrado.");
        if (result.requiresCascade) return conflict("El dominio tiene dependencias. Confirme eliminación en cascada.", { dependencies: result.dependencies });
        return ok({ ok: true, deleted: { ...result.dependencies, obsoletedTasks: result.obsoletedTasks, cascadeSchedules: result.cascadeSchedules } });
      }
      const container = getContainer("domains");
      const { resources } = await container
        .items.query<DomainRecord>({ query: "SELECT * FROM c WHERE c.id = @id", parameters: [{ name: "@id", value: id }] })
        .fetchAll();
      if (!resources.length) return notFound("Dominio no encontrado.");
      const dom = resources[0];

      const dbsQ = await getContainer("databases")
        .items.query<DatabaseRecord>({
          query: "SELECT * FROM c WHERE c.domainId = @d AND c.status != 'deleted'",
          parameters: [{ name: "@d", value: id }],
        })
        .fetchAll();
      const { resources: schedulesAsociadas } = await getContainer("updateSchedules").items
        .query<UpdateSchedule>({
          query: "SELECT * FROM c WHERE c.domainId = @d OR ARRAY_CONTAINS(c.targetIds, @d)",
          parameters: [{ name: "@d", value: id }],
        })
        .fetchAll();
      const { resources: tasks } = await getContainer("updateTasks").items
        .query<UpdateTask>({
          query: "SELECT * FROM c WHERE c.domainId = @d AND c.status NOT IN ('completed', 'cancelled')",
          parameters: [{ name: "@d", value: id }],
        })
        .fetchAll();
      const dependencies = { databases: dbsQ.resources.length, schedules: schedulesAsociadas.length, pendingTasks: tasks.length };
      if (!cascade && (dependencies.databases > 0 || dependencies.schedules > 0 || dependencies.pendingTasks > 0)) {
        return conflict("El dominio tiene dependencias. Confirme eliminación en cascada.", { dependencies });
      }

      const now = new Date().toISOString();
      const schedContainer = getContainer("updateSchedules");
      let cascadaSchedules = 0;
      for (const s of schedulesAsociadas) {
        try {
          await schedContainer.item(s.id, s.clientId).delete();
          cascadaSchedules++;
          await writeAuditLog({
            entityType: "schedule", entityId: s.id, clientId: s.clientId, clientName: s.clientName,
            domainId: id, domainName: dom.domainName,
            action: "schedule_deleted_cascade", performedBy: user.id, performedByEmail: user.email,
            metadata: { cascadeFromDomain: id }, before: s,
          });
        } catch {/* si falla una, seguimos con las demás */}
      }

      for (const db of dbsQ.resources) {
        const before = { ...db };
        const deleted = { ...db, status: "deleted" as const, deletedAt: now, deletedBy: user.id, updatedAt: now, updatedBy: user.id };
        await getContainer("databases").item(db.id, db.clientId).replace(deleted);
        await writeAuditLog({
          entityType: "database", entityId: db.id, clientId: db.clientId, clientName: db.clientName,
          domainId: id, domainName: dom.domainName, companyName: db.companyName,
          action: "database_deleted_cascade", performedBy: user.id, performedByEmail: user.email,
          metadata: { cascadeFromDomain: id }, before: { ...before, dbAccess: { ...before.dbAccess, passwordSecretName: undefined } },
          after: { status: "deleted" },
        });
      }
      const beforeDomain = { ...dom };
      const deletedDomain = { ...dom, status: "deleted" as const, deletedAt: now, deletedBy: user.id, updatedAt: now, updatedBy: user.id };
      await container.item(id, dom.clientId).replace(deletedDomain);
      const obsoletedTasks = await cancelPendingTasksForDomain(id, user, "target_domain_deleted");
      await writeAuditLog({
        entityType: "domain", entityId: id, clientId: dom.clientId, clientName: dom.clientName,
        domainId: id, domainName: dom.domainName,
        action: "domain_deleted_cascade", performedBy: user.id, performedByEmail: user.email,
        metadata: { ...dependencies, cascadeSchedules: cascadaSchedules, obsoletedTasks },
        before: beforeDomain,
        after: { status: "deleted" },
      });
      return ok({ ok: true, deleted: { ...dependencies, obsoletedTasks } });
    } catch (e) {
      return serverError(e);
    }
  },
});
