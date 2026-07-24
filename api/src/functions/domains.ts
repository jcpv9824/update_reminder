import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
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
import { getPagination } from "../lib/pagination";
import { isAllowedEnvironment } from "../lib/environments";
import { isValidHttpsDomain } from "../lib/inputValidation";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { readSqlDomains, readSqlPublicDatabases, type DomainFilters } from "../lib/coreMastersSqlRepository";
import { createSqlDomain, setSqlDomainStatus, updateSqlDomain } from "../lib/domainsSqlWriteRepository";
import { deleteSqlCoreCascade } from "../lib/coreCascadeSqlRepository";
import type { DomainRecord } from "../types/models";

async function getUserOrFail(req: HttpRequest) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  return profile;
}

async function readDomain(id: string): Promise<DomainRecord | null> {
  const result = await readSqlDomains({ sourceId: id }, { enabled: false, page: 1, pageSize: 1 });
  return Array.isArray(result) ? result[0] ?? null : result.items[0] ?? null;
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
      return ok(await readSqlDomains(sqlFilters, pagination));
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
      const record = await createSqlDomain(
        `domain_${randomUUID()}`,
        parsed.data.clientId,
        parsed.data,
        { id: user.id, email: user.email },
      );
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
      return ok(await readSqlPublicDatabases(
        { domainId: id, visibility: includeDeleted ? "all" : "active" },
        { enabled: false, page: 1, pageSize: 100 }
      ));
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
      const updated = await updateSqlDomain(id, {
        ...(typeof body.domainName === "string" ? { domainName: body.domainName.trim() } : {}),
        ...(typeof body.environment === "string" ? { environment: body.environment } : {}),
        ...(typeof body.currentWebVersion === "string" ? { currentWebVersion: body.currentWebVersion.trim() } : {}),
        ...(Array.isArray(body.assignedUpdaterIds) ? { assignedUpdaterIds: body.assignedUpdaterIds } : {}),
        ...(typeof body.notes === "string" ? { notes: body.notes.trim() } : {}),
      }, { id: user.id, email: user.email });
      return updated ? ok(updated) : notFound("Dominio no encontrado.");
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
  const result = await setSqlDomainStatus(
    id,
    status,
    action,
    { id: user.id, email: user.email },
    status === "inactive" ? "target_domain_inactive" : undefined,
  );
  return result ? ok(result.domain) : notFound("Dominio no encontrado.");
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
      const result = await deleteSqlCoreCascade("domain", id, cascade, { id: user.id, email: user.email });
      if (!result.found) return notFound("Dominio no encontrado.");
      if (result.requiresCascade) return conflict("El dominio tiene dependencias. Confirme eliminación en cascada.", { dependencies: result.dependencies });
      return ok({ ok: true, deleted: { ...result.dependencies, obsoletedTasks: result.obsoletedTasks, cascadeSchedules: result.cascadeSchedules } });
    } catch (e) {
      return serverError(e);
    }
  },
});
